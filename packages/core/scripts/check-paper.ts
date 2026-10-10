import { features, field, readLibrary, RULES, setDifficulty, stepFor, type Bar } from "../src/dots";
import { cost, drawingLayout, INK_CELL, INK_EDGE_CELLS, judge, open, openOn, PEN_CELLS, placeRounded, refund, won, type Stroke } from "../src/ink";
import { roundedTerms as areaTerms } from "../src/odds";
import { gridStep } from "../src/chain";

/**
 * How the thirty-second paper run plays at each difficulty: the replay of
 * `check-ink-area.ts`, with only the strokes someone new draws near the price
 * (a level line within a market step of it, one with the move, one against
 * it, one along the price itself, one from the price drifting off it, a zigzag
 * across it), at the default ten cents a dot.
 *
 *   DIFFICULTIES=55,50,25,0 STEP=300 bun packages/core/scripts/check-paper.ts lib.bin csv-folder 2026-10-07 ...
 *
 * A section's chance is measured on the paths and does not depend on the
 * difficulty: whether the price touches a line is the market's, at any
 * setting. What the difficulty moves is the rung each section pays, so it is
 * what decides how often a round comes out ahead. Printed for each level:
 * the share of drawings the price touched at all, the share that came out
 * ahead (the round card's "You won"), and what came back per dollar.
 */
const [libPath, dataDir, ...days] = process.argv.slice(2);
if (!libPath || !dataDir || !days.length) throw new Error("Supply library, CSV folder and day(s)");
const cadence = Number(process.env.STEP ?? 300);
const perDot = Number(process.env.STAKE ?? 0.1);
const levels = (process.env.DIFFICULTIES ?? "55,50,40,30,20,10,0,-25,-50").split(",").map(Number);
const lib = readLibrary(new Uint8Array(await Bun.file(libPath).arrayBuffer()));
const views = [{ name: "phone", width: 390, height: 788 }, { name: "laptop", width: 1000, height: 577 }, { name: "desktop", width: 1280, height: 672 }];
let seed = 7;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
type Acc = { placed: number; touched: number; ahead: number; stake: number; paid: number; cells: number; hits: number };
const blank = (): Acc => ({ placed: 0, touched: 0, ahead: 0, stake: 0, paid: 0, cells: 0, hits: 0 });
const results = new Map<string, Acc>();
const acc = (k: string) => results.get(k) ?? (results.set(k, blank()), results.get(k)!);
let samples = 0;
for (const day of days) {
  const text = await Bun.file(`${dataDir}/${process.env.MARKET ?? "BTC-USD"}-1s-${day}.csv`).text();
  const bars: Bar[] = text.trim().split("\n").map(row => { const v = row.split(","); return { t: Number(v[0]) / 1000, h: Number(v[2]), l: Number(v[3]), c: Number(v[4]) }; });
  if (bars.length !== 86400) throw new Error(`Incomplete day ${day}`);
  for (let i = 320; i < bars.length - RULES.horizon - 3; i += cadence) {
    const now = bars[i].t + 1500;
    const previewAt = bars[i].t + 1000;
    const openingAt = bars[i].t + 2000;
    const f = features(bars.slice(i - 305, i + 1), previewAt)!;
    const opening = features(bars.slice(i - 304, i + 2), openingAt)!;
    const marketStep = stepFor(f.sigma, f.price);
    const direction = Math.sign(f.momentum) || 1;
    const offset = (random() * 2 - 1) * 1;
    const strategies = [
      { name: "level-line", pts: [{ t: 4000, p: offset * marketStep }, { t: 22000, p: offset * marketStep }] },
      { name: "momentum", pts: [{ t: 4000, p: direction * marketStep * 0.5 }, { t: 14000, p: direction * marketStep * 1.5 }] },
      { name: "contrarian", pts: [{ t: 4000, p: -direction * marketStep * 0.5 }, { t: 14000, p: -direction * marketStep * 1.5 }] },
      { name: "on-price", pts: [{ t: 3000, p: 0 }, { t: 15000, p: 0 }] },
      // From the price at the wait line, drifting half a step up or down: the first stroke most people try.
      { name: "from-price", pts: [{ t: 3000, p: 0 }, { t: 15000, p: (random() < 0.5 ? -1 : 1) * marketStep * 0.5 }] },
      // A zigzag across the price, a few seconds a swing.
      { name: "zigzag", pts: [0, 1, 2, 3, 4].map(k => ({ t: 3000 + k * 3000, p: (k % 2 ? 1 : -1) * marketStep * 0.4 })) },
    ];
    const priceStep = gridStep(marketStep);
    // A section's chance does not depend on the difficulty: the maps are measured once, and each level prices off them.
    const previewMap = field(lib, f, previewAt, priceStep * INK_CELL, INK_CELL, INK_EDGE_CELLS);
    const openingMap = field(lib, opening, openingAt, priceStep * INK_CELL, INK_CELL, INK_EDGE_CELLS);
    for (const view of views) {
      const { step, pitch, pxMs } = drawingLayout(view.width, view.height, marketStep);
      for (const [pen, width] of Object.entries(PEN_CELLS)) for (const strategy of strategies) {
        const radius = width * 20 / 2;
        const st: Stroke = { t0: openingAt, p0: f.price, pts: strategy.pts, rt: radius / pxMs, rp: radius * step / pitch };
        for (const d of levels) {
          setDifficulty(d, d);
          const quote = areaTerms(previewMap, now, priceStep, perDot).line(st);
          if (quote.cost < 0.01 || !quote.inPlay.length) continue;
          const placed = placeRounded(st, perDot, priceStep, now, `${samples}:${view.name}:${pen}:${strategy.name}`, INK_EDGE_CELLS)!;
          placed.drawn = quote.inPlay.map(({ t, lo, hi, area }) => ({ t, lo, hi, area }));
          let bet = openOn(placed, openingMap) ?? open(placed, lib, bars.slice(i - 304, i + 2));
          if (bet.status === "void") continue;
          for (let j = i + 2; j <= i + RULES.horizon + 2 && bet.status === "live"; j++) bet = judge(bet, bars[j], true, bars[j - 1].c);
          const stake = cost(bet) - refund(bet), paid = won(bet);
          const hits = bet.cells.filter(c => c.status === "hit").length;
          for (const k of [`${d}`, `${d}/${strategy.name}`, `${d}/pen:${pen}`]) {
            const a = acc(k);
            a.placed++; a.stake += stake; a.paid += paid; a.cells += bet.cells.length; a.hits += hits;
            if (hits > 0) a.touched++;
            if (paid > stake + 1e-9) a.ahead++;
          }
        }
      }
    }
    samples++;
  }
  console.error(`${day}: ${samples} moments so far`);
}
const pct = (x: number) => `${(100 * x).toFixed(1)}%`.padStart(6);
console.log(`${samples} moments, ${views.length} screens, 3 pens, 6 strokes, ${perDot} a dot, on ${days.join(", ")}`);
console.log("difficulty  bestInk  drawings  touched  ahead   perDollar  cellsHit");
for (const d of levels) {
  setDifficulty(d, d);
  const a = acc(`${d}`);
  console.log(`${String(d).padStart(10)}  ${RULES.ladderBest.toFixed(2).padStart(7)}  ${String(a.placed).padStart(8)}  ${pct(a.touched / a.placed)}  ${pct(a.ahead / a.placed)}  ${(a.paid / a.stake).toFixed(3).padStart(9)}  ${pct(a.hits / a.cells)}`);
}
for (const d of levels) {
  const parts = [...results].filter(([k]) => k.startsWith(`${d}/`)).map(([k, a]) => `${k.slice(String(d).length + 1)} ahead ${pct(a.ahead / a.placed).trim()} touched ${pct(a.touched / a.placed).trim()} $${(a.paid / a.stake).toFixed(2)}`);
  console.log(`${d}: ${parts.join(" · ")}`);
}
