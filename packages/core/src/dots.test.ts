import { beforeAll, expect, test } from "bun:test";
import { type Bar, type Bet, cost, features, field, hits, judge, type Library, multipleFor, open, openFor, place, readLibrary, refund, rowOf, RULES, stepFor, volatility, won, writeLibrary } from "./dots";

// These test how the game works, not how hard it is: they are written for the house's terms at 0.85 and 50x.
beforeAll(() => Object.assign(RULES, { rtp: 0.85, maxMultiple: 50, minMultiple: 1.01, momentumMargin: 0.11 }));

/** A library of `n` paths that all do the same thing: each second's close and swing, in volatilities. */
function flatLib(n: number, closes: number[], swing = 0): Library {
  const seconds = closes.length + 1;
  const lib: Library = { n, seconds, lnSigma: new Float32Array(n).fill(Math.log(5e-5)), momentum: new Float32Array(n), wick: new Float32Array(n).fill(0.15), close: new Int16Array(n * seconds), up: new Uint8Array(n * seconds), down: new Uint8Array(n * seconds) };
  for (let i = 0; i < n; i++)
    closes.forEach((c, j) => {
      lib.close[i * seconds + j + 1] = Math.round(c * 100);
      lib.up[i * seconds + j + 1] = swing * 20;
      lib.down[i * seconds + j + 1] = swing * 20;
    });
  return lib;
}

/** Five minutes of a price that rises a little every second, then `at`: the second a bet opens on. */
function history(price: number, drift = 0.02): { bars: Bar[]; at: number } {
  const t0 = 1_800_000_000_000;
  const bars: Bar[] = [];
  for (let s = 0; s < 320; s++) {
    const c = price + drift * s + (s % 2 ? 0.5 : -0.5);
    bars.push({ t: t0 + s * 1000, h: c + 0.2, l: c - 0.2, c });
  }
  return { bars, at: t0 + 320 * 1000 };
}

test("a price step is a round number near 1.2 typical moves", () => {
  expect(stepFor(5e-5, 84_000)).toBe(10); // 2.5 * 4.2 = 10.5
  expect(stepFor(1.5e-5, 84_000)).toBe(2.5); // 3.15, nearer 2.5 than 5 on a log scale
  expect(stepFor(2e-4, 84_000)).toBe(50); // 42, nearer 50 than 25
});

test("a row holds its bottom edge, not its top: a price on the line is in the upper row only", () => {
  expect(rowOf(84_200, 2)).toBe(42_100);
  expect(rowOf(84_199.99, 2)).toBe(42_099);
  const bet: Bet = { id: "b", placedAt: 0, openAt: 0, perDot: 1, step: 2, painted: [], status: "live", dots: [{ t: 5000, row: 42_099, multiple: 3, status: "live" }, { t: 5000, row: 42_100, multiple: 3, status: "live" }] };
  const after = judge(bet, { t: 5000, h: 84_200, l: 84_200, c: 84_200 }, true);
  expect(after.dots.map((d) => d.status)).toEqual(["miss", "hit"]);
});

test("volatility is read on five-second moves, so a price that rattles in place reads as quiet", () => {
  const t0 = 1_800_000_000_000;
  const rattle: Bar[] = Array.from({ length: 301 }, (_, s) => ({ t: t0 + s * 1000, h: 0, l: 0, c: 84_000 + (s % 2 ? 1 : -1) }));
  // A walk of $1 steps up or down, seeded: its five-second moves spread about $2.24.
  let seed = 3;
  let c = 84_000;
  const walk: Bar[] = Array.from({ length: 301 }, (_, s) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    c += (seed >> 16) & 1 ? 1 : -1;
    return { t: t0 + s * 1000, h: 0, l: 0, c };
  });
  // The rattle's one-second moves are twice the walk's, but over five seconds it has gone nowhere much.
  expect(volatility(rattle, t0 + 301_000)).toBeLessThan(volatility(walk, t0 + 301_000));
});

test("features: the price the second before opening, and the last three seconds' move", () => {
  const { bars, at } = history(84_000, 1);
  const f = features(bars, at)!;
  expect(f.price).toBe(bars.at(-1)!.c);
  expect(f.momentum).toBeGreaterThan(0);
  expect(features(bars.slice(0, 2), at)).toBeNull();
});

test("a drawing opens on the next second and keeps only dots from the second after that to the horizon", () => {
  const now = 1_800_000_000_400;
  const openAt = openFor(now);
  expect(openAt).toBe(1_800_000_001_000);
  const bet = place(
    [
      { t: openAt, row: 5 }, // the second it opens in: never part of it
      { t: openAt + 1000, row: 5 },
      { t: openAt + 1000, row: 5 }, // painted twice: one dot
      { t: openAt + 30_000, row: 5 },
      { t: openAt + 31_000, row: 5 }, // past the horizon
    ],
    0.1,
    2,
    now,
    "x",
  )!;
  expect(bet.painted).toEqual([{ t: openAt + 1000, row: 5 }, { t: openAt + 30_000, row: 5 }]);
  expect(cost(bet)).toBeCloseTo(0.2);
  expect(place([{ t: openAt, row: 1 }], 0.1, 2, now, "y")).toBeNull();
});

test("a dot's chance is the share of like paths whose second covers its row", () => {
  // Half the paths end second 1 two volatilities up, half stay put.
  const up = flatLib(50, [2]);
  const flat = flatLib(50, [0]);
  const lib: Library = { ...up, n: 100, lnSigma: new Float32Array(100).fill(Math.log(5e-5)), momentum: new Float32Array(100), wick: new Float32Array(100).fill(0.15), close: new Int16Array([...up.close, ...flat.close]), up: new Uint8Array(200), down: new Uint8Array(200) };
  const f = { price: 84_000, sigma: 5e-5, momentum: 0, wick: 0.15 };
  const step = 2.5; // one volatility is $4.20: two is $8.40, three rows up
  const fl = field(lib, f, 0, step);
  const at = (row: number) => fl.chance[row - fl.row0];
  const here = rowOf(84_000, step);
  // Second 1 moves from the start (0) to its close: the rows between are covered too.
  const noise = (1 - 0.5) / fl.paths;
  expect(at(here)).toBeCloseTo(1 + 0 / fl.paths, 5);
  expect(at(here + 3)).toBeCloseTo(0.5 + noise, 5);
  expect(at(here + 4)).toBe(0);
});

test("a chance pays rtp over it, rounded down, and only between 1.01x and 50x", () => {
  expect(multipleFor(0.1)).toBe(8.5);
  expect(multipleFor(0.03)).toBe(28);
  expect(multipleFor(0.02)).toBe(42);
  expect(multipleFor(0.75)).toBe(1.13);
  expect(multipleFor(0.85)).toBeNull(); // pays under 1.01x: not offered
  expect(multipleFor(0.01)).toBeNull(); // 85x: over the cap
  expect(multipleFor(0)).toBeNull();
});

test("a drawing's life: priced at opening, hit dots pay, the rest are missed, and dots not on offer come back", () => {
  // One path in ten ends its second second a volatility and a half up; the rest never move.
  const moves = flatLib(100, [0, 1.5, ...Array(28).fill(0)]);
  const still = flatLib(900, Array(30).fill(0));
  const lib: Library = { ...still, n: 1000, lnSigma: new Float32Array(1000).fill(Math.log(5e-5)), momentum: new Float32Array(1000), wick: new Float32Array(1000).fill(0.15), close: new Int16Array([...moves.close, ...still.close]), up: new Uint8Array([...moves.up, ...still.up]), down: new Uint8Array([...moves.down, ...still.down]) };
  const { bars, at } = history(84_000, 0);
  const f = features(bars, at)!;
  // Paths from a market as busy as this one, so every one counts.
  lib.lnSigma.fill(Math.log(f.sigma));
  const step = stepFor(f.sigma, f.price);
  const here = rowOf(f.price, step);
  const now = at - 500;
  let bet = place([{ t: at + 2000, row: here }, { t: at + 2000, row: here + 1 }, { t: at + 3000, row: here - 1 }], 0.5, step, now, "life")!;
  expect(bet.openAt).toBe(at);
  bet = open(bet, lib, bars);
  // The price row is certain and the row under it never happens: neither is on offer. The row above is a one-in-ten.
  expect(bet.status).toBe("live");
  expect(bet.dots.map((d) => d.row)).toEqual([here + 1]);
  // A little under 8.5: the test market rattles, and ink the way it last moved gets the momentum margin.
  expect(bet.dots[0].multiple).toBeGreaterThan(6);
  expect(bet.dots[0].multiple).toBeLessThan(9.4);
  expect(refund(bet)).toBeCloseTo(1);
  const p = f.price;
  bet = judge(bet, { t: at + 2000, h: p + step * 1.1, l: p, c: p }, true);
  expect(bet.dots.find((d) => d.row === here + 1)!.status).toBe("hit");
  // Its one dot on offer is decided, so the drawing is.
  expect(bet.status).toBe("done");
  expect(hits(bet)).toBe(1);
  const m = bet.dots.find((d) => d.row === here + 1)!.multiple;
  expect(won(bet)).toBe(Math.floor(0.5 * m * 100) / 100);
});

test("a drawing none of which is on offer when it opens is voided and costs nothing", () => {
  const lib = flatLib(200, Array(30).fill(0));
  const { bars, at } = history(84_000, 0);
  const f = features(bars, at)!;
  lib.lnSigma.fill(Math.log(f.sigma));
  const step = stepFor(f.sigma, f.price);
  const bet = open(place([{ t: at + 5000, row: rowOf(f.price, step) }], 1, step, at - 100, "v")!, lib, bars);
  expect(bet.status).toBe("void");
  expect(refund(bet)).toBe(cost(bet));
});

test("a dot is only missed once its second has closed, so a late trade can still land in it", () => {
  const bet: Bet = { id: "b", placedAt: 0, openAt: 0, perDot: 1, step: 1, painted: [], status: "live", dots: [{ t: 5000, row: 100, multiple: 4, status: "live" }] };
  const open1 = judge(bet, { t: 5000, h: 99.5, l: 99, c: 99 }, false);
  expect(open1.dots[0].status).toBe("live");
  const late = judge(open1, { t: 5000, h: 100.2, l: 99, c: 99 }, false);
  expect(late.dots[0].status).toBe("hit");
  expect(judge(bet, { t: 5000, h: 99.5, l: 99, c: 99 }, true).dots[0].status).toBe("miss");
});

test("the library survives a round trip, and the shipped one is the version the engine reads", async () => {
  const lib = flatLib(3, [1, -2, 3], 1);
  const back = readLibrary(writeLibrary(lib));
  expect([...back.close]).toEqual([...lib.close]);
  expect([...back.up]).toEqual([...lib.up]);
  const shipped = readLibrary(new Uint8Array(await Bun.file(new URL("./dots-lib.bin", import.meta.url)).arrayBuffer()));
  expect(shipped.n).toBe(16_000);
  expect(shipped.seconds).toBe(RULES.horizon + 1);
});

test("difficulty sets every lever together, harder all the way up", async () => {
  const { difficulty } = await import("./dots");
  const levels = [50, 60, 70, 80, 100].map(difficulty);
  expect(levels[0]).toMatchObject({ difficulty: 50, rtp: 0.78, maxMultiple: 15, minMultiple: 1.01, ladderBest: 1 });
  expect(levels[4]).toMatchObject({ rtp: 0.62, maxMultiple: 6, minMultiple: 1.1 });
  for (let i = 1; i < levels.length; i++) {
    expect(levels[i].rtp).toBeLessThan(levels[i - 1].rtp);
    expect(levels[i].maxMultiple).toBeLessThanOrEqual(levels[i - 1].maxMultiple);
    expect(levels[i].minMultiple).toBeGreaterThanOrEqual(levels[i - 1].minMultiple);
    expect(levels[i].momentumMargin).toBe(0.11);
  }
  // Out of range is the nearest end: under 50, ink on a rung would return more than a dollar, so it is 50.
  expect(difficulty(0)).toEqual(difficulty(50));
  expect(difficulty(-5)).toEqual(difficulty(50));
  expect(difficulty(49)).toEqual(difficulty(50));
  expect(difficulty(250)).toEqual(difficulty(100));
});
