/**
 * What settling will do, worked out before sending, with the contract's own
 * integer arithmetic: which bands hit, what each bet is due, and who the pool
 * cannot pay and so is owed in IOUs. The settler posts the very bar it settles
 * against and knows every band from the chain's own Placed events, so this is
 * exact, and the gas limit (gas.ts) is charged for what will run, not for the
 * worst that could.
 *
 * Mirrors `_settle` and `_pay` in SkechGame.sol.
 */
import type { Hex } from "viem";

/** A band as placed: its second (ms), its edges and stake (e8, e6), its rung (x100). */
export type Band = { second: number; lo: bigint; hi: bigint; stake: bigint; rung: number };
/** A bet's live bands, or `null` when they are not known (restored from an old state file): then assume the worst. */
export type LiveBet = { betId: Hex; unit: bigint; bands: Band[] | null };
export type PostedBar = { second: number; prevClose: bigint; high: bigint; low: bigint };

export const BPS = 10_000n;

/** Whether the price covered a band in its second: from the second before's close to this one's high and low, one unit wider each way. */
export function hits(band: Band, unit: bigint, bar: PostedBar): boolean {
  const high = bar.high > bar.prevClose ? bar.high : bar.prevClose;
  const low = bar.low < bar.prevClose ? bar.low : bar.prevClose;
  return high + unit >= band.lo && low <= band.hi + unit;
}

export type Prediction = {
  /** Bets that pay out. */
  hits: number;
  /** Bets the pool cannot pay the player in full: the player is minted IOUs. */
  ious: number;
  /** Every live band of every bet sent: what settling reads. */
  liveSections: number;
  /** Per paying bet: what it is due, and the house's cut of the profit. */
  due: Map<Hex, { gross: bigint; fee: bigint }>;
  /** The pool after, if it was `pool` before and nothing else touched it. */
  poolAfter: bigint | null;
};

/**
 * Settle `bets` in order on `bars` (the seconds being posted now). `pool` is
 * what the pool holds, or null when it is not known: then every paying bet may
 * be owed.
 */
export function predictSettle(bets: LiveBet[], bars: Map<number, PostedBar>, pool: bigint | null, profitFeeBps: bigint): Prediction {
  let left = pool;
  let hitCount = 0;
  let ious = 0;
  let liveSections = 0;
  const due = new Map<Hex, { gross: bigint; fee: bigint }>();
  for (const bet of bets) {
    if (bet.bands === null) {
      // Unknown: one band read, taken to hit, taken to be owed.
      liveSections += 1;
      hitCount++;
      ious++;
      left = 0n;
      continue;
    }
    liveSections += bet.bands.length;
    let gross = 0n;
    let stakeHit = 0n;
    for (const band of bet.bands) {
      const bar = bars.get(band.second);
      if (!bar || !hits(band, bet.unit, bar)) continue;
      stakeHit += band.stake;
      gross += (band.stake * BigInt(band.rung)) / 100n;
    }
    if (gross === 0n) continue;
    hitCount++;
    // Rounded up, as the contract takes it.
    const fee = ((gross - stakeHit) * profitFeeBps + BPS - 1n) / BPS;
    due.set(bet.betId, { gross, fee });
    // The player first, then the house's cut, both out of the pool. What it cannot pay the player is owed; the
    // house's cut is only what it has left.
    if (left === null || left < gross - fee) {
      ious++;
      left = left === null ? null : 0n;
    } else {
      left -= gross - fee;
      left -= left < fee ? left : fee;
    }
  }
  return { hits: hitCount, ious, liveSections, due, poolAfter: left };
}

