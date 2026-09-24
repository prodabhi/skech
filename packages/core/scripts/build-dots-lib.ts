import { type Bar, excursion, features, LIB_SCALE, type Library, RULES, SIGMA_DEFAULT, SWING_SCALE, VOL_LAG, WICK_MS, writeLibrary } from "../src/dots";
/*
  Build the library dots are priced on: real thirty-second stretches
  of Bitcoin, from Coinbase BTC-USD one-second bars (scripts/fetch-coinbase.ts), each with the volatility, momentum
  and in-second swing it started on, as `features()` reads them live.

    bun packages/core/scripts/build-dots-lib.ts <folder of BTC-USD-1s CSVs (MARKET=BTCUSDT for Binance)> <out.bin> 2026-09-01 ... 2026-09-16

  Starts are spread evenly over how busy and how fast-moving the market was,
  so a jumpy moment has as many paths to compare with as a quiet one. The
  pick is seeded: the same days give the same bytes.
*/
const [dataDir, out, ...days] = process.argv.slice(2);
const PATHS = 16000;
const S = RULES.horizon;

const bars: Bar[] = [];
for (const day of days) {
  const text = await Bun.file(`${dataDir}/${process.env.MARKET ?? "BTC-USD"}-1s-${day}.csv`).text();
  for (const r of text.trim().split("\n")) {
    const f = r.split(",");
    bars.push({ t: Math.floor(Number(f[0]) / 1000), h: +f[2], l: +f[3], c: +f[4] });
  }
}
console.log(`${bars.length} seconds from ${days.length} days`);

/*
  Every start's volatility, as a rolling sum over the same five minutes
  `volatility()` reads. Checked against it below, so the two cannot differ.
*/
type Start = { i: number; ls: number; m: number; lw: number };
const starts: Start[] = [];
const W = RULES.volWindowMs / 1000;
for (let i = W + 5; i < bars.length - S - 2; i++) {
  if (bars[i + 1 + S].t - bars[i].t !== (S + 1) * 1000) continue; // a gap in the data: skip
  starts.push({ i, ls: 0, m: 0, lw: 0 });
}
{
  // Rolling: five-second moves whose both ends are inside [B - 300 s, B), B the end of bar i.
  let n = 0;
  let sum = 0;
  let sq = 0;
  const L = VOL_LAG;
  const ret = (k: number) => (k - L >= 0 && bars[k].t - bars[k - L].t === L * 1000 ? Math.log(bars[k].c / bars[k - L].c) : null);
  let first = -1; // index of the first bar in the window
  let last = -1; // last bar added
  const inWindow = (k: number) => k - L >= first;
  for (const s of starts) {
    const B = bars[s.i].t + 1000;
    let a = s.i;
    while (a > 0 && bars[a - 1].t >= B - RULES.volWindowMs) a--;
    if (first < 0) (first = a), (last = a - 1);
    while (last < s.i) {
      last++;
      if (inWindow(last)) {
        const r = ret(last);
        if (r !== null) (n++, (sum += r), (sq += r * r));
      }
    }
    while (first < a) {
      // The move ending first + L loses its start as `first` leaves the window.
      const k = first + L;
      if (k <= last) {
        const r = ret(k);
        if (r !== null) (n--, (sum -= r), (sq -= r * r));
      }
      first++;
    }
    const sd = n < 30 ? SIGMA_DEFAULT : Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2) / L);
    const sigma = Math.min(3e-4, Math.max(5e-6, sd));
    s.ls = Math.log(sigma);
    s.m = Math.log(bars[s.i].c / bars[s.i - 3].c) / (sigma * Math.sqrt(3));
    // The minute before B, as wickOf() reads it: bars with t in [B - 60 s, B).
    let wn = 0;
    let ws = 0;
    for (let k = s.i; k >= 1 && bars[k].t >= B - WICK_MS; k--) if (bars[k].t - bars[k - 1].t === 1000) (wn++, (ws += excursion(bars[k - 1].c, bars[k]) / bars[k].c));
    s.lw = wn < 20 ? 0.15 : Math.max(0.01, ws / wn / sigma);
  }
}
for (let k = 0; k < 200; k++) {
  const s = starts[Math.floor((k / 200) * starts.length)];
  const B = bars[s.i].t + 1000;
  const f = features(bars.slice(s.i - W - 2, s.i + 1), B)!;
  if (Math.abs(Math.log(f.sigma) - s.ls) > 1e-5 || Math.abs(f.momentum - s.m) > 1e-6 || Math.abs(f.wick - s.lw) > 1e-6) throw new Error(`rolling features differ at ${s.i}: ${Math.log(f.sigma)} vs ${s.ls}`);
}
console.log(`${starts.length} starts; features match features() on a sample`);

let seed = 11;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const quantiles = (xs: number[], k: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return Array.from({ length: k - 1 }, (_, q) => s[Math.floor(((q + 1) / k) * s.length)]);
};
const binOf = (edges: number[], x: number) => edges.filter((e) => x >= e).length;
const LS = 10;
const MB = 8;
const lsEdges = quantiles(starts.map((s) => s.ls), LS);
const mEdges = quantiles(starts.map((s) => s.m), MB);
const cells = new Map<number, Start[]>();
for (const s of starts) {
  const c = binOf(lsEdges, s.ls) * MB + binOf(mEdges, s.m);
  (cells.get(c) ?? cells.set(c, []).get(c)!).push(s);
}
const per = Math.ceil(PATHS / cells.size);
const picked: Start[] = [];
for (const [, list] of [...cells].sort((a, b) => a[0] - b[0])) {
  for (let k = 0; k < per && list.length; k++) picked.push(list.splice(Math.floor(rand() * list.length), 1)[0]);
}
picked.length = Math.min(picked.length, PATHS);

const n = picked.length;
// Second 0, the one a bet opens in, is stored too: its close is where second 1 starts from.
const T = S + 1;
const lib: Library = { n, seconds: T, lnSigma: new Float32Array(n), momentum: new Float32Array(n), wick: new Float32Array(n), close: new Int16Array(n * T), up: new Uint8Array(n * T), down: new Uint8Array(n * T) };
const i16 = (x: number) => Math.max(-32767, Math.min(32767, Math.round(x)));
const u8 = (x: number) => Math.max(0, Math.min(255, Math.round(x)));
let clipped = 0;
picked.forEach((s, p) => {
  const sigma = Math.exp(s.ls);
  const c0 = bars[s.i].c;
  const unit = (x: number) => Math.log(x / c0) / sigma; // a price, in volatilities from the start
  lib.lnSigma[p] = s.ls;
  lib.momentum[p] = s.m;
  lib.wick[p] = s.lw;
  let prev = 0;
  for (let j = 0; j <= S; j++) {
    const b = bars[s.i + 1 + j];
    const c = i16(unit(b.c) * LIB_SCALE);
    // Measured from the closes as stored, so what is read back is the bar's own high and low.
    const top = Math.max(prev, c) / LIB_SCALE;
    const bottom = Math.min(prev, c) / LIB_SCALE;
    const up = Math.max(0, unit(b.h) - top) * SWING_SCALE;
    const down = Math.max(0, bottom - unit(b.l)) * SWING_SCALE;
    if (up > 255 || down > 255) clipped++;
    lib.close[p * T + j] = c;
    lib.up[p * T + j] = u8(up);
    lib.down[p * T + j] = u8(down);
    prev = c;
  }
});
console.log(`${clipped} of ${n * T} seconds swung past what a byte holds`);
const bytes = writeLibrary(lib);
await Bun.write(out, bytes);
console.log(`${lib.n} paths, ${(bytes.length / 1024).toFixed(0)} KB -> ${out}`);
