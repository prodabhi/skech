import type { Cell, Stroke } from "./ink";
import { RULES } from "./dots";

/** Two screen pixels at the chart's fixed price-step scale. Time is
 * resolved to one second, the resolution of the historical pricing feed. */
export const INK_CELL = 0.1;
export const CHART_STEP_PX = 20;
export const CHART_LINE_PX = INK_CELL * CHART_STEP_PX;
export const MIN_INK_MULTIPLE = 1.1;
/** The most one section of a new drawing pays, in dots. Past it, far ink
 * stakes less rather than paying less, so this bounds a single payout and
 * never the return per dollar. */
export const MAX_INK_MULTIPLE = 256;
/** rounded-v3's ceiling, kept for drawings saved on those terms. */
export const V3_MAX_MULTIPLE = 25;
/**
 * How tall a band may be, in grid units (cells of ink, each one unit tall): the widest pen (`PEN_CELLS.wide`, one
 * screen step) at the smallest chart `drawingLayout` draws (120 px for 6.75 market steps of 50 units, so 6750 / 120 =
 * 56.25 units), with a little room over. Taller ink is cut into bands this tall (`sectionsOf`); the relayer and the
 * program refuse a taller band (`MAX_SECTION_WIDTH` in the program's state.rs).
 */
export const MAX_SECTION_WIDTH = 64;
/** Two CSS pixels of paid price-edge tolerance for new drawings. */
export const INK_EDGE_CELLS = 1;
/** Seconds ahead of now the chart shows, on every screen. Ink can be bet up to
 * RULES.horizon ahead; the view shows the nearer half of that, stretched, so
 * the chart moves at twice the pace it did showing all thirty seconds. */
export const VIEW_SECONDS = 15;
/** Market steps the chart shows top to bottom. 6.75 is nine steps zoomed in
 * by 10/7.5: where a $10 step used to fill a row of the chart, $7.50 does. */
export const VIEW_STEPS = 6.75;
/** Shared by the canvas and replay: pricing atoms stay one chart-line
 * thick even on tall displays. Pen choice never participates in the camera. */
export function drawingLayout(width: number, height: number, marketStep: number) {
  const phone = width < 640;
  // On a phone the chart sits centred between the market row and the dock: about 16px clear of each.
  const top = phone ? 138 : 142;
  // Room under the chart for the time axis and the dock: on a phone the axis sits 16px over the dock, not 57.
  const bottom = Math.max(top + 120, height - (phone ? 134 : 116));
  const plotHeight = bottom - top;
  const nowX = Math.round(width * (phone ? 0.24 : 0.28));
  return { top, bottom, nowX, pitch: CHART_STEP_PX,
    step: marketStep * VIEW_STEPS * CHART_STEP_PX / plotHeight,
    pxMs: (width - nowX - (phone ? 10 : 20)) / ((VIEW_SECONDS + 1.5) * 1000) };
}

const SAMPLES = 24;

/** Round the total stake up once, so sub-cent area cannot be undercharged.
 * Exact whole dots keep their selected price. Never round per piece. */
export const areaCostOf = (perDot: number, units: number) => Math.ceil(perDot * units * 100 - 1e-9) / 100;

/** Exact vertical cross-section of the union of round, elliptical capsules.
 * Work in nib radii so this remains independent of zoom and pointer speed.
 * `xs` and `ys` are the points in nib radii (`t / rt`, `p / rp`), worked out
 * once per stroke; `near` the indices of the points, and the segments from
 * them to the next, that can reach `time` at all, in order. Every other point
 * and segment would add nothing here: leaving them out changes no span. */
let lo = Infinity, hi = -Infinity, crossed = false;
/** Where the edge from (cx, cy) to (dx, dy) crosses x, if it does, taken into `lo` and `hi`. */
function edge(x: number, cx: number, cy: number, dx: number, dy: number) {
  if (x < Math.min(cx, dx) || x > Math.max(cx, dx)) return;
  crossed = true;
  if (Math.abs(cx - dx) < 1e-12) {
    lo = Math.min(lo, cy, dy);
    hi = Math.max(hi, cy, dy);
  } else {
    const y = cy + ((x - cx) / (dx - cx)) * (dy - cy);
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
  }
}
function section(st: Stroke, xs: Float64Array, ys: Float64Array, near: Int32Array, count: number, time: number): [number, number][] {
  const x = (time - st.t0) / st.rt;
  const spans: [number, number][] = [];
  const circle = (px: number, py: number) => {
    const dx = x - px;
    if (Math.abs(dx) >= 1) return;
    const r = Math.sqrt(1 - dx * dx);
    spans.push([py - r, py + r]);
  };
  const n = xs.length;
  for (let j = 0; j < count; j++) {
    const i = near[j];
    const ax = xs[i], ay = ys[i];
    circle(ax, ay);
    if (i + 1 >= n) continue;
    const bx = xs[i + 1], by = ys[i + 1];
    if (x < Math.min(ax, bx) - 1 || x > Math.max(ax, bx) + 1) continue;
    const length = Math.hypot(bx - ax, by - ay);
    if (length < 1e-12) continue;
    const nx = -(by - ay) / length, ny = (bx - ax) / length;
    // The capsule's body, a rectangle: where its four edges cross x, the lowest and highest. Kept as numbers, not
    // made into arrays per segment per sample: the same arithmetic, in the same order, without the garbage.
    const c0x = ax + nx, c0y = ay + ny, c1x = bx + nx, c1y = by + ny, c2x = bx - nx, c2y = by - ny, c3x = ax - nx, c3y = ay - ny;
    lo = Infinity;
    hi = -Infinity;
    crossed = false;
    edge(x, c0x, c0y, c1x, c1y);
    edge(x, c1x, c1y, c2x, c2y);
    edge(x, c2x, c2y, c3x, c3y);
    edge(x, c3x, c3y, c0x, c0y);
    if (crossed) spans.push([lo, hi]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [lo, hi] of spans) {
    const last = merged.at(-1);
    if (last && lo <= last[1]) last[1] = Math.max(last[1], hi);
    else merged.push([lo, hi]);
  }
  return merged.map(([lo, hi]) => [st.p0 + lo * st.rp, st.p0 + hi * st.rp]);
}

/** Covered area in units of one full nib-sized dot (π rt rp). Retracing the
 * same ink costs nothing extra. Cells are an internal accounting detail.
 * Integrate each second with midpoint quadrature, clipping before charging. */
export function areaCells(st: Stroke, openAt: number, step: number): Cell[] {
  if (!(st.rt > 0 && st.rp > 0 && step > 0) || ![st.rt, st.rp, step, st.t0, st.p0, openAt].every(Number.isFinite) || !st.pts.length || st.pts.length > 2048 || st.pts.some(p => !Number.isFinite(p.t) || !Number.isFinite(p.p))) return [];
  const size = step * INK_CELL;
  const start = st.t0 + Math.min(...st.pts.map(p => p.t)) - st.rt;
  const end = st.t0 + Math.max(...st.pts.map(p => p.t)) + st.rt;
  const first = Math.max(Math.floor(start / 1000) * 1000, openAt + 1000);
  const last = Math.min(Math.floor(end / 1000) * 1000, openAt + RULES.horizon * 1000);
  const unit = Math.PI * st.rt * st.rp;
  const cells: Cell[] = [];
  /*
    Each second is measured only on the points near it. A cross-section used to look at every point of the stroke,
    24 times a second of it, so a long stroke cost the square of its length: 60 ms to price a 300-point scribble on
    a phone's engine, twenty times a second while it was drawn. The points, in nib radii, are worked out once; for
    each second, the ones a pen's radius (and a margin) from its samples are found once, in order, and only they are
    looked at. What a sample measures is exactly what it measured before: the others never reached it.
  */
  const n = st.pts.length;
  const xs = new Float64Array(n), ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = st.pts[i].t / st.rt;
    ys[i] = st.pts[i].p / st.rp;
  }
  const near = new Int32Array(n);
  for (let t = first; t <= last; t += 1000) {
    const a = Math.max(t, start), b = Math.min(t + 1000, end);
    if (b <= a) continue;
    const dt = (b - a) / SAMPLES;
    // The first and last samples' places, in nib radii: every sample of the second is between them.
    const xFrom = (a + 0.5 * dt - st.t0) / st.rt - 1.5, xTo = (a + (SAMPLES - 0.5) * dt - st.t0) / st.rt + 1.5;
    let count = 0;
    for (let i = 0; i < n; i++) {
      const ax = xs[i];
      const bx = i + 1 < n ? xs[i + 1] : ax;
      if (Math.max(ax, bx) >= xFrom && Math.min(ax, bx) <= xTo) near[count++] = i;
    }
    const rows = new Map<number, number>();
    for (let k = 0; k < SAMPLES; k++) {
      for (const [lo, hi] of section(st, xs, ys, near, count, a + (k + 0.5) * dt)) {
        const r0 = Math.floor(lo / size), r1 = Math.ceil(hi / size) - 1;
        // Bound malformed/extreme inputs, without silently charging truncated ink.
        if (r1 - r0 > 2048) return [];
        for (let r = r0; r <= r1; r++) {
          const overlap = Math.max(0, Math.min(hi, (r + 1) * size) - Math.max(lo, r * size));
          rows.set(r, (rows.get(r) ?? 0) + overlap * dt / unit);
        }
      }
    }
    for (const [r, area] of rows) if (area > 1e-10) cells.push({ t, lo: r * size, hi: (r + 1) * size, area });
  }
  // A complete isolated tap is exactly one unit, independent of alignment.
  const point = st.pts[0];
  if (start >= openAt + 1000 && end <= openAt + (RULES.horizon + 1) * 1000 && st.pts.every(p => p.t === point.t && p.p === point.p)) {
    const total = cells.reduce((n, c) => n + c.area, 0);
    if (total > 0) for (const c of cells) c.area /= total;
  }
  return cells.sort((a, b) => a.t - b.t || a.lo - b.lo);
}

/** Bound the return of a covered piece, rather than treating a microscopic
 * fraction as a whole $1 wager. The unweighted odds remain rtp / probability. */
export function areaMultiple(p: number, rtp: number, area: number): number | null {
  if (!(p > 0 && p <= 1 && area > 0) || ![p, rtp, area].every(Number.isFinite)) return null;
  const fair = rtp / p;
  if (fair < RULES.minMultiple || fair * area < MIN_INK_MULTIPLE || fair * area > RULES.maxMultiple) return null;
  const unit = fair >= 10 ? 1 : fair >= 2 ? 0.1 : 0.01;
  const rounded = Math.round(Math.floor(fair / unit + 1e-9) * unit * 100) / 100;
  return rounded * area + 1e-9 >= MIN_INK_MULTIPLE ? rounded : null;
}

/** Price connected ink in each second as one section. Any edge touch pays
 * that section once; its probability covers the whole band, not its centre.
 * Area (and therefore stake) is unchanged by grouping. */
export function roundedCells(st: Stroke, openAt: number, step: number): Cell[] {
  return sectionsOf(areaCells(st, openAt, step), step);
}

/** Group fine cells into rounded sections: each second's connected band,
 * split into adjacent sections of about two dots or less, and none taller
 * than MAX_SECTION_WIDTH cells (the widest pen; a steep stroke's sliver of a
 * second can cover a tall band with almost no area, and the chain refuses one
 * taller). */
export function sectionsOf(cells: Cell[], step: number): Cell[] {
  const bands: Cell[][] = [];
  for (const cell of [...cells].sort((a, b) => a.t - b.t || a.lo - b.lo)) {
    const previous = bands.at(-1);
    const last = previous?.at(-1);
    if (last && last.t === cell.t && cell.lo <= last.hi + step * 1e-8) previous!.push(cell);
    else bands.push([cell]);
  }
  // A steep stroke can cover many dots in one second. Never make that
  // entire stake compete for one capped payout: subdivide it into adjacent
  // price sections, preserving every row and every unit of charged area.
  const maxArea = Math.min(2, RULES.maxMultiple / RULES.minMultiple / 2);
  return bands.flatMap(rows => {
    const total = rows.reduce((n, c) => n + c.area, 0);
    const count = Math.max(Math.ceil(total / maxArea), Math.ceil(rows.length / MAX_SECTION_WIDTH));
    let remaining = total;
    let target = total / count;
    const sections: Cell[] = [];
    let current: Cell | null = null;
    let tall = 0;
    for (const row of rows) {
      const byArea = sections.length < count - 1 && current !== null && current.area >= target * 0.75 && current.area + row.area > target;
      if (current && (byArea || tall >= MAX_SECTION_WIDTH)) {
        sections.push(current);
        remaining -= current.area;
        target = remaining / Math.max(1, count - sections.length);
        current = null;
      }
      if (!current) { current = { ...row }; tall = 1; }
      else { current.hi = row.hi; current.area += row.area; tall++; }
    }
    if (current) sections.push(current);
    return sections;
  });
}

/** The ink `st` adds to `prev` (the same stroke, drawn less far), as sections,
 * for ink bet as it is drawn. Both are measured on the same opening, so ink
 * that was in play when `prev` was bet and is too soon now is in neither.
 * The total is exactly the growth of the stroke's measured area, so bets on
 * successive pieces add up to the whole stroke with nothing charged twice. */
export function newInk(st: Stroke, prev: Stroke | null, openAt: number, step: number): Cell[] {
  const full = areaCells(st, openAt, step);
  if (!prev) return sectionsOf(full, step);
  const old = new Map(areaCells(prev, openAt, step).map(c => [`${c.t}:${c.lo}`, c.area]));
  const grown = full.reduce((n, c) => n + c.area, 0) - [...old.values()].reduce((n, a) => n + a, 0);
  if (!(grown > 1e-6)) return [];
  // Re-measuring the old ink in the second the stroke grew in moves a little
  // area between its cells; keep the growth, spread over where it grew.
  const added = full.map(c => ({ ...c, area: c.area - (old.get(`${c.t}:${c.lo}`) ?? 0) })).filter(c => c.area > 1e-9);
  const sum = added.reduce((n, c) => n + c.area, 0);
  if (!(sum > 0)) return [];
  return sectionsOf(added.map(c => ({ ...c, area: c.area * grown / sum })), step);
}

/** Rounded sections may quote below fair odds at the cap; a long shot stays
 * drawable without raising its payout or inventing a probability. */
export function cappedRoundedMultiple(p: number, rtp: number, area: number): number | null {
  if (!(p > 0 && p <= 1 && area > 0) || ![p, rtp, area].every(Number.isFinite)) return null;
  const value = Math.floor(Math.min(area * rtp / p, RULES.maxMultiple) * 10 + 1e-9) / 10;
  const multiple = value / area;
  return value >= MIN_INK_MULTIPLE && multiple >= RULES.minMultiple ? multiple : null;
}

/** A smooth cap for new contracts. It is monotone in the uncapped return,
 * always at or below it, and approaches the cap without flattening every
 * long shot to 10x. Applying the same function to previews and openings
 * keeps the displayed approximate quotes backed by actual payout terms. */
export function smoothRoundedMultiple(p: number, rtp: number, area: number): number | null {
  if (!(p > 0 && p <= 1 && area > 0) || ![p, rtp, area].every(Number.isFinite)) return null;
  const raw = area * rtp / p;
  if (raw < MIN_INK_MULTIPLE) return null;
  const span = RULES.maxMultiple - MIN_INK_MULTIPLE;
  if (!(span > 0)) return null;
  const log = Math.log1p((raw - MIN_INK_MULTIPLE) / span);
  const value = Math.floor((MIN_INK_MULTIPLE + span * log / (1 + log)) * 10 + 1e-9) / 10;
  const multiple = value / area;
  return value >= MIN_INK_MULTIPLE && multiple >= RULES.minMultiple ? multiple : null;
}

/** The ladder new drawings pay on, per dollar of ink, from the price outward:
 * doubling, with a rung between each pair so rounding down costs little. */
export const LADDER = [1.1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128] as const;
/** What the best-placed ink returns per dollar at the default difficulty: a
 * spot whose chance puts it exactly on a rung. Everywhere else rounds down to
 * the rung below. The game reads RULES.ladderBest, set by difficulty. */
export const LADDER_BEST = RULES.ladderBest;

/** ladder-v1, the terms for new drawings: a section's fair multiple
 * (LADDER_BEST over its chance, less the momentum margin rtpAt takes on the
 * side the price just moved toward) rounded down to a rung, so every label
 * is a rung from 1.1x to 128x and only ink the price actually crosses pays.
 * Ink too likely for the floor pays its fair multiple, rounded down to the
 * hundredth and never under 1x: no stroke is cut, and none returns more than
 * a dollar. Ink past 128x pays 128x.
 * The stake is the ink drawn, up to what MAX_INK_MULTIPLE dots pays for. */
export function ladderSection(p: number, rtp: number, area: number): { area: number; multiple: number } | null {
  if (!(p > 0 && p <= 1 && area > 0) || ![p, rtp, area].every(Number.isFinite)) return null;
  const fair = (RULES.ladderBest - (RULES.rtp - rtp)) / p;
  // Under the floor: the fair multiple to the hundredth, at least 1x.
  if (fair + 1e-9 < RULES.ladderFloor) {
    const multiple = Math.max(1, Math.floor(fair * 100 + 1e-9) / 100);
    // Ink that would return more than the fee leaves (chance x multiple over 1 - fee, on chain) is not offered.
    if (p * multiple > RULES.maxReturn + 1e-9) return null;
    return { area: Math.min(area, MAX_INK_MULTIPLE / multiple), multiple };
  }
  // The floor is the first rung: 1.1x, easing to 1x at the hardest setting.
  let multiple: number = RULES.ladderFloor;
  for (const rung of LADDER) if (rung <= fair + 1e-9 && rung > multiple) multiple = rung;
  if (p * multiple > RULES.maxReturn + 1e-9) return null;
  // One section never pays past MAX_INK_MULTIPLE dots: a big one stakes only what that pays for.
  return { area: Math.min(area, MAX_INK_MULTIPLE / multiple), multiple };
}

/** fair-v1 (saved drawings only), the terms before the ladder: every section pays its target
 * (the difficulty's rtp) over its chance, rounded down to a hundredth per
 * dollar, so a section returns the same per dollar however big it is,
 * whatever the pen and whatever screen drew it. Two exceptions:
 *
 * - Past MAX_INK_MULTIPLE a section pays that and is charged less instead:
 *   its stake shrinks to the area that multiple is exactly fair for, so far
 *   ink stays drawable without a cap taking from it.
 * - Ink so likely to be touched that its fair price is under 1.1x pays 1.1x,
 *   so a stroke across the live price is never cut. That ink returns more
 *   than the target, and more than a dollar where it is over 91% likely.
 *
 * Returns the area to charge and the multiple on it, or null. */
export function fairSection(p: number, rtp: number, area: number): { area: number; multiple: number } | null {
  if (!(p > 0 && p <= 1 && area > 0) || ![p, rtp, area].every(Number.isFinite)) return null;
  const multiple = Math.max(MIN_INK_MULTIPLE, Math.floor((rtp / p) * 100 + 1e-9) / 100);
  return area * multiple > MAX_INK_MULTIPLE ? { area: MAX_INK_MULTIPLE / multiple, multiple } : { area, multiple };
}

/** rounded-v3 (saved drawings only): preserve ordinary probability-priced returns through
 * 10x, then soften the long-shot tail with a square-root curve up to 25x.
 * For raw >= 10, 1.1 + sqrt((raw-1.1)*8.9) <= raw, so expected payouts
 * remain bounded by the existing pricing target before downward rounding. */
export function roundedMultiple(p: number, rtp: number, area: number): number | null {
  if (!(p > 0 && p <= 1 && area > 0) || ![p, rtp, area].every(Number.isFinite)) return null;
  const raw = area * rtp / p;
  if (raw < MIN_INK_MULTIPLE) return null;
  const tail = raw <= 10 ? raw : MIN_INK_MULTIPLE + Math.sqrt((raw - MIN_INK_MULTIPLE) * (10 - MIN_INK_MULTIPLE));
  const value = Math.floor(Math.min(V3_MAX_MULTIPLE, tail) * 10 + 1e-9) / 10;
  const multiple = value / area;
  return value >= MIN_INK_MULTIPLE && multiple >= RULES.minMultiple ? multiple : null;
}
