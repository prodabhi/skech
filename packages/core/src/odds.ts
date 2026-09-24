/**
 * Legacy per-row odds. The active practice game uses roundedTerms below
 * (ladder-v1); see docs/HOW-IT-WORKS.md.
 *
 * The original odds: everything the game says about a line, from one place.
 *
 * The map's labels, the pen's "10x · $2.50", the ticket while drawing, what
 * a line costs, what a hit pays, and the server's settlement once there is
 * money in it all come from `terms`. Nothing else works any of it out.
 *
 *   a row       step * PEN_CELLS[pen] dollars tall: a wider pen, taller rows
 *   a point     each second a line passes through a row, once (`cellsOf`)
 *   cost        perPoint * the points in play
 *   chance      how often the price trades in that row in that second, as
 *               measured on 16,000 real thirty-second stretches of Bitcoin
 *               from moments like this one (`field` in `dots.ts`)
 *   multiple    rtp / chance, rounded down; not offered under 1.01x or over
 *               50x. rtp is 0.85, less on the side the market just moved
 *               towards (`rtpAt`)
 *   a hit pays  perPoint * multiple, rounded down to the cent
 *   the house   keeps 1 - rtp of every point on average
 *
 * So the pen changes the multiples (a taller row is hit more often and pays
 * less), and what a point costs changes the dollars (a hit pays the point
 * times its multiple), never the multiple: if it did, a bigger bet would be
 * a worse one.
 *
 * Why the chance is measured and not a formula: one was fitted
 * (`scripts/odds-formula.ts`) and it lost on both ends. On
 * days it never saw, ordinary lines got back 0.45 to 0.75 a dollar, and a
 * player who knew the real odds and drew only where the formula was wrong
 * got back up to 1.21. Bitcoin a second at a time sits on a tick, jumps,
 * and carries on after a jump, and a smooth formula misses all three.
 */

import { type Features, type Field, chanceOf, rangeChanceOf, multipleFor, openFor, RULES, rtpAt } from "./dots";
import { ladderSection, roundedCells, areaCells, areaMultiple, areaCostOf, INK_CELL, cellsOf, type Cell, costOf, PEN_CELLS, type Pen, payoutOf, type Stroke } from "./ink";

export { PEN_CELLS, type Pen } from "./ink";

/** What a point can cost, in dollars: 5¢, 10¢ to $1 in dimes, then $2 to $10 in dollars. 10¢ unless set. */
export const POINT_PRICES = {
  values: [
    0.05,
    ...Array.from({ length: 10 }, (_, i) => Math.round((i + 1) * 10) / 100),
    ...Array.from({ length: 9 }, (_, i) => i + 2),
  ],
  default: 0.1,
} as const;

export { costOf, payoutOf } from "./ink";

export type Priced = Cell & { multiple: number | null };

/**
 * The terms of the game for a drawing placed now, on a map of the odds. The
 * map is the measured field of one second's market, in this pen's rows
 * (`field(lib, f, openAt, step * PEN_CELLS[pen])`, which the page measures
 * in a worker). A map a second old is read as if it opened now: each point
 * as far ahead of it as the point is ahead of the drawing's second.
 */
export function terms(map: Field, now: number, step: number, pen: Pen, perPoint: number) {
  const cell = PEN_CELLS[pen];
  const size = step * cell;
  const openAt = openFor(now);
  const fits = Math.abs(map.step - size) < size * 1e-9;
  const row = (lo: number) => Math.round(lo / size);
  const chance = (t: number, lo: number) => (fits ? chanceOf(map, { t: map.openAt + (t - openAt), row: row(lo) }) : 0);
  const multiple = (t: number, lo: number): number | null => {
    const j = (t - openAt) / 1000;
    if (!fits || j < 1 || j > RULES.horizon) return null;
    // The row's middle exactly as a drawing's own point has it, (lo + hi) / 2 with both from the row, so a row centred on the price is priced the same both ways.
    const r = row(lo);
    return multipleFor(chance(t, lo), rtpAt(map.f, (r * size + (r + 1) * size) / 2));
  };
  return {
    /** The second a drawing placed now opens on. */
    openAt,
    /** How tall a row is, in dollars. */
    size,
    /** The row a price is in: a price exactly on a line is in the row above. */
    rowOf: (price: number) => Math.floor(price / size) * size,
    chance,
    multiple,
    /** What a hit on the point there pays, in dollars; null if it is not on offer. */
    pays: (t: number, lo: number) => {
      const m = multiple(t, lo);
      return m === null ? null : payoutOf(perPoint, m);
    },
    /** A line as drawn so far: its points, which are in play, what those cost, and the range a hit pays. */
    line: (st: Stroke) => {
      const points: Priced[] = cellsOf(st, openAt, step, cell).map((c) => ({ ...c, multiple: multiple(c.t, c.lo) }));
      const inPlay = points.filter((c) => c.multiple !== null);
      const ms = inPlay.map((c) => c.multiple!);
      return {
        points,
        inPlay,
        out: points.filter((c) => c.multiple === null),
        cost: costOf(perPoint, inPlay.length),
        low: ms.length ? payoutOf(perPoint, Math.min(...ms)) : 0,
        high: ms.length ? payoutOf(perPoint, Math.max(...ms)) : 0,
      };
    },
  };
}
export type Terms = ReturnType<typeof terms>;

/** The market a map was priced on, for anyone who needs it with the terms. */
export type { Features };

/** Area contracts use fine, pen-independent slices. The selected stake is
 * spread over one dot's area, not multiplied by the nib's pixel count. */
export function areaTerms(map: Field, now: number, step: number, perDot: number, rounded = false) {
  const openAt = openFor(now);
  const size = step * INK_CELL;
  const fits = Math.abs(map.step - size) < size * 1e-9;
  return {
    line(st: Stroke) {
      const points: Priced[] = (rounded ? roundedCells : areaCells)(st, openAt, step).map(c => {
        const t = map.openAt + c.t - openAt;
        const p = !fits ? 0 : rounded ? rangeChanceOf(map, t, c.lo, c.hi, map.edgeCells ?? 0, INK_CELL) : chanceOf(map, { t, row: Math.round(c.lo / size) });
        const rtp = rtpAt(map.f, (c.lo + c.hi) / 2);
        if (!rounded) return { ...c, multiple: areaMultiple(p, rtp, c.area) };
        const q = ladderSection(p, rtp, c.area);
        return q ? { ...c, ...q } : { ...c, multiple: null };
      });
      const inPlay = points.filter(c => c.multiple !== null);
      const units = inPlay.reduce((n, c) => n + c.area, 0);
      // Rounded (ladder) terms read per dollar of ink: the rungs themselves.
      const multiples = inPlay.map(c => rounded ? c.multiple! : c.area * c.multiple!);
      const returns = inPlay.map(c => perDot * c.area * c.multiple!);
      return {
        points, inPlay, out: points.filter(c => c.multiple === null), units,
        cost: areaCostOf(perDot, units),
        multipleLow: multiples.length ? Math.min(...multiples) : 0,
        multipleHigh: multiples.length ? Math.max(...multiples) : 0,
        // Each slice can pay once; the total is a ceiling, not a promised return.
        low: returns.length ? Math.floor(Math.min(...returns) * 100) / 100 : 0,
        high: Math.floor(returns.reduce((n, p) => n + p, 0) * 100 + 1e-8) / 100,
      };
    },
  };
}

export const roundedTerms = (map: Field, now: number, step: number, perDot: number) => areaTerms(map, now, step, perDot, true);
