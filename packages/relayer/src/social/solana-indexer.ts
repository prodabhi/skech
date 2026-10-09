/**
 * The game's history, from the chain: every placement and settlement, including those of relayers other than this
 * one, and those this one made while the social service was down. Solana keeps only a stroke's hash: what is read
 * from the chain counts in the numbers, but a drawing's shape comes only from the relayer that placed it.
 *
 * - Live: `logsSubscribe` on the program. A transaction's logs come with it, so following the game costs no request a
 *   transaction. Not on the pool: a placement loads the pool through the lookup table, and the RPC's `mentions`
 *   filter does not see addresses loaded that way (it missed every placement). A program id is never in a lookup
 *   table. That brings the bar posted every second too: its logs are looked over for the two events and dropped.
 * - Catch-up, every 30 s and on every reconnect, by the pool's address (`getSignaturesForAddress` does count
 *   addresses from lookup tables): the signatures since the last one counted. Those the socket
 *   already brought, failed ones, and ones already in the database are passed over; the rest are fetched.
 * - Backfill, once, newest first, back to SOCIAL_BACKFILL_DAYS: a page of signatures and a `getTransaction` each.
 *
 * Every request waits its turn in a budget of its own (SOCIAL_RPC_RPS, 2 a second by default, the backfill after
 * everything else), and a 429 stops them all for a while: it adds to the relayer's own requests on the same RPC
 * and must never crowd them out.
 */
import { getPlacedEventDecoder, getSettledEventDecoder, PLACED_EVENT_DISCRIMINATOR, SETTLED_EVENT_DISCRIMINATOR, type PlacedEvent, type SettledEvent } from "@skech/contracts/solana/sdk";
import type { PublicDrawing } from "@skech/core/social";
import { remember } from "../limits";
import { Budget } from "../solana/budget";
import type { Placement, Settlement, SocialStore } from "./store";

/** `testPlays`: the standalone service's test hook (worker.ts, POST /test/placed); never set by the relayer. */
export type IndexerConfig = { cluster: string; program: string; game: string; pool: string; rpcUrl: string; wsUrl: string; rps: number; backfillDays: number; testPlays?: boolean };
export type Changed = (drawing: PublicDrawing | null, kind: "placed" | "settled", event: string) => void;
/** A stroke a player's app sent for a bet before its placement was read: given with the placement, and checked. */
export type StrokeFor = (bet: string) => string | undefined;
/** News, told from memory before the database is written: whether it was (false: the piece is not in memory). */
export type Live = (e: { placement: Placement } | { settlement: Settlement }, event: string) => boolean;
type SignatureRow = { signature: string; err: unknown; blockTime: number | null };
export type GameEvent = { name: "placed"; data: PlacedEvent } | { name: "settled"; data: SettledEvent };

const same = (a: Uint8Array, b: ArrayLike<number>) => a.length === b.length && a.every((x, i) => x === b[i]);
/** How recent an event is to be news on the live feed; older ones only count. */
export const NEWS_MS = 120_000;
const PAGE = 1000;
/** An error fit for a log: no RPC URL, which can carry a key. */
const said = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0].replace(/(https?|wss?):\/\/\S+/g, "<rpc>").slice(0, 200);

/**
 * The game's own events in a transaction's logs: only those its program wrote, not another program it called or
 * that called it, which could write anything.
 */
export function gameEvents(logs: readonly string[], program: string): GameEvent[] {
  const out: GameEvent[] = [];
  const stack: string[] = [];
  for (const line of logs) {
    const invoke = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (invoke) {
      stack.push(invoke[1]);
      continue;
    }
    if (/^Program \w+ (success|failed)/.test(line)) {
      stack.pop();
      continue;
    }
    if (!line.startsWith("Program data: ") || stack.at(-1) !== program) continue;
    const bytes = new Uint8Array(Buffer.from(line.slice(14), "base64"));
    const head = bytes.subarray(0, 8);
    try {
      if (same(head, PLACED_EVENT_DISCRIMINATOR)) out.push({ name: "placed", data: getPlacedEventDecoder().decode(bytes) });
      else if (same(head, SETTLED_EVENT_DISCRIMINATOR)) out.push({ name: "settled", data: getSettledEventDecoder().decode(bytes) });
    } catch {
      /* Not one of ours after all. */
    }
  }
  return out;
}

export class SolanaIndexer {
  private budget: Budget;
  /** Signatures the socket brought: catch-up need not fetch them. */
  private heard = new Map<string, true>();
  private head: string | null = null;
  private ws: WebSocket | null = null;
  private stopped = false;
  private catching: Promise<void> | null = null;
  stats = { live: 0, notices: 0, fetched: 0, skipped: 0, backfilled: 0 };
  /** The last game event the socket brought: its signature, when it was heard, and when it was told to the apps. */
  last: { signature: string; heardAt: number; toldAt: number; writtenAt: number } | null = null;

  constructor(
    private readonly cfg: IndexerConfig,
    private readonly store: SocialStore,
    private readonly changed: Changed,
    private readonly status: (counting: boolean, progress: number) => void,
    private readonly log: (message: string) => void,
    private readonly strokeFor: StrokeFor = () => undefined,
    private readonly live: Live = () => false,
  ) {
    this.budget = new Budget(Math.max(0.2, cfg.rps), log, Date.now, Math.max(1, Math.ceil(cfg.rps)), Math.random, "SOCIAL_RPC_RPS");
  }

  async start() {
    this.head = await this.store.meta("solana_head");
    this.listen();
    await this.catchUp();
    void this.backfill();
    const timer = setInterval(() => void this.catchUp(), 30_000);
    timer.unref?.();
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
  }

  /* ---- the RPC, within the budget ---- */

  private async rpc<T>(method: string, params: unknown[], priority: "read" | "sweep"): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.budget.take(priority);
      const res = await fetch(this.cfg.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
      if (res.status === 429) {
        const after = Number(res.headers.get("retry-after"));
        this.budget.throttled(method, Number.isFinite(after) && after > 0 ? after * 1000 : null, this.cfg.rpcUrl);
        if (attempt >= 5) throw new Error(`${method}: rate limited`);
        continue;
      }
      if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
      const body = (await res.json()) as { result: T; error?: { code?: number; message?: string } };
      if (body.error) {
        if (/rate limit|too many/i.test(body.error.message ?? "") || body.error.code === 429) {
          this.budget.throttled(method, null, this.cfg.rpcUrl);
          if (attempt >= 5) throw new Error(`${method}: rate limited`);
          continue;
        }
        throw new Error(`${method}: ${body.error.message ?? "error"}`);
      }
      this.budget.ok();
      return body.result;
    }
  }

  /* ---- counting a transaction ---- */

  /**
   * A transaction's events: news first (`live`, from memory, at once), then the database. What `live` could not
   * place (a piece from before this service started) is read back from the database and told from there.
   */
  private async ingest(signature: string, logs: readonly string[], at: number): Promise<number> {
    const events = gameEvents(logs, this.cfg.program);
    for (const ev of events) {
      if (ev.name === "placed") {
        const p = ev.data;
        const placement: Placement = { betId: p.bet, player: p.player, drawing: p.drawing.toString(), openAt: p.openAt, staked: p.staked, unit: p.unit, strokeHash: Buffer.from(p.strokeHash).toString("hex"), stroke: this.strokeFor(p.bet), sections: p.sections.map((s) => ({ second: s.second, lo: s.lo.toString(), hi: s.hi.toString(), stake: s.stake.toString(), rung: s.rung })), tx: signature };
        const news = Number(p.openAt) > Date.now() - NEWS_MS;
        const told = news && this.live({ placement }, `${signature}:${p.bet}`);
        const drawing = await this.store.place(placement, told);
        if (news && !told) this.changed(drawing, "placed", `${signature}:${p.bet}`);
      } else {
        const s = ev.data;
        const settlement: Settlement = { betId: s.bet, player: s.player, hitMask: s.hitMask, missMask: s.missMask, expiredMask: s.expiredMask, paid: s.paid, owed: s.owed, tx: signature, at };
        const event = `${signature}:${s.bet}:${s.hitMask}:${s.missMask}`;
        const news = at > Date.now() - NEWS_MS;
        const told = news && this.live({ settlement }, event);
        const drawing = await this.store.settle(settlement, told);
        if (news && !told) this.changed(drawing, "settled", event);
      }
    }
    return events.length;
  }

  /** One signature from history: fetched only if nothing has counted it yet. */
  private async fetch(row: SignatureRow, priority: "read" | "sweep") {
    if (row.err) return;
    if (this.heard.has(row.signature) || (await this.store.knows(row.signature))) {
      this.stats.skipped++;
      return;
    }
    const tx = await this.rpc<{ meta: { err: unknown; logMessages: string[] | null } | null; blockTime: number | null } | null>("getTransaction", [row.signature, { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0 }], priority);
    this.stats.fetched++;
    if (!tx?.meta || tx.meta.err) return;
    await this.ingest(row.signature, tx.meta.logMessages ?? [], (tx.blockTime ?? row.blockTime ?? Math.floor(Date.now() / 1000)) * 1000);
  }

  private signatures(before: string | undefined, until: string | undefined, limit = PAGE, priority: "read" | "sweep" = "read") {
    return this.rpc<SignatureRow[]>("getSignaturesForAddress", [this.cfg.pool, { limit, commitment: "confirmed", ...(before ? { before } : {}), ...(until ? { until } : {}) }], priority);
  }

  /* ---- live ---- */

  private listen(backoff = 1000) {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.cfg.wsUrl);
    } catch (e) {
      this.log(`live logs: ${said(e)}`);
      setTimeout(() => this.listen(Math.min(30_000, backoff * 2)), backoff);
      return;
    }
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [this.cfg.program] }, { commitment: "confirmed" }] }));
      // Whatever happened while the socket was down.
      void this.catchUp();
    };
    ws.onmessage = (e) => {
      let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: { result?: { value?: { signature: string; err: unknown; logs: string[] } } } };
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (msg.id === 1) {
        if (msg.error) this.log(`live logs refused: ${said(msg.error.message)}`);
        else if (backoff === 1000 && !this.stats.live) this.log("following the game live");
        return;
      }
      const v = msg.method === "logsNotification" ? msg.params?.result?.value : undefined;
      if (!v || typeof v.signature !== "string") return;
      this.stats.notices++;
      if (v.err || !Array.isArray(v.logs)) return;
      // Most are the bar posted each second, whose one event is the bar: gameEvents reads only the two it wants.
      if (!v.logs.some((l) => l.startsWith("Program data: "))) return;
      remember(this.heard, v.signature, true, 20_000);
      const heardAt = Date.now();
      // The news is told before ingest's first wait (from memory); the database write follows.
      const writing = this.ingest(v.signature, v.logs, heardAt);
      const toldAt = Date.now();
      void writing.then(
        (n) => {
          if (!n) return;
          this.stats.live++;
          this.last = { signature: v.signature, heardAt, toldAt, writtenAt: Date.now() };
        },
        (err) => this.log(`live: ${said(err)}`),
      );
    };
    ws.onclose = () => {
      if (this.ws !== ws || this.stopped) return;
      this.ws = null;
      setTimeout(() => this.listen(opened ? 1000 : Math.min(30_000, backoff * 2)), opened ? 1000 : backoff);
    };
    ws.onerror = () => ws.close();
  }

  /* ---- catching up, and the history before ---- */

  catchUp(): Promise<void> {
    this.catching ??= this.catchUpOnce()
      .catch((e) => this.log(`catching up: ${said(e)}`))
      .finally(() => {
        this.catching = null;
      });
    return this.catching;
  }

  private async catchUpOnce() {
    if (!this.head) {
      // The first start: from here on is followed; what came before is the backfill's, from here back.
      const [newest] = await this.signatures(undefined, undefined, 1);
      if (!newest) return;
      // The backfill starts before it: it is counted here.
      await this.fetch(newest, "read");
      this.head = newest.signature;
      await this.store.setMeta("solana_head", newest.signature);
      if (!(await this.store.meta("solana_backfill"))) await this.store.setMeta("solana_backfill", `before:${newest.signature}`);
      return;
    }
    const rows: SignatureRow[] = [];
    let before: string | undefined;
    for (let pages = 0; pages < 50; pages++) {
      const page = await this.signatures(before, this.head);
      rows.push(...page);
      if (page.length < PAGE) break;
      before = page.at(-1)!.signature;
    }
    if (!rows.length) return;
    // Oldest first, so a placement is counted before what settles it.
    for (const row of rows.reverse()) await this.fetch(row, "read");
    this.head = rows.at(-1)!.signature;
    await this.store.setMeta("solana_head", this.head);
  }

  private async backfill() {
    const since = Date.now() - this.cfg.backfillDays * 86_400_000;
    for (;;) {
      if (this.stopped) return;
      const cursor = await this.store.meta("solana_backfill").catch(() => null);
      if (!cursor || cursor === "done") {
        this.status(false, 1);
        return;
      }
      try {
        const before = cursor.slice("before:".length);
        const rows = await this.signatures(before, undefined, 100, "sweep");
        for (const row of rows) {
          await this.fetch(row, "sweep");
          this.stats.backfilled++;
        }
        const last = rows.at(-1);
        const reached = last?.blockTime ? last.blockTime * 1000 : since;
        const done = rows.length < 100 || reached <= since;
        await this.store.setMeta("solana_backfill", done ? "done" : `before:${last!.signature}`);
        this.status(!done, done ? 1 : Math.max(0, Math.min(0.99, (Date.now() - reached) / Math.max(1, Date.now() - since))));
        if (done) this.log(`history read: ${this.stats.backfilled} transactions, ${this.stats.fetched} fetched`);
      } catch (e) {
        this.log(`history: ${said(e)}`);
        await Bun.sleep(10_000);
      }
    }
  }
}
