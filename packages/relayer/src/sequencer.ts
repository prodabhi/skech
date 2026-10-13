/**
 * Pieces come in as they are drawn; every second's worth opens together.
 *
 * A piece is checked as it arrives (its shape, its signatures, its session,
 * its money, that it is not late) and answered at once. Pieces that open on
 * the same second wait for that second to start and a little longer, for
 * late trades; then each band is priced on the map of that second, the quote
 * is signed, and one transaction places them all. What the chain says back
 * goes to each player.
 */
import { features, NICE, stepFor } from "@skech/core/dots";
import { betIdOf, CHANCE_ONE, decodeStroke, HORIZON, MAX_SECTIONS, momentumE6, rungE2, stakeOf, toE8, TYPES, unitFor, withMomentum, type Piece, type Section } from "@skech/core/chain";
import { type Address, type Hex, hashStruct, keccak256, type TypedDataDomain } from "viem";
import type { ChainClient, GameConfig, Session } from "./chain";
import type { Config } from "./config";
import type { Engine } from "./engine";
import { remember } from "./limits";
import type { Pricer } from "./pricer";
import { report } from "./sentry";
import type { Settler } from "./settler";
import { verifyPiece, verifyPrice } from "./verify";
import { big } from "./wire";

export type PieceWire = {
  player: Address;
  drawing: string;
  index: number;
  market: number;
  difficulty: number;
  openAt: string;
  perDot: string;
  unit: string;
  priceSeen: string;
  priceTime: string;
  sections: { second: number; lo: string; hi: string; stake: string }[];
  strokeHash: Hex;
};
export type PieceMsg = { type: "piece"; piece: PieceWire; sessionSig: Hex; priceSig: Hex; stroke: Hex };

export type Placed = { betId: Hex; player: Address; openAt: bigint; staked: bigint; fee: bigint; refunded: bigint; sections: { second: number; lo: bigint; hi: bigint; stake: bigint; rung: number }[]; tx: Hex };
export type Refused = { betId: Hex; player: Address; why: string; tx?: Hex };
export type Notify = { placed: (p: Placed) => void; refused: (r: Refused) => void };

type Pending = { piece: Piece; hash: Hex; sessionSig: Hex; priceSig: Hex; stroke: Hex; receivedAt: number; betId: Hex };

const REFUSALS = ["None", "Mismatch", "Replay", "Difficulty", "Late", "StalePrice", "PerDot", "Sections", "PriceSig", "Stroke", "Session", "SessionSig", "NotOffered", "Allowance", "Balance"];
const isHex = (s: unknown, bytes?: number): s is Hex => typeof s === "string" && /^0x[0-9a-fA-F]*$/.test(s) && (bytes === undefined || s.length === 2 + bytes * 2);
/** Players whose session and balance are kept between reads: any address can be asked about. */
const CACHED = 20_000;

export class Sequencer {
  difficulty = 51;
  gameConfig: GameConfig | null = null;
  private buckets = new Map<bigint, Pending[]>();
  private timers = new Map<bigint, ReturnType<typeof setTimeout>>();
  private seen = new Set<Hex>();
  private sessions = new Map<Address, { at: number; session: Session }>();
  private balances = new Map<Address, { at: number; balance: bigint }>();
  /** Stakes accepted but not yet on chain, per player (lowercased: one player however the address is cased), so a fast hand cannot outrun its balance. */
  private pending = new Map<Address, bigint>();
  readonly domain: TypedDataDomain;
  /** `turnedAway`: pieces answered no before they reached the chain, by why. They never show up on chain. */
  stats = { accepted: 0, refused: 0, placed: 0, batches: 0, turnedAway: {} as Record<string, number> };

  constructor(
    private readonly cfg: Config,
    private readonly engine: Engine,
    private readonly pricer: Pricer,
    private readonly chain: ChainClient,
    private readonly settler: Settler,
    private readonly notify: Notify,
    private readonly log: (s: string) => void,
  ) {
    this.domain = { name: "skech", version: "1", chainId: cfg.chainId, verifyingContract: cfg.game };
  }

  /**
   * The grid units a piece may be on now: the market step's, or a round step
   * near it. The app holds its step while ink is on the chart, up to 1.6x from
   * the market's; anything within 2.5x of a round step is taken.
   */
  units(): bigint[] | null {
    const f = features(this.engine.book.bars, Math.floor(this.engine.now() / 1000) * 1000);
    if (!f) return null;
    const want = stepFor(f.sigma, f.price);
    return NICE.filter((n) => n >= want / 2.5 && n <= want * 2.5).map((n) => toE8(unitFor(n)));
  }

  forgetSession(player: Address) {
    this.sessions.delete(player.toLowerCase() as Address);
  }
  forgetBalance(player: Address) {
    this.balances.delete(player.toLowerCase() as Address);
  }
  /**
   * A payout, as the chain reported it: added to the cached balance rather
   * than read again. The cache still expires on its own, so the chain's own
   * figure comes back within seconds either way.
   */
  credit(player: Address, paid: bigint) {
    const c = this.balances.get(player.toLowerCase() as Address);
    if (c && paid > 0n) c.balance += paid;
  }

  /** Check a piece and queue it for its second. */
  async accept(msg: PieceMsg): Promise<{ ok: true; betId: Hex } | { ok: false; why: string; betId?: Hex }> {
    const now = Math.floor(this.engine.now());
    const parsed = this.parse(msg);
    if (typeof parsed === "string") {
      this.stats.turnedAway[parsed] = (this.stats.turnedAway[parsed] ?? 0) + 1;
      return { ok: false, why: parsed };
    }
    const piece = parsed;
    const betId = betIdOf(piece.player, piece.drawing, piece.index);
    const bad = (why: string) => {
      const k = why.replace(/\d+/g, "N");
      this.stats.turnedAway[k] = (this.stats.turnedAway[k] ?? 0) + 1;
      return { ok: false as const, why, betId };
    };
    if (this.seen.has(betId)) return bad("Already sent");
    if (piece.market !== this.cfg.market) return bad("Unknown market");
    if (piece.difficulty !== this.difficulty) return bad(`Difficulty is ${this.difficulty} now`);
    if (!this.engine.ready() || !this.engine.signer) return bad("Waiting for live prices");
    const openAt = Number(piece.openAt);
    if (openAt % 1000 !== 0) return bad("Bad opening second");
    if (now > openAt + this.cfg.lateMs) return bad("Too late for that second");
    if (openAt > now + this.cfg.aheadMs) return bad("Your clock is ahead");
    const gc = this.gameConfig;
    if (!gc) return bad("Starting up");
    if (piece.perDot < gc.minPerDot || piece.perDot > gc.maxPerDot) return bad("Per dot out of range");
    const units = this.units();
    if (!units) return bad("Waiting for live prices");
    if (!units.includes(piece.unit)) return bad("Grid out of date");
    const stake = stakeOf(piece.sections);
    if (stake > gc.maxPieceStake) return bad("Too much on one piece");
    // The price seen carries the engine's own time; a trade that reached the player a beat before it reached
    // here counts as received then. What matters is that it was signed, and that it is not old.
    const priceTime = Number(piece.priceTime);
    if (priceTime > now + 2000 || now - priceTime > gc.maxPriceAgeMs) return bad("Price seen is stale");
    const receivedAt = Math.max(now, priceTime);
    if (receivedAt > openAt + this.cfg.lateMs) return bad("Too late for that second");
    // Together: the price's signature, and the player's session and balance (cached, or one batched read).
    const [priceOk, session, balance] = await Promise.all([
      verifyPrice(this.domain, this.engine.signer, this.cfg.marketName, piece.priceSeen, piece.priceTime, msg.priceSig),
      this.session(piece.player),
      this.balance(piece.player).catch(() => null),
    ]);
    if (!priceOk) return bad("Price seen is not the engine's");
    if (!session || Number(session.validUntil) * 1000 <= now) return bad("No session");
    if (!(await verifyPiece(this.domain, piece, msg.sessionSig, session))) return bad("Not signed by your session");
    const who = piece.player.toLowerCase() as Address;
    const pendingStake = this.pending.get(who) ?? 0n;
    if (session.allowance < stake + pendingStake) return bad("Session allowance used up");
    if (balance === null) return bad("Could not read your balance");
    if (balance < stake + pendingStake) return bad("Not enough in your balance");
    // Looked at again here, with nothing awaited between it and taking the piece in: the same piece sent twice at
    // once passed the first look together.
    if (this.seen.has(betId)) return bad("Already sent");
    // In.
    this.seen.add(betId);
    if (this.seen.size > 50_000) this.seen.delete(this.seen.values().next().value!);
    this.pending.set(who, pendingStake + stake);
    const hash = hashStruct({ types: TYPES, primaryType: "Piece", data: piece });
    const entry: Pending = { piece, hash, sessionSig: msg.sessionSig, priceSig: msg.priceSig, stroke: msg.stroke, receivedAt, betId };
    let bucket = this.buckets.get(piece.openAt);
    if (!bucket) {
      this.buckets.set(piece.openAt, (bucket = []));
      const delay = Math.max(0, openAt + this.cfg.openAfterMs - now);
      this.timers.set(
        piece.openAt,
        setTimeout(() => void this.flush(piece.openAt).catch((e) => this.log(`place at ${piece.openAt}: ${String((e as Error).message ?? e).split("\n")[0]}`)), delay),
      );
    }
    bucket.push(entry);
    this.stats.accepted++;
    return { ok: true, betId };
  }

  private parse(msg: PieceMsg): Piece | string {
    const w = msg.piece;
    if (!w || typeof w !== "object") return "No piece";
    if (!isHex(w.player, 20)) return "Bad player";
    const drawing = big(w.drawing);
    const openAt = big(w.openAt);
    const perDot = big(w.perDot);
    const unit = big(w.unit);
    const priceSeen = big(w.priceSeen);
    const priceTime = big(w.priceTime);
    if (drawing === null || openAt === null || perDot === null || unit === null || priceSeen === null || priceTime === null) return "Bad numbers";
    if (!Number.isInteger(w.index) || w.index < 0 || w.index > 0xffffffff) return "Bad index";
    if (!Number.isInteger(w.market) || !Number.isInteger(w.difficulty) || w.difficulty > 100) return "Bad market";
    if (!Array.isArray(w.sections) || w.sections.length === 0 || w.sections.length > MAX_SECTIONS) return "Bad sections";
    if (unit <= 0n) return "Bad unit";
    const sections: Section[] = [];
    for (const s of w.sections) {
      if (!s || typeof s !== "object") return "Bad section";
      const lo = big(s.lo);
      const hi = big(s.hi);
      const stake = big(s.stake);
      if (!Number.isInteger(s.second) || s.second < 1 || s.second > HORIZON || lo === null || hi === null || stake === null) return "Bad section";
      if (lo >= hi || stake <= 0n || lo % unit !== 0n || hi % unit !== 0n) return "Section off the grid";
      sections.push({ second: s.second, lo, hi, stake });
    }
    if (!isHex(w.strokeHash, 32) || !isHex(msg.stroke) || !isHex(msg.sessionSig) || !isHex(msg.priceSig)) return "Bad bytes";
    if (msg.stroke.length > 2 + 2 * (33 + 2048 * 12)) return "Stroke too long";
    if (keccak256(msg.stroke) !== w.strokeHash) return "Stroke does not match";
    try {
      decodeStroke(msg.stroke);
    } catch {
      return "Bad stroke";
    }
    return { player: w.player, drawing, index: w.index, market: w.market, difficulty: w.difficulty, openAt, perDot, unit, priceSeen, priceTime, sections, strokeHash: w.strokeHash };
  }

  private async session(player: Address): Promise<Session | null> {
    const k = player.toLowerCase() as Address;
    const c = this.sessions.get(k);
    if (c && Date.now() - c.at < 20_000) return c.session;
    try {
      const session = await this.chain.sessionOf(player);
      remember(this.sessions, k, { at: Date.now(), session }, CACHED);
      return session;
    } catch {
      return null;
    }
  }

  private async balance(player: Address): Promise<bigint> {
    const k = player.toLowerCase() as Address;
    const c = this.balances.get(k);
    if (c && Date.now() - c.at < 3_000) return c.balance;
    const balance = await this.chain.balanceOf(player);
    remember(this.balances, k, { at: Date.now(), balance }, CACHED);
    return balance;
  }

  /**
   * A placement, as the chain reported it: its stake off the cached balance
   * and the session's allowance, exactly as the contract takes it, so the
   * next piece is checked without a read.
   */
  private debit(player: Address, staked: bigint) {
    const k = player.toLowerCase() as Address;
    const b = this.balances.get(k);
    if (b) b.balance = b.balance > staked ? b.balance - staked : 0n;
    const s = this.sessions.get(k);
    if (s) s.session = { ...s.session, allowance: s.session.allowance > staked ? s.session.allowance - staked : 0n };
  }

  /** Price and place everything that opens on `openAt`. */
  private async flush(openAt: bigint) {
    const bucket = this.buckets.get(openAt) ?? [];
    this.buckets.delete(openAt);
    this.timers.delete(openAt);
    if (!bucket.length) return;
    // What was held for these pieces while they were on their way: let go the moment the chain has answered for them.
    const release = (entries: Pending[]) => {
      for (const e of entries) {
        const who = e.piece.player.toLowerCase() as Address;
        const left = (this.pending.get(who) ?? 0n) - stakeOf(e.piece.sections);
        if (left > 0n) this.pending.set(who, left);
        else this.pending.delete(who);
      }
    };
    const f = features(this.engine.book.bars, Number(openAt));
    if (!f) {
      release(bucket);
      for (const e of bucket) this.notify.refused({ betId: e.betId, player: e.piece.player, why: "No price to open on" });
      this.stats.refused += bucket.length;
      return;
    }
    // One map per grid in use; one transaction per grid, since the quote names it.
    const byUnit = new Map<bigint, Pending[]>();
    for (const e of bucket) byUnit.set(e.piece.unit, [...(byUnit.get(e.piece.unit) ?? []), e]);
    await Promise.all(
      [...byUnit].map(async ([unit, entries]) => {
        // What goes on chain: the pieces that keep a band.
        let sending = entries;
        try {
          const fl = await this.pricer.fieldFor(f, Number(openAt), Number(unit) / 1e8, this.difficulty);
          const each = entries.map((e) => this.pricer.chances(fl, e.piece.sections, Number(openAt)));
          if (each.flat().some((c) => c < 0 || c > CHANCE_ONE)) throw new Error("a chance out of range");
          const price = toE8(f.price);
          const momentum = momentumE6(f.momentum);
          // A piece none of whose bands earns a rung, the chain refuses, and the gas to send it would be paid for
          // nothing: turned away here instead, with the chain's own reason.
          const keeps = entries.map((e, i) => e.piece.sections.some((s, j) => rungE2(each[i][j], e.piece.difficulty, withMomentum(s.lo, s.hi, price, momentum), momentum) > 0));
          sending = entries.filter((_, i) => keeps[i]);
          for (const e of entries.filter((_, i) => !keeps[i])) {
            this.stats.refused++;
            this.notify.refused({ betId: e.betId, player: e.piece.player, why: "NotOffered" });
          }
          if (!sending.length) return;
          const chances = entries.flatMap((_, i) => (keeps[i] ? each[i] : []));
          const message = {
            market: this.cfg.market,
            openAt,
            unit,
            price,
            momentum: BigInt(momentum),
            pieces: sending.map((e) => e.hash),
            receivedAt: sending.map((e) => BigInt(e.receivedAt)),
            chances,
          };
          const sig = await this.chain.wallet.signTypedData({ domain: this.domain, types: TYPES, primaryType: "Quote", message });
          const placements = sending.map((e) => ({ piece: e.piece, sessionSig: e.sessionSig, priceSig: e.priceSig, stroke: e.stroke }));
          const quote = { market: message.market, openAt, unit, price: message.price, momentum: message.momentum, receivedAt: message.receivedAt, chances };
          const shape = {
            kind: "place" as const,
            pieces: sending.length,
            sections: sending.reduce((n, e) => n + e.piece.sections.length, 0),
            strokeBytes: sending.reduce((n, e) => n + (e.stroke.length - 2) / 2, 0),
            coldSlots: this.chain.ledger.coldSlots,
          };
          const receipt = await this.chain.send("place", [placements, quote, sig], `place ${sending.length} at ${openAt}`, shape);
          this.stats.batches++;
          const answered = new Set<Hex>();
          for (const ev of this.chain.events(receipt)) {
            if (ev.name === "Placed") {
              const a = ev.args as { betId: Hex; player: Address; openAt: bigint; unit: bigint; staked: bigint; fee: bigint; refunded: bigint; sections: bigint[] };
              const sections = a.sections.map((w) => ({
                second: Number(w & 0xffn),
                lo: (w >> 8n) & 0xffffffffffffffffn,
                hi: (w >> 72n) & 0xffffffffffffffffn,
                stake: (w >> 136n) & 0xffffffffffffffffn,
                rung: Number((w >> 200n) & 0xffffn),
              }));
              answered.add(a.betId);
              this.stats.placed++;
              this.debit(a.player, a.staked);
              for (const s of sections) this.settler.watch(a.betId, a.player, a.unit, { second: Number(openAt) + s.second * 1000, lo: s.lo, hi: s.hi, stake: s.stake, rung: s.rung });
              this.notify.placed({ betId: a.betId, player: a.player, openAt, staked: a.staked, fee: a.fee, refunded: a.refunded, sections, tx: receipt.transactionHash });
            } else if (ev.name === "Refused") {
              const a = ev.args as { betId: Hex; player: Address; why: number };
              answered.add(a.betId);
              this.stats.refused++;
              this.notify.refused({ betId: a.betId, player: a.player, why: REFUSALS[a.why] ?? `Refused (${a.why})`, tx: receipt.transactionHash });
            }
          }
          for (const e of sending) if (!answered.has(e.betId)) this.notify.refused({ betId: e.betId, player: e.piece.player, why: "Not placed", tx: receipt.transactionHash });
        } catch (err) {
          this.log(`place at ${openAt} (unit ${unit}) failed: ${String((err as Error).message ?? err).split("\n")[0]}`);
          report("place", err);
          for (const e of sending) this.notify.refused({ betId: e.betId, player: e.piece.player, why: "Could not reach the chain" });
          this.stats.refused += sending.length;
        } finally {
          release(entries);
        }
      }),
    );
  }
}

