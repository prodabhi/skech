/**
 * skech: paint dots ahead of the price. Every dot the price passes through pays.
 *
 * The space ahead of now is a field of dots: one second wide, one price step
 * tall. You paint over them, and every dot you paint is a bet of the same
 * size, set by you (a dime a dot, say). So a drawing costs its area. A dot
 * pays its own multiple when the price passes through it: dots close to the
 * price, and soon, are likely and pay a little; dots far from it, in price
 * or in time, are unlikely and pay a lot.
 *
 * How likely is measured, not modelled: the field is laid over thousands of
 * real thirty-second stretches of Bitcoin, taken from moments that looked
 * like this one (as busy, moving the same way), and the share of them that
 * passed through a dot is its chance. A dot pays `rtp / chance`, so every
 * dot returns the same on average wherever it is: the house keeps the same
 * share of a long shot as of a sure thing.
 *
 * Time runs in whole seconds, as the price data does. A drawing opens on the
 * second after it is placed and is priced there, on everything known by
 * then. The second after that is never part of it, so nobody can react
 * faster than the bet. A dot is hit when its second's trades reach its step.
 *
 * Pure functions over plain data: the page runs it for free play, and the
 * server can run the same code once there is money in it.
 */

/** The least difficulty the game may be set to, here and on chain: below it, ink exactly on a rung returns more than a dollar. */
export const MIN_DIFFICULTY = 50;

/**
 * How hard the game is, from 50 to 100: one number that sets every lever the
 * house has, together. Below 50 ink exactly on a rung would return more than a
 * dollar, so a lower number is taken as 50, here and on chain.
 *
 *   rtp             0.94 - 0.32 * d/100          what a point returns on average
 *   maxMultiple     40 * 0.14^(d/100), at least 2x   the most one hit pays
 *   minMultiple     1.01, rising to 1.10 above 50    less than this is not offered
 *   momentumMargin  0.11 at every level          taken off the side it just moved to
 *   ladderBest      1.20 - 0.40 * d/100          what ink exactly on a ladder rung returns (new drawings)
 *   ladderFloor     1.1x, easing to 1x from 70 to 100   the least a rung pays; likelier ink pays its fair multiple, never under 1x
 *
 * The top payout is the trade: a low cap makes wins small and frequent but
 * offers only points near the price, a high one lets a line go anywhere and
 * win rarely. At 50 a point returns 78 cents and pays up to 15x: on 17-23
 * September the house kept about a quarter of what was drawn, a quarter of
 * lines won, and about a third of the rows near the price were on offer
 * (`check-ink.ts`, DIFFICULTY=, prints every level).
 *
 * `least` is the floor: MIN_DIFFICULTY for everything real. Only the paper
 * run (`paper.ts`), which has no money in it, passes its own, lower one.
 */
export function difficulty(d: number, least: number = MIN_DIFFICULTY) {
  const k = Math.min(100, Math.max(least, d)) / 100;
  return {
    difficulty: Math.round(k * 100),
    rtp: Math.round((0.94 - 0.32 * k) * 1000) / 1000,
    maxMultiple: Math.max(2, Math.round(40 * 0.14 ** k)),
    minMultiple: Math.round((1.01 + 0.18 * Math.max(0, k - 0.5)) * 100) / 100,
    // Held where it stopped a bot drawing with the last three seconds' move: raised with the rest, it took a fine pen's far points down to half a dollar back.
    momentumMargin: 0.11,
    // The ladder new drawings pay on. Higher difficulty lowers every rung a
    // spot earns; ink too likely for the floor pays its fair multiple, never under 1x.
    ladderBest: Math.round((1.2 - 0.4 * k) * 1000) / 1000,
    ladderFloor: Math.max(1, Math.round((1.1 - 0.1 * Math.max(0, k - 0.7) / 0.3) * 100) / 100),
  };
}
/** The game's difficulty, 50 to 100: the one setting for how much the house
 * keeps. At 55, ink exactly on a rung returns 98¢ a dollar, about 78¢ on
 * average once spots round down to their rung (Sept 17–24 replay: 0.779). */
export const DIFFICULTY = 55;

/*
  Calibration. The chance measured on the paths is right on average but not
  everywhere: on days the paths never saw, points priced at a given chance
  were hit more or less often than that, by band of chance and more so for
  thin rows. And the house offers only points whose chance clears a bar, so
  where the measure runs high, those are the points it offers. Each pen's
  chance can be scaled by what was really hit in its band (`check-ink.ts`
  prints the factors). Empty: factors fitted on 17-20 September did not hold
  on 21-23, where near-price points ran the other way, so what corrects the
  measure is paths from recent days, not a fixed table.
*/
/** The top of each band of chance. */
export const CAL_EDGES = [0.03, 0.06, 0.1, 0.16, 0.25, 0.4, 0.6, 0.8];
/** By pen, as its row's share of a step: hit / priced in each band, and the last above the top edge. */
export const CALIBRATION: Record<string, number[]> = {};
/** A measured chance, corrected for the pen's rows: unchanged for a row no pen draws. */
export function calibrate(p: number, cell: number): number {
  const f = CALIBRATION[String(cell)];
  if (!f || !(p > 0)) return p;
  const band = CAL_EDGES.findIndex((e) => p < e);
  return Math.min(0.999, p * f[band < 0 ? CAL_EDGES.length : band]);
}

export const RULES = {
  /** What a point returns on average, the most and least one pays, and the momentum margin: all set by `difficulty`. */
  ...difficulty(DIFFICULTY),
  /** Seconds ahead a dot may be. */
  horizon: 30 as const,
  /** Dots in one drawing. */
  maxDots: 400 as const,
  /** How the one-second volatility is read: the five minutes before. */
  volWindowMs: 300_000 as const,
  /** How tall a dot is, in the market's typical one-second moves. */
  // Rows this many one-second moves tall. At 1.2 a quiet market left the price's own row a near-certainty and the next one past the cap, so nothing in between; at 2.5 the ladder has steps, and the held-out week paid back the same (0.59 to 0.80 a day, Medium pen).
  stepSigmas: 2.5 as const,
  /** See `setMaxReturn`. */
  maxReturn: 1,
};

/**
 * The most a band may return per dollar before fees, chance × multiple: 1 − the stake fee when playing for real (the
 * chain does not offer ink that returns more, `withinFee`), and 1 otherwise, which the ladder never passes.
 */
export function setMaxReturn(r: number) {
  RULES.maxReturn = Math.min(1, Math.max(0, r));
}

/**
 * Set how hard the game is, for everything priced from now on: drawings
 * already opened keep the multiples they opened on. `least` as `difficulty`.
 */
export function setDifficulty(d: number, least: number = MIN_DIFFICULTY) {
  Object.assign(RULES, difficulty(d, least));
}

/** What one dot costs, in practice dollars. The first is the default. */
export const DOT_BETS = [0.1, 0.25, 0.5, 1] as const;
export const START_BALANCE = 1000;

export type Bar = { t: number; h: number; l: number; c: number };
/**
 * What a moment is priced on: the price, how busy the market is (`sigma`),
 * which way it has just moved (`momentum`) and how far it swings inside a
 * second beyond its moves between seconds (`wick`). The last matters for
 * dots, which are small: on days as busy as each other, one swung a fifth
 * more inside each second than another, and its dots were hit that much
 * more often.
 */
export type Features = { sigma: number; momentum: number; price: number; wick: number };

/**
 * A dot: its second (ms, from the feed's clock) and its price row, from
 * `row * step` up to but not including `(row + 1) * step`. A price exactly
 * on the line between two rows is in the upper one only: prices sit on
 * round numbers often, and counted in both, the row under the price was hit
 * twice as often as it was priced.
 */
export type Dot = { t: number; row: number };
export type DotStatus = "live" | "hit" | "miss";
export type BetDot = Dot & { multiple: number; status: DotStatus; paid?: number };

export type BetStatus = "opening" | "live" | "done" | "void";
export type Bet = {
  id: string;
  placedAt: number;
  /** The second it opens and is priced on. */
  openAt: number;
  /** What each dot costs. */
  perDot: number;
  step: number;
  /** As painted, before it opened. */
  painted: Dot[];
  /** As priced: the dots on offer when it opened, each with its multiple. */
  dots: BetDot[];
  status: BetStatus;
  /** Why it was voided, if it was. */
  why?: string;
  /**
   * The stroke as it was drawn, for the picture only: what is bet is
   * `painted`. Points in time and price from `t0` and `p0`, and the pen's
   * half-width in each, so it draws the same whatever the zoom.
   */
  stroke?: Stroke;
};

export type Stroke = { t0: number; p0: number; pts: { t: number; p: number }[]; rt: number; rp: number };

/* ------------------------------------------------------------------ */
/* How busy the market is, and which way it is going                   */
/* ------------------------------------------------------------------ */

export const SIGMA_DEFAULT = 6.85e-5;
const SIGMA_MIN = 5e-6;
const SIGMA_MAX = 3e-4;

/**
 * Volatility per second, as a fraction of price, from the closes of the five
 * minutes before `at` (a second boundary): the spread of five-second moves,
 * scaled to one second. Five, not one: from second to second the price
 * rattles between buyers and sellers, which makes a market look busier than
 * it is over the seconds a dot is ahead. Priced on one-second moves, a dot
 * on the price in a quiet market paid as if it were hit one time in ten; it
 * was hit four in ten. Clamped, so a frozen feed cannot make everything 100x.
 */
export function volatility(bars: Bar[], at: number): number {
  const from = at - RULES.volWindowMs;
  const bySecond = new Map<number, number>();
  for (const b of bars) if (b.t >= from && b.t < at) bySecond.set(Math.floor(b.t / 1000), b.c);
  let n = 0;
  let sum = 0;
  let sq = 0;
  for (const [sec, c] of bySecond) {
    const before = bySecond.get(sec - VOL_LAG);
    if (before === undefined) continue;
    const r = Math.log(c / before);
    n++;
    sum += r;
    sq += r * r;
  }
  if (n < 30) return SIGMA_DEFAULT;
  const sd = Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2) / VOL_LAG);
  return Math.min(SIGMA_MAX, Math.max(SIGMA_MIN, sd));
}
/** The move volatility is read on, in seconds. */
export const VOL_LAG = 5;

/**
 * Everything a bet opening at `at` is priced on: the price as the second
 * before closed, the volatility, and the last three seconds' move in units
 * of that volatility over three seconds. Null until those seconds exist.
 */
export function features(bars: Bar[], at: number): Features | null {
  const closeOf = (t: number) => {
    for (let i = bars.length - 1; i >= 0; i--) if (bars[i].t === t) return bars[i].c;
    return null;
  };
  const price = closeOf(at - 1000);
  const then = closeOf(at - 4000);
  if (!price || !then) return null;
  const sigma = volatility(bars, at);
  return { price, sigma, momentum: Math.log(price / then) / (sigma * Math.sqrt(3)), wick: wickOf(bars, at, sigma) };
}

/**
 * How far the price swings inside a second, beyond the move from the last
 * close to this one, over the minute before `at`: per bar, how far the high
 * went past the higher of the two closes plus how far the low went past the
 * lower, as a fraction of price, averaged, in volatilities.
 */
export function wickOf(bars: Bar[], at: number, sigma: number): number {
  let n = 0;
  let sum = 0;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const prev = bars[i - 1];
    if (b.t < at - WICK_MS || b.t >= at || b.t - prev.t !== 1000) continue;
    n++;
    sum += excursion(prev.c, b) / b.c;
  }
  return n < 20 ? WICK_DEFAULT : Math.max(0.01, sum / n / sigma);
}
/** A bar's reach past its two closes, in price. */
export const excursion = (prevClose: number, b: Bar) => Math.max(0, b.h - Math.max(prevClose, b.c)) + Math.max(0, Math.min(prevClose, b.c) - b.l);
export const WICK_MS = 60_000;
const WICK_DEFAULT = 0.15;

/* ------------------------------------------------------------------ */
/* The paths the chances are measured on                               */
/* ------------------------------------------------------------------ */

/**
 * Real thirty-second stretches of Bitcoin. For each: the volatility,
 * momentum and in-second swing it started with; and each second's close,
 * as a log move from the starting price in units of its own volatility
 * times 100, with how far that second's high and low went past its two
 * closes, in twentieths of a volatility.
 *
 * The swing is kept apart from the closes so it can be scaled: a path from
 * a moment that swung half as much inside each second is priced now with
 * its swings doubled. Matching on it instead left too few paths like now to
 * measure with.
 *
 * Second 0 is the second a bet opens in: never part of a bet, but where
 * second 1 starts from.
 *
 * Binary layout, little-endian: "SKRL", u32 version (3), u32 paths, u32
 * seconds (with second 0), then per path f32 ln(sigma), f32 momentum, f32 wick, and per
 * second i16 close, u8 up, u8 down.
 */
export type Library = { n: number; seconds: number; lnSigma: Float32Array; momentum: Float32Array; wick: Float32Array; close: Int16Array; up: Uint8Array; down: Uint8Array };
export const LIB_SCALE = 100;
export const SWING_SCALE = 20;

export function readLibrary(bytes: Uint8Array): Library {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== "SKRL" || v.getUint32(4, true) !== 3) throw new Error("Not a dots library");
  const n = v.getUint32(8, true);
  const seconds = v.getUint32(12, true);
  const lib: Library = { n, seconds, lnSigma: new Float32Array(n), momentum: new Float32Array(n), wick: new Float32Array(n), close: new Int16Array(n * seconds), up: new Uint8Array(n * seconds), down: new Uint8Array(n * seconds) };
  let o = 16;
  for (let i = 0; i < n; i++) {
    lib.lnSigma[i] = v.getFloat32(o, true);
    lib.momentum[i] = v.getFloat32(o + 4, true);
    lib.wick[i] = v.getFloat32(o + 8, true);
    o += 12;
    for (let j = 0; j < seconds; j++, o += 4) {
      lib.close[i * seconds + j] = v.getInt16(o, true);
      lib.up[i * seconds + j] = bytes[o + 2];
      lib.down[i * seconds + j] = bytes[o + 3];
    }
  }
  return lib;
}

export function writeLibrary(lib: Library): Uint8Array {
  const out = new Uint8Array(16 + lib.n * (12 + lib.seconds * 4));
  const v = new DataView(out.buffer);
  out.set([83, 75, 82, 76]);
  v.setUint32(4, 3, true);
  v.setUint32(8, lib.n, true);
  v.setUint32(12, lib.seconds, true);
  let o = 16;
  for (let i = 0; i < lib.n; i++) {
    v.setFloat32(o, lib.lnSigma[i], true);
    v.setFloat32(o + 4, lib.momentum[i], true);
    v.setFloat32(o + 8, lib.wick[i], true);
    o += 12;
    for (let j = 0; j < lib.seconds; j++, o += 4) {
      v.setInt16(o, lib.close[i * lib.seconds + j], true);
      out[o + 2] = lib.up[i * lib.seconds + j];
      out[o + 3] = lib.down[i * lib.seconds + j];
    }
  }
  return out;
}

/**
 * How much each path counts: by how like now it started. Measured on paths
 * from days held back from the library: wider than this and a strong move
 * was priced like a quiet one; narrower and the far regions got noisy.
 */
export const KERNEL = { lnSigma: 0.4, momentum: 0.3 } as const;

/**
 * How much each path counts: by how like now it started. After a sharp
 * move there are few moments like it, and the chances measured on a
 * handful of paths come out in holes and blotches; so the match widens
 * until at least `MIN_PATHS` paths count. It widens on how busy the market
 * is, and hardly at all on which way it just moved: widened on momentum
 * as much, a bot drawing the way a jump went got back 1.23 per dollar,
 * because the jump was priced like a quiet moment.
 */
export const MIN_PATHS = 1500;
export function weightsFor(lib: Library, f: Features): { w: Float64Array; paths: number } {
  const w = new Float64Array(lib.n);
  const ls = Math.log(f.sigma);
  let paths = 0;
  for (let round = 0; round < 6; round++) {
    const busy = KERNEL.lnSigma * 1.5 ** round;
    const moved = KERNEL.momentum * (round >= 4 ? 1.25 : 1);
    let all = 0;
    let sq = 0;
    for (let i = 0; i < lib.n; i++) {
      const a = (lib.lnSigma[i] - ls) / busy;
      const b = (lib.momentum[i] - f.momentum) / moved;
      const wi = Math.exp(-0.5 * (a * a + b * b));
      w[i] = wi;
      all += wi;
      sq += wi * wi;
    }
    paths = sq > 0 ? (all * all) / sq : 0;
    if (paths >= MIN_PATHS) break;
  }
  return { w, paths };
}
const weights = (lib: Library, f: Features) => weightsFor(lib, f).w;

/* ------------------------------------------------------------------ */
/* The field: every dot's chance                                       */
/* ------------------------------------------------------------------ */

/** The price steps a dot can be, so the axis reads in round numbers. */
export const NICE = [0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100];

/** How tall a dot is for this market: `stepSigmas` one-second moves, to the nearest round step. */
export function stepFor(sigma: number, price: number): number {
  const want = RULES.stepSigmas * sigma * price;
  return NICE.reduce((best, s) => (Math.abs(Math.log(s / want)) < Math.abs(Math.log(best / want)) ? s : best), NICE[0]);
}

export const rowOf = (price: number, step: number) => Math.floor(price / step);

/**
 * Every dot's chance, for a drawing opening at `openAt`: seconds 1 to
 * `horizon` after it, rows `row0` to `row0 + rows - 1`. Each path is laid
 * over the field once, adding its weight to every dot its range covers in
 * each second.
 */
export type Field = { lowCdf?: Float64Array; highCdf?: Float64Array; edgeCells?: number; openAt: number; step: number; row0: number; rows: number; seconds: number; chance: Float32Array; rtp: number; f: Features; /** How many paths the chances rest on, as an effective count. */ paths: number; /** Band chances made to fall away from the likeliest price, by second and band height: filled as asked for. */ falling?: Map<number, Float32Array> };

export function field(lib: Library, f: Features, openAt: number, step: number, cell = 0, edgeCells = 0): Field {
  const job = fieldJob(lib, f, openAt, step, cell, edgeCells);
  job.run(Infinity);
  return job.result();
}

/**
 * `field`, a slice at a time: `run(n)` lays the next `n` paths over the field and says whether all of them are
 * in. The same sums in the same order, so the result is exactly `field`'s. A phone, with no worker to hand the
 * map to, runs a few milliseconds of it a frame and has it inside the second without stalling the pen.
 */
export function fieldJob(
  lib: Library,
  f: Features,
  openAt: number,
  step: number,
  cell = 0,
  edgeCells = 0,
  /*
    For the phone, which prices only bands (`rangeChanceOf`, from the CDFs) and only as far ahead as its screen:
    `perRow: false` skips each fine row's own chance (`chance`, empty), most of the work; `seconds` stops early.
    The rows are the full horizon's either way, so every CDF it does make is the full map's, bit for bit.
  */
  opts: { seconds?: number; perRow?: boolean } = {},
): { run: (paths: number) => boolean; result: () => Field } {
  const horizon = lib.seconds - 1;
  const seconds = Math.max(1, Math.min(horizon, opts.seconds ?? horizon));
  const perRow = opts.perRow ?? true;
  // Far enough to hold any move the paths make, and bounded to 512 fine rows either way for large viewports.
  const reach = Math.min(512, Math.ceil((8 * f.sigma * f.price * Math.sqrt(horizon)) / step));
  const here = rowOf(f.price, step);
  const row0 = here - reach;
  const rows = reach * 2 + 1;
  const acc = new Float64Array(perRow ? seconds * rows : 0);
  const lowHistogram = new Float64Array(seconds * (rows + 2));
  const highHistogram = new Float64Array(seconds * (rows + 2));
  const w = weights(lib, f);
  let all = 0;
  let sq = 0;
  const k = f.sigma / LIB_SCALE;
  let i = 0;
  const run = (budget: number) => {
    for (const last = Math.min(lib.n, i + budget); i < last; i++) {
      const wi = w[i];
      if (wi < 1e-5) continue;
      all += wi;
      sq += wi * wi;
      // This path's swings, scaled to how far the market swings inside a second now.
      const swing = (Math.min(3, Math.max(0.33, f.wick / lib.wick[i])) * LIB_SCALE) / SWING_SCALE;
      const base = i * lib.seconds;
      let prev = lib.close[base];
      for (let j = 0; j < seconds; j++) {
        const c = lib.close[base + j + 1];
        // The second's high and low, once each: the band it covers and the histograms both read them.
        const rawHigh = f.price * Math.exp((Math.max(prev, c) + lib.up[base + j + 1] * swing) * k);
        const rawLow = f.price * Math.exp((Math.min(prev, c) - lib.down[base + j + 1] * swing) * k);
        const hi = rowOf(rawHigh + edgeCells * step, step) - row0;
        const lowPrice = rawLow - edgeCells * step;
        const lo = (edgeCells ? Math.ceil(lowPrice / step) - 1 : rowOf(lowPrice, step)) - row0;
        highHistogram[j * (rows + 2) + Math.min(rows + 1, Math.max(0, Math.floor(rawHigh / step) - row0 + 1))] += wi;
        lowHistogram[j * (rows + 2) + Math.min(rows + 1, Math.max(0, Math.ceil(rawLow / step) - row0))] += wi;
        prev = c;
        if (!perRow) continue;
        const a = Math.max(0, lo);
        const b = Math.min(rows - 1, hi);
        for (let r = a; r <= b; r++) acc[j * rows + r] += wi;
      }
    }
    return i >= lib.n;
  };
  const result = (): Field => {
    /*
      A chance measured on `paths` paths is off by about sqrt(p(1-p)/paths),
      and paying 1/p on an estimate that is sometimes low pays more than the
      estimate is worth on average: on days the library had not seen, dots
      paid back 1.08 per dollar before this. Adding (1-p)/paths to each chance
      takes that back out, to first order. It raises rare dots most, which is
      where the estimate is thinnest.
    */
    const paths = sq > 0 ? (all * all) / sq : 0;
    const chance = new Float32Array(perRow ? seconds * rows : 0);
    if (perRow && all > 0 && paths > 0)
      for (let x = 0; x < acc.length; x++) {
        const p = acc[x] / all;
        chance[x] = p > 0 ? calibrate(p + (1 - p) / paths, cell) : 0;
      }
    const lowCdf = new Float64Array(seconds * (rows + 1));
    const highCdf = new Float64Array(seconds * (rows + 1));
    if (all > 0)
      for (let j = 0; j < seconds; j++) {
        let low = 0,
          high = 0;
        for (let r = 0; r <= rows; r++) {
          low += lowHistogram[j * (rows + 2) + r];
          high += highHistogram[j * (rows + 2) + r];
          lowCdf[j * (rows + 1) + r] = low / all;
          highCdf[j * (rows + 1) + r] = high / all;
        }
      }
    return { lowCdf, highCdf, edgeCells, openAt, step, row0, rows, seconds, chance, rtp: rtpFor(f), f, paths };
  };
  return { run, result };
}

/** A dot's chance on a field; zero off it. */
export function chanceOf(fl: Field, d: Dot): number {
  const j = Math.round((d.t - fl.openAt) / 1000);
  const r = d.row - fl.row0;
  // A map made without each row's chance (`perRow: false`) has none to give.
  if (j < 1 || j > fl.seconds || r < 0 || r >= fl.rows || !fl.chance.length) return 0;
  return fl.chance[(j - 1) * fl.rows + r];
}

/**
 * What a dollar returns on average, for a spot at `price` on this market.
 * Less on the side the price has just moved towards, the harder it moved:
 * on days the paths had not seen, a move carried on further than the paths
 * said, and a bot drawing the way the last three seconds went got back
 * 1.04 per dollar, 1.12 just after a jump, when every spot was priced
 * alike. The other side is priced as usual.
 */
export function rtpAt(f: Features, price: number): number {
  const withIt = Math.sign(price - f.price) === Math.sign(f.momentum);
  return withIt ? RULES.rtp - RULES.momentumMargin * Math.min(2, Math.abs(f.momentum)) : RULES.rtp;
}
/** The return for a spot in no particular direction: the usual one. */
export const rtpFor = (_f: Features) => RULES.rtp;

/** What a chance pays: `rtp / chance`, to two figures and never rounded up. Null when it is not offered. */
export function multipleFor(p: number, rtp: number = RULES.rtp): number | null {
  if (!(p > 0)) return null;
  const fair = rtp / p;
  if (fair < RULES.minMultiple || fair > RULES.maxMultiple) return null;
  const unit = fair >= 10 ? 1 : fair >= 2 ? 0.1 : 0.01;
  return Math.round(Math.floor(fair / unit + 1e-9) * unit * 100) / 100;
}

export const multipleOf = (fl: Field, d: Dot) => multipleFor(chanceOf(fl, d), rtpAt(fl.f, (d.row + 0.5) * fl.step));

/* ------------------------------------------------------------------ */
/* A drawing's life                                                    */
/* ------------------------------------------------------------------ */

/** The second a drawing placed at `now` opens on. */
export const openFor = (now: number) => Math.floor(now / 1000) * 1000 + 1000;

/** Whether a dot can be in a drawing opening at `openAt`: from the second after it, up to the horizon. */
export const inReach = (d: Dot, openAt: number) => d.t >= openAt + 1000 && d.t <= openAt + RULES.horizon * 1000;

/** Painted dots, as a drawing: not priced yet. Its cost is every painted dot; what is not on offer when it opens comes back. */
export function place(painted: Dot[], perDot: number, step: number, now: number, id: string, stroke?: Stroke): Bet | null {
  const openAt = openFor(now);
  const seen = new Set<string>();
  const dots = painted.filter((d) => {
    const k = `${d.t}:${d.row}`;
    if (seen.has(k) || !inReach(d, openAt)) return false;
    seen.add(k);
    return true;
  });
  if (!dots.length) return null;
  return { id, placedAt: now, openAt, perDot, step, painted: dots.slice(0, RULES.maxDots), dots: [], status: "opening", stroke };
}

export const cost = (bet: Bet) => bet.perDot * bet.painted.length;
/** What comes back when it opens: the dots no longer on offer, or all of them when it is voided. */
export const refund = (bet: Bet) => (bet.status === "void" ? cost(bet) : bet.status === "opening" ? 0 : bet.perDot * (bet.painted.length - bet.dots.length));
export const won = (bet: Bet) => bet.dots.reduce((s, d) => s + (d.paid ?? 0), 0);
export const hits = (bet: Bet) => bet.dots.filter((d) => d.status === "hit").length;
/** Nothing left to happen: every dot decided, or voided when it opened. */
export const decided = (bet: Bet) => bet.status === "done" || bet.status === "void";

/**
 * Price a drawing on the second it opened, from the bars before it. A dot
 * the market has moved onto, or too far from, is dropped and its cost comes
 * back; if none is left the drawing is voided. `ready` is a field measured
 * for the same second on the same bars, if there is one.
 */
export function open(bet: Bet, lib: Library, bars: Bar[], ready?: Field): Bet {
  const f = features(bars, bet.openAt);
  if (!f) return { ...bet, status: "void", why: "No price to open on." };
  // A field already measured for this second and this market is the same field.
  const same = ready && ready.openAt === bet.openAt && ready.step === bet.step && ready.f.price === f.price && ready.f.sigma === f.sigma && ready.f.momentum === f.momentum && ready.f.wick === f.wick;
  const fl = same ? ready : field(lib, f, bet.openAt, bet.step);
  const dots: BetDot[] = [];
  for (const d of bet.painted) {
    const m = multipleOf(fl, d);
    if (m !== null) dots.push({ ...d, multiple: m, status: "live" });
  }
  if (!dots.length) return { ...bet, status: "void", why: "The price moved, and none of it is on offer now." };
  return { ...bet, status: "live", dots };
}

/**
 * Judge a live drawing on one second's bar, as it stands: a dot in that
 * second is hit the moment the bar's range reaches its step. Once the bar's
 * second is over (`closed`, after a margin for trades that arrive late), its
 * dots that were not hit, and any before it, are missed.
 */
export function judge(bet: Bet, bar: Bar, closed: boolean): Bet {
  if (bet.status !== "live") return bet;
  let changed = false;
  const dots = bet.dots.map((d) => {
    if (d.status !== "live") return d;
    // The same rule the chances were counted with: the rows from the bar's low to its high, each row from its bottom edge up to, not including, its top.
    if (d.t === bar.t && rowOf(bar.l, bet.step) <= d.row && d.row <= rowOf(bar.h, bet.step)) {
      {
        changed = true;
        return { ...d, status: "hit" as const, paid: Math.floor(bet.perDot * d.multiple * 100) / 100 };
      }
    }
    if (closed && d.t <= bar.t) {
      changed = true;
      return { ...d, status: "miss" as const };
    }
    return d;
  });
  if (!changed) return bet;
  return { ...bet, dots, status: dots.every((d) => d.status !== "live") ? "done" : "live" };
}

/** Exact union probability for a contiguous price band. Since low <= high,
 * P(path intersects [a,b]) = P(low <= b) - P(high < a). No independence
 * assumption or sum of overlapping cell probabilities is involved. */
export function rangeChanceOf(fl: Field, t: number, lo: number, hi: number, edgeCells = 0, cell = 0): number {
  const j = Math.round((t - fl.openAt) / 1000) - 1;
  const a = Math.round(lo / fl.step) - fl.row0 - edgeCells;
  const b = Math.round(hi / fl.step) - fl.row0 + edgeCells;
  if (!fl.lowCdf || !fl.highCdf || j < 0 || j >= fl.seconds || a < 0 || b > fl.rows || a > b || !(fl.paths > 0)) return 0;
  const p = fallingChances(fl, j, b - a)[a];
  return p > 0 ? calibrate(Math.min(1, p + (1 - p) / fl.paths), cell) : 0;
}

/*
  Every band of one height in second j, by its lowest row, made to fall away
  from the likeliest one. Far out, a band's chance rests on a handful of paths,
  and a few that ended together made a band likelier than one nearer the price:
  on the map, 12x, 8x, 12x, 8x a few pixels apart, and 64x inside 48x. A band
  is never less likely than any band beyond it on the same side, so noise can
  only lower a payout, never raise one.
*/
function fallingChances(fl: Field, j: number, height: number): Float32Array {
  const key = j * 8192 + height;
  const cached = (fl.falling ??= new Map()).get(key);
  if (cached) return cached;
  const span = fl.rows + 1;
  const n = fl.rows - height + 1;
  const out = new Float32Array(n);
  let peak = 0;
  for (let a = 0; a < n; a++) {
    out[a] = Math.max(0, fl.lowCdf![j * span + a + height] - fl.highCdf![j * span + a]);
    if (out[a] > out[peak]) peak = a;
  }
  for (let a = n - 2; a > peak; a--) out[a] = Math.max(out[a], out[a + 1]);
  for (let a = 1; a < peak; a++) out[a] = Math.max(out[a], out[a - 1]);
  fl.falling.set(key, out);
  return out;
}
