import { expect, test } from "bun:test";
import { areaCells, areaMultiple, areaCostOf, roundedCells, INK_EDGE_CELLS, drawingLayout, CHART_LINE_PX, INK_CELL, MAX_INK_MULTIPLE, MIN_INK_MULTIPLE } from "./ink-area";
import { cost, liveInkTotals, judge, open, openOn, PEN_CELLS, placeArea, placeRounded, refund, won, type InkBet, type Stroke } from "./ink";
import { areaTerms, roundedTerms } from "./odds";
import { features, field, rangeChanceOf, readLibrary, RULES, DIFFICULTY, difficulty, rtpAt, setDifficulty, stepFor, type Bar, type Field } from "./dots";

const at = 1_800_000_000_000;
const dot = (rt = 300, rp = 0.35): Stroke => ({ t0: at + 5500, p0: 100.013, rt, rp, pts: [{ t: 0, p: 0 }] });
const units = (st: Stroke) => areaCells(st, at, 1).reduce((sum, cell) => sum + cell.area, 0);
function uniformMap(chance = 0.02): Field {
  return { openAt: at, step: INK_CELL, row0: Math.floor(95 / INK_CELL), rows: Math.round(10 / INK_CELL), seconds: 30, chance: new Float32Array(Math.round(300 / INK_CELL)).fill(chance), paths: 2000, rtp: RULES.rtp, f: { price: 100, sigma: 0.0001, momentum: 0, wick: 0.15 } };
}

test("one isolated dot costs the selected amount for every nib and grid alignment", () => {
  for (const width of Object.values(PEN_CELLS)) for (const shift of [0, 0.005, 0.024]) for (const time of [4200, 4500, 4999]) {
    const st = { ...dot(width * 500, width / 2), p0: 100 + shift, t0: at + time };
    expect(units(st)).toBeCloseTo(1, 10);
    expect(cost(placeArea(st, 1, 1, at - 100, "tap")!)).toBe(1);
  }
});

test("a line charges its capsule area, including the pen width, not just its centreline", () => {
  const st = dot(); st.pts.push({ t: 2400, p: 0 });
  expect(units(st)).toBeCloseTo(1 + 2 * 2400 / (Math.PI * st.rt), 2);
  const cells = areaCells(st, at, 1);
  expect(Math.min(...cells.map(c => c.lo))).toBeLessThan(st.p0 - st.rp + INK_CELL);
  expect(Math.max(...cells.map(c => c.hi))).toBeGreaterThan(st.p0 + st.rp - INK_CELL);
});

test("retracing and adding redundant pointer samples do not charge the ink twice", () => {
  const straight = { ...dot(), pts: [{ t: 0, p: 0 }, { t: 2000, p: 0 }] };
  const back = { ...straight, pts: [...straight.pts, { t: 0, p: 0 }, { t: 2000, p: 0 }] };
  const sampled = { ...straight, pts: Array.from({ length: 101 }, (_, i) => ({ t: i * 20, p: 0 })) };
  expect(units(back)).toBeCloseTo(units(straight), 9);
  expect(units(sampled)).toBeCloseTo(units(straight), 9);
});

test("vertical and diagonal strokes have the same normalized capsule geometry", () => {
  for (const [t, p] of [[0, 2.8], [1440, 2.24]]) {
    const st = { ...dot(), pts: [{ t: 0, p: 0 }, { t, p }] };
    const length = Math.hypot(t / st.rt, p / st.rp);
    expect(units(st)).toBeCloseTo(1 + 2 * length / Math.PI, 2);
  }
});

test("past and out-of-horizon ink is clipped without renormalizing it into a full dot", () => {
  const st = { ...dot(), t0: at + 1000 };
  expect(units(st)).toBeCloseTo(0.5, 2);
  expect(areaCells({ ...st, t0: at - 5000 }, at, 1)).toEqual([]);
  expect(areaCells({ ...st, t0: at + 40000 }, at, 1)).toEqual([]);
  expect(areaCells(st, at, 1).every(c => c.t >= at + 1000)).toBe(true);
});

test("invalid or unbounded drawing inputs are rejected", () => {
  for (const st of [{ ...dot(), rt: 0 }, { ...dot(), rp: -1 }, { ...dot(), p0: NaN }, { ...dot(), pts: [{ t: Infinity, p: 0 }] }, { ...dot(), pts: [] }]) expect(areaCells(st, at, 1)).toEqual([]);
  expect(placeArea(dot(), -1, 1, at - 100, "bad")).toBeNull();
  expect(placeArea(dot(), Infinity, 1, at - 100, "bad")).toBeNull();
});

test("a wider nib spreads the same stake over more atoms, lowering a central piece's payout", () => {
  const paid = (width: number) => {
    const st = { ...dot(width * 1000, width / 2), p0: 100 + INK_CELL / 2 };
    const preview = areaTerms(uniformMap(), at - 100, 1, 1).line(st);
    expect(preview.cost).toBeGreaterThan(0);
    expect(preview.cost).toBeLessThanOrEqual(1);
    return Math.max(...preview.inPlay.map(c => c.area * c.multiple!));
  };
  expect(paid(PEN_CELLS.fine)).toBeGreaterThan(paid(PEN_CELLS.medium));
  expect(paid(PEN_CELLS.medium)).toBeGreaterThan(paid(PEN_CELLS.wide));
});

test("preview, debit, opening and maximum payout agree on a fixed market", () => {
  const map = uniformMap();
  const st = dot();
  const preview = areaTerms(map, at - 100, 1, 1).line(st);
  const placed = placeArea(st, 1, 1, at - 100, "same")!;
  let bet = openOn(placed, map)!;
  expect(cost(bet) - refund(bet)).toBe(preview.cost);
  expect(bet.cells.map(c => c.multiple)).toEqual(preview.inPlay.map(c => c.multiple));
  for (const t of new Set(bet.cells.map(c => c.t))) bet = judge(bet, { t, l: 90, h: 110, c: 100 }, true);
  expect(won(bet)).toBe(preview.high);
  expect(judge(bet, { t: at + 5500, l: 90, h: 110, c: 100 }, true)).toBe(bet);
});

test("tiny partial hits accumulate before cent rounding and never pay twice", () => {
  const cells = Array.from({ length: 40 }, (_, i) => ({ t: at + 5000, lo: 100 + i * 0.025, hi: 100.025 + i * 0.025, area: 0.0001, multiple: 5, status: "live" as const }));
  const bet: InkBet = { model: "area-v1", id: "dust", placedAt: at - 100, openAt: at, perUnit: 1, step: 1, cell: INK_CELL, stroke: dot(), drawn: cells, cells, status: "live" };
  const hit = judge(bet, { t: at + 5000, l: 99, h: 102, c: 100 }, true);
  expect(won(hit)).toBe(0.02);
  expect(won(judge(hit, { t: at + 5000, l: 99, h: 102, c: 100 }, true))).toBe(0.02);
  // Historical per-row contracts retain their original rounding.
  expect(won(judge({ ...bet, model: undefined }, { t: at + 5000, l: 99, h: 102, c: 100 }, true))).toBe(0);
});

test("only reached ink pays; an unavailable drawing is refunded", () => {
  const placed = placeArea(dot(), 1, 1, at - 100, "partial")!;
  let bet = openOn(placed, uniformMap())!;
  for (const t of new Set(bet.cells.map(c => c.t))) bet = judge(bet, { t, l: 100.01, h: 100.01, c: 100.01 }, true);
  expect(won(bet)).toBeGreaterThan(0);
  expect(bet.cells.some(c => c.status === "miss")).toBe(true);
  const voided = openOn(placed, uniformMap(0))!;
  expect(voided.status).toBe("void");
  expect(refund(voided)).toBe(1);
});

test("piece odds have the same modelled expected return for every area and stay under the payout cap", () => {
  for (const area of [0.001, 0.01, 0.1, 1]) for (const p of [0.005, 0.1, 0.4]) {
    const m = areaMultiple(p, 0.78, area);
    if (m === null) continue;
    expect(p * m).toBeLessThanOrEqual(0.78 + 1e-9);
    expect(p * m).toBeGreaterThan(0.70);
    expect(area * m).toBeLessThanOrEqual(RULES.maxMultiple + 1e-9);
    expect(area * m).toBeGreaterThanOrEqual(MIN_INK_MULTIPLE - 1e-9);
  }
});

test("fine-slice worker pricing agrees with exact historical-path pricing", async () => {
  const lib = readLibrary(new Uint8Array(await Bun.file(new URL("./dots-lib.bin", import.meta.url)).arrayBuffer()));
  const bars: Bar[] = Array.from({ length: 320 }, (_, i) => { const c = 84000 + (i % 2 ? 0.5 : -0.5); return { t: at - (320 - i) * 1000, h: c + 0.2, l: c - 0.2, c }; });
  const f = features(bars, at)!;
  const step = stepFor(f.sigma, f.price);
  const map = field(lib, f, at, step * INK_CELL, INK_CELL);
  for (const width of Object.values(PEN_CELLS)) {
    const st = { ...dot(width * 900, width * step / 2), p0: f.price + 3 * step, pts: [{ t: 0, p: 0 }, { t: 5000, p: step }] };
    const bet = placeArea(st, 1, step, at - 100, "history")!;
    const fast = openOn(bet, map)!;
    const exact = open(bet, lib, bars);
    expect(fast.cells.length).toBeGreaterThan(0);
    expect(fast.cells.map(({ chance: _, ...c }) => c)).toEqual(exact.cells.map(({ chance: _, ...c }) => c));
  }
});


test("the 1.1x minimum is enforced in pricing, not a misleading display clamp", () => {
  expect(areaMultiple(0.4, 0.78, 0.1)).toBeNull();
  // Downward odds rounding must not sneak a piece just under the minimum.
  expect(areaMultiple(0.78 / 22.01, 0.78, 0.04999)).toBeNull();
  for (const width of Object.values(PEN_CELLS)) {
    const preview = areaTerms(uniformMap(), at - 100, 1, 1).line(dot(width * 1000, width / 2));
    expect(preview.inPlay.length).toBeGreaterThan(0);
    for (const c of preview.inPlay) expect(c.area * c.multiple!).toBeGreaterThanOrEqual(1.1 - 1e-9);
  }
});


test("fractional stakes cannot gain an edge through cent rounding, including after refunds", () => {
  // Previously 0.149 of a 10-cent dot cost $0.01 but had $0.0116 expected payout.
  const atom = { t: at + 5000, lo: 100, hi: 100.1, area: 0.149, multiple: 78, chance: 0.01, status: "live" as const };
  const bet: InkBet = { ...placeArea(dot(), 0.1, 1, at - 100, "rounding")!, drawn: [atom], cells: [atom], status: "live" };
  expect(cost(bet)).toBe(0.02);
  expect(cost({ ...bet, stakeRounding: undefined })).toBe(0.01);
  expect(refund(bet)).toBe(0);
  const partial = { ...bet, drawn: [atom, { ...atom, area: 0.5 }] };
  expect(cost(partial) - refund(partial)).toBeCloseTo(0.02, 10);
  expect(refund({ ...partial, status: "void" })).toBe(cost(partial));
  for (const amount of [0.1, 0.25, 0.5, 1, 10, 100]) for (const area of [0.00001, 0.0149, 0.149, 0.499, 1, 4.789]) {
    expect(areaCostOf(amount, area) + 1e-10).toBeGreaterThanOrEqual(amount * area);
    expect(areaCostOf(amount, area) - amount * area).toBeLessThan(0.010000001);
  }
});

test("live drawing P&L excludes pending stake and recognizes only settled ink", () => {
  const placed = placeArea(dot(), 1, 1, at - 100, "pnl")!;
  expect(liveInkTotals([placed])).toEqual({ drawings: 1, committed: 1, returned: 0, settledCost: 0, pending: 1, pnl: 0 });
  const opened = openOn(placed, uniformMap())!;
  const cell = opened.cells[0];
  const partial = judge(opened, { t: cell.t, l: cell.lo, h: cell.lo, c: cell.lo }, false);
  const totals = liveInkTotals([partial]);
  expect(totals.drawings).toBe(1);
  expect(totals.committed).toBeCloseTo(cost(partial) - refund(partial), 2);
  expect(totals.returned).toBe(won(partial));
  expect(totals.pnl).toBeCloseTo(won(partial) - totals.settledCost, 2);
  expect(totals.pending).toBeGreaterThan(0);
  expect(totals.settledCost + totals.pending).toBeCloseTo(totals.committed, 8);
  const voided = openOn(placed, uniformMap(0))!;
  expect(liveInkTotals([voided])).toEqual({ drawings: 0, committed: 0, returned: 0, settledCost: 0, pending: 0, pnl: 0 });
  let settled = partial;
  for (const t of new Set(settled.cells.map(c => c.t))) settled = judge(settled, { t, l: 90, h: 110, c: 100 }, true);
  expect(liveInkTotals([settled]).drawings).toBe(0);
});


test("visible multiplier range quotes exactly the eligible ink, independently of dollar amount", () => {
  const small = areaTerms(uniformMap(), at - 100, 1, 0.1).line(dot());
  const large = areaTerms(uniformMap(), at - 100, 1, 100).line(dot());
  expect(small.inPlay.length).toBeGreaterThan(0);
  expect(small.multipleLow).toBe(Math.min(...small.inPlay.map(c => c.area * c.multiple!)));
  expect(small.multipleHigh).toBe(Math.max(...small.inPlay.map(c => c.area * c.multiple!)));
  expect(small.multipleLow).toBeGreaterThanOrEqual(1.1);
  expect(small.multipleHigh).toBeLessThanOrEqual(RULES.maxMultiple + 1e-9);
  expect(large.multipleLow).toBe(small.multipleLow);
  expect(large.multipleHigh).toBe(small.multipleHigh);
  const empty = areaTerms(uniformMap(0), at - 100, 1, 1).line(dot());
  expect(empty.multipleLow).toBe(0);
  expect(empty.multipleHigh).toBe(0);
});


test("drawings above and below the live price are both eligible when the model offers them", () => {
  const map = uniformMap();
  for (const offset of [-1, 1]) {
    const stroke = { ...dot(), p0: map.f.price + offset };
    const quote = areaTerms(map, at - 100, 1, 1).line(stroke);
    expect(quote.inPlay.length).toBeGreaterThan(0);
    expect(quote.multipleLow).toBeGreaterThanOrEqual(1.1);
    expect(quote.multipleHigh).toBeLessThanOrEqual(RULES.maxMultiple + 1e-9);
    const opened = openOn(placeArea(stroke, 1, 1, at - 100, `direction-${offset}`)!, map)!;
    expect(opened.status).toBe("live");
    let hit = opened;
    for (const t of new Set(hit.cells.map(c => c.t))) hit = judge(hit, { t, l: stroke.p0 - 1, h: stroke.p0 + 1, c: stroke.p0 }, true);
    expect(won(hit)).toBeGreaterThan(0);
  }
});


test("pricing resolution remains chart-line thick across viewport sizes and pens", () => {
  for (const [w, h] of [[390, 844], [1280, 720], [987, 1500], [1920, 1080]]) {
    const layout = drawingLayout(w, h, 20);
    expect(layout.step * INK_CELL / layout.step * layout.pitch).toBeCloseTo(CHART_LINE_PX, 10);
    // 6.75 market steps of $20 top to bottom.
    expect((layout.bottom - layout.top) * layout.step / layout.pitch).toBeCloseTo(135, 10);
    for (const width of Object.values(PEN_CELLS)) {
      const radius = width * 20 / 2;
      const stroke = { ...dot(), rt: radius / layout.pxMs, rp: radius * layout.step / layout.pitch };
      expect(areaCells(stroke, at, layout.step).reduce((n, c) => n + c.area, 0)).toBeCloseTo(1, 10);
    }
  }
});

test("a live hit credits immediately and completed drawings stay in the batch P&L", () => {
  const placed = placeArea(dot(), 1, 1, at - 100, "instant")!;
  const opened = openOn(placed, uniformMap())!;
  const c = opened.cells[0];
  const hit = judge(opened, { t: c.t, l: c.lo, h: c.lo, c: c.lo }, false);
  const credit = won(hit) - won(opened);
  expect(credit).toBeGreaterThan(0);
  expect(won(judge(hit, { t: c.t, l: c.lo, h: c.lo, c: c.lo }, false)) - won(hit)).toBe(0);
  // A completed winner must not disappear when another drawing remains open.
  const pending = { ...placed, id: "next" };
  const summary = liveInkTotals([pending], { committed: 2, returned: 5 });
  expect(summary).toEqual({ drawings: 1, committed: 3, returned: 5, settledCost: 2, pending: 1, pnl: 3 });
  expect(liveInkTotals([], { committed: 2, returned: 5 })).toEqual({ drawings: 0, committed: 2, returned: 5, settledCost: 2, pending: 0, pnl: 3 });
});

test("the default difficulty sets payouts without changing the minimum", () => {
  expect(DIFFICULTY).toBe(55);
  expect(difficulty(DIFFICULTY).maxMultiple).toBe(14);
  expect(difficulty(DIFFICULTY).rtp).toBe(0.764);
  expect(difficulty(DIFFICULTY).ladderBest).toBe(0.98);
  expect(difficulty(DIFFICULTY).ladderFloor).toBe(1.1);
  expect(difficulty(DIFFICULTY).rtp).toBeLessThan(difficulty(50).rtp);
  expect(MIN_INK_MULTIPLE).toBe(1.1);
});


test("new drawings pay the padded edge once; historical bounds stay unchanged", () => {
  const cell = { t: at + 5000, lo: 100, hi: 100.1, area: 0.5, multiple: 4, status: "live" as const };
  const base: InkBet = { ...placeArea(dot(), 1, 1, at - 100, "edge", INK_EDGE_CELLS)!, cells: [cell], drawn: [cell], status: "live" };
  for (const p of [99.9, 100.19999999999999]) {
    const bar = { t: cell.t, l: p, h: p, c: p };
    const hit = judge(base, bar, false);
    expect(won(hit)).toBe(2);
    expect(judge(hit, bar, false)).toBe(hit);
    expect(won(judge({ ...base, edgeCells: undefined }, bar, false))).toBe(0);
  }
  for (const p of [99.899, 100.201]) expect(won(judge(base, { t: cell.t, l: p, h: p, c: p }, false))).toBe(0);
});

test("edge-tolerant worker quotes match direct pricing of the larger hit region", async () => {
  const lib = readLibrary(new Uint8Array(await Bun.file(new URL("./dots-lib.bin", import.meta.url)).arrayBuffer()));
  const bars: Bar[] = Array.from({ length: 320 }, (_, i) => { const c = 84000 + (i % 2 ? 0.5 : -0.5); return { t: at - (320 - i) * 1000, h: c + 0.2, l: c - 0.2, c }; });
  const f = features(bars, at)!;
  let offered = 0;
  for (const [width, height] of [[390, 844], [1280, 720], [987, 1500]]) {
    const { step, pitch, pxMs } = drawingLayout(width, height, stepFor(f.sigma, f.price));
    const fl = field(lib, f, at, step * INK_CELL, INK_CELL, INK_EDGE_CELLS);
    const old = field(lib, f, at, step * INK_CELL, INK_CELL);
    for (let i = 0; i < fl.chance.length; i++) expect(fl.chance[i]).toBeGreaterThanOrEqual(old.chance[i]);
    for (const nib of Object.values(PEN_CELLS)) for (const offset of [-3, -1, 0, 1, 3]) {
      const st = { ...dot(), p0: f.price + offset * stepFor(f.sigma, f.price), rt: nib * 10 / pxMs, rp: nib * 10 * step / pitch, pts: [{ t: 0, p: 0 }, { t: 5000, p: step * 4 }] };
      const bet = placeArea(st, 1, step, at - 100, "padded", INK_EDGE_CELLS)!;
      const quick = openOn(bet, fl) ?? open(bet, lib, bars);
      const exact = open(bet, lib, bars);
      offered += quick.cells.length;
      expect(quick.status).toBe(exact.status);
      expect(quick.cells.map(({ chance: _, ...c }) => c)).toEqual(exact.cells.map(({ chance: _, ...c }) => c));
      expect(openOn(bet, old)).toBeNull();
      expect(openOn({ ...bet, edgeCells: undefined }, fl)).toBeNull();
      for (const c of quick.cells) {
        expect(c.area * c.multiple).toBeGreaterThanOrEqual(1.1 - 1e-9);
        expect(c.area * c.multiple).toBeLessThanOrEqual(RULES.maxMultiple + 1e-9);
        expect(c.multiple * c.chance!).toBeLessThanOrEqual(RULES.rtp + 1e-9);
      }
    }
  }
  expect(offered).toBeGreaterThan(0);
});


test("rounded sections preserve area and price the entire touched band", async () => {
  const lib = readLibrary(new Uint8Array(await Bun.file(new URL("./dots-lib.bin", import.meta.url)).arrayBuffer()));
  const bars: Bar[] = Array.from({ length: 320 }, (_, i) => { const c = 84000 + (i % 2 ? 0.5 : -0.5); return { t: at - (320 - i) * 1000, h: c + 0.2, l: c - 0.2, c }; });
  const f = features(bars, at)!;
  let offered = 0;
  for (const [width, height] of [[390, 844], [1280, 720], [987, 1500]]) {
    const { step, pitch, pxMs } = drawingLayout(width, height, stepFor(f.sigma, f.price));
    const fl = field(lib, f, at, step * INK_CELL, INK_CELL, INK_EDGE_CELLS);
    for (const nib of Object.values(PEN_CELLS)) for (const offset of [-1, 0, 1]) {
      const st = { ...dot(), p0: f.price + offset * stepFor(f.sigma, f.price), rt: nib * 10 / pxMs, rp: nib * 10 * step / pitch, pts: [{ t: 0, p: 0 }, { t: 5000, p: step * 4 }] };
      expect(roundedCells(st, at, step).reduce((a,c)=>a+c.area,0)).toBeCloseTo(areaCells(st, at, step).reduce((a,c)=>a+c.area,0), 8);
      const placed = placeRounded(st, 1, step, at - 100, "round", INK_EDGE_CELLS)!;
      const quick = openOn(placed, fl) ?? open(placed, lib, bars);
      const exact = open(placed, lib, bars);
      const quote = roundedTerms(fl, at - 100, step, 1).line(st);
      expect(quick.status).toBe(exact.status);
      expect(quick.cells.map(({chance:_,...c})=>c)).toEqual(exact.cells.map(({chance:_,...c})=>c));
      expect(cost(quick)-refund(quick)).toBeCloseTo(quote.cost, 8);
      offered += quick.cells.length;
      let bet=quick;
      for (const t of new Set(quick.cells.map(c=>c.t))) bet=judge(bet,{t,l:80000,h:90000,c:f.price},true);
      expect(won(bet)).toBe(quote.high);
      for (const c of quick.cells) {
        expect(c.multiple).toBeGreaterThanOrEqual(1.1-1e-9);
        expect(c.area*c.multiple).toBeLessThanOrEqual(MAX_INK_MULTIPLE + 1e-9);
        expect(c.multiple*c.chance!).toBeLessThanOrEqual(Math.max(RULES.ladderBest, 1.1*c.chance!)+1e-9);
      }
    }
  }
  expect(offered).toBeGreaterThan(0);
});


test("a steep stroke is not rejected as one oversized capped section", () => {
  const st = { ...dot(180, 0.35), t0: at + 6000, pts: [{ t: 0, p: 0 }, { t: 900, p: -14 }] };
  const atoms = areaCells(st, at, 1);
  const sections = roundedCells(st, at, 1);
  expect(sections.reduce((n,c)=>n+c.area,0)).toBeCloseTo(atoms.reduce((n,c)=>n+c.area,0), 9);
  for (const atom of atoms) expect(sections.some(c=>c.t===atom.t && c.lo<=atom.lo+1e-9 && c.hi>=atom.hi-1e-9)).toBe(true);
  for (const second of new Set(atoms.map(c=>c.t))) {
    const same = sections.filter(c=>c.t===second);
    const total = atoms.filter(c=>c.t===second).reduce((n,c)=>n+c.area,0);
    if (total > 10) expect(same.length).toBeGreaterThan(1);
    for (let i=1;i<same.length;i++) expect(same[i].lo).toBeCloseTo(same[i-1].hi, 9);
  }
});

test("varied payouts are monotone, stay below fair odds, and avoid the hard cap plateau", async () => {
  const { roundedMultiple, cappedRoundedMultiple, smoothRoundedMultiple } = await import("./ink-area");
  const values: number[] = [];
  for (const p of [0.1, 0.05, 0.01, 0.005, 0.001]) {
    const m = roundedMultiple(p, RULES.rtp, 1)!;
    expect(m).toBeGreaterThanOrEqual(1.1);
    expect(m).toBeLessThanOrEqual(MAX_INK_MULTIPLE);
    expect(m * p).toBeLessThanOrEqual(RULES.rtp + 1e-12);
    expect(cappedRoundedMultiple(p, RULES.rtp, 1)!).toBeLessThanOrEqual(RULES.maxMultiple);
    expect(smoothRoundedMultiple(p, RULES.rtp, 1)!).toBeLessThanOrEqual(RULES.maxMultiple);
    values.push(m);
  }
  expect(new Set(values).size).toBeGreaterThanOrEqual(3);
  for (let i=1;i<values.length;i++) expect(values[i]).toBeGreaterThanOrEqual(values[i-1]);
});


test("new drawing odds cover ordinary returns and genuine 25x long shots", async () => {
  const { roundedMultiple } = await import("./ink-area");
  expect(roundedMultiple(RULES.rtp / 2, RULES.rtp, 1)).toBe(2);
  expect(roundedMultiple(RULES.rtp / 100, RULES.rtp, 1)).toBe(25);
  expect(roundedMultiple(RULES.rtp / 1000, RULES.rtp, 1)).toBe(25);
});


test("a ten dollar drawing is not a loss before its time window closes", () => {
  const placed = placeRounded(dot(), 10, 1, at - 100, "ten")!;
  const drawn = { t: at + 6000, lo: 99, hi: 101, area: 1 };
  const live: InkBet = { ...placed, drawn: [drawn], status: "live", cells: [{ ...drawn, multiple: 2, status: "live" }] };
  expect(liveInkTotals([live]).pnl).toBe(0);
  const waiting = judge(live, { t: drawn.t, l: 103, h: 104, c: 103 }, false);
  expect(waiting.status).toBe("live");
  expect(liveInkTotals([waiting]).pnl).toBe(0);
  const missed = judge(waiting, { t: drawn.t, l: 103, h: 104, c: 103 }, true);
  expect(missed.status).toBe("done");
  expect(liveInkTotals([missed], { committed: cost(missed) - refund(missed), returned: won(missed) }).pnl).toBe(-10);
  const hit = judge(live, { t: drawn.t, l: 100, h: 100, c: 100 }, false);
  expect(liveInkTotals([hit], { committed: cost(hit) - refund(hit), returned: won(hit) }).pnl).toBe(10);
});

test("partial losses update realized P&L while the rest remains pending", () => {
  const placed = placeRounded(dot(), 0.1, 1, at - 100, "fraction")!;
  const a = { t: at + 6000, lo: 99, hi: 100, area: 0.3333 };
  const b = { ...a, t: at + 7000 };
  const live: InkBet = { ...placed, drawn: [a, b, { ...a, t: at + 8000 }], status: "live", cells: [{ ...a, multiple: 2, status: "miss" }, { ...b, multiple: 2, status: "live" }] };
  const totals = liveInkTotals([live]);
  expect(totals.committed).toBe(0.07);
  expect(totals.settledCost).toBe(0.03);
  expect(totals.pending).toBe(0.04);
  expect(totals.pnl).toBe(-0.03);
  const done: InkBet = { ...live, status: "done", cells: live.cells.map(c => ({ ...c, status: "miss" })) };
  expect(liveInkTotals([done], { committed: cost(done) - refund(done), returned: 0 }).pnl).toBe(-0.07);
});

test("fair-v1 returns its target per dollar at every size, with a 1.1x floor", async () => {
  const { fairSection } = await import("./ink-area");
  const target = RULES.rtp;
  for (const area of [0.05, 0.3, 1, 1.7, 2]) for (const p of [0.98, 0.9, 0.5, 0.2, 0.08, 0.03, 0.01, 0.001]) {
    const q = fairSection(p, target, area)!;
    // Always offered, never under 1.1x a dollar, never over 100x a dot, never a bigger stake than was drawn.
    expect(q).not.toBeNull();
    expect(q.multiple).toBeGreaterThanOrEqual(MIN_INK_MULTIPLE);
    expect(q.area * q.multiple).toBeLessThanOrEqual(MAX_INK_MULTIPLE + 1e-9);
    expect(q.area).toBeLessThanOrEqual(area + 1e-12);
    const perDollar = q.multiple * p;
    if (target / p < MIN_INK_MULTIPLE) { expect(q.multiple).toBe(MIN_INK_MULTIPLE); continue; }
    // Otherwise: the target per dollar staked, less at most a cent of multiple.
    expect(perDollar).toBeLessThanOrEqual(target + 1e-12);
    expect(target - perDollar).toBeLessThanOrEqual(0.01 * p + 1e-12);
  }
  // A long shot pays the cap on a smaller stake, exactly fair.
  const far = fairSection(0.001, target, 1)!;
  expect(far.area * far.multiple).toBeCloseTo(MAX_INK_MULTIPLE, 9);
  expect(far.multiple * 0.001).toBeCloseTo(target, 12);
});

test("new drawings open on ladder-v1, and preview, opening and settlement agree", async () => {
  const lib = readLibrary(new Uint8Array(await Bun.file(new URL("./dots-lib.bin", import.meta.url)).arrayBuffer()));
  const bars: Bar[] = Array.from({ length: 320 }, (_, i) => { const c = 84000 + (i % 2 ? 0.5 : -0.5); return { t: at - (320 - i) * 1000, h: c + 0.2, l: c - 0.2, c }; });
  const f = features(bars, at)!;
  const { ladderSection, LADDER } = await import("./ink-area");
  const LADDER_BEST = RULES.ladderBest;
  for (const [width, height] of [[390, 844], [820, 1180], [1000, 577], [2560, 1300]]) {
    const { step, pitch, pxMs } = drawingLayout(width, height, stepFor(f.sigma, f.price));
    const fl = field(lib, f, at, step * INK_CELL, INK_CELL, INK_EDGE_CELLS);
    const st = { ...dot(), p0: f.price + stepFor(f.sigma, f.price), rt: 7 / pxMs, rp: 7 * step / pitch, pts: [{ t: 0, p: 0 }, { t: 6000, p: -step * 6 }] };
    const placed = placeRounded(st, 1, step, at - 100, "fair", INK_EDGE_CELLS)!;
    expect(placed.model).toBe("ladder-v1");
    const bet = openOn(placed, fl) ?? open(placed, lib, bars);
    const quote = roundedTerms(fl, at - 100, step, 1).line(st);
    expect(cost(bet) - refund(bet)).toBeCloseTo(quote.cost, 8);
    for (const c of bet.cells) {
      // Re-pricing what opened reproduces it: the stake and the multiple are settled.
      expect(ladderSection(c.chance!, rtpAt(f, (c.lo + c.hi) / 2), c.area)).toEqual({ area: c.area, multiple: c.multiple });
      // A rung, or under the floor its fair multiple to the hundredth, at least 1x; never more than a dollar back.
      if (c.multiple < RULES.ladderFloor) expect(c.multiple).toBeGreaterThanOrEqual(1);
      else expect([RULES.ladderFloor, ...LADDER]).toContain(c.multiple);
      expect(c.multiple * c.chance!).toBeLessThanOrEqual(Math.max(LADDER_BEST, c.chance!) + 1e-9);
    }
  }
});

test("ladder-v1 pays a rung, the highest the chance allows, and never beats its best", async () => {
  const { ladderSection, LADDER } = await import("./ink-area");
  const LADDER_BEST = RULES.ladderBest;
  for (const p of [0.999, 0.99, 0.95, 0.9, 0.6, 0.45, 0.3, 0.2, 0.1, 0.05, 0.02, 0.01, 0.001]) {
    const q = ladderSection(p, RULES.rtp, 1)!;
    const fair = LADDER_BEST / p;
    expect(q.area).toBe(1);
    expect(ladderSection(p, RULES.rtp, 5)!.area * q.multiple).toBeLessThanOrEqual(256 + 1e-9);
    const higher = LADDER.filter(r => r > q.multiple);
    // The next rung up would be more than the chance supports.
    if (higher.length) expect(higher[0]).toBeGreaterThan(fair - 1e-9);
    if (fair >= RULES.ladderFloor) {
      expect([RULES.ladderFloor, ...LADDER]).toContain(q.multiple);
      expect(q.multiple * p).toBeLessThanOrEqual(LADDER_BEST + 1e-12);
    } else {
      // Too likely for the floor: its fair multiple to the hundredth, never under 1x, so never more than a dollar back.
      expect(q.multiple).toBe(Math.max(1, Math.floor(fair * 100 + 1e-9) / 100));
      expect(q.multiple * p).toBeLessThanOrEqual(Math.max(LADDER_BEST, p) + 1e-12);
    }
  }
  // 99% likely at 55: fair 0.99x, so it pays 1x and returns 99 cents, not the 1.1x it once paid.
  expect(ladderSection(0.99, RULES.rtp, 1)!.multiple).toBe(1);
  expect(ladderSection(0.9, RULES.rtp, 1)!.multiple).toBe(1.08);
});

test("ink bet as it is drawn adds up to the whole stroke, nothing charged twice", async () => {
  const { newInk } = await import("./ink-area");
  const { placeInk } = await import("./ink");
  const whole = { ...dot(180, 0.35), t0: at + 3000, pts: Array.from({ length: 40 }, (_, k) => ({ t: k * 250, p: Math.sin(k / 3) * 2 })) };
  const full = areaCells(whole, at, 1).reduce((n, c) => n + c.area, 0);
  let prev: typeof whole | null = null, sum = 0;
  for (let n = 4; n <= 40; n += 4) {
    const st = { ...whole, pts: whole.pts.slice(0, n) };
    const piece = newInk(st, prev, at, 1);
    for (const c of piece) expect(c.area).toBeGreaterThan(0);
    sum += piece.reduce((a, c) => a + c.area, 0);
    prev = st;
  }
  expect(sum).toBeCloseTo(full, 6);
  // Going back over ink already bet adds nothing.
  const back = { ...whole, pts: [...whole.pts, ...whole.pts.slice(30, 39).reverse()] };
  expect(newInk(back, whole, at, 1).reduce((a, c) => a + c.area, 0)).toBeLessThan(0.02);
  // A piece opens on the second after it was drawn, on the ladder, in the drawing's group.
  const bet = placeInk(whole, null, 1, 1, at - 100, "piece", "drawing")!;
  expect(bet.model).toBe("ladder-v1");
  expect(bet.group).toBe("drawing");
  expect(bet.openAt).toBe(at);
  expect(placeInk(whole, whole, 1, 1, at - 100, "none", "drawing")).toBeNull();
});

test("difficulty lowers the ladder, and nothing ever pays under 1x", async () => {
  const { ladderSection } = await import("./ink-area");
  const was = RULES.difficulty;
  try {
    let before = Infinity;
    for (const d of [0, 25, 50, 70, 75, 90, 100]) {
      setDifficulty(d);
      expect(RULES.ladderFloor).toBeGreaterThanOrEqual(1);
      const q = ladderSection(0.04, RULES.rtp, 1)!;
      expect(q.multiple).toBeLessThanOrEqual(before);
      before = q.multiple;
      expect(ladderSection(0.999, RULES.rtp, 1)!.multiple).toBeGreaterThanOrEqual(1);
    }
    setDifficulty(100);
    expect(RULES.ladderFloor).toBe(1);
  } finally {
    setDifficulty(was);
  }
});

test("a band is never likelier than one nearer the price", async () => {
  const lib = readLibrary(new Uint8Array(await Bun.file(new URL("./dots-lib.bin", import.meta.url)).arrayBuffer()));
  const bars: Bar[] = Array.from({ length: 320 }, (_, i) => { const c = 84000 + 3 * Math.sin(i / 7) + (i % 3) * 0.4; return { t: at - (320 - i) * 1000, h: c + 0.3, l: c - 0.3, c }; });
  const f = features(bars, at)!;
  const step = stepFor(f.sigma, f.price);
  const fl = field(lib, f, at, step * INK_CELL, INK_CELL, INK_EDGE_CELLS);
  const size = step * INK_CELL;
  for (const second of [2, 5, 10, 20, 29]) for (const height of [4, 7, 10, 20]) {
    const t = at + second * 1000;
    const p = Array.from({ length: fl.rows - height }, (_, r) => rangeChanceOf(fl, t, (fl.row0 + r) * size, (fl.row0 + r + height) * size, INK_EDGE_CELLS, INK_CELL));
    const peak = p.indexOf(Math.max(...p));
    for (let r = peak + 1; r < p.length; r++) expect(p[r]).toBeLessThanOrEqual(p[r - 1] + 1e-12);
    for (let r = peak - 1; r >= 0; r--) expect(p[r]).toBeLessThanOrEqual(p[r + 1] + 1e-12);
  }
});

test("no band is taller than the widest pen at the smallest chart, which the chain caps", async () => {
  const { MAX_SECTION_WIDTH, sectionsOf } = await import("./ink-area");
  const { PEN_CELLS } = await import("./ink");
  const { GRID, unitFor, withinFee } = await import("./chain");
  // The widest pen is PEN_CELLS.wide screen steps; the smallest chart drawingLayout draws makes a screen step tallest.
  const marketStep = 10;
  const smallest = drawingLayout(390, 0, marketStep);
  expect(smallest.bottom - smallest.top).toBe(120);
  const widest = (PEN_CELLS.wide * smallest.step) / unitFor(marketStep);
  expect(widest).toBeCloseTo(6750 / 120, 6);
  expect(widest).toBeLessThan(MAX_SECTION_WIDTH);
  expect(MAX_SECTION_WIDTH).toBeLessThan(1.5 * GRID);
  // A sliver of a steep stroke: 300 rows of a second, almost no area. Cut into bands no taller than the cap, every row
  // and every bit of area kept.
  const step = 1 / INK_CELL;
  const rows = Array.from({ length: 300 }, (_, r) => ({ t: 5000, lo: r, hi: r + 1, area: 1e-4 }));
  const out = sectionsOf(rows, step);
  for (const s of out) expect(Math.round(s.hi - s.lo)).toBeLessThanOrEqual(MAX_SECTION_WIDTH);
  expect(out.reduce((n, s) => n + Math.round(s.hi - s.lo), 0)).toBe(300);
  expect(out.reduce((n, s) => n + s.area, 0)).toBeCloseTo(0.03, 9);
  expect(out.length).toBe(Math.ceil(300 / MAX_SECTION_WIDTH));
  // Ordinary ink is cut by area as before.
  const pen = Array.from({ length: 12 }, (_, r) => ({ t: 5000, lo: r, hi: r + 1, area: 0.3 }));
  expect(sectionsOf(pen, step).length).toBe(2);
  expect(withinFee(960_000_000, 100, 400)).toBe(true);
  expect(withinFee(960_000_001, 100, 400)).toBe(false);
});

test("on chain, ink that returns more than the stake fee leaves is not offered", async () => {
  const { ladderSection } = await import("./ink-area");
  const { RULES, setMaxReturn, setDifficulty } = await import("./dots");
  setDifficulty(55);
  // At 55, ink exactly on 2x returns 0.98: offered in practice, not where the chain keeps 4%.
  const p = RULES.ladderBest / 2;
  expect(ladderSection(p, RULES.rtp, 1)?.multiple).toBe(2);
  setMaxReturn(0.96);
  expect(ladderSection(p, RULES.rtp, 1)).toBeNull();
  // Near-certain ink under the floor: not offered either. A long shot just under its rung still is.
  expect(ladderSection(0.97, RULES.rtp, 1)).toBeNull();
  expect(ladderSection(0.005, RULES.rtp, 1)?.multiple).toBe(128);
  setMaxReturn(1);
  expect(ladderSection(0.97, RULES.rtp, 1)?.multiple).toBe(1.01);
});
