import { type Bar, type Bet, type Dot, features, field, judge, open, place, readLibrary, rowOf, RULES, stepFor } from "../src/dots";
/*
  Paint dots on days the library never saw, with the engine the page runs,
  and report what every kind of player got back per dollar. Fair pricing
  pays about RULES.rtp (0.94) whoever plays, wherever they paint.

    bun packages/core/scripts/check-dots.ts <dots-lib.bin> <folder of BTC-USD-1s CSVs (MARKET=BTCUSDT for Binance)> 2026-09-17 [more days]
*/
const [libPath, dataDir, ...days] = process.argv.slice(2);
const lib = readLibrary(new Uint8Array(await Bun.file(libPath).arrayBuffer()));
const STEP = Number(process.env.STEP ?? 60);
let seed = 7;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

type Acc = { bets: number; dots: number; staked: number; paid: number; hits: number; implied: number; dropped: number; won: number };
const tables: Record<string, Record<string, Acc>> = { player: {}, multiple: {}, day: {}, volatility: {}, "5-15x by second": {}, "5-15x by distance": {}, "on-price 5-15x dots": {} };
const acc = (t: string, k: string) => (tables[t][k] ??= { bets: 0, dots: 0, staked: 0, paid: 0, hits: 0, implied: 0, dropped: 0, won: 0 });
let essSum = 0, essN = 0, essMin = Infinity;
const bucket = (m: number) => (m < 2 ? "a  1.1-2x" : m < 5 ? "b  2-5x" : m < 15 ? "c  5-15x" : m < 40 ? "d  15-40x" : "e  40-100x");

for (const day of days) {
  const text = await Bun.file(`${dataDir}/${process.env.MARKET ?? "BTC-USD"}-1s-${day}.csv`).text();
  const bars: Bar[] = text.trim().split("\n").map((r) => {
    const f = r.split(",");
    return { t: Math.floor(Number(f[0]) / 1000), h: +f[2], l: +f[3], c: +f[4] };
  });
  for (let i = 320; i < bars.length - RULES.horizon - 3; i += STEP) {
    const now = bars[i].t + 1000 + Math.floor(rand() * 1000); // partway through second i+1
    const openAt = bars[i + 1].t + 1000;
    const hist = bars.slice(i - 305, i + 2);
    const f = features(hist, openAt);
    if (!f) continue;
    const step = stepFor(f.sigma, f.price);
    const fl = field(lib, f, openAt, step);
    essSum += fl.paths; essN++; essMin = Math.min(essMin, fl.paths);
    const here = rowOf(f.price, step);
    const perSec = (f.sigma * f.price) / step; // rows in one typical one-second move
    const up = Math.sign(f.momentum) || 1;
    /** Every dot inside an ellipse: centre `sec` s after opening, `z` typical moves of that horizon off the price. */
    const blob = (sec: number, z: number, rs: number, rr: number): Dot[] => {
      const c = here + z * perSec * Math.sqrt(sec);
      const out: Dot[] = [];
      for (let s = Math.ceil(sec - rs); s <= sec + rs; s++)
        for (let r = Math.floor(c - rr); r <= c + rr; r++) if (((s - sec) / rs) ** 2 + ((r - c) / rr) ** 2 <= 1) out.push({ t: openAt + s * 1000, row: r });
      return out;
    };
    const players: [string, Dot[]][] = [
      ["blob near the price", blob(2 + rand() * 6, (rand() - 0.5) * 2, 0.6 + rand() * 2, 1 + rand() * 4)],
      ["blob anywhere", blob(2 + rand() * 27, (rand() - 0.5) * 6, 0.6 + rand() * 3, 1 + rand() * 6)],
      ["far dots, a few", blob(10 + rand() * 18, (rand() < 0.5 ? -1 : 1) * (2.5 + rand() * 1.5), 1, 1.2)],
      ["a wall across the price", blob(5 + rand() * 20, 0, 0.6, 40)],
      ["bot, with the last 3s", blob(2 + rand() * 5, up * 1.2, 1, 2)],
      ["bot, against the last 3s", blob(2 + rand() * 5, -up * 1.2, 1, 2)],
    ];
    // A stroke: a wander from ahead of now, painted with a round brush.
    {
      const out: Dot[] = [];
      let z = (rand() - 0.5) * 2;
      let v = (rand() - 0.5) * 0.6;
      const rr = 1 + rand() * 3;
      for (let s = 2; s <= 5 + rand() * 25; s++) (v += (rand() - 0.5) * 0.4), (z += v * 0.3), out.push(...blob(s, z, 0.6, rr));
      players.push(["drawn stroke", out]);
    }
    if (Math.abs(f.momentum) > 1.5) players.push(["bot, chase a 1.5σ jump", blob(3, up * 1, 1.2, 2)]);
    if (f.sigma < 2.5e-5) players.push(["bot, far dots in a quiet market", blob(20, up * 3, 3, 2)]);

    const vol = f.sigma < 1.5e-5 ? "a  under 1.5e-5" : f.sigma < 2.5e-5 ? "b  1.5-2.5e-5" : f.sigma < 5e-5 ? "c  2.5-5e-5" : f.sigma < 1e-4 ? "d  5e-5 to 1e-4" : "e  over 1e-4";
    for (const [who, painted] of players) {
      let bet: Bet | null = place(painted, 0.1, step, now, who);
      if (!bet) continue;
      bet = open(bet, lib, hist, fl);
      for (let j = i + 2; j < bars.length && bet.status === "live"; j++) bet = judge(bet, bars[j], true);
      const rows: [string, string][] = [["player", who], ["day", day], ["volatility", vol]];
      for (const [t, k] of rows) {
        const a = acc(t, k);
        a.bets++;
        a.dropped += bet.painted.length - bet.dots.length;
        const w = bet.dots.reduce((s, d) => s + (d.paid ?? 0), 0);
        if (w > bet.dots.length * bet.perDot) a.won++;
        for (const d of bet.dots) (a.dots++, (a.staked += bet.perDot), (a.paid += d.paid ?? 0), (a.hits += d.status === "hit" ? 1 : 0), (a.implied += 1 / d.multiple));
      }
      for (const d of bet.dots) if (d.multiple >= 5 && d.multiple < 15) {
        const j = Math.round((d.t - openAt) / 1000);
        const dist = Math.abs(d.row + 0.5 - (f.price / step)) / (perSec * Math.sqrt(j));
        const b = acc("5-15x by second", `${String(j).padStart(2)}s`);
        b.dots++, (b.staked += 0.1), (b.paid += d.paid ?? 0), (b.hits += d.status === "hit" ? 1 : 0), (b.implied += 1 / d.multiple);
        if (dist < 0.25) {
          const e = acc("on-price 5-15x dots", `sigma ${f.sigma < 2.5e-5 ? "a quiet" : f.sigma < 5e-5 ? "b mid" : "c busy"}  |m| ${Math.abs(f.momentum) < 0.5 ? "a <0.5" : Math.abs(f.momentum) < 1.5 ? "b <1.5" : "c big"}  step/move ${(step / (f.sigma * f.price)).toFixed(1)}`);
          e.dots++, (e.staked += 0.1), (e.paid += d.paid ?? 0), (e.hits += d.status === "hit" ? 1 : 0), (e.implied += 1 / d.multiple);
        }
        const c = acc("5-15x by distance", `${(Math.floor(dist * 4) / 4).toFixed(2)} moves out`);
        c.dots++, (c.staked += 0.1), (c.paid += d.paid ?? 0), (c.hits += d.status === "hit" ? 1 : 0), (c.implied += 1 / d.multiple);
      }
      for (const d of bet.dots) {
        const a = acc("multiple", bucket(d.multiple));
        a.dots++, (a.staked += bet.perDot), (a.paid += d.paid ?? 0), (a.hits += d.status === "hit" ? 1 : 0), (a.implied += 1 / d.multiple);
      }
    }
  }
}
for (const [title, t] of Object.entries(tables)) {
  console.log(`\nBy ${title}`);
  console.log("  " + "".padEnd(34) + "drawings".padStart(9) + "    dots" + "  pays back" + "  dot hit" + "  priced" + "  drawing won" + "  dropped");
  for (const [k, a] of Object.entries(t).sort())
    console.log("  " + k.padEnd(34) + String(a.bets || "").padStart(9) + String(a.dots).padStart(8) + (a.paid / a.staked).toFixed(3).padStart(11) + ((100 * a.hits) / a.dots).toFixed(1).padStart(8) + "%" + ((100 * a.implied) / a.dots).toFixed(1).padStart(7) + "%" + (a.bets ? ((100 * a.won) / a.bets).toFixed(0) + "%" : "").padStart(13) + String(a.dropped || "").padStart(9));
}
console.log(`\nPaths per moment: mean ${(essSum / essN).toFixed(0)}, least ${essMin.toFixed(0)}`);
