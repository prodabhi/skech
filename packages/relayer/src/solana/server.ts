/**
 * The relayer's door: one WebSocket per app (`hello`, `watch`, `account`, `piece`, `ack`, `placed`, `refused`,
 * `settled`, `activity`), and a build-and-submit for everything a wallet signs.
 *
 * A session, a deposit, a withdrawal or a claim of what the player's SKT earned is a transaction the wallet signs and
 * the relayer pays for:
 *   app → { type: "build", kind: "session" | "deposit" | "withdraw" | "revoke" | "claim", player, ... }
 *   relayer → { type: "built", id, kind, tx }          base64, the relayer's fee-payer signature already on it
 *   app → { type: "submit", id, tx }                   the same transaction, signed by the wallet (Coinbase or MWA)
 *   relayer → { type: "submitted", id, kind, ok, tx | why }
 * The relayer co-signs nothing it did not build: `submit` sends only the exact message `build` made.
 */
import type { Server as BunServer, ServerWebSocket } from "bun";
import { type Address, address, createNoopSigner, getBase16Decoder, type Instruction } from "@solana/kit";
import { fetchMaybeToken, findAssociatedTokenPda, getApproveInstruction, getCreateAssociatedTokenIdempotentInstruction, TOKEN_PROGRAM_ADDRESS, type Token } from "@solana-program/token";
import { claimableE6, sktNowE6, getClaimInstruction, getDepositInstruction, getRevokeSessionInstruction, getSetSessionInstruction, getWithdrawInstruction, holderAddress, playerAddress } from "@skech/contracts/solana/sdk";
import type { Engine } from "../engine";
import type { SolanaChain } from "./chain";
import type { SolanaConfig } from "./config";
import type { Placed, Refused, SolanaPieceMsg, SolanaSequencer } from "./sequencer";
import type { Settled, SolanaSettler } from "./settler";
import type { SocialBridge } from "../social/bridge";
import { beat, clientIp, Door, IDLE_S, MESSAGE_BYTES, Rates, remember, Sponsor } from "../limits";
import { report } from "../sentry";
import { big, type Message, read, refusal, SOLANA } from "../wire";

type Data = { id: number; ip: string; rates: Rates; player?: Address };
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
const addr = (s: unknown): Address | null => {
  try {
    return typeof s === "string" ? address(s) : null;
  } catch {
    return null;
  }
};
const usdc = (e6: bigint) => (Number(e6) / 1e6).toString();
const reason = (e: unknown) => String((e as Error).message ?? e).split("\n")[0].slice(0, 160);

export class SolanaServer {
  private clients = new Set<ServerWebSocket<Data>>();
  private byPlayer = new Map<Address, Set<ServerWebSocket<Data>>>();
  private nextId = 1;
  private door = new Door();
  private sponsor = new Sponsor();
  private server: BunServer<Data> | null = null;
  sequencer: SolanaSequencer | null = null;
  settler: SolanaSettler | null = null;
  /** Transactions per player, counted from their account's signatures: fetched on demand, then kept up to date. */
  private sweeping = new Set<Address>();
  private activity = new Map<Address, { at: number; txs: number; newest: string | null; recent: { signature: string; time: number | null }[]; partial: boolean }>();

  constructor(
    private readonly cfg: SolanaConfig,
    private readonly engine: Engine,
    private readonly chain: SolanaChain,
    private readonly domain: Uint8Array,
    private readonly log: (s: string) => void,
    private readonly status: () => Record<string, unknown>,
  ) {}

  start() {
    this.server = Bun.serve<Data>({
      port: this.cfg.port,
      hostname: this.cfg.host,
      fetch: (req, server) => {
        const url = new URL(req.url);
        if (url.pathname === "/health") return new Response("ok");
        if (url.pathname === "/status") return new Response(json(this.status()), { headers: { "content-type": "application/json" } });
        if (url.pathname === "/ws") {
          const ip = clientIp(req, server.requestIP(req)?.address);
          if (!this.door.enter(ip)) return new Response("too many connections", { status: 429 });
          if (server.upgrade(req, { data: { id: this.nextId++, ip, rates: new Rates() } })) return undefined;
          this.door.leave(ip);
          return new Response("expected a websocket", { status: 426 });
        }
        return new Response("skech relayer (Solana): /ws, /health, /status", { status: 404 });
      },
      websocket: {
        open: (ws) => {
          this.clients.add(ws);
          ws.send(json(this.hello()));
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
    this.log(`listening on ws://${this.cfg.host}:${this.cfg.port}/ws (${this.cfg.net.label})`);
  }

  announce() {
    const text = json(this.hello());
    for (const ws of this.clients) ws.send(text);
  }
  get connections() {
    return this.clients.size;
  }

  hello() {
    const d = this.cfg.deployment;
    return {
      type: "hello",
      chain: "solana",
      cluster: this.cfg.net.cluster,
      label: this.cfg.net.label,
      program: d.program,
      game: d.game,
      usdc: d.usdcMint,
      lookupTable: d.lookupTable,
      domain: getBase16Decoder().decode(this.domain),
      oracle: this.chain.signer.address,
      relayer: this.chain.signer.address,
      engineSigner: this.engine.signer,
      market: { id: this.cfg.market, name: this.cfg.marketName },
      difficulty: this.sequencer?.difficulty ?? null,
      lateMs: this.cfg.lateMs,
      units: this.sequencer?.units() ?? null,
      terms: this.sequencer?.terms ?? null,
      faucet: this.cfg.net.faucet,
      activity: true,
    };
  }

  /** The social service, told what was placed and settled; null without a database. */
  social: SocialBridge | null = null;

  readonly notify = {
    placed: (p: Placed) => {
      this.chain.accounts.invalidate(p.player);
      // The stroke is the player's own: the app has it, and it is the social feed's to show.
      const { stroke: _stroke, unit: _unit, ...told } = p;
      this.toPlayer(p.player, { type: "placed", ...told });
      this.social?.placed(p);
    },
    refused: (r: Refused) => this.toPlayer(r.player, { type: "refused", ...r }),
    settled: (s: Settled) => {
      this.chain.accounts.invalidate(s.player);
      this.sequencer?.credit(s.player, s.paid);
      this.toPlayer(s.player, { type: "settled", ...s });
      this.social?.settled(s);
    },
    owed: (to: Address, value: bigint) => this.toPlayer(to, { type: "owed", value }),
    account: (player: Address) => void this.sendAccount(player),
  };

  /** Stop telling `ws` about the player it watched; a player nobody watches is forgotten. */
  private unwatch(ws: ServerWebSocket<Data>) {
    const player = ws.data.player;
    if (!player) return;
    const set = this.byPlayer.get(player);
    set?.delete(ws);
    if (set && !set.size) this.byPlayer.delete(player);
  }

  private toPlayer(player: Address, msg: unknown) {
    const text = json(msg);
    for (const ws of this.byPlayer.get(player) ?? []) ws.send(text);
  }

  /** The player's account, no older than `maxAgeMs` (0: read after now), to `only` or to every socket watching them. */
  private async sendAccount(player: Address, only?: ServerWebSocket<Data>, maxAgeMs = 0, missingMs = maxAgeMs) {
    try {
      const { player: p, pool, token, holder, rewards } = await this.chain.accounts.get(player, maxAgeMs, missingMs);
      const wallet = this.walletUsdc(token);
      const now = BigInt(Math.floor(Date.now() / 1000));
      const owed = p && p.iouShares > 0n ? (p.iouShares * (pool.iouIndexAt + pool.iouRate * (now - pool.iouTimeAt > 0n ? now - pool.iouTimeAt : 0n))) / 10n ** 18n : 0n;
      const msg = {
        type: "account",
        player,
        balance: p?.balance ?? 0n,
        session: p ? { key: p.session.key, validUntil: p.session.validUntil, allowance: p.session.allowance } : null,
        owed,
        wallet,
        // Their SKT now, e6, decayed as it is (it halves every half-life), and the USDC it has earned that a claim would pay now.
        skt: { balance: holder && rewards ? sktNowE6(holder, rewards, now) : 0n, claimable: holder && rewards ? claimableE6(holder, rewards) : 0n },
      };
      if (only) only.send(json(msg));
      else this.toPlayer(player, msg);
    } catch (e) {
      this.log(`account ${player}: ${reason(e)}`);
    }
  }

  /** The USDC in the player's own wallet, and how much of it the game may sweep in. */
  private walletUsdc(t: Token | null) {
    if (!t) return { usdc: 0n, approved: 0n };
    const approved = t.delegate.__option === "Some" && t.delegate.value === this.cfg.deployment.game ? t.delegatedAmount : 0n;
    return { usdc: t.amount, approved };
  }

  /** Every message, checked (wire.ts) before it is handled; whatever goes wrong in handling it is answered, never thrown. */
  private async receive(ws: ServerWebSocket<Data>, raw: string | Buffer) {
    const r = read(raw, SOLANA);
    if (!ws.data.rates.take(typeof r.msg?.type === "string" ? r.msg.type : "")) {
      // Too many: answered only where the app waits for an answer. Nobody waits on an `error`.
      const no = refusal(r.msg, "Too many requests; slow down");
      if (no.type !== "error") ws.send(json(no));
      return;
    }
    if ("why" in r) return ws.send(json(refusal(r.msg, r.why)));
    if (!this.sequencer) return ws.send(json(refusal(r.msg, "Starting up")));
    try {
      await this.onMessage(ws, r.msg, this.sequencer);
    } catch (e) {
      this.log(`${r.msg.type}: ${reason(e)}`);
      report("message", e);
      ws.send(json(refusal(r.msg, "Something went wrong; try again")));
    }
  }

  private async onMessage(ws: ServerWebSocket<Data>, msg: Message, seq: SolanaSequencer) {
    switch (msg.type) {
      case "hello":
        return ws.send(json(this.hello()));
      case "watch": {
        const player = addr(msg.player);
        if (!player) return ws.send(json({ type: "error", why: "Bad player" }));
        this.unwatch(ws);
        ws.data.player = player;
        let set = this.byPlayer.get(player);
        if (!set) this.byPlayer.set(player, (set = new Set()));
        set.add(ws);
        // A second-old read will do; an address with no game account is answered from one up to 30 s old.
        return void this.sendAccount(player, ws, 1_000, 30_000);
      }
      case "account":
        if (ws.data.player) return void this.sendAccount(ws.data.player, ws);
        return;
      case "activity": {
        const player = addr(msg.player) ?? ws.data.player;
        if (!player) return ws.send(json({ type: "activity", player: null, txs: 0, recent: [], counting: true, progress: 0 }));
        return ws.send(json({ type: "activity", player, ...(await this.countActivity(player)) }));
      }
      case "sweep": {
        // The app saw USDC land in the wallet: move it in now rather than on the next round, once at a time.
        const player = ws.data.player;
        if (!player || !this.settler || this.sweeping.has(player)) return;
        this.sweeping.add(player);
        void this.settler
          .sweepIn(player)
          .catch((e) => this.log(`sweep ${player}: ${reason(e)}`))
          .finally(() => this.sweeping.delete(player));
        return;
      }
      case "piece": {
        const m = msg as unknown as SolanaPieceMsg;
        const r = await seq.accept(m);
        return ws.send(json({ type: "ack", ...r, index: m.piece?.index, drawing: m.piece?.drawing }));
      }
      case "build": {
        try {
          const built = await this.build(msg, ws.data.ip);
          return ws.send(json({ type: "built", kind: msg.kind, ...built }));
        } catch (e) {
          return ws.send(json({ type: "built", kind: msg.kind, ok: false, why: reason(e) }));
        }
      }
      case "submit": {
        const id = typeof msg.id === "string" ? msg.id : "";
        try {
          const { kind, player, sent, approve } = await this.chain.submit(id, String(msg.tx ?? ""));
          seq.forget(player);
          if (sent.err) ws.send(json({ type: "submitted", id, kind, ok: false, why: `Failed on chain: ${json(sent.err)}`, tx: sent.signature }));
          else {
            // Whether it carried an approval is what `build` put in it, not what the app says.
            if (kind === "session" && approve) this.settler?.approve(player);
            // The new balance first, then the answer.
            await this.sendAccount(player);
            ws.send(json({ type: "submitted", id, kind, ok: true, tx: sent.signature }));
          }
        } catch (e) {
          ws.send(json({ type: "submitted", id, ok: false, why: reason(e) }));
        }
        return;
      }
      default:
        return ws.send(json({ type: "error", why: `Unknown message ${String(msg.type)}` }));
    }
  }

  /**
   * A transaction for the player's wallet to sign, the relayer paying its fee and the rent of any account it opens.
   * So that is held to what a player with money in needs: the game's account for them (whose rent nobody gets back)
   * only with USDC in or coming in; a token account (whose rent its owner gets back by closing it) only for a
   * withdrawal to an address without one; and a few an hour for one wallet or one address.
   */
  private async build(msg: Record<string, unknown>, ip: string) {
    const player = addr(msg.player);
    if (!player) throw new Error("Bad player");
    if (!this.sponsor.take(ip, player)) throw new Error("Too many transactions for now; try again in a few minutes");
    const d = this.cfg.deployment;
    const me = this.chain.signer;
    const wallet = createNoopSigner(player);
    const playerPda = await playerAddress(player, d.program);
    const [ata] = await findAssociatedTokenPda({ mint: d.usdcMint, owner: player, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const { player: p, token: held, holder, rewards } = await this.chain.accounts.get(player, 1_000);
    const inWallet = held ? held.amount : 0n;
    const min = this.cfg.minMoveE6;
    const ixs: Instruction[] = [];
    let units = 60_000;
    let approved = false;
    switch (msg.kind) {
      case "session": {
        const key = addr(msg.key);
        const until = big(msg.validUntil);
        const allowance = big(msg.allowance);
        if (!key || until === null || allowance === null) throw new Error("Bad session");
        if (!(p && p.balance > 0n) && inWallet < min) throw new Error("Deposit first");
        ixs.push(getSetSessionInstruction({ payer: me, authority: wallet, game: d.game, player: playerPda, key, validUntil: until, allowance }));
        // Optionally, a standing approval: USDC that lands in the wallet is swept into the balance by itself. Only on
        // the token account the wallet has: one opened for it would be rent it could close and keep.
        const approve = big(msg.approve);
        if (approve !== null && approve > 0n && held) {
          ixs.push(getApproveInstruction({ source: ata, delegate: d.game, owner: wallet, amount: approve }));
          approved = true;
          units = 90_000;
        }
        break;
      }
      case "deposit": {
        const amount = big(msg.amount);
        if (!amount) throw new Error("Bad amount");
        if (amount < min) throw new Error(`At least ${usdc(min)} USDC`);
        if (inWallet < amount) throw new Error("Not that much USDC in your wallet");
        ixs.push(getDepositInstruction({ payer: me, authority: wallet, game: d.game, player: playerPda, from: ata, vault: d.vault, usdcMint: d.usdcMint, tokenProgram: TOKEN_PROGRAM_ADDRESS, amount }));
        break;
      }
      case "withdraw": {
        const amount = big(msg.amount);
        const to = addr(msg.to) ?? player;
        if (!amount) throw new Error("Bad amount");
        if (!p || p.balance < amount) throw new Error("Not that much in your balance");
        if (amount < min && amount !== p.balance) throw new Error(`At least ${usdc(min)} USDC, or all of it`);
        const [toAta] = await findAssociatedTokenPda({ mint: d.usdcMint, owner: to, tokenProgram: TOKEN_PROGRAM_ADDRESS });
        if (!(to === player ? held : (await fetchMaybeToken(this.chain.rpc, toAta)).exists)) ixs.push(getCreateAssociatedTokenIdempotentInstruction({ payer: me, ata: toAta, owner: to, mint: d.usdcMint }));
        ixs.push(getWithdrawInstruction({ authority: wallet, game: d.game, player: playerPda, to: toAta, vault: d.vault, usdcMint: d.usdcMint, tokenProgram: TOKEN_PROGRAM_ADDRESS, amount }));
        units = 80_000;
        break;
      }
      case "revoke":
        if (!p) throw new Error("No session to end");
        ixs.push(getRevokeSessionInstruction({ authority: wallet, player: playerPda }));
        break;
      case "claim": {
        // What it pays is the player's own, already in the vault: only built when there is something to pay.
        if (!p || !holder || !rewards || claimableE6(holder, rewards) === 0n) throw new Error("Nothing to claim");
        ixs.push(getClaimInstruction({ authority: wallet, game: d.game, rewards: this.chain.rewards, player: playerPda, holder: await holderAddress(player, d.program) }));
        units = Math.ceil((this.cfg.compute.claim ?? 20_000) * 1.25) + 5_000;
        break;
      }
      default:
        throw new Error(`Unknown kind ${String(msg.kind)}`);
    }
    return this.chain.build(String(msg.kind), player, ixs, units, approved);
  }

  private async countActivity(player: Address) {
    const pda = await playerAddress(player, this.cfg.deployment.program);
    const explorer = this.cfg.net.explorer("address", pda);
    // An address nobody here watches is asked about cheaply: not at all while it has no game account (known for
    // 30 s at a time), and one page of its history, every 30 s at most.
    const watched = this.byPlayer.has(player);
    if (!watched && !(await this.chain.accounts.get(player, 1_000, 30_000)).player) return { txs: 0, recent: [], explorer, counting: false, progress: 1 };
    let c = this.activity.get(player);
    if (Date.now() - (c?.at ?? 0) > (watched ? 10_000 : 30_000)) {
      // Counted only in part before: counted again from the start.
      if (!c || c.partial) c = { at: 0, txs: 0, newest: null, recent: [], partial: false };
      // Newer signatures than we had, page by page: every transaction that touched the player's account.
      const pages = watched ? 20 : 1;
      let before: string | undefined;
      let more = false;
      const fresh: { signature: string; time: number | null }[] = [];
      for (let page = 0; page < pages; page++) {
        const sigs = await this.chain.rpc
          .getSignaturesForAddress(pda, { limit: 1000, ...(before ? { before: before as never } : {}), ...(c.newest ? { until: c.newest as never } : {}) })
          .send()
          .catch(() => []);
        fresh.push(...sigs.map((s) => ({ signature: s.signature as string, time: s.blockTime === null ? null : Number(s.blockTime) })));
        if (sigs.length < 1000) break;
        before = sigs.at(-1)!.signature;
        more = !watched && page === pages - 1;
      }
      c.txs += fresh.length;
      // Where a count in part stopped is not where the next may start: it is not kept.
      if (fresh.length && !more) c.newest = fresh[0].signature;
      c.partial = more;
      c.recent = [...fresh, ...c.recent].slice(0, 20);
      c.at = Date.now();
      remember(this.activity, player, c, 20_000);
    }
    return { txs: c!.txs, recent: c!.recent, explorer, counting: c!.partial, progress: c!.partial ? 0 : 1 };
  }
}
