import { beforeAll, expect, test } from "bun:test";
import { type Bar, type Library, features, field, openFor, readLibrary, RULES, stepFor } from "./dots";
import { CELL, cellsOf, chances, cost, crossSection, hitShare, judge, open, openOn, PEN_CELLS, place, quote, quoteOn, refund, type Stroke, won } from "./ink";
import { RULES as HOUSE } from "./dots";

// These test how the game works, not how hard it is: they are written for the house's terms at 0.85 and 50x.
beforeAll(() => Object.assign(HOUSE, { rtp: 0.85, maxMultiple: 50, minMultiple: 1.01, momentumMargin: 0.11 }));

/** Paths that all do the same thing: each second's close, in volatilities; `share` of them do it, the rest stay put. */
function lib(n: number, closes: number[], share: number, lnSigma: number): Library {
  const seconds = closes.length + 1;
  const l: Library = { n, seconds, lnSigma: new Float32Array(n).fill(lnSigma), momentum: new Float32Array(n), wick: new Float32Array(n).fill(0.15), close: new Int16Array(n * seconds), up: new Uint8Array(n * seconds), down: new Uint8Array(n * seconds) };
  for (let i = 0; i < Math.round(n * share); i++) closes.forEach((c, j) => (l.close[i * seconds + j + 1] = Math.round(c * 100)));
  return l;
}
function history(price: number): { bars: Bar[]; at: number } {
  const t0 = 1_800_000_000_000;
  const bars: Bar[] = Array.from({ length: 320 }, (_, s) => {
    const c = price + (s % 2 ? 0.5 : -0.5);
    return { t: t0 + s * 1000, h: c + 0.2, l: c - 0.2, c };
  });
  return { bars, at: t0 + 320 * 1000 };
}
const line = (t0: number, p0: number, pts: [number, number][], rt = 200, rp = 1): Stroke => ({ t0, p0, pts: pts.map(([t, p]) => ({ t, p })), rt, rp });

test("the ink at an instant is the pen's height there, as ranges", () => {
  const st = line(0, 100, [[0, 0], [10_000, 0]], 200, 2);
  expect(crossSection(st, 5000)).toEqual([[98, 102]]);
  expect(crossSection(st, 20_000)).toEqual([]);
});

test("a line is a point for every row it passes through, each second, once", () => {
  const openAt = 1_000_000;
  // Level at 100.2 from second 2 to second 6, on rows half a dollar tall: one point a second, in the row from 100 to 100.5.
  const level = cellsOf(line(openAt + 2000, 100.2, [[0, 0], [4000, 0]]), openAt, 1, 0.5);
  expect(level.map((s) => [(s.t - openAt) / 1000, s.lo, s.hi, s.area])).toEqual([2, 3, 4, 5, 6].map((j) => [j, 100, 100.5, 1]));
  // Straight up from 99.2 to 101.2 inside second 3: every row it crosses, from 99 to 101, is a point.
  const up = cellsOf(line(openAt + 3100, 99.2, [[0, 0], [500, 2]]), openAt, 1, 0.5);
  expect(up.map((s) => s.lo)).toEqual([99, 99.5, 100, 100.5, 101]);
  expect(new Set(up.map((s) => s.t))).toEqual(new Set([openAt + 3000]));
  // Back over the same row in the same second is the same point, not a second one.
  expect(cellsOf(line(openAt + 3100, 100.2, [[0, 0], [300, 0.1], [600, 0]]), openAt, 1, 0.5)).toHaveLength(1);
  // The second it opens in is never part of it.
  expect(cellsOf(line(openAt + 200, 100.2, [[0, 0]]), openAt, 1, 0.5)).toHaveLength(0);
});

test("a point costs what a point costs, and a hit pays that times its multiple", () => {
  const { bars, at } = history(84_000);
  const f = features(bars, at)!;
  const unit = f.sigma * f.price;
  const step = stepFor(f.sigma, f.price);
  // Half the paths reach two volatilities up by second 2 and stay there.
  const l = lib(2000, [1, 2, 2, 2, 2, 2], 0.5, Math.log(f.sigma));
  let bet = place(line(at + 2000, f.price + 2 * unit, [[0, 0], [3000, 0]]), 0.25, step, at - 400, "flat", 1)!;
  expect(cost(bet)).toBeCloseTo(0.25 * bet.drawn.length, 9);
  bet = open(bet, l, bars);
  const first = bet.cells[0];
  bet = judge(bet, { t: first.t, h: first.lo + 0.01, l: f.price, c: f.price }, true);
  expect(bet.cells[0].status).toBe("hit");
  expect(bet.cells[0].paid).toBe(Math.floor(0.25 * first.multiple * 100) / 100);
});

test("a cell's chance is the share of like paths whose second reaches it", () => {
  const { bars, at } = history(84_000);
  const f = features(bars, at)!;
  // A tenth of the paths are three volatilities up by second 2 and stay there.
  const l = lib(2000, [1.5, 3, 3, 3, 3], 0.1, Math.log(f.sigma));
  const unit = f.sigma * f.price;
  const st = line(at + 2000, f.price + 3 * unit, [[0, 0], [3000, 0]], 1, unit * 0.1);
  const cells = cellsOf(st, at, stepFor(f.sigma, f.price));
  for (const p of chances(l, cells, at, f)) expect(p).toBeCloseTo(0.1, 2);
});

test("only the ink the price runs through pays: a tall stroke crossed at one point pays for that point", () => {
  const { bars, at } = history(84_000);
  const f = features(bars, at)!;
  const unit = f.sigma * f.price;
  // Half the paths run from two to six volatilities up in second 2; ink stands from the price to eight up, several rows of 2.5.
  const l = lib(2000, [2, 6, 6, 6], 0.5, Math.log(f.sigma));
  const step = stepFor(f.sigma, f.price);
  let bet = place(line(at + 2000, f.price + 3.5 * unit, [[0, -3.5 * unit], [0, 4.5 * unit]], 60, unit * 0.3), 0.5, step, at - 400, "tall")!;
  bet = open(bet, l, bars);
  expect(bet.status).toBe("live");
  const inSecond = bet.cells.filter((s) => s.t === at + 2000);
  expect(inSecond.length).toBeGreaterThanOrEqual(3);
  // The second's trades run from the price to half a volatility up: only the cells there are hit.
  bet = judge(bet, { t: at + 2000, h: f.price + 0.5 * unit, l: f.price - 0.1, c: f.price }, true);
  const hit = bet.cells.filter((s) => s.status === "hit");
  expect(hit.length).toBeGreaterThan(0);
  expect(hit.length).toBeLessThan(inSecond.length);
  for (const s of hit) expect(s.lo).toBeLessThanOrEqual(f.price + 0.5 * unit);
  expect(won(bet)).toBeCloseTo(hit.reduce((a, s) => a + Math.floor(0.5 * s.area * s.multiple * 100) / 100, 0), 2);
  expect(bet.status).toBe("done");
  expect(hitShare(bet)).toBeLessThan(0.6);
  expect(cost(bet)).toBeGreaterThan(0);
  expect(refund(bet)).toBeGreaterThanOrEqual(0);
});

test("ink too near the price to pay anything is not in play, and costs nothing", () => {
  const { bars, at } = history(84_000);
  const f = features(bars, at)!;
  const l = lib(2000, Array(RULES.horizon).fill(0), 1, Math.log(f.sigma)); // the price never moves
  const bet = open(place(line(at + 2000, f.price, [[0, 0], [2000, 0]], 1, 1), 1, stepFor(f.sigma, f.price), at - 100, "v")!, l, bars);
  expect(bet.status).toBe("void");
  expect(refund(bet)).toBe(cost(bet));
});

test("the preview read off the map pays what the drawing is priced at, for every pen", async () => {
  // The real paths, on a market like a quiet afternoon, and a wandering stroke up and away from the price.
  const real = readLibrary(new Uint8Array(await Bun.file(new URL("./dots-lib.bin", import.meta.url)).arrayBuffer()));
  const { bars, at } = history(84_000);
  const f = features(bars, at)!;
  const step = stepFor(f.sigma, f.price);
  const unit = f.sigma * f.price;
  const now = at - 400;
  for (const cell of Object.values(PEN_CELLS)) {
    const st = line(at + 3000, f.price + unit, [[0, 0], [4000, 2 * unit], [9000, -unit], [14000, 3 * unit]], 150, (cell * step) / 2);
    const exact = quote(real, st, now, step, f, cell);
    const fast = quoteOn(field(real, f, at, step * cell, cell), st, now, step, cell);
    expect(fast.cells).toEqual(exact.cells);
    const both = exact.multiples.map((m, i) => [m, fast.multiples[i]] as const).filter(([a, b]) => a !== null && b !== null);
    expect(both.length).toBeGreaterThan(exact.cells.length / 2);
    // Rounded the same way from nearly the same chance: within a step of rounding either way.
    for (const [a, b] of both) expect(Math.abs(Math.log(a! / b!))).toBeLessThan(0.06);
  }
});

test("a drawing priced off its second's map is priced exactly as off the paths", async () => {
  const real = readLibrary(new Uint8Array(await Bun.file(new URL("./dots-lib.bin", import.meta.url)).arrayBuffer()));
  const { bars, at } = history(84_000);
  const f = features(bars, at)!;
  const step = stepFor(f.sigma, f.price);
  const unit = f.sigma * f.price;
  for (const cell of Object.values(PEN_CELLS)) {
    const st = line(at + 3000, f.price + unit, [[0, 0], [4000, 2 * unit], [9000, -unit], [14000, 3 * unit]], 150, (cell * step) / 2);
    const bet = place(st, 0.25, step, at - 400, "same", cell)!;
    const exact = open(bet, real, bars);
    const fast = openOn(bet, field(real, f, at, step * cell, cell))!;
    expect(fast.cells.map(({ chance: _, ...c }) => c)).toEqual(exact.cells.map(({ chance: _, ...c }) => c));
    // A map of another second, or of another pen, is not used.
    expect(openOn(bet, field(real, f, at + 1000, step * cell))).toBeNull();
    expect(openOn(bet, field(real, f, at, step * cell * 2))).toBeNull();
  }
});

test("a jump from one second's last trade across a row to the next second's trades crosses it", () => {
  const row = { t: 5000, lo: 100, hi: 100.5, area: 1, multiple: 4, status: "live" as const };
  const bet = { id: "gap", placedAt: 0, openAt: 3000, perUnit: 0.25, step: 1, cell: 0.5, stroke: line(0, 100, [[0, 0]]), drawn: [row], cells: [row], status: "live" as const };
  // The second before closed under the row, and every trade of this one was above it: the price went through it.
  const bar = { t: 5000, h: 101.5, l: 100.6, c: 101.5 };
  expect(judge(bet, bar, true).cells[0].status).toBe("miss");
  const hit = judge(bet, bar, true, 99.9);
  expect(hit.cells[0].status).toBe("hit");
  expect(hit.cells[0].paid).toBe(1);
  expect(hit.cells[0].range).toEqual([99.9, 101.5]);
});
