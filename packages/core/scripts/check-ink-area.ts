import { createHash } from "node:crypto";
import { DIFFICULTY, features, field, readLibrary, RULES, setDifficulty, stepFor, type Bar } from "../src/dots";
import { areaCells, drawingLayout, cost, INK_CELL, INK_EDGE_CELLS, judge, MIN_INK_MULTIPLE, MAX_INK_MULTIPLE, open, openOn, PEN_CELLS, placeRounded, refund, won, type Stroke } from "../src/ink";
import { roundedTerms as areaTerms } from "../src/odds";
import { gridStep } from "../src/chain";

/** Replay ladder-v1 with only information available at placement and opening.
 * Usage: STEP=300 OUT=report.json bun packages/core/scripts/check-ink-area.ts lib.bin csv-folder 2026-09-17 ...
 * This evaluates the shipped model; it never fits or changes calibration.
 * Input CSVs: one-second bars in Binance kline column order, microsecond timestamps: Coinbase BTC-USD from fetch-coinbase.ts by default, or MARKET=BTCUSDT for Binance klines.
 */
const [libPath, dataDir, ...days] = process.argv.slice(2);
if (!libPath || !dataDir || !days.length) throw new Error("Supply library, CSV folder and day(s)");
const cadence = Number(process.env.STEP ?? 300);
const perDot = Number(process.env.STAKE ?? 1);
if (!Number.isFinite(perDot) || perDot <= 0) throw new Error("STAKE must be positive");
if (!Number.isInteger(cadence) || cadence < 35) throw new Error("STEP must be an integer >= 35 seconds to avoid overlapping outcome windows");
setDifficulty(Number(process.env.DIFFICULTY ?? DIFFICULTY));
const bytes = new Uint8Array(await Bun.file(libPath).arrayBuffer());
const lib = readLibrary(bytes);
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
// Canvas fills the viewport; use the exact geometry shared with Stage.
const views = [
  { name: "phone", width: 390, height: 788 }, { name: "ipad-mini", width: 744, height: 1133 }, { name: "ipad", width: 820, height: 1180 },
  { name: "ipad-pro", width: 1024, height: 1366 }, { name: "ipad-landscape", width: 1180, height: 820 }, { name: "laptop", width: 1000, height: 577 },
  { name: "desktop", width: 1280, height: 672 }, { name: "macbook", width: 1512, height: 860 }, { name: "1080p", width: 1920, height: 960 }, { name: "1440p", width: 2560, height: 1300 },
];
let seed = 42;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
type Bucket = { attempted: number; placed: number; accepted: number; voids: number; debit: number; refunds: number; stake: number; paid: number; expected: number; profitable: number; pieces: number; hits: number; probability: number; area: number; offeredArea: number; previewPaid: number; blocks: Record<string, [number, number]> };
const blank = (): Bucket => ({ attempted: 0, placed: 0, accepted: 0, voids: 0, debit: 0, refunds: 0, stake: 0, paid: 0, expected: 0, profitable: 0, pieces: 0, hits: 0, probability: 0, area: 0, offeredArea: 0, previewPaid: 0, blocks: {} });
const groups = new Map<string, Bucket>();
const get = (k: string) => { let a = groups.get(k); if (!a) { a = blank(); groups.set(k, a); } return a; };
const hashes: Record<string, string> = {};
let samples = 0;
let assertions = 0;
const assert = (ok: boolean, why: string) => { assertions++; if (!ok) throw new Error(why); };
const started = Date.now();
for (const day of days) {
  const text = await Bun.file(`${dataDir}/${process.env.MARKET ?? "BTC-USD"}-1s-${day}.csv`).text();
  hashes[day] = sha(text);
  const bars: Bar[] = text.trim().split("\n").map(row => { const v = row.split(","); return { t: Number(v[0]) / 1000, h: Number(v[2]), l: Number(v[3]), c: Number(v[4]) }; });
  assert(bars.length === 86400, `Incomplete day ${day}`);
  assert(new Date(bars[0].t).toISOString().slice(0, 10) === day, `Wrong timestamp unit/day ${day}`);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    assert([b.t, b.h, b.l, b.c].every(Number.isFinite) && b.h >= b.l && b.c <= b.h && b.c >= b.l, `Invalid bar ${day}:${i}`);
    if (i) assert(b.t - bars[i - 1].t === 1000, `Gap/duplicate ${day}:${i}`);
  }
  for (let i = 320; i < bars.length - RULES.horizon - 3; i += cadence) {
    // Place 500ms after the last fully known bar. Price at the next whole second.
    const now = bars[i].t + 1500;
    const previewAt = bars[i].t + 1000;
    const openingAt = bars[i].t + 2000;
    const f = features(bars.slice(i - 305, i + 1), previewAt)!;
    const opening = features(bars.slice(i - 304, i + 2), openingAt)!;
    const marketStep = stepFor(f.sigma, f.price);
    const direction = Math.sign(f.momentum) || 1;
    // The same seeded targets across pens and viewports; no future path consulted.
    const offset = (random() * 2 - 1) * 2;
    const when = 4 + random() * 21;
    const strategies = [
      { name: "random-dot", pts: [{ t: when * 1000, p: offset * marketStep }] },
      { name: "level-line", pts: [{ t: 4000, p: offset * marketStep }, { t: 22000, p: offset * marketStep }] },
      { name: "momentum", pts: [{ t: 4000, p: direction * marketStep * 0.5 }, { t: 14000, p: direction * marketStep * 1.5 }] },
      { name: "contrarian", pts: [{ t: 4000, p: -direction * marketStep * 0.5 }, { t: 14000, p: -direction * marketStep * 1.5 }] },
      // Near-certain ink's worst case: ink only on the live price, in the first seconds it can be.
      { name: "on-price", pts: [{ t: 1000, p: 0 }, { t: 3000, p: 0 }] },
    ];
    const block = `${day}:${Math.floor(i / 3600)}`;
    // Ink is priced on a grid of the market step, the same on every screen and on chain; the screen sets only the pen's size in price and time.
    const priceStep = gridStep(marketStep);
    const previewMap = field(lib, f, previewAt, priceStep * INK_CELL, INK_CELL, INK_EDGE_CELLS);
    const openingMap = field(lib, opening, openingAt, priceStep * INK_CELL, INK_CELL, INK_EDGE_CELLS);
    for (const view of views) {
      const { step, pitch, pxMs } = drawingLayout(view.width, view.height, marketStep);
      for (const [pen, width] of Object.entries(PEN_CELLS)) for (const strategy of strategies) {
      const radius = width * 20 / 2;
      const st: Stroke = { t0: openingAt, p0: f.price, pts: strategy.pts, rt: radius / pxMs, rp: radius * step / pitch };
      const quote = areaTerms(previewMap, now, priceStep, perDot).line(st);
      const buckets = [get("all"), get(`pen:${pen}`), get(`viewport:${view.name}`), get(`strategy:${strategy.name}`), get(`day:${day}`), get(`case:${view.name}/${pen}/${strategy.name}`)];
      const fullArea = areaCells(st, openingAt, priceStep).reduce((s, c) => s + c.area, 0);
      for (const a of buckets) { a.attempted++; a.area += fullArea; a.offeredArea += fullArea - quote.out.reduce((s, c) => s + c.area, 0); }
      if (quote.cost < 0.01 || !quote.inPlay.length) continue;
      const placed = placeRounded(st, perDot, priceStep, now, `${samples}:${view.name}:${pen}:${strategy.name}`, INK_EDGE_CELLS)!;
      placed.drawn = quote.inPlay.map(({ t, lo, hi, area }) => ({ t, lo, hi, area }));
      let bet = openOn(placed, openingMap) ?? open(placed, lib, bars.slice(i - 304, i + 2));
      assert(!!bet, "Opening field mismatch");
      const debit = cost(bet), back = refund(bet), stake = debit - back;
      assert(Math.abs(debit - quote.cost) < 1e-8 && back >= -1e-8 && back <= debit + 1e-8, "Debit/refund mismatch");
      const expected = bet.cells.reduce((n, c) => n + perDot * c.area * c.multiple * (c.chance ?? 0), 0);
      assert(expected <= bet.cells.reduce((n, c) => n + perDot * c.area * Math.max(RULES.ladderBest, c.chance ?? 0), 0) + 1e-8, "A section beats its best, or returns more than a dollar");
      for (const c of bet.cells) {
        const m = c.area * c.multiple;
        assert(c.multiple >= 1 - 1e-9 && m <= MAX_INK_MULTIPLE + 1e-9, "Multiplier bounds violated");
        assert(c.multiple * (c.chance ?? 0) <= Math.max(RULES.ladderBest, c.chance ?? 0) + 1e-9, "Expected payout exceeds pricing target");
      }
      for (let j = i + 2; j <= i + RULES.horizon + 2 && bet.status === "live"; j++) bet = judge(bet, bars[j], true, bars[j - 1].c);
      assert(bet.status === "void" || bet.status === "done", "Unsettled contract");
      const paid = won(bet);
      const probability = bet.cells.reduce((n, c) => n + (c.chance ?? 0), 0);
      const hits = bet.cells.filter(c => c.status === "hit").length;
      for (const a of buckets) {
        a.placed++; a.debit += debit; a.refunds += back; a.stake += stake; a.paid += paid; a.expected += expected;
        a.previewPaid += quote.high; a.pieces += bet.cells.length; a.hits += hits; a.probability += probability;
        if (bet.status === "void") a.voids++; else a.accepted++;
        if (paid > stake) a.profitable++;
        const b = a.blocks[block] ??= [0, 0]; b[0] += stake; b[1] += paid;
      }
    }
    }
    samples++;
  }
  console.log(JSON.stringify({ day, samples, seconds: Math.round((Date.now() - started) / 1000), cumulativeReturn: get("all").paid / get("all").stake }));
}
// Resample whole hours, keeping correlated pieces and simultaneous strategies together.
function interval(a: Bucket) {
  const blocks = Object.values(a.blocks), ratios: number[] = [];
  if (blocks.length < 2) return null;
  for (let b = 0; b < 1000; b++) {
    let stake = 0, paid = 0;
    for (let i = 0; i < blocks.length; i++) { const k = blocks[Math.floor(random() * blocks.length)]; stake += k[0]; paid += k[1]; }
    if (stake) ratios.push(paid / stake);
  }
  ratios.sort((a, b) => a - b);
  return [ratios[Math.floor(ratios.length * 0.025)], ratios[Math.floor(ratios.length * 0.975)]];
}
const report = {
  model: "ladder-v1", cadenceSeconds: cadence, samples, seed: 42, perDot, rules: { ...RULES, maxInkMultiple: MAX_INK_MULTIPLE }, views, days,
  librarySha256: sha(bytes), dataSha256: hashes, assertions, elapsedSeconds: (Date.now() - started) / 1000,
  caveats: ["September 17–23 is out of the library's documented September 1–16 window, but was used to evaluate previous model versions; this is retrospective validation, not an untouched final holdout.", "Replays completed one-second bars, not intrasecond execution latency. Fresh viewport camera and market step at each independent sample.", "Confidence intervals resample hours; they do not guarantee future returns. Four predefined strategies are not an exhaustive exploit search."],
  results: Object.fromEntries([...groups].map(([key, a]) => { const { blocks, ...counts } = a; return [key, { ...counts, returnPerDollar: a.paid / a.stake, modelReturnPerDollar: a.expected / a.stake, return95CI: interval(a), profitableFraction: a.profitable / a.accepted, offeredAreaFraction: a.offeredArea / a.area, observedHitRate: a.hits / a.pieces, predictedHitRate: a.probability / a.pieces, hourBlocks: Object.keys(blocks).length }]; })),
};
const out = process.env.OUT ?? "ink-area-backtest.json";
await Bun.write(out, JSON.stringify(report, null, 2) + "\n");
for (const [key, a] of Object.entries(report.results)) if (!key.startsWith("case:")) console.log(`${key.padEnd(24)} n=${a.accepted} actual=${a.returnPerDollar.toFixed(3)} model=${a.modelReturnPerDollar.toFixed(3)} offered=${(100 * a.offeredAreaFraction).toFixed(1)}% CI=${a.return95CI?.map(x => x.toFixed(3)).join("–")}`);
console.log(`Saved ${out}; ${assertions} invariant checks passed.`);
