import { expect, test } from "bun:test";
import { areaCells, INK_CELL, newInk } from "./ink-area";
import { RULES } from "./dots";
import type { Cell, Stroke } from "./ink";

/*
  areaCells measures each second on only the points near it. It must measure exactly what it did when every
  cross-section looked at every point: these tests keep that version, word for word, and compare the two on
  thousands of strokes (taps, lines, scribbles, strokes that turn back in time, steep ones, repeated points),
  number for number, not to within a tolerance.
*/

const SAMPLES = 24;
function sectionBefore(st: Stroke, time: number): [number, number][] {
  const x = (time - st.t0) / st.rt;
  const spans: [number, number][] = [];
  const circle = (px: number, py: number) => {
    const dx = x - px;
    if (Math.abs(dx) >= 1) return;
    const r = Math.sqrt(1 - dx * dx);
    spans.push([py - r, py + r]);
  };
  for (let i = 0; i < st.pts.length; i++) {
    const a = st.pts[i];
    const ax = a.t / st.rt, ay = a.p / st.rp;
    circle(ax, ay);
    const b = st.pts[i + 1];
    if (!b) continue;
    const bx = b.t / st.rt, by = b.p / st.rp;
    if (x < Math.min(ax, bx) - 1 || x > Math.max(ax, bx) + 1) continue;
    const length = Math.hypot(bx - ax, by - ay);
    if (length < 1e-12) continue;
    const nx = -(by - ay) / length, ny = (bx - ax) / length;
    const corners = [[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]];
    const ys: number[] = [];
    for (let k = 0; k < 4; k++) {
      const c = corners[k], d = corners[(k + 1) % 4];
      if (x < Math.min(c[0], d[0]) || x > Math.max(c[0], d[0])) continue;
      if (Math.abs(c[0] - d[0]) < 1e-12) ys.push(c[1], d[1]);
      else ys.push(c[1] + ((x - c[0]) / (d[0] - c[0])) * (d[1] - c[1]));
    }
    if (ys.length) spans.push([Math.min(...ys), Math.max(...ys)]);
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
function areaCellsBefore(st: Stroke, openAt: number, step: number): Cell[] {
  if (!(st.rt > 0 && st.rp > 0 && step > 0) || ![st.rt, st.rp, step, st.t0, st.p0, openAt].every(Number.isFinite) || !st.pts.length || st.pts.length > 2048 || st.pts.some(p => !Number.isFinite(p.t) || !Number.isFinite(p.p))) return [];
  const size = step * INK_CELL;
  const start = st.t0 + Math.min(...st.pts.map(p => p.t)) - st.rt;
  const end = st.t0 + Math.max(...st.pts.map(p => p.t)) + st.rt;
  const first = Math.max(Math.floor(start / 1000) * 1000, openAt + 1000);
  const last = Math.min(Math.floor(end / 1000) * 1000, openAt + RULES.horizon * 1000);
  const unit = Math.PI * st.rt * st.rp;
  const cells: Cell[] = [];
  for (let t = first; t <= last; t += 1000) {
    const a = Math.max(t, start), b = Math.min(t + 1000, end);
    if (b <= a) continue;
    const dt = (b - a) / SAMPLES;
    const rows = new Map<number, number>();
    for (let k = 0; k < SAMPLES; k++) {
      for (const [lo, hi] of sectionBefore(st, a + (k + 0.5) * dt)) {
        const r0 = Math.floor(lo / size), r1 = Math.ceil(hi / size) - 1;
        if (r1 - r0 > 2048) return [];
        for (let r = r0; r <= r1; r++) {
          const overlap = Math.max(0, Math.min(hi, (r + 1) * size) - Math.max(lo, r * size));
          rows.set(r, (rows.get(r) ?? 0) + overlap * dt / unit);
        }
      }
    }
    for (const [r, area] of rows) if (area > 1e-10) cells.push({ t, lo: r * size, hi: (r + 1) * size, area });
  }
  const point = st.pts[0];
  if (start >= openAt + 1000 && end <= openAt + (RULES.horizon + 1) * 1000 && st.pts.every(p => p.t === point.t && p.p === point.p)) {
    const total = cells.reduce((n, c) => n + c.area, 0);
    if (total > 0) for (const c of cells) c.area /= total;
  }
  return cells.sort((a, b) => a.t - b.t || a.lo - b.lo);
}

let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const openAt = 1_800_000_000_000;

/** A stroke as a hand might draw one: a walk in time and price, sometimes turning back, sometimes still. */
function strokeOf(kind: number): Stroke {
  const rt = [150, 260, 400, 700][kind % 4] * (0.5 + rand());
  const rp = [0.2, 0.35, 1, 3][(kind >> 2) % 4] * (0.5 + rand());
  const n = kind % 7 === 0 ? 1 : 1 + Math.floor(rand() * [5, 40, 200, 600][kind % 4]);
  const pts = [{ t: 0, p: 0 }];
  let t = 0, p = 0;
  for (let i = 1; i < n; i++) {
    const back = rand() < 0.1 ? -1 : 1;
    t += back * rand() * [30, 90, 250][i % 3];
    p += (rand() - 0.5) * rp * [0.5, 3, 12][kind % 3];
    // Now and then the same point again, as a finger that rests.
    pts.push(rand() < 0.05 ? { ...pts[pts.length - 1] } : { t, p });
  }
  return { t0: openAt + 1000 + rand() * 9000, p0: 100_000 + rand() * 10, rt, rp, pts };
}

test("each second measured on the points near it is exactly what measuring every point gave", () => {
  for (let kind = 0; kind < 2000; kind++) {
    const st = strokeOf(kind);
    const step = [0.5, 1, 5, 20][kind % 4];
    expect(areaCells(st, openAt, step)).toEqual(areaCellsBefore(st, openAt, step));
  }
});

test("strokes far beyond the horizon, behind the opening, or in one place: still the same", () => {
  const cases: Stroke[] = [
    { t0: openAt - 5000, p0: 100, rt: 300, rp: 0.35, pts: [{ t: 0, p: 0 }, { t: 9000, p: 2 }] },
    { t0: openAt + 25_000, p0: 100, rt: 300, rp: 0.35, pts: [{ t: 0, p: 0 }, { t: 20_000, p: -3 }] },
    { t0: openAt + 4000, p0: 100, rt: 300, rp: 0.35, pts: Array.from({ length: 50 }, () => ({ t: 0, p: 0 })) },
    { t0: openAt + 4000, p0: 100, rt: 300, rp: 0.35, pts: Array.from({ length: 300 }, (_, i) => ({ t: 0, p: i * 0.01 })) },
    { t0: openAt + 4000, p0: 100, rt: 300, rp: 0.35, pts: Array.from({ length: 300 }, (_, i) => ({ t: (i % 2) * 2000, p: i * 0.001 })) },
  ];
  for (const st of cases) for (const step of [0.5, 1, 5]) expect(areaCells(st, openAt, step)).toEqual(areaCellsBefore(st, openAt, step));
});

test("the ink a stroke adds to itself is the same too", () => {
  for (let kind = 0; kind < 300; kind++) {
    const st = strokeOf(kind);
    const prev = { ...st, pts: st.pts.slice(0, Math.max(1, Math.floor(st.pts.length * 0.7))) };
    const cells = newInk(st, prev, openAt, 5);
    // newInk is built on areaCells: the growth it finds must equal the growth measured the old way.
    const grown = areaCellsBefore(st, openAt, 5).reduce((n, c) => n + c.area, 0) - areaCellsBefore(prev, openAt, 5).reduce((n, c) => n + c.area, 0);
    if (grown > 1e-6) expect(cells.reduce((n, c) => n + c.area, 0)).toBeCloseTo(grown, 9);
    else expect(cells).toEqual([]);
  }
});
