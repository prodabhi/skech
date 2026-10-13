/**
 * Every second the price is over, signed and posted, and every bet with ink
 * in it settled, in one transaction. Then the IOUs: whoever is owed is paid
 * off as the pool refills, and the house's fees are moved out.
 */
import { CLOSE_AFTER_MS } from "@skech/core/bars";
import { TYPES } from "@skech/core/chain";
import type { Address, Hex } from "viem";
import { type ChainClient, Reverted } from "./chain";
import type { Config } from "./config";
import type { Engine } from "./engine";
import { type Band, type LiveBet, type PostedBar, predictSettle } from "./predict";
import { report } from "./sentry";
import { readState, writeAtomic } from "./state";

export type Settled = { betId: Hex; player: Address; hitMask: number; missMask: number; paid: bigint; owed: bigint; tx: Hex };
export type Notify = { settled: (s: Settled) => void; owed: (to: Address, value: bigint) => void; account: (player: Address) => void };

/** A bet still being settled: whose it is, its grid, and its bands not yet decided (null: not known, restored from an old state file). */
type Live = { player: Address; unit: bigint; bands: Band[] | null };
type BandJson = { second: number; lo: string; hi: string; stake: string; rung: number };
type Bar = { prevClose: bigint; high: bigint; low: bigint; close: bigint };
type State = {
  bets?: { betId: Hex; player: Address; unit: string; bands: BandJson[] }[];
  /** The old format: bets by second, bands unknown. */
  watch?: Record<string, { betId: Hex; player: Address }[]>;
  holders: Address[];
  posted: Record<string, string>;
};

export class Settler {
  /** Every bet with a band still to be decided. */
  private bets = new Map<Hex, Live>();
  /** Seconds with ink in them: the bets to settle once each is over. */
  private watching = new Map<number, Set<Hex>>();
  /** The close we posted for each second, so the next second follows on from it exactly. */
  private posted = new Map<number, bigint>();
  /** Seconds the chain already has a different bar for: posted as the chain has them, so their bets settle. */
  private adopted = new Map<number, Bar>();
  /** Posts failed in a row, and when to try again: a revert that keeps coming is not paid for every 100 ms. */
  private failures = 0;
  private retryAt = 0;
  private holders = new Set<Address>();
  private running = false;
  private sweeping = false;
  private lastSweep = 0;
  /** When each player was last sent their account after a settlement. */
  private told = new Map<Address, number>();
  /** What the state file was last written with. */
  private saved: string | null = null;
  /** The house's cut of profits, from the chain's config: what a hit is due depends on it. */
  profitFeeBps = 1000n;
  /** The least a partial redemption may pay, from the chain's config. */
  minRedeem = 10_000n;
  stats = { bars: 0, settled: 0, redeemed: 0n, collected: 0n };

  constructor(
    private readonly cfg: Config,
    private readonly engine: Engine,
    private readonly chain: ChainClient,
    private readonly notify: Notify,
    private readonly log: (s: string) => void,
    private readonly statePath: string,
  ) {
    if (cfg.revenue) this.holders.add(cfg.revenue);
    this.load();
  }

  watchers() {
    return this.watching.size;
  }

  /** A band of `betId`, as the chain placed it (its second in ms). */
  watch(betId: Hex, player: Address, unit: bigint, band: Band) {
    let bet = this.bets.get(betId);
    if (!bet) this.bets.set(betId, (bet = { player, unit, bands: [] }));
    bet.bands?.push(band);
    let at = this.watching.get(band.second);
    if (!at) this.watching.set(band.second, (at = new Set()));
    at.add(betId);
  }

  /** A second is posted: its bands are decided, whatever they did. */
  private forget(second: number) {
    for (const betId of this.watching.get(second) ?? []) {
      const bet = this.bets.get(betId);
      if (!bet) continue;
      // Known bands say at once whether the bet has seconds left; only the old format has to look.
      if (bet.bands) bet.bands = bet.bands.filter((b) => b.second !== second);
      const stillWatched = bet.bands ? bet.bands.length > 0 : [...this.watching].some(([s, ids]) => s !== second && ids.has(betId));
      if (!stillWatched) this.bets.delete(betId);
    }
    this.watching.delete(second);
  }

  owed(holder: Address) {
    this.holders.add(holder);
  }

  start() {
    setInterval(() => void this.tick(), 100);
    setInterval(() => this.save(), 5_000);
  }

  /** Post every second that is over and has ink in it, oldest first, a few at a time. */
  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.engine.now();
      const due = [...this.watching.keys()].filter((s) => s + 1000 + CLOSE_AFTER_MS <= now).sort((a, b) => a - b).slice(0, 8);
      if (due.length && this.engine.ready() && Date.now() >= this.retryAt) {
        try {
          await this.post(due);
          this.failures = 0;
        } catch (e) {
          // Backing off, doubling up to thirty seconds; and a bar the chain disagrees with is taken as the chain has it.
          this.failures++;
          const wait = Math.min(30_000, 100 * 2 ** Math.min(this.failures, 9));
          this.retryAt = Date.now() + wait;
          this.log(`settle ${due.join(",")}: ${String((e as Error).message ?? e).split("\n")[0]}; again in ${wait} ms`);
          report("settle", e);
          await this.mend(due, e);
        }
      }
      // Paying off IOUs and collecting fees takes a few transactions, and settling waits behind it: sweep when no
      // second is about to be due, so a win is never held up by it. A player who never stops drawing still gets one
      // every few sweeps' time.
      const soon = [...this.watching.keys()].some((s) => s + 1000 + CLOSE_AFTER_MS <= now + 1500);
      const since = Date.now() - this.lastSweep;
      if (since > this.cfg.sweepEveryMs && (!soon || since > 4 * this.cfg.sweepEveryMs)) {
        this.lastSweep = Date.now();
        await this.sweep();
      }
    } catch (e) {
      this.log(`settle: ${String((e as Error).message ?? e).split("\n")[0]}`);
      report("settle", e);
    } finally {
      this.running = false;
    }
  }

  private async post(seconds: number[]) {
    const bars: { market: number; second: bigint; prevClose: bigint; high: bigint; low: bigint; close: bigint }[] = [];
    const sigs: Hex[] = [];
    const bets = new Map<Hex, Address>();
    for (const second of seconds) {
      const b = this.engine.book.at(second);
      const theirs = this.adopted.get(second);
      if (!b && !theirs) {
        // Not in our book: the relayer came up after that second. Its bets stay live until the engine's history has it.
        if (this.engine.book.bars[0] && this.engine.book.bars[0].t > second) {
          this.log(`settle: no bar for ${second}; the second is before this relayer's history, dropping its watch`);
          this.forget(second);
        }
        continue;
      }
      // The second before's close: as this batch posts it, as the chain has it if we posted it, otherwise as our book has it now.
      let prevClose = bars.at(-1)?.second === BigInt(second - 1000) ? bars.at(-1)!.close : this.posted.get(second - 1000);
      if (prevClose === undefined && !theirs) {
        const onChain = await this.chain.barAt(this.cfg.market, BigInt(second - 1000)).then((r) => r[3]).catch(() => 0n);
        prevClose = onChain > 0n ? onChain : BigInt(Math.round((this.engine.book.at(second - 1000)?.c ?? b!.c) * 1e8));
      }
      const bar = theirs
        ? { market: this.cfg.market, second: BigInt(second), ...theirs }
        : { market: this.cfg.market, second: BigInt(second), prevClose: prevClose!, high: BigInt(Math.round(b!.h * 1e8)), low: BigInt(Math.round(b!.l * 1e8)), close: BigInt(Math.round(b!.c * 1e8)) };
      bars.push(bar);
      sigs.push(await this.chain.wallet.signTypedData({ domain: { name: "skech", version: "1", chainId: this.cfg.chainId, verifyingContract: this.cfg.game }, types: TYPES, primaryType: "Bar", message: bar }));
      for (const betId of this.watching.get(second) ?? []) bets.set(betId, this.bets.get(betId)?.player ?? ("0x" as Address));
    }
    if (!bars.length) return;
    const ids = [...bets.keys()];
    // What will happen, exactly: which bets pay, and which the pool cannot cover. The gas is for that.
    const posting = new Map<number, PostedBar>(bars.map((b) => [Number(b.second), { second: Number(b.second), prevClose: b.prevClose, high: b.high, low: b.low }]));
    const live: LiveBet[] = ids.map((betId) => {
      const bet = this.bets.get(betId);
      return { betId, unit: bet?.unit ?? 0n, bands: bet?.bands ?? null };
    });
    const ledger = this.chain.ledger;
    const will = predictSettle(live, posting, ledger.pool, this.profitFeeBps);
    const receipt = await this.chain.send(
      bars.length === 1 ? "postBarAndSettle" : "postBarsAndSettle",
      bars.length === 1 ? [bars[0], sigs[0], ids] : [bars, sigs, ids],
      `bar ${bars.map((b) => b.second).join(",")} + settle ${ids.length}`,
      { kind: "settle", bars: bars.length, bets: ids.length, liveSections: will.liveSections, hits: will.hits, ious: will.ious, coldFees: ledger.coldFees },
    );
    for (const bar of bars) {
      this.posted.set(Number(bar.second), bar.close);
      this.adopted.delete(Number(bar.second));
      this.forget(Number(bar.second));
      this.stats.bars++;
    }
    if (this.posted.size > 4000) for (const k of [...this.posted.keys()].sort((a, b) => a - b).slice(0, 1000)) this.posted.delete(k);
    const touched = new Set<Address>();
    for (const ev of this.chain.events(receipt)) {
      if (ev.name === "Settled") {
        const a = ev.args as { betId: Hex; player: Address; hitMask: number; missMask: number; paid: bigint; owed: bigint; fee: bigint };
        this.stats.settled++;
        // The stake left the balance when the piece went in: only a payout changes it now. Without one, the chain's
        // figure is still sent now and then, so what the app counts for itself never drifts for long.
        const k = a.player.toLowerCase() as Address;
        if (a.paid > 0n || a.owed > 0n || Date.now() - (this.told.get(k) ?? 0) > 5_000) touched.add(a.player);
        this.notify.settled({ betId: a.betId, player: a.player, hitMask: Number(a.hitMask), missMask: Number(a.missMask), paid: a.paid, owed: a.owed, tx: receipt.transactionHash });
      } else if (ev.name === "Owed") {
        const a = ev.args as { to: Address; value: bigint };
        this.holders.add(a.to);
        this.notify.owed(a.to, a.value);
      }
    }
    for (const p of touched) {
      this.told.set(p.toLowerCase() as Address, Date.now());
      this.notify.account(p);
    }
    if (this.told.size > 5_000) this.told.clear();
  }

  /**
   * After a post reverted. A bar the chain already has, different from ours (BarConflict), or one that does not
   * follow on from the chain's second before (BarDiscontinuous), would revert every time it is sent: the chain's
   * own bars are read instead, and posted as they are. Anything else (paused, say) is waited out.
   */
  private async mend(seconds: number[], e: unknown) {
    const why = e instanceof Reverted ? e.why : null;
    if (why !== "BarConflict" && why !== "BarDiscontinuous") return;
    for (const second of seconds) {
      this.posted.delete(second - 1000);
      const [prevClose, high, low, close] = await this.chain.barAt(this.cfg.market, BigInt(second)).catch(() => [0n, 0n, 0n, 0n]);
      if (close > 0n) this.adopted.set(second, { prevClose, high, low, close });
    }
    this.log(`settle: ${why} on ${seconds.join(",")}; posting the chain's own bars`);
  }

  /** Pay off what is owed, as far as the pool goes, and move the fees out. */
  private async sweep() {
    if (this.sweeping || !this.cfg.iou) return;
    this.sweeping = true;
    try {
      let pool = await this.chain.pool();
      for (const holder of this.holders) {
        if (pool === 0n) break;
        const shares = await this.chain.iouBalance(holder).catch(() => 0n);
        if (shares === 0n) {
          if (holder !== this.cfg.revenue) this.holders.delete(holder);
          continue;
        }
        const value = await this.chain.iouAssets(holder).catch(() => 0n);
        // A partial redemption must be worth the chain's minimum; a full one always goes.
        if (value > pool && pool < this.minRedeem) continue;
        const receipt = await this.chain.send("redeem", [holder, shares], `redeem ${holder}`, { kind: "redeem" });
        for (const ev of this.chain.events(receipt)) if (ev.name === "Redeemed") this.stats.redeemed += (ev.args as { value: bigint }).value;
        this.notify.account(holder);
        pool = await this.chain.pool();
      }
      const fees = await this.chain.fees();
      if (fees >= this.cfg.collectAboveE6) {
        await this.chain.send("collectFees", [], `collect ${fees} fees`);
        this.stats.collected += fees;
      }
    } catch (e) {
      this.log(`sweep: ${String((e as Error).message ?? e).split("\n")[0]}`);
      report("sweep", e);
    } finally {
      this.sweeping = false;
    }
  }

  /* ---- what survives a restart: the seconds still to settle, who is owed, what we posted ---- */

  /** A file that is there but cannot be read stops the relayer here (state.ts): nothing owed is written over. */
  private load() {
    const s = readState<State>(this.statePath);
    if (!s) return;
    try {
      for (const b of s.bets ?? []) {
        for (const band of b.bands) this.watch(b.betId, b.player, BigInt(b.unit), { second: band.second, lo: BigInt(band.lo), hi: BigInt(band.hi), stake: BigInt(band.stake), rung: band.rung });
      }
      // The old format knew the seconds, not the bands: settle those assuming the worst.
      for (const [second, list] of Object.entries(s.watch ?? {})) {
        for (const w of list) {
          if (!this.bets.has(w.betId)) this.bets.set(w.betId, { player: w.player, unit: 0n, bands: null });
          let at = this.watching.get(Number(second));
          if (!at) this.watching.set(Number(second), (at = new Set()));
          at.add(w.betId);
        }
      }
      for (const h of s.holders) this.holders.add(h);
      for (const [second, close] of Object.entries(s.posted)) this.posted.set(Number(second), BigInt(close));
      this.log(`settle: restored ${this.watching.size} seconds to settle and ${this.holders.size} IOU holders`);
    } catch (e) {
      throw new Error(`${this.statePath} is not state this relayer can restore (${String((e as Error).message ?? e)}): restore it, or move it aside to start without it`);
    }
  }

  save() {
    const s: State = { bets: [], watch: {}, holders: [...this.holders], posted: {} };
    for (const [betId, bet] of this.bets) {
      if (bet.bands) s.bets!.push({ betId, player: bet.player, unit: bet.unit.toString(), bands: bet.bands.map((b) => ({ second: b.second, lo: b.lo.toString(), hi: b.hi.toString(), stake: b.stake.toString(), rung: b.rung })) });
    }
    for (const [second, ids] of this.watching) {
      const unknown = [...ids].filter((id) => this.bets.get(id)?.bands === null);
      if (unknown.length) s.watch![second] = unknown.map((betId) => ({ betId, player: this.bets.get(betId)!.player }));
    }
    for (const [second, close] of [...this.posted].slice(-600)) s.posted[second] = close.toString();
    // Written only when it changed: an idle relayer does not fsync the same file every five seconds.
    const text = JSON.stringify(s);
    if (text === this.saved) return;
    try {
      writeAtomic(this.statePath, text);
      this.saved = text;
    } catch (e) {
      this.log(`settle: could not write ${this.statePath}: ${String(e)}`);
      report("state-write", e);
    }
  }
}

