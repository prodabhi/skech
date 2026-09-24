import { expect, test } from "bun:test";
import { type Bar, features, field, readLibrary, stepFor } from "./dots";
import { cost, open, openOn, place, quote, type Stroke } from "./ink";
import { costOf, PEN_CELLS, payoutOf, terms } from "./odds";

const real = readLibrary(new Uint8Array(await Bun.file(new URL("./dots-lib.bin", import.meta.url)).arrayBuffer()));
const t0 = 1_800_000_000_000;
const bars: Bar[] = Array.from({ length: 320 }, (_, s) => {
  const c = 84_000 + (s % 2 ? 0.5 : -0.5);
  return { t: t0 + s * 1000, h: c + 0.2, l: c - 0.2, c };
});
const at = t0 + 320_000;
const f = features(bars, at)!;
const step = stepFor(f.sigma, f.price);
const unit = f.sigma * f.price;
const now = at - 400;
const line = (p0: number, pts: [number, number][]): Stroke => ({ t0: at + 3000, p0, pts: pts.map(([t, p]) => ({ t, p })), rt: 100, rp: step / 3 });
const mapFor = (pen: keyof typeof PEN_CELLS) => field(real, f, at, step * PEN_CELLS[pen], PEN_CELLS[pen]);

test("a line costs the point times its points in play, and a hit pays the point times its multiple", () => {
  const t = terms(mapFor("medium"), now, step, "medium", 0.25);
  const l = t.line(line(f.price + 2 * unit, [[0, 0], [6000, unit], [12000, -unit]]));
  expect(l.inPlay.length).toBeGreaterThan(3);
  expect(l.cost).toBe(costOf(0.25, l.inPlay.length));
  for (const p of l.inPlay) expect(t.pays(p.t, p.lo)).toBe(payoutOf(0.25, p.multiple!));
  expect(l.low).toBeLessThanOrEqual(l.high);
});

test("the pen changes the multiples; what a point costs changes only the dollars", () => {
  const spot = { t: at + 9000, price: f.price + 3 * unit };
  const at$ = (pen: keyof typeof PEN_CELLS, perPoint: number) => {
    const t = terms(mapFor(pen), now, step, pen, perPoint);
    return { m: t.multiple(spot.t, t.rowOf(spot.price))!, pays: t.pays(spot.t, t.rowOf(spot.price))! };
  };
  expect(at$("wide", 0.25).m).toBeLessThan(at$("fine", 0.25).m);
  expect(at$("fine", 1).m).toBe(at$("fine", 0.25).m);
  expect(at$("fine", 1).pays).toBeCloseTo(4 * at$("fine", 0.25).pays, 1);
});

test("what the terms show is what a drawing is charged and priced at", () => {
  for (const pen of ["fine", "medium", "wide"] as const) {
    const st = line(f.price + unit, [[0, 0], [5000, 2 * unit], [11000, -unit]]);
    const t = terms(mapFor(pen), now, step, pen, 0.25);
    const shown = t.line(st);
    // The same points, at the same multiples, as the exact pricing on the paths.
    const exact = quote(real, st, now, step, f, PEN_CELLS[pen]);
    expect(shown.points.map(({ multiple: _, ...c }) => c)).toEqual(exact.cells);
    expect(shown.points.map((p) => p.multiple)).toEqual(exact.multiples);
    // And once placed and opened on its second's map, the same again.
    const bet = openOn(place(st, 0.25, step, now, "x", PEN_CELLS[pen])!, mapFor(pen))!;
    expect(bet.cells.map((c) => c.multiple)).toEqual(shown.inPlay.map((p) => p.multiple!));
    const opened = open(place(st, 0.25, step, now, "y", PEN_CELLS[pen])!, real, bars);
    expect(cost(bet) - (cost(bet) - costOf(0.25, bet.cells.length))).toBe(shown.cost);
    // Priced on the paths directly: the same multiples, and the same chance to the map's float precision.
    expect(opened.cells.map(({ chance: _, ...c }) => c)).toEqual(bet.cells.map(({ chance: _, ...c }) => c));
    opened.cells.forEach((c, i) => expect(c.chance!).toBeCloseTo(bet.cells[i].chance!, 6));
  }
});
