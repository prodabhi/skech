/*
  Coinbase BTC-USD, one second at a time, for the library and the replay.

    bun packages/core/scripts/fetch-coinbase.ts <out folder> 2026-09-01 ... 2026-09-24

  Coinbase publishes no one-second candles, so this pages back through every
  public trade of each UTC day (GET /products/BTC-USD/trades) and folds them
  into bars the way the live feed does: each trade into the bar of its
  second, and a second with no trade closed flat at the last price. Written
  as BTC-USD-1s-<day>.csv in Binance's kline column order (open time in
  microseconds, open, high, low, close), which is all the scripts read.
*/
import { existsSync } from "node:fs";

const API = "https://api.exchange.coinbase.com/products/BTC-USD/trades";
const [outDir, ...days] = process.argv.slice(2);
if (!outDir || !days.length) throw new Error("Supply an output folder and day(s)");

type Trade = { trade_id: number; price: string; time: string };

// Public endpoints allow about ten requests a second; stay under it.
let nextSlot = 0;
async function page(after?: number): Promise<Trade[]> {
  for (let attempt = 0; ; attempt++) {
    const wait = Math.max(0, nextSlot - Date.now());
    nextSlot = Math.max(Date.now(), nextSlot) + 125;
    if (wait) await Bun.sleep(wait);
    const res = await fetch(`${API}?limit=1000${after ? `&after=${after}` : ""}`).catch(() => null);
    if (res?.ok) return (await res.json()) as Trade[];
    if (attempt > 8) throw new Error(`Coinbase failed at after=${after}: ${res?.status}`);
    await Bun.sleep(500 * 2 ** Math.min(attempt, 5));
  }
}

/** The id of the first trade at or after `ms`: trade ids only ever rise. */
async function firstIdAt(ms: number, hi: number): Promise<number> {
  let lo = 1;
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2);
    const trades = await page(mid + 1);
    const t = trades.length ? Date.parse(trades[0].time) : 0;
    if (t >= ms) hi = mid;
    else lo = mid;
  }
  // Settle the last thousand from one page.
  const trades = await page(hi + 1);
  const first = trades.filter((x) => Date.parse(x.time) >= ms).at(-1);
  return first ? first.trade_id : hi + 1;
}

const latest = (await page())[0].trade_id;

// Workers share one clock, so days run side by side within the rate limit.
await Promise.all(days.map(async (day) => {
  const out = `${outDir}/BTC-USD-1s-${day}.csv`;
  if (existsSync(out)) return console.log(`${day}: have it`);
  const start = Date.parse(`${day}T00:00:00Z`);
  const end = start + 86_400_000;
  const [from, to] = await Promise.all([firstIdAt(start, latest), firstIdAt(end, latest)]);
  // The last price before the day opened, so its first seconds are not empty.
  const before = (await page(from))[0];
  const h = new Float64Array(86_400).fill(Number.NaN);
  const l = new Float64Array(86_400).fill(Number.NaN);
  const c = new Float64Array(86_400).fill(Number.NaN);
  const lastId = new Float64Array(86_400);
  let cursor = to;
  let count = 0;
  while (cursor > from) {
    const trades = await page(cursor);
    if (!trades.length) break;
    for (const x of trades) {
      if (x.trade_id < from || x.trade_id >= to) continue;
      const s = Math.floor((Date.parse(x.time) - start) / 1000);
      if (s < 0 || s >= 86_400) continue;
      const p = Number(x.price);
      if (Number.isNaN(h[s])) { h[s] = p; l[s] = p; }
      else { h[s] = Math.max(h[s], p); l[s] = Math.min(l[s], p); }
      // The close is the second's last trade: the highest id in it.
      if (x.trade_id > lastId[s]) { lastId[s] = x.trade_id; c[s] = p; }
      count++;
    }
    cursor = trades.at(-1)!.trade_id;
  }
  let prev = before ? Number(before.price) : Number.NaN;
  if (Number.isNaN(prev)) prev = c.find((v) => !Number.isNaN(v)) ?? 0;
  const rows: string[] = [];
  for (let s = 0; s < 86_400; s++) {
    const open = prev;
    if (Number.isNaN(c[s])) { h[s] = l[s] = c[s] = prev; }
    const t = (start + s * 1000) * 1000;
    rows.push(`${t},${open},${h[s]},${l[s]},${c[s]},0,${t + 999_999},0,0,0,0,0`);
    prev = c[s];
  }
  await Bun.write(out, rows.join("\n") + "\n");
  console.log(`${day}: ${count} trades`);
}));
