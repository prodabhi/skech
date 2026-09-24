/**
 * Freehand drawing contracts. New drawings use ladder-v1: the union of the
 * swept nib is priced in full-dot units, split into rounded sections, and
 * each section pays a rung of the ladder (1x to 128x) set by its chance.
 * Legacy per-row contracts retain their original pricing and settlement.
 * See docs/HOW-IT-WORKS.md for the equations and the replay.
 */

import { type Bar, calibrate, chanceOf, rangeChanceOf, type Features, features, field, type Field, type Library, LIB_SCALE, multipleFor, openFor, RULES, rtpAt, SWING_SCALE, weightsFor } from "./dots";

import { fairSection, ladderSection, newInk, smoothRoundedMultiple, cappedRoundedMultiple, roundedMultiple, roundedCells, areaCells, areaMultiple, areaCostOf, INK_CELL } from "./ink-area";
export { VIEW_SECONDS, MAX_INK_MULTIPLE, LADDER, LADDER_BEST, ladderSection, newInk, sectionsOf, fairSection, roundedMultiple, roundedCells, INK_EDGE_CELLS, drawingLayout, areaCells, areaMultiple, areaCostOf, INK_CELL, MIN_INK_MULTIPLE, CHART_STEP_PX, CHART_LINE_PX } from "./ink-area";

export { RULES } from "./dots";

/** A pen stroke: points in time (ms, the feed's clock) and price, from `t0` and `p0`; the pen's half-width in each. */
export type Stroke = { t0: number; p0: number; pts: { t: number; p: number }[]; rt: number; rp: number };

/**
 * How tall a cell of ink is, as a share of the price step: the finest the
 * ink is judged at, and the default. Each pen judges its ink in cells as
 * tall as the pen is wide, so a bigger pen catches the price more easily
 * and pays less for it; see `PEN_CELLS`.
 */
export const CELL = 0.5;
/** Each pen's cell, in price steps: its width. */
export const PEN_CELLS = { fine: 0.4, medium: 0.7, wide: 1 } as const;
export type Pen = keyof typeof PEN_CELLS;

export type CellStatus = "live" | "hit" | "miss";
/** A point: its second, its row of prices from `lo` up to (not including) `hi`, and how many points it is: one. */
export type Cell = { t: number; lo: number; hi: number; area: number };
export type BetCell = Cell & {
  multiple: number;
  /** The chance it was priced on, so what was paid can be checked against what happened. */
  chance?: number;
  status: CellStatus;
  paid?: number;
  /** For a hit: the prices that second traded across, so the picture shows where the price met the ink. */
  range?: [number, number];
  /** On chain: its second's bar was never posted, so it was given its stake back. Out of play, never a miss. */
  expired?: true;
};

/** Missing means the original per-row contract. ladder-v1 is what new drawings open on. */
export type InkModel = "area-v1" | "rounded-v1" | "rounded-v2" | "rounded-v3" | "fair-v1" | "ladder-v1";
/** Priced by covered area, in full-dot units: every model but the original per-row one. */
export const isArea = (model?: InkModel): model is InkModel => model !== undefined;
/** Priced as rounded sections that pay once if the price reaches any part. */
export const isRounded = (model?: InkModel) => model !== undefined && model !== "area-v1";
/** How each saved model prices a section: the area it stakes and its multiple. Never reinterpret a saved bet. */
export function priceSection(model: InkModel, p: number, rtp: number, area: number): { area: number; multiple: number } | null {
  if (model === "ladder-v1") return ladderSection(p, rtp, area);
  if (model === "fair-v1") return fairSection(p, rtp, area);
  const m = (model === "rounded-v3" ? roundedMultiple : model === "rounded-v2" ? smoothRoundedMultiple : model === "rounded-v1" ? cappedRoundedMultiple : areaMultiple)(p, rtp, area);
  return m === null ? null : { area, multiple: m };
}

export type InkBetStatus = "opening" | "live" | "done" | "void";
export type InkBet = {
  /** Missing means the original per-row contract; never reinterpret saved bets. */
  model?: InkModel;
  /** Absent on older saved contracts, which retain their original rounding. */
  stakeRounding?: "up";
  /** What this piece of a drawing bet as it was drawn actually took, in
   * dollars: the drawing's stake rounds up once over all its pieces, so a
   * piece's debit is the growth of that rounded total. Absent on bets placed
   * whole. Its payout is left unrounded too: the drawing rounds it once. */
  charged?: number;
  /** Paid price tolerance, in fine rows. Absent on historical contracts. */
  edgeCells?: number;
  id: string;
  placedAt: number;
  openAt: number;
  /** What a point costs. */
  perUnit: number;
  step: number;
  /** How tall its cells are, as a share of `step`. Missing on drawings from before pens had their own: `CELL`. */
  cell?: number;
  stroke: Stroke;
  /** The line it is part of: a line is placed as it is drawn, a few points at a time, each its own bet. */
  group?: string;
  /** As drawn, before it opened. */
  drawn: Cell[];
  /** As priced: the ink in play when it opened, each cell with its multiple. */
  cells: BetCell[];
  status: InkBetStatus;
  why?: string;
};

/* ------------------------------------------------------------------ */
/* From a stroke to cells of ink                                       */
/* ------------------------------------------------------------------ */

function union(spans: [number, number][]): [number, number][] {
  const s = spans.filter(([a, b]) => b >= a).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of s) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** The ink at one instant: the price ranges the pen covered at time `t`, as an ellipse `rt` by `rp` walked along the path. */
export function crossSection(st: Stroke, t: number): [number, number][] {
  const spans: [number, number][] = [];
  const pts = st.pts;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1] ?? a;
    const steps = pts[i + 1] ? Math.max(1, Math.ceil(Math.max(Math.abs(b.t - a.t) / (st.rt / 3), Math.abs(b.p - a.p) / (st.rp / 3)))) : 1;
    for (let k = 0; k < steps; k++) {
      const u = k / steps;
      const ct = st.t0 + a.t + (b.t - a.t) * u;
      const dt = (t - ct) / st.rt;
      if (Math.abs(dt) > 1) continue;
      const cp = st.p0 + a.p + (b.p - a.p) * u;
      const h = st.rp * Math.sqrt(1 - dt * dt);
      spans.push([cp - h, cp + h]);
    }
  }
  return union(spans);
}

/**
 * The points a line makes, for a drawing opening at `openAt`: from the
 * second after it to the horizon, every row the line passes through in each
 * second, once. Walked finely enough, in time and in price, that no row it
 * crosses is skipped. A point's `area` is one point.
 */
export function cellsOf(st: Stroke, openAt: number, step: number, cell: number = CELL): Cell[] {
  const size = step * cell;
  const pts = st.pts.map((q) => ({ t: st.t0 + q.t, p: st.p0 + q.p }));
  const seen = new Map<string, Cell>();
  const visit = (t: number, p: number) => {
    const sec = Math.floor(t / 1000) * 1000;
    const j = (sec - openAt) / 1000;
    if (j < 1 || j > RULES.horizon) return;
    const r = Math.floor(p / size);
    const key = `${sec}:${r}`;
    if (!seen.has(key)) seen.set(key, { t: sec, lo: r * size, hi: (r + 1) * size, area: 1 });
  };
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (!b) {
      visit(a.t, a.p);
      continue;
    }
    const n = Math.max(1, Math.ceil(Math.abs(b.t - a.t) / 50), Math.ceil(Math.abs(b.p - a.p) / (size / 2)));
    for (let k = 0; k < n; k++) visit(a.t + ((b.t - a.t) * k) / n, a.p + ((b.p - a.p) * k) / n);
  }
  return [...seen.values()].sort((x, y) => x.t - y.t || x.lo - y.lo);
}

/* ------------------------------------------------------------------ */
/* Pricing                                                              */
/* ------------------------------------------------------------------ */

/**
 * Each cell's chance of being hit, from a drawing opening at `openAt` on
 * `f`: the share of like paths whose second reaches its prices. The paths
 * are those of `dots.ts`, weighted the same way, with each path's swings
 * scaled to now; and the same correction for how thin the estimate is, so a
 * rare cell is not overpaid.
 */
export function chances(lib: Library, cells: Cell[], openAt: number, f: Features, cell = 0, inclusive = false): number[] {
  const { w } = weightsFor(lib, f);
  const k = f.sigma / LIB_SCALE;
  // Each cell, as the paths store a move: log from the price, in volatilities, times the scale.
  const at = cells.map((s) => ({ j: Math.round((s.t - openAt) / 1000), lo: Math.log(s.lo / f.price) / k, hi: Math.log(s.hi / f.price) / k }));
  const hit = new Float64Array(cells.length);
  let all = 0;
  let sq = 0;
  for (let i = 0; i < lib.n; i++) {
    const wi = w[i];
    if (wi < 1e-5) continue;
    all += wi;
    sq += wi * wi;
    const base = i * lib.seconds;
    const swing = (Math.min(3, Math.max(0.33, f.wick / lib.wick[i])) * LIB_SCALE) / SWING_SCALE;
    for (let s = 0; s < at.length; s++) {
      const j = at[s].j;
      if (j < 1 || j >= lib.seconds) continue;
      const prev = lib.close[base + j - 1];
      const c = lib.close[base + j];
      const hi = Math.max(prev, c) + lib.up[base + j] * swing;
      const lo = Math.min(prev, c) - lib.down[base + j] * swing;
      // A price exactly on a cell's top edge is in the cell above, as in `dots.ts`: counted in both, prices on round numbers hit twice.
      if (hi >= at[s].lo && (inclusive ? lo <= at[s].hi : lo < at[s].hi)) hit[s] += wi;
    }
  }
  const paths = sq > 0 ? (all * all) / sq : 0;
  return [...hit].map((h) => {
    if (!(all > 0) || !(paths > 0)) return 0;
    const p = h / all;
    return p > 0 ? calibrate(p + (1 - p) / paths, cell) : 0;
  });
}

/** What a stroke would pay, cell by cell, if it were placed now: null for a cell not in play. */
export function quote(lib: Library, st: Stroke, now: number, step: number, f: Features, cell: number = CELL): { cells: Cell[]; multiples: (number | null)[] } {
  const openAt = openFor(now);
  const cells = cellsOf(st, openAt, step, cell);
  return { cells, multiples: chances(lib, cells, openAt, f, cell).map((p, i) => multipleFor(p, rtpAt(f, (cells[i].lo + cells[i].hi) / 2))) };
}

/**
 * The same, read off a field instead of the paths: for the stroke being
 * drawn, many times a second, where running every path each time stalls the
 * page. The field must be mapped in this pen's cells (`step * cell` tall),
 * so each cell is one of its rows. A field a second old is read as if it
 * opened now, each cell as far ahead of it as the cell is ahead of this
 * drawing's second. What a drawing pays is still set by `open`, on its own
 * second.
 */
export function quoteOn(fl: Field, st: Stroke, now: number, step: number, cell: number = CELL): { cells: Cell[]; multiples: (number | null)[] } {
  const openAt = openFor(now);
  const size = step * cell;
  const cells = cellsOf(st, openAt, step, cell);
  const same = Math.abs(fl.step - size) < size * 1e-9;
  return {
    cells,
    multiples: cells.map((c) => {
      if (!same) return null;
      const row = Math.round(c.lo / size);
      return multipleFor(chanceOf(fl, { t: fl.openAt + (c.t - openAt), row }), rtpAt(fl.f, (c.lo + c.hi) / 2));
    }),
  };
}

/* ------------------------------------------------------------------ */
/* A drawing's life                                                    */
/* ------------------------------------------------------------------ */

const cents = (n: number) => Math.round(n * 100) / 100;
/** What a line costs: every point in play at the same price. The one place it is worked out, with `payoutOf`; `odds.ts` states both. */
export const costOf = (perPoint: number, points: number) => cents(perPoint * points);
/** What a hit pays: the point times its multiple, rounded down to the cent. */
export const payoutOf = (perPoint: number, multiple: number) => Math.floor(perPoint * multiple * 100 + 1e-9) / 100;
const areaOf = (cells: Cell[]) => cells.reduce((s, g) => s + g.area, 0);
export const cost = (bet: InkBet) => bet.charged ?? (bet.stakeRounding === "up" ? areaCostOf : costOf)(bet.perUnit, areaOf(bet.drawn));
/** What comes back when it opens: the ink no longer in play, or all of it when it is voided. */
export const refund = (bet: InkBet) => {
  if (bet.status === "void") return cost(bet);
  if (bet.status === "opening") return 0;
  // A piece refunds the share of its ink that did not open, never more than it took.
  if (bet.charged !== undefined) {
    const drawn = areaOf(bet.drawn);
    return drawn > 0 ? Math.floor(bet.charged * Math.max(0, 1 - areaOf(bet.cells) / drawn) * 100 + 1e-8) / 100 : bet.charged;
  }
  const retained = bet.stakeRounding === "up" ? areaCostOf(bet.perUnit, areaOf(bet.cells)) : bet.perUnit * areaOf(bet.cells);
  return cents(cost(bet) - retained);
};
export const won = (bet: InkBet) => {
  const total = bet.cells.reduce((s, g) => s + (g.paid ?? 0), 0);
  if (bet.charged !== undefined) return total;
  return isArea(bet.model) ? Math.floor(total * 100 + 1e-8) / 100 : cents(total);
};
/** How much of the ink in play the price ran through. */
export const hitShare = (bet: InkBet) => {
  const all = areaOf(bet.cells);
  return all > 0 ? areaOf(bet.cells.filter((g) => g.status === "hit")) / all : 0;
};
export const decided = (bet: InkBet) => bet.status === "done" || bet.status === "void";

/** A stroke, as a drawing: not priced yet. It costs all its ink; what is not in play when it opens comes back. */
export function place(st: Stroke, perUnit: number, step: number, now: number, id: string, cell: number = CELL): InkBet | null {
  const openAt = openFor(now);
  const drawn = cellsOf(st, openAt, step, cell);
  if (!drawn.length) return null;
  return { id, placedAt: now, openAt, perUnit, step, cell, stroke: st, drawn, cells: [], status: "opening" };
}

/** Area-priced ink is committed once, on release. A full dot costs the
 * selected amount; unavailable area is refunded on opening. */
export function placeArea(st: Stroke, perUnit: number, step: number, now: number, id: string, edgeCells = 0): InkBet | null {
  if (!Number.isFinite(perUnit) || perUnit <= 0 || !Number.isFinite(now) || !Number.isFinite(edgeCells) || edgeCells < 0 || edgeCells > 4) return null;
  const openAt = openFor(now);
  const drawn = areaCells(st, openAt, step);
  if (!drawn.length) return null;
  return { model: "area-v1", stakeRounding: "up", edgeCells, id, placedAt: now, openAt, perUnit, step, cell: INK_CELL, stroke: st, drawn, cells: [], status: "opening" };
}

/** New drawings: rounded sections on ladder-v1 terms, preserving the exact swept-area stake. */
export function placeRounded(st: Stroke, perUnit: number, step: number, now: number, id: string, edgeCells = 1): InkBet | null {
  const bet = placeArea(st, perUnit, step, now, id, edgeCells);
  return bet ? { ...bet, model: "ladder-v1", drawn: roundedCells(st, bet.openAt, step) } : null;
}

/** The next piece of a drawing bet as it is drawn: only the ink `st` adds to
 * `prev`, opening on the second after now, on ladder-v1 terms. The caller
 * sets `charged` so the drawing's stake rounds up once over its pieces. */
export function placeInk(st: Stroke, prev: Stroke | null, perUnit: number, step: number, now: number, id: string, group: string, edgeCells = 1): InkBet | null {
  if (!Number.isFinite(perUnit) || perUnit <= 0 || !Number.isFinite(now) || !Number.isFinite(edgeCells) || edgeCells < 0 || edgeCells > 4) return null;
  const openAt = openFor(now);
  const drawn = newInk(st, prev, openAt, step);
  if (!drawn.length) return null;
  return { model: "ladder-v1", stakeRounding: "up", edgeCells, id, group, placedAt: now, openAt, perUnit, step, cell: INK_CELL, stroke: st, drawn, cells: [], status: "opening" };
}

/** Some points of a line, as a drawing of their own: placed now, not priced yet. */
export function placePoints(points: Cell[], st: Stroke, group: string, perUnit: number, step: number, now: number, id: string, cell: number = CELL): InkBet | null {
  const openAt = openFor(now);
  const drawn = points.filter((c) => c.t >= openAt + 1000 && c.t <= openAt + RULES.horizon * 1000);
  if (!drawn.length) return null;
  return { id, group, placedAt: now, openAt, perUnit, step, cell, stroke: st, drawn, cells: [], status: "opening" };
}

const priced1 = (m: number | null, area: number) => (m === null ? null : { area, multiple: m });

/** Price a drawing on the second it opened, from the bars before it. */
export function open(bet: InkBet, lib: Library, bars: Bar[]): InkBet {
  const f = features(bars, bet.openAt);
  if (!f) return { ...bet, status: "void", why: "No price to open on." };
  // New drawings are priced off a map of their own second, as `openOn` does,
  // so its chances fall away from the likeliest price whichever way it opens.
  if (bet.model === "ladder-v1") {
    const cell = bet.cell ?? CELL;
    const mapped = openOn(bet, field(lib, f, bet.openAt, bet.step * cell, cell, bet.edgeCells ?? 0));
    if (mapped) return mapped;
  }
  const pad = (bet.edgeCells ?? 0) * bet.step * INK_CELL;
  const priced = pad ? bet.drawn.map(s => ({ ...s, lo: s.lo - pad, hi: s.hi + pad })) : bet.drawn;
  const ps = chances(lib, priced, bet.openAt, f, bet.cell ?? CELL, pad > 0);
  const cells: BetCell[] = [];
  bet.drawn.forEach((s, i) => {
    const rtp = rtpAt(f, (s.lo + s.hi) / 2);
    const q = isArea(bet.model) ? priceSection(bet.model, ps[i], rtp, s.area) : priced1(multipleFor(ps[i], rtp), s.area);
    if (q) cells.push({ ...s, ...q, chance: ps[i], status: "live" });
  });
  if (!cells.length) return { ...bet, status: "void", why: "The price moved, and none of it is in play now." };
  return { ...bet, status: "live", cells };
}

/**
 * Price a drawing off the map of its own second, instead of the paths: the
 * same chances, measured in a worker, so opening a drawing never holds the
 * page up. Only a map of the second the drawing opens on, in its pen's
 * cells, will do; anything else is null, and `open` prices it instead.
 */
export function openOn(bet: InkBet, fl: Field): InkBet | null {
  const size = bet.step * (bet.cell ?? CELL);
  if (fl.openAt !== bet.openAt || (fl.edgeCells ?? 0) !== (bet.edgeCells ?? 0) || Math.abs(fl.step - size) > size * 1e-9) return null;
  // Only bands can be priced on a map made without each row's chance: anything else is opened the long way.
  if (!fl.chance.length && !isRounded(bet.model)) return null;
  // A bounded worker map cannot price ink beyond its range. Use direct
  // path pricing instead of silently voiding an otherwise payable section.
  const pad = (bet.edgeCells ?? 0) * size;
  if (bet.drawn.some(s => s.lo - pad < fl.row0 * size - size * 1e-8 || s.hi + pad > (fl.row0 + fl.rows) * size + size * 1e-8)) return null;
  const cells: BetCell[] = [];
  for (const s of bet.drawn) {
    const p = isRounded(bet.model) ? rangeChanceOf(fl, s.t, s.lo, s.hi, bet.edgeCells ?? 0, bet.cell ?? CELL) : chanceOf(fl, { t: s.t, row: Math.round(s.lo / size) });
    const rtp = rtpAt(fl.f, (s.lo + s.hi) / 2);
    const q = isArea(bet.model) ? priceSection(bet.model, p, rtp, s.area) : priced1(multipleFor(p, rtp), s.area);
    if (q) cells.push({ ...s, ...q, chance: p, status: "live" });
  }
  if (!cells.length) return { ...bet, status: "void", why: "The price moved, and none of it is in play now." };
  return { ...bet, status: "live", cells };
}

/**
 * Judge a live drawing on one second's bar, as it stands: the ink in that
 * second is hit where the bar's range reaches it, cell by cell, the moment
 * it does; the rest of that second's ink is missed once the second is over
 * (`closed`, after a margin for trades that arrive late).
 */
export function judge(bet: InkBet, bar: Bar, closed: boolean, prevClose?: number): InkBet {
  if (bet.status !== "live") return bet;
  /*
    What the price covered in the second: from where the second before it
    closed to its own high and low. A jump from one trade to the next still
    crosses every price between them, as the chart's line does, and the paths
    the chances are measured on count it so: judged on the second's own
    trades only, a row in the gap was never hit though it was priced as if
    it could be, and the near rows a fine pen draws in paid back 0.67 a
    dollar where a wide pen's paid 0.77.
  */
  const lo = prevClose === undefined ? bar.l : Math.min(bar.l, prevClose);
  const hi = prevClose === undefined ? bar.h : Math.max(bar.h, prevClose);
  let changed = false;
  const cells = bet.cells.map((s) => {
    if (s.status !== "live") return s;
    const pad = (bet.edgeCells ?? 0) * bet.step * INK_CELL;
    if (s.t === bar.t && hi >= s.lo - pad && (pad ? lo <= s.hi + pad : lo < s.hi)) {
      changed = true;
      return { ...s, status: "hit" as const, paid: isArea(bet.model) ? bet.perUnit * s.area * s.multiple : payoutOf(bet.perUnit * s.area, s.multiple), range: [lo, hi] as [number, number] };
    }
    if (closed && s.t <= bar.t) {
      changed = true;
      return { ...s, status: "miss" as const };
    }
    return s;
  });
  if (!changed) return bet;
  return { ...bet, cells, status: cells.every((s) => s.status !== "live") ? "done" : "live" };
}

/** Realized P&L only: reserved stake is not a loss until its ink settles.
 * Completed bets are supplied in `settled` so fading geometry is never counted twice. */
export function liveInkTotals(bets: InkBet[], settled = { committed: 0, returned: 0 }) {
  const active = bets.filter(b => !decided(b));
  const committed = active.reduce((n, b) => n + cost(b) - refund(b), settled.committed);
  const returned = active.reduce((n, b) => n + won(b), settled.returned);
  const settledCost = active.reduce((n, b) => {
    if (b.status === "opening") return n;
    const totalArea = areaOf(b.cells);
    const resolvedArea = areaOf(b.cells.filter(c => c.status !== "live"));
    if (!totalArea) return n;
    // Allocate the actual cent-rounded retained stake by settled area. Carry
    // the fractional cent until completion, when the exact stake is recognized.
    const retained = cost(b) - refund(b);
    return n + Math.floor(retained * Math.min(1, resolvedArea / totalArea) * 100 + 1e-8) / 100;
  }, settled.committed);
  const drawings = new Set(active.map(b => b.group ?? b.id)).size;
  return { drawings, committed: cents(committed), returned: cents(returned), settledCost: cents(settledCost), pending: cents(committed - settledCost), pnl: cents(returned - settledCost) };
}
