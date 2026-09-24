/**
 * A formula for the odds, fitted and backtested, and not used: see
 * docs/HOW-IT-WORKS.md, "Why the chance is measured". Kept so the
 * result can be reproduced; the game prices on measured chances
 * (`src/odds.ts`).
 *
 * A point is a row of prices, `lo` to `hi`, during one second, `j` seconds
 * after a drawing opens. The price is measured in volatilities from where it
 * stood when the drawing opened: `z = ln(price / now) / sigma`, where
 * `sigma` is the market's one-second volatility (`dots.ts`, read on
 * five-second moves). In those units:
 *
 *   where it is by the start of the second    X ~ Normal(mu * j, v^2 * j)
 *     mu = drift * momentum                   (the last three seconds' move)
 *   a point it is not already in is touched   2 * Phi(-gap / s)
 *     within the second, if it is `gap` away  (the reflection principle)
 *     s  = v * (swing0 + swing1 * wick)       (how far a second swings, from
 *                                              how far they have lately)
 *   and every so often the market jumps:      a share `tail` of the time,
 *                                              all of the above with v * tailVol
 *   but often it has not moved at all:        stays = exp(-k * j^shape),
 *     Bitcoin trades on a tick, and in a       k = stay0 * (sigma / 5e-5)^stay1
 *     quiet market it sits on one for seconds   (the row it is in is hit;
 *                                              no other is)
 *
 *   moved  = integral over X of  1                          if lo <= X < hi
 *                                2 * Phi(-gap(X) / s)       otherwise
 *   chance = stays * [lo <= now < hi] + (1 - stays) * moved
 *
 *   multiple = rtp / chance, rounded down; not offered under 1.01x or over 50x
 *
 * `rtp` is the share of a stake a point returns on average, and less on the
 * side the market just moved towards (`rtpAt` in `dots.ts`); the house keeps
 * the rest. The constants in `ODDS` are fitted to 16,000 real thirty-second
 * stretches of Binance BTCUSDT (`scripts/fit-odds.ts`), and what they come to
 * is checked on days the fit never saw (`scripts/check-ink.ts`).
 */

import type { Features, Field } from "../src/dots";

export const ODDS = {
  /** The spread of the price, per square-root second, in volatilities. */
  v: 0.7385,
  /** How far the price reaches inside a second beyond where it opens and closes it: a base, and how much of the lately measured swing to add. */
  swing0: 0.3778,
  swing1: 0.0475,
  /** Volatilities a second of drift, per unit of momentum. */
  drift: 0.0476,
  /** How often the market is in a jump, and how much wider it is then. */
  tail: 0.428,
  tailVol: 5.807,
  /** How fast a market that has not moved starts to: the chance it still has not by second j is exp(-stay0 * (sigma / 5e-5)^stay1 * j^stayShape). A busier market leaves its tick sooner. */
  stay0: 0.3445,
  stay1: 0.267,
  stayShape: 0.4363,
};
export type Odds = typeof ODDS;

/** A middling one-second volatility, the one `stay1` is measured against. */
const SIGMA_REF = 5e-5;

/** The standard normal's cumulative: Abramowitz and Stegun 7.1.26, good to 1.5e-7. */
export function Phi(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Points the integral is taken at: Simpson's rule over six spreads either side. */
const N = 64;

/** One regime of the market: where the price may be by second `j`, and how likely each place is to reach the row within the second. */
function touchOne(a: number, b: number, j: number, mu: number, v: number, s: number): number {
  const mean = mu * j;
  const sd = v * Math.sqrt(j);
  const from = mean - 6 * sd;
  const h = (12 * sd) / N;
  let sum = 0;
  for (let k = 0; k <= N; k++) {
    const x = from + k * h;
    const u = (x - mean) / sd;
    const density = Math.exp(-0.5 * u * u);
    const gap = x < a ? a - x : x >= b ? x - b : 0;
    const reach = gap === 0 ? 1 : 2 * Phi(-gap / s);
    sum += (k === 0 || k === N ? 1 : k % 2 ? 4 : 2) * density * Math.min(1, reach);
  }
  return (sum * h) / 3 / (sd * Math.sqrt(2 * Math.PI));
}

/**
 * The chance the price trades in a row of prices during second `j` of a
 * drawing opened on `f`: `lo` to `hi` in dollars. The equation above.
 */
export function touch(f: Features, j: number, lo: number, hi: number, o: Odds = ODDS): number {
  const a = Math.log(lo / f.price) / f.sigma;
  const b = Math.log(hi / f.price) / f.sigma;
  const mu = o.drift * f.momentum;
  const s = o.v * (o.swing0 + o.swing1 * f.wick);
  const calm = touchOne(a, b, j, mu, o.v, s);
  const moved = o.tail > 0 ? (1 - o.tail) * calm + o.tail * touchOne(a, b, j, mu, o.v * o.tailVol, s * o.tailVol) : calm;
  const stays = Math.exp(-o.stay0 * (f.sigma / SIGMA_REF) ** o.stay1 * j ** o.stayShape);
  // The row the price is in now, by the same rule as everywhere: a price on a line is in the row above.
  const inIt = lo <= f.price && f.price < hi ? 1 : 0;
  return stays * inIt + (1 - stays) * moved;
}

/**
 * The whole map for a drawing opening at `openAt`: every row of `step`
 * dollars, for every second to the horizon, by the equation. The same shape
 * as a field measured on paths, so everything that reads one reads this.
 */
export function oddsField(f: Features, openAt: number, step: number, seconds = 30, o: Odds = ODDS): Field {
  const reach = Math.min(150, Math.ceil((8 * f.sigma * f.price * Math.sqrt(seconds)) / step));
  const here = Math.floor(f.price / step);
  const row0 = here - reach;
  const rows = reach * 2 + 1;
  const chance = new Float32Array(seconds * rows);
  for (let j = 1; j <= seconds; j++)
    for (let r = 0; r < rows; r++) {
      const lo = (row0 + r) * step;
      chance[(j - 1) * rows + r] = touch(f, j, lo, lo + step, o);
    }
  return { openAt, step, row0, rows, seconds, chance, rtp: 0, f, paths: Number.POSITIVE_INFINITY };
}

