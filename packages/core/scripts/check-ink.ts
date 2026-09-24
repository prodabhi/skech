import { type Bar, CAL_EDGES, features, readLibrary, RULES, setDifficulty, stepFor } from "../src/dots";
import { CELL, type InkBet, judge, open, PEN_CELLS, type Pen, place, type Stroke } from "../src/ink";
/*
  Draw strokes on days the paths never saw, with the engine the page runs,
  and report what every kind of stroke got back per dollar of ink. Fair
  pricing pays about RULES.rtp whoever draws.

    bun packages/core/scripts/check-ink.ts <dots-lib.bin> <folder of BTC-USD-1s CSVs (MARKET=BTCUSDT for Binance)> 2026-09-17 [more days]

  PEN=fine|medium|wide draws every stroke with that pen, as the page does:
  as wide as its cells are tall. Without it, pens of every width on the
  finest cells.
*/
const [libPath, dataDir, ...days] = process.argv.slice(2);
// How hard, 0 to 100 (the game's default unless DIFFICULTY is set); RTP and MAX override single levers, for trying them apart.
if (process.env.DIFFICULTY) setDifficulty(Number(process.env.DIFFICULTY));
if (process.env.RTP) Object.assign(RULES, { rtp: Number(process.env.RTP) });
if (process.env.MAX) Object.assign(RULES, { maxMultiple: Number(process.env.MAX) });
if (process.env.MIN) Object.assign(RULES, { minMultiple: Number(process.env.MIN) });
if (process.env.MOM) Object.assign(RULES, { momentumMargin: Number(process.env.MOM) });
// How tall a row is, in one-second moves, for trying row sizes.
if (process.env.STEPSIG) Object.assign(RULES, { stepSigmas: Number(process.env.STEPSIG) });
console.log(`difficulty ${RULES.difficulty}: rtp ${RULES.rtp}, ${RULES.minMultiple}x to ${RULES.maxMultiple}x, momentum margin ${RULES.momentumMargin}`);
const lib = readLibrary(new Uint8Array(await Bun.file(libPath).arrayBuffer()));
const STEP = Number(process.env.STEP ?? 60);
const PEN = process.env.PEN as Pen | undefined;
const cell = PEN ? PEN_CELLS[PEN] : CELL;
let seed = 5;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
type Acc = { n: number; staked: number; paid: number; hits: number; segs: number; implied: number; won: number };
const tables: Record<string, Record<string, Acc>> = { stroke: {}, multiple: {}, day: {} };
/** How often points were really hit against the chance they were priced on, by band of chance: what `calibrate` corrects. */
const cal: { n: number; p: number; hits: number }[] = [];
/** Each kind of stroke's drawings, net of their cost, in order. */
const sessions: Record<string, number[]> = {};
const acc = (t: string, k: string) => (tables[t][k] ??= { n: 0, staked: 0, paid: 0, hits: 0, segs: 0, implied: 0, won: 0 });
const bucket = (m: number) => (m < 2 ? "a  1.1-2x" : m < 5 ? "b  2-5x" : m < 15 ? "c  5-15x" : m < 40 ? "d  15-40x" : "e  40-100x");

for (const day of days) {
  const bars: Bar[] = (await Bun.file(`${dataDir}/${process.env.MARKET ?? "BTC-USD"}-1s-${day}.csv`).text()).trim().split("\n").map((r) => {
    const f = r.split(",");
    return { t: Math.floor(Number(f[0]) / 1000), h: +f[2], l: +f[3], c: +f[4] };
  });
  for (let i = 320; i < bars.length - RULES.horizon - 3; i += STEP) {
    const now = bars[i].t + 1000 + Math.floor(rand() * 1000);
    const openAt = bars[i + 1].t + 1000;
    const hist = bars.slice(i - 305, i + 2);
    const f = features(hist, openAt);
    if (!f) continue;
    const step = stepFor(f.sigma, f.price);
    const unit = f.sigma * f.price;
    const up = Math.sign(f.momentum) || 1;
    const pen = (k: number) => (PEN ? { rt: 250 + cell * 300, rp: (cell * step) / 2 } : { rt: 250 + k * 500, rp: unit * (0.3 + k * 1.5) });
    const stroke = (pts: { t: number; p: number }[], k: number): Stroke => ({ t0: openAt, p0: f.price, pts, ...pen(k) });
    const wander = (start: number, z0: number, len: number) => {
      const pts: { t: number; p: number }[] = [];
      let z = z0;
      let v = (rand() - 0.5) * 0.6;
      for (let s = start; s <= start + len; s += 0.5) (v += (rand() - 0.5) * 0.3), (z += v * 0.3), pts.push({ t: s * 1000, p: z * unit * Math.sqrt(s) });
      return pts;
    };
    const strokes: [string, Stroke][] = [
      ["wander from near the price", stroke(wander(1.5, (rand() - 0.5), 5 + rand() * 25), rand())],
      ["wander, far out", stroke(wander(5 + rand() * 10, (rand() < 0.5 ? -1 : 1) * (1.5 + rand() * 2), 3 + rand() * 12), rand())],
      ["a flick, anywhere", stroke(wander(2 + rand() * 25, (rand() - 0.5) * 6, 1 + rand() * 2), rand())],
      ["thick blob near the price", stroke([{ t: 3000, p: 0 }, { t: 6000, p: 0 }], 1)],
      ["thin level line", stroke([{ t: 2000, p: 2 * unit * up }, { t: 30000, p: 2 * unit * up }], 0)],
      ["bot, with the last 3s", stroke([{ t: 2000, p: up * 1.5 * unit }, { t: 8000, p: up * 3 * unit }], 0.3)],
      ["bot, against the last 3s", stroke([{ t: 2000, p: -up * 1.5 * unit }, { t: 8000, p: -up * 3 * unit }], 0.3)],
    ];
    if (Math.abs(f.momentum) > 1.5) strokes.push(["bot, chase a jump", stroke([{ t: 2000, p: up * unit }, { t: 6000, p: up * 3 * unit }], 0.4)]);
    for (const [who, st] of strokes) {
      let bet: InkBet | null = place(st, 0.1, step, now, who, cell);
      if (!bet) continue;
      bet = open(bet, lib, hist);
      for (let j = i + 2; j < bars.length && bet.status === "live"; j++) bet = judge(bet, bars[j], true, bars[j - 1].c);
      if (bet.status === "void") continue;
      const staked = bet.cells.reduce((s, g) => s + bet!.perUnit * g.area, 0);
      const paid = bet.cells.reduce((s, g) => s + (g.paid ?? 0), 0);
      (sessions[who] ??= []).push(paid - staked);
      for (const [t, k] of [["stroke", who], ["day", day]] as const) {
        const a = acc(t, k);
        a.n++, (a.staked += staked), (a.paid += paid), (a.won += paid > staked ? 1 : 0);
        for (const g of bet.cells) (a.segs++, (a.hits += g.status === "hit" ? 1 : 0), (a.implied += 1 / g.multiple));
      }
      for (const g of bet.cells) {
        const band = CAL_EDGES.findIndex((e) => (g.chance ?? 0) < e);
        const c = (cal[band < 0 ? CAL_EDGES.length : band] ??= { n: 0, p: 0, hits: 0 });
        c.n++, (c.p += g.chance ?? 0), (c.hits += g.status === "hit" ? 1 : 0);
        const a = acc("multiple", bucket(g.multiple));
        a.segs++, (a.staked += bet.perUnit * g.area), (a.paid += g.paid ?? 0), (a.hits += g.status === "hit" ? 1 : 0), (a.implied += 1 / g.multiple);
      }
    }
  }
}
/*
  Sessions: a player's drawings in the order they came, fifty or two hundred
  at a time, of one kind of stroke. How often a session ends up ahead is
  what a player feels, more than what a dollar returns.
*/
for (const size of [50, 200]) {
  console.log(`\nSessions of ${size} drawings: how many ended ahead`);
  for (const [who, list] of Object.entries(sessions).sort()) {
    let n = 0;
    let ahead = 0;
    let worst = 0;
    let best = 0;
    for (let i = 0; i + size <= list.length; i += size) {
      const net = list.slice(i, i + size).reduce((a, b) => a + b, 0);
      n++;
      if (net > 0) ahead++;
      worst = Math.min(worst, net);
      best = Math.max(best, net);
    }
    if (n) console.log("  " + who.padEnd(30) + String(n).padStart(6) + ((100 * ahead) / n).toFixed(0).padStart(6) + "% ahead" + ("   best +" + best.toFixed(2)).padStart(16) + ("   worst " + worst.toFixed(2)).padStart(16) + "  (at 10¢ a point)");
  }
}
for (const [title, t] of Object.entries(tables)) {
  console.log(`\nBy ${title}`);
  console.log("  " + "".padEnd(30) + "drawings".padStart(9) + "    cells" + "  pays back" + "    cell hit" + "  priced" + "  drawing won");
  for (const [k, a] of Object.entries(t).sort())
    console.log("  " + k.padEnd(30) + String(a.n || "").padStart(9) + String(a.segs).padStart(9) + (a.paid / a.staked).toFixed(3).padStart(11) + ((100 * a.hits) / a.segs).toFixed(1).padStart(11) + "%" + ((100 * a.implied) / a.segs).toFixed(1).padStart(7) + "%" + (a.n ? ((100 * a.won) / a.n).toFixed(0) + "%" : "").padStart(13));
}

console.log("\nPriced chance against what happened, by band of chance (factor = hit / priced)");
cal.forEach((c, i) => c && console.log(`  below ${String(CAL_EDGES[i] ?? 1).padEnd(6)} n ${String(c.n).padStart(8)}  priced ${((100 * c.p) / c.n).toFixed(1).padStart(5)}%  hit ${((100 * c.hits) / c.n).toFixed(1).padStart(5)}%  factor ${(c.hits / c.p).toFixed(3)}`));
console.log("FACTORS " + JSON.stringify(CAL_EDGES.concat(1).map((_, i) => (cal[i] && cal[i].n > 200 ? Math.round((cal[i].hits / cal[i].p) * 1000) / 1000 : 1))));
