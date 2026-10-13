/**
 * The relayer's door: one WebSocket per app. The app sends pieces as they are
 * drawn and asks for its account; the relayer answers each piece at once and
 * tells the player what the chain made of it, and of every second after.
 * Deposits, sessions and withdrawals signed by the wallet come through here
 * too, so a player never needs gas.
 */
import type { Server as BunServer, ServerWebSocket } from "bun";
import type { Address, Hex } from "viem";
import type { ChainClient } from "./chain";
import type { Config } from "./config";
import type { Engine } from "./engine";
import type { PieceMsg, Placed, Refused, Sequencer } from "./sequencer";
import type { Settled, Settler } from "./settler";
import type { Activity } from "./activity";
import { beat, clientIp, Door, IDLE_S, MESSAGE_BYTES, Rates, Sponsor } from "./limits";
import { report } from "./sentry";
import { big, type Message, MONAD, read, refusal } from "./wire";

type Data = { id: number; ip: string; rates: Rates; player?: Address };
type Deps = { cfg: Config; engine: Engine; chain: ChainClient; log: (s: string) => void; status: () => Record<string, unknown> };

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
const isHex = (s: unknown): s is Hex => typeof s === "string" && /^0x[0-9a-fA-F]*$/.test(s);
const isAddress = (s: unknown): s is Address => isHex(s) && s.length === 42;

export class Server {
  private clients = new Set<ServerWebSocket<Data>>();
  private byPlayer = new Map<Address, Set<ServerWebSocket<Data>>>();
  private nextId = 1;
  private door = new Door();
  private sponsor = new Sponsor();
  private server: BunServer<Data> | null = null;
  sequencer: Sequencer | null = null;
  settler: Settler | null = null;
  activity: Activity | null = null;

  constructor(private readonly d: Deps) {}

  start() {
    this.server = Bun.serve<Data>({
      port: this.d.cfg.port,
      hostname: this.d.cfg.host,
      fetch: (req, server) => {
        const url = new URL(req.url);
        if (url.pathname === "/health") return new Response("ok");
        if (url.pathname === "/status") return new Response(json(this.d.status()), { headers: { "content-type": "application/json" } });
        if (url.pathname === "/ws") {
          const ip = clientIp(req, server.requestIP(req)?.address);
          if (!this.door.enter(ip)) return new Response("too many connections", { status: 429 });
          if (server.upgrade(req, { data: { id: this.nextId++, ip, rates: new Rates() } })) return undefined;
          this.door.leave(ip);
          return new Response("expected a websocket", { status: 426 });
        }
        return new Response("skech relayer: /ws, /health, /status", { status: 404 });
      },
      websocket: {
        open: (ws) => {
          this.clients.add(ws);
          this.send(ws, this.hello());
        },
        message: (ws, raw) => void this.receive(ws, raw),
        close: (ws) => {
          this.clients.delete(ws);
          this.door.leave(ws.data.ip);
          this.unwatch(ws);
        },
        perMessageDeflate: false,
        maxPayloadLength: MESSAGE_BYTES,
        idleTimeout: IDLE_S,
      },
    });
    beat(this.clients);
    this.d.log(`listening on ws://${this.d.cfg.host}:${this.d.cfg.port}/ws`);
  }

  /** Tell every app the terms again: after the difficulty or the game's config changed on chain. */
  announce() {
    const text = json(this.hello());
    for (const ws of this.clients) ws.send(text);
  }

  get connections() {
    return this.clients.size;
  }

  /** What every app is told on connect: where the game is, and the terms. */
  hello() {
    const c = this.d.cfg;
    const gc = this.sequencer?.gameConfig;
    return {
      type: "hello",
      chainId: c.chainId,
      game: c.game,
      iou: c.iou ?? null,
      usdc: c.usdc ?? null,
      revenue: c.revenue ?? null,
      oracle: this.d.engine.signer,
      relayer: this.d.chain.account.address,
      market: { id: c.market, name: c.marketName },
      difficulty: this.sequencer?.difficulty ?? null,
      lateMs: c.lateMs,
      units: this.sequencer?.units() ?? null,
      config: gc ?? null,
      /** Whether this relayer answers `activity`: the app shows a player's transaction count only if so. */
      activity: this.activity !== null,
    };
  }

  /* ---- what the sequencer and settler tell players ---- */

  readonly notify = {
    placed: (p: Placed) => this.toPlayer(p.player, { type: "placed", ...p }),
    refused: (r: Refused) => this.toPlayer(r.player, { type: "refused", ...r }),
    settled: (s: Settled) => {
      this.sequencer?.credit(s.player, s.paid);
      this.toPlayer(s.player, { type: "settled", ...s });
    },
    owed: (to: Address, value: bigint) => this.toPlayer(to, { type: "owed", value }),
    account: (player: Address) => void this.sendAccount(player),
  };

  private toPlayer(player: Address, msg: unknown) {
    const text = json(msg);
    for (const ws of this.byPlayer.get(player.toLowerCase() as Address) ?? []) ws.send(text);
  }

  /** Stop telling `ws` about the player it watched; a player nobody watches is forgotten. */
  private unwatch(ws: ServerWebSocket<Data>) {
    const player = ws.data.player;
    if (!player) return;
    const set = this.byPlayer.get(player);
    set?.delete(ws);
    if (set && !set.size) this.byPlayer.delete(player);
  }

  private send(ws: ServerWebSocket<Data>, msg: unknown) {
    ws.send(json(msg));
  }

  private async sendAccount(player: Address, only?: ServerWebSocket<Data>) {
    try {
      // One batched read. The nonce rides along so the app can sign a session or a withdrawal without asking first.
      const [balance, session, iou, nonce] = await Promise.all([
        this.d.chain.balanceOf(player),
        this.d.chain.sessionOf(player),
        this.d.cfg.iou ? this.d.chain.iouAssets(player).catch(() => 0n) : Promise.resolve(0n),
        this.d.chain.nonceOf(player).catch(() => null),
      ]);
      const msg = { type: "account", player, balance, session: { key: session.key, x: session.x, y: session.y, validUntil: session.validUntil, allowance: session.allowance }, owed: iou, nonce };
      if (only) this.send(only, msg);
      else this.toPlayer(player, msg);
    } catch (e) {
      this.d.log(`account ${player}: ${String((e as Error).message ?? e).split("\n")[0]}`);
    }
  }

  /* ---- what apps send ---- */

  /** Every message, checked (wire.ts) before it is handled; whatever goes wrong in handling it is answered, never thrown. */
  private async receive(ws: ServerWebSocket<Data>, raw: string | Buffer) {
    const r = read(raw, MONAD);
    if (!ws.data.rates.take(typeof r.msg?.type === "string" ? r.msg.type : "")) {
      // Too many: answered only where the app waits for an answer. Nobody waits on an `error`.
      const no = refusal(r.msg, "Too many requests; slow down");
      if (no.type !== "error") this.send(ws, no);
      return;
    }
    if ("why" in r) return this.send(ws, refusal(r.msg, r.why));
    if (!this.sequencer) return this.send(ws, refusal(r.msg, "Starting up"));
    try {
      await this.onMessage(ws, r.msg, this.sequencer);
    } catch (e) {
      this.d.log(`${r.msg.type}: ${reason(e)}`);
      report("message", e);
      this.send(ws, refusal(r.msg, "Something went wrong; try again"));
    }
  }

  private async onMessage(ws: ServerWebSocket<Data>, msg: Message, seq: Sequencer) {
    switch (msg.type) {
      case "watch": {
        if (!isAddress(msg.player)) return this.send(ws, { type: "error", why: "Bad player" });
        const player = msg.player.toLowerCase() as Address;
        this.unwatch(ws);
        ws.data.player = player;
        let set = this.byPlayer.get(player);
        if (!set) this.byPlayer.set(player, (set = new Set()));
        set.add(ws);
        return void this.sendAccount(msg.player, ws);
      }
      case "account": {
        if (ws.data.player) return void this.sendAccount(ws.data.player, ws);
        return;
      }
      case "hello":
        return this.send(ws, this.hello());
      case "activity": {
        // Anyone's count is public on chain anyway; the watched player's unless another is named.
        const player = isAddress(msg.player) ? (msg.player.toLowerCase() as Address) : ws.data.player;
        if (!player || !this.activity) return this.send(ws, { type: "activity", player: player ?? null, txs: 0, pieces: 0, deposits: 0, withdrawals: 0, recent: [], counting: true, progress: 0 });
        return this.send(ws, { type: "activity", player, ...this.activity.of(player) });
      }
      case "piece": {
        const r = await seq.accept(msg as unknown as PieceMsg);
        return this.send(ws, { type: "ack", ...r, index: (msg as unknown as PieceMsg).piece?.index, drawing: (msg as unknown as PieceMsg).piece?.drawing });
      }
      case "session": {
        const { player, kind, key, x, y, validUntil, allowance, deadline, sig } = msg as Record<string, unknown>;
        if (!isAddress(player) || !isHex(sig) || !isHex(x) || !isHex(y) || !isAddress(key)) return this.send(ws, { type: "session-set", ok: false, why: "Bad session" });
        const until = big(validUntil);
        const allow = big(allowance);
        const dl = big(deadline);
        if (until === null || allow === null || dl === null || (kind !== 0 && kind !== 1)) return this.send(ws, { type: "session-set", ok: false, why: "Bad session" });
        if (!this.sponsor.take(ws.data.ip, player)) return this.send(ws, { type: "session-set", ok: false, why: TOO_MANY });
        // The relayer pays for a session: only for a player with money in the game to play with.
        const held = await this.d.chain.balanceOf(player).catch(() => null);
        if (held === null) return this.send(ws, { type: "session-set", ok: false, why: "Could not read your balance" });
        if (held === 0n) return this.send(ws, { type: "session-set", ok: false, why: "Deposit first" });
        const args = [player, kind, key, x, y, until, allow, dl, sig];
        const checked = await this.d.chain.check("registerSession", args);
        if ("why" in checked) return this.send(ws, { type: "session-set", ok: false, why: checked.why });
        try {
          const receipt = await this.d.chain.send("registerSession", args, `session ${player}`, { kind: "session" }, checked.gas);
          seq.forgetSession(player);
          this.send(ws, { type: "session-set", ok: true, tx: receipt.transactionHash });
        } catch (e) {
          this.send(ws, { type: "session-set", ok: false, why: reason(e) });
        }
        return void this.sendAccount(player);
      }
      case "deposit": {
        // EIP-3009 (an authorization with a random nonce, no allowance), or an EIP-2612 permit for tokens without it.
        const m = msg as Record<string, unknown>;
        const owner = m.owner;
        const amt = big(m.amount);
        let fn: "depositWithAuthorization" | "depositWithPermit";
        let args: unknown[];
        if (m.nonce !== undefined) {
          const after = big(m.validAfter);
          const before = big(m.validBefore);
          const now = BigInt(Math.floor(Date.now() / 1000));
          if (!isAddress(owner) || amt === null || after === null || before === null || !isHex(m.nonce) || (m.nonce as string).length !== 66 || !isHex(m.sig)) return this.send(ws, { type: "deposited", ok: false, why: "Bad deposit" });
          if (before <= now || before > now + 86_400n) return this.send(ws, { type: "deposited", ok: false, why: "Authorization expired or too long" });
          fn = "depositWithAuthorization";
          args = [owner, amt, after, before, m.nonce, m.sig];
        } else {
          const dl = big(m.deadline);
          if (!isAddress(owner) || amt === null || dl === null || typeof m.v !== "number" || !isHex(m.r) || !isHex(m.s)) return this.send(ws, { type: "deposited", ok: false, why: "Bad deposit" });
          fn = "depositWithPermit";
          args = [owner, amt, dl, m.v, m.r, m.s];
        }
        if (amt < this.d.cfg.minMoveE6) return this.send(ws, { type: "deposited", ok: false, why: `At least ${usdc(this.d.cfg.minMoveE6)} USDC` });
        if (!this.sponsor.take(ws.data.ip, owner)) return this.send(ws, { type: "deposited", ok: false, why: TOO_MANY });
        // One round trip to check it and price its gas, not one for each.
        const checked = await this.d.chain.check(fn, args);
        if ("why" in checked) return this.send(ws, { type: "deposited", ok: false, why: checked.why });
        try {
          const receipt = await this.d.chain.send(fn, args, `deposit ${amt} for ${owner}${fn === "depositWithPermit" ? " (permit)" : ""}`, undefined, checked.gas);
          seq.forgetBalance(owner);
          // The new balance first, then the answer: an app that celebrates on "deposited" already holds the balance
          // to play with, instead of a moment where it says "added" and still reads the old one.
          await this.sendAccount(owner);
          this.send(ws, { type: "deposited", ok: true, amount: amt, tx: receipt.transactionHash });
        } catch (e) {
          this.send(ws, { type: "deposited", ok: false, why: reason(e) });
          return void this.sendAccount(owner);
        }
        return;
      }
      case "withdraw": {
        const { player, amount, to, deadline, sig } = msg as Record<string, unknown>;
        const amt = big(amount);
        const dl = big(deadline);
        if (!isAddress(player) || !isAddress(to) || amt === null || dl === null || !isHex(sig)) return this.send(ws, { type: "withdrawn", ok: false, why: "Bad withdrawal" });
        // Less than the least is taken only as the whole balance, so dust cannot be moved out a piece at a time on the relayer's gas.
        if (amt < this.d.cfg.minMoveE6 && amt !== (await this.d.chain.balanceOf(player).catch(() => null))) {
          return this.send(ws, { type: "withdrawn", ok: false, why: `At least ${usdc(this.d.cfg.minMoveE6)} USDC, or all of it` });
        }
        if (!this.sponsor.take(ws.data.ip, player)) return this.send(ws, { type: "withdrawn", ok: false, why: TOO_MANY });
        const args = [player, amt, to, dl, sig];
        const checked = await this.d.chain.check("withdrawBySig", args);
        if ("why" in checked) return this.send(ws, { type: "withdrawn", ok: false, why: checked.why });
        try {
          const receipt = await this.d.chain.send("withdrawBySig", args, `withdraw ${amt} for ${player}`, undefined, checked.gas);
          seq.forgetBalance(player);
          // The new balance first, then the answer, as with deposits.
          await this.sendAccount(player);
          this.send(ws, { type: "withdrawn", ok: true, amount: amt, tx: receipt.transactionHash });
        } catch (e) {
          this.send(ws, { type: "withdrawn", ok: false, why: reason(e) });
          return void this.sendAccount(player);
        }
        return;
      }
      default:
        return this.send(ws, { type: "error", why: `Unknown message ${String(msg.type)}` });
    }
  }
}

const TOO_MANY = "Too many transactions for now; try again in a few minutes";
const usdc = (e6: bigint) => (Number(e6) / 1e6).toString();
const reason = (e: unknown) => String((e as Error).message ?? e).split("\n")[0].slice(0, 160);

