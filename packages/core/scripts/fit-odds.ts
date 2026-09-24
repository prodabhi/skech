import { type Features, field, readLibrary, stepFor } from "../src/dots";
import { ODDS, type Odds, touch } from "./odds-formula";
/*
  Fit the constants of the odds formula (`odds-formula.ts`, not used by the game) to what really
  happened: the chances measured on 16,000 real thirty-second stretches of
  Binance BTCUSDT (1-16 September), for markets like the ones the paths
  started in, for rows as tall as each pen's.

    bun packages/core/scripts/fit-odds.ts packages/core/src/dots-lib.bin

  The error is in log multiples, so a point priced at 20x and worth 22x
  counts the same as one at 2x worth 2.2x; and paying more than a point is
  worth counts twice as much as paying less, because that is the house's
  money. Prints the constants to paste into `ODDS`, and how far off they are.
*/

const lib = readLibrary(new Uint8Array(await Bun.file(process.argv[2]).arrayBuffer()));
let seed = 3;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

type Sample = { f: Features; j: number; lo: number; hi: number; p: number };
const samples: Sample[] = [];
const STATES = Number(process.env.STATES ?? 80);
const price = 84_000;
for (let k = 0; k < STATES; k++) {
  // A market the paths really started in: its volatility, momentum and swing.
  const i = Math.floor(rand() * lib.n);
  const f: Features = { price, sigma: Math.exp(lib.lnSigma[i]), momentum: lib.momentum[i], wick: lib.wick[i] };
  const step = stepFor(f.sigma, price);
  for (const cell of [0.4, 0.7, 1]) {
    const size = step * cell;
    const fl = field(lib, f, 0, size);
    for (const j of [1, 2, 3, 4, 6, 8, 11, 15, 20, 26]) {
      if (j > fl.seconds) continue;
      for (let r = 0; r < fl.rows; r += 1 + Math.floor(rand() * 2)) {
        const p = fl.chance[(j - 1) * fl.rows + r];
        // Only points that are offered: between 1.01x and 50x at the return the game pays.
        if (p < 0.85 / 50 || p > 0.85 / 1.01) continue;
        const lo = (fl.row0 + r) * size;
        samples.push({ f, j, lo, hi: lo + size, p });
      }
    }
  }
}
console.log(`${samples.length} points from ${STATES} markets`);

const KEYS = ["v", "swing0", "swing1", "drift", "tail", "tailVol", "stay0", "stay1", "stayShape"] as const;
const toOdds = (x: number[]): Odds => Object.fromEntries(KEYS.map((k, i) => [k, x[i]])) as Odds;
const loss = (x: number[]) => {
  const o = toOdds(x);
  if (o.v <= 0.2 || o.swing0 < 0 || o.swing1 < 0 || o.tail < 0 || o.tail > 0.5 || o.tailVol < 1 || o.stay0 < 0 || o.stayShape < 0.2 || o.stayShape > 2) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (const s of samples) {
    const m = touch(s.f, s.j, s.lo, s.hi, o);
    if (!(m > 0)) return Number.POSITIVE_INFINITY;
    const e = Math.log(s.p / m); // above zero: the equation says less likely than it is, so it pays too much
    sum += (e > 0 ? 2 : 1) * e * e;
  }
  return sum / samples.length;
};

// Nelder-Mead, from the constants as they stand.
function minimise(start: number[], iters: number): number[] {
  const n = start.length;
  let pts = [start, ...start.map((_, d) => start.map((v, k) => (k === d ? v * 1.3 + 0.05 : v)))];
  let vals = pts.map(loss);
  for (let it = 0; it < iters; it++) {
    const order = vals.map((v, k) => [v, k] as const).sort((a, b) => a[0] - b[0]).map(([, k]) => k);
    pts = order.map((k) => pts[k]);
    vals = order.map((k) => vals[k]);
    const c = Array.from({ length: n }, (_, d) => pts.slice(0, n).reduce((s, q) => s + q[d], 0) / n);
    const at = (t: number) => c.map((v, d) => v + t * (pts[n][d] - v));
    const r = at(-1);
    const fr = loss(r);
    if (fr < vals[0]) {
      const e = at(-2);
      const fe = loss(e);
      [pts[n], vals[n]] = fe < fr ? [e, fe] : [r, fr];
    } else if (fr < vals[n - 1]) [pts[n], vals[n]] = [r, fr];
    else {
      const k = at(0.5);
      const fk = loss(k);
      if (fk < vals[n]) [pts[n], vals[n]] = [k, fk];
      else {
        pts = pts.map((q, i) => (i === 0 ? q : q.map((v, d) => pts[0][d] + 0.5 * (v - pts[0][d]))));
        vals = pts.map(loss);
      }
    }
    if (it % 50 === 0) console.log(`  ${it}: ${vals[0].toFixed(5)}`);
  }
  return pts[vals.indexOf(Math.min(...vals))];
}

const start = process.env.FROM ? (JSON.parse(process.env.FROM) as number[]) : KEYS.map((k) => ODDS[k]);
start[4] = Math.max(start[4], 0.05);
const best = minimise(start, Number(process.env.ITERS ?? 400));
const o = toOdds(best);
console.log("\nODDS =", JSON.stringify(Object.fromEntries(KEYS.map((k) => [k, Math.round(o[k] * 10000) / 10000]))));

// How far off, by how likely a point is: the median error, and how often it pays more than the point is worth.
const buckets = new Map<string, number[]>();
for (const s of samples) {
  const e = Math.log(s.p / touch(s.f, s.j, s.lo, s.hi, o));
  const m = 0.85 / s.p;
  const k = m < 2 ? "a  1-2x" : m < 5 ? "b  2-5x" : m < 15 ? "c  5-15x" : m < 40 ? "d  15-40x" : "e  40-50x";
  (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(e);
}
console.log("\n  points by what they pay   n      mean error   overpaid by >10%");
for (const [k, es] of [...buckets].sort()) {
  const mean = es.reduce((a, b) => a + b, 0) / es.length;
  console.log(`  ${k.padEnd(22)}${String(es.length).padStart(7)}${((Math.exp(mean) - 1) * 100).toFixed(1).padStart(12)}%${((100 * es.filter((e) => e > Math.log(1.1)).length) / es.length).toFixed(0).padStart(14)}%`);
}
