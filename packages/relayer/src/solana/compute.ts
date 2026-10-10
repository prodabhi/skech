/**
 * What a settlement costs in compute, from what the program does for it: the instruction itself (with the bar, or
 * without), then for each bet a fixed part, a part for every band it has (each is read, decided or not) and a part
 * for every band decided in this second, and for each player whose SKT account it opens, that. Measured part by part
 * in LiteSVM (`limits.rs` `settle_costs`, into `snapshots/compute.json`), and budgeted as their sum with a margin:
 * a second full of bands is budgeted for its bands, not only for its bets.
 */

/** The most compute one transaction may ask for. */
export const MAX_CU = 1_400_000;
/** What is asked for over the sum of the parts: a quarter more, and a little for the compute-budget instructions. */
const margin = (cu: number) => Math.ceil(cu * 1.25) + 5_000;

/** One bet in a settlement: the bands it has on chain, those this second decides, and its player's holder bump if
 * the settlement may open their holder (null: it is open already, or this program has none). */
export type BetLoad = { sections: number; decided: number; openBump?: number | null };

/** The snapshot's figures a settlement's cost is made of. Keys missing from an older snapshot count as nothing. */
export type Costs = Record<string, number>;

export function settleCompute(c: Costs, bar: boolean, bets: readonly BetLoad[]): number {
  let cu = bar ? c.post_bar : (c.settle_base ?? 4_000);
  for (const b of bets) {
    cu += (c.settle_bet ?? 0) + (c.settle_section ?? 0) * b.sections + (c.settle_decided ?? 0) * b.decided;
    // Opening a holder searches for its address's bump down from 255, as placing does for a bet's.
    if (b.openBump !== undefined && b.openBump !== null) cu += (c.holder_open ?? 0) + (c.place_per_bump ?? 0) * (255 - b.openBump);
  }
  return Math.min(MAX_CU, margin(cu));
}

/**
 * `bets` cut into settlements in order, each at most `most` bets (what a transaction's bytes hold) and at most what
 * one transaction's compute allows; the first carries the bar when `bar`. A bet too big to share a settlement goes
 * alone: it always fits, at 32 bands.
 */
export function chunksFor<T>(c: Costs, bar: boolean, bets: readonly T[], loadOf: (bet: T) => BetLoad, most: number): T[][] {
  const out: T[][] = [];
  let chunk: T[] = [];
  let loads: BetLoad[] = [];
  for (const bet of bets) {
    const load = loadOf(bet);
    const withBar = bar && out.length === 0;
    if (chunk.length && (chunk.length >= most || settleCompute(c, withBar, [...loads, load]) >= MAX_CU)) {
      out.push(chunk);
      chunk = [];
      loads = [];
    }
    chunk.push(bet);
    loads.push(load);
  }
  if (chunk.length || !out.length) out.push(chunk);
  return out;
}
