import { useState, useSyncExternalStore } from "react";
import { START_BALANCE } from "@skech/core/dots";
import { POINT_PRICES } from "@skech/core/odds";
import type { InkBet } from "@skech/core/ink";
import { addRound } from "./scoreboard";
import { readJson, writeJson } from "./storage";

/**
 * Practice money, kept on this phone: the balance, what you have set, the
 * drawings still in play and the last ones finished.
 *
 * Dollars you cannot lose, so the numbers read the way real ones will. The
 * same engine runs on the server once there is money in it; until then the
 * only thing on the line is the balance in the corner.
 */

export type Brush = "fine" | "medium" | "wide";

export type DrawingResult = { id: string; at: number; cost: number; won: number; hits: number; dots: number; best: number };

export type Practice = {
  balance: number;
  /** Drawings in a row with at least one dot hit. */
  streak: number;
  bestStreak: number;
  /** The biggest multiple ever hit. */
  bestHit: number;
  drawings: number;
  history: DrawingResult[];
  perDot: number;
  brush: Brush;
  /**
   * How hard the game is, 0 to 100, when the house has set it on this
   * browser's slider; null follows the game's own (`DIFFICULTY` in
   * `@skech/core/dots`), so a change to that reaches everyone who has not.
   */
  houseDifficulty: number | null;
  sound: boolean;
  /** A tap under the finger when ink goes in and when it hits, where the phone can. */
  haptics: boolean;
  /** Whether the first-visit hint has been dismissed. */
  taught: boolean;
  /**
   * Drawings still in play. Their cost is already spent, so a reload must
   * not lose them: they are judged again on the minutes of prices the page
   * fetches when it starts.
   */
  open: InkBet[];
};

const DEFAULTS: Practice = {
  balance: START_BALANCE,
  streak: 0,
  bestStreak: 0,
  bestHit: 0,
  drawings: 0,
  history: [],
  perDot: POINT_PRICES.default,
  houseDifficulty: null,
  brush: "medium",
  sound: true,
  haptics: true,
  taught: false,
  open: [],
};

/*
  Its own name, so drawings kept in an older shape are never read back. The
  second one is points: drawings from the first were priced by area, and the
  balances won on them before the house's margin was set are not carried over.
*/
const KEY = "skech:practice:points";
let current: Practice | null = null;
const listeners = new Set<() => void>();

function read(): Practice {
  try {
    const stored = readJson<Partial<Practice>>(KEY);
    if (!stored) return DEFAULTS;
    const s = { ...DEFAULTS, ...stored };
    // A price kept from before the stops it is chosen from now: the nearest one.
    const stops = POINT_PRICES.values as readonly number[];
    if (!stops.includes(s.perDot)) s.perDot = stops.reduce((best, v) => (Math.abs(v - s.perDot) < Math.abs(best - s.perDot) ? v : best), stops[0]);
    return s;
  } catch {
    return DEFAULTS;
  }
}

export function practice(): Practice {
  if (current === null) current = read();
  return current;
}

export function setPractice(patch: Partial<Practice> | ((s: Practice) => Partial<Practice>)) {
  const s = practice();
  current = { ...s, ...(typeof patch === "function" ? patch(s) : patch) };
  writeJson(KEY, current);
  for (const l of listeners) l();
}

/** Back to a new phone's: balance, settings, history. Held in memory as well, so clearing storage alone would be written back. */
export function resetPractice() {
  current = DEFAULTS;
  writeJson(KEY, current);
  for (const l of listeners) l();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function usePractice(): Practice {
  return useSyncExternalStore(subscribe, practice, () => DEFAULTS);
}

/**
 * Only some of it: the component renders again only when one of `keys` changes, as the web's. The drawings in play
 * are written as each trade judges them and the balance as each piece goes in, many times a second while drawing,
 * and a whole screen reading the store re-rendered for each.
 */
export function usePracticeOf<K extends keyof Practice>(...keys: K[]): Pick<Practice, K> {
  const [pick] = useState(() => {
    let last: Pick<Practice, K> | null = null;
    return (s: Practice) => {
      const prev = last;
      if (prev && keys.every((k) => prev[k] === s[k])) return prev;
      const next = {} as Pick<Practice, K>;
      for (const k of keys) next[k] = s[k];
      return (last = next);
    };
  });
  return useSyncExternalStore(subscribe, () => pick(practice()), () => pick(DEFAULTS));
}

export { cents } from "./money";

/** A finished drawing goes into the books: the streak, the bests, the recent results. */
export function record(result: DrawingResult) {
  addRound(result);
  setPractice((s) => {
    const streak = result.hits > 0 ? s.streak + 1 : 0;
    return {
      streak,
      bestStreak: Math.max(s.bestStreak, streak),
      bestHit: Math.max(s.bestHit, result.best),
      drawings: s.drawings + 1,
      history: [result, ...s.history].slice(0, 30),
    };
  });
}
