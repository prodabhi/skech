"use client";

import { useState, useSyncExternalStore } from "react";
import { START_BALANCE } from "@skech/core/dots";
import { POINT_PRICES } from "@skech/core/odds";
import type { InkBet } from "@skech/core/ink";
import { addRound } from "./scoreboard";

/**
 * Practice money, kept in this browser: the balance, what you have set, the
 * drawings still in play and the last ones finished.
 *
 * Dollars you cannot lose, so the numbers read the way real ones will. The
 * same engine runs on the server once there is money in it; until then the
 * only thing at stake is the balance in the corner.
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
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const s = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Practice>) };
    // A price kept from before the stops it is chosen from now: the nearest one.
    const stops = POINT_PRICES.values as readonly number[];
    if (!stops.includes(s.perDot)) s.perDot = stops.reduce((best, v) => (Math.abs(v - s.perDot) < Math.abs(best - s.perDot) ? v : best), stops[0]);
    return s;
  } catch {
    return DEFAULTS;
  }
}

export function practice(): Practice {
  if (current === null) current = typeof window === "undefined" ? DEFAULTS : read();
  return current;
}

/*
  Written to storage at most once a second, not on every change: the drawings in play change with every
  second the price judges them, and each write is all of this, every open drawing included. What is waiting
  is written at once when the page is hidden or closed, so a reload finds it; only a page killed outright
  can lose the last second.
*/
const WRITE_EVERY_MS = 1000;
let wroteAt = 0;
let writeTimer: ReturnType<typeof setTimeout> | undefined;
let flushOnHide = false;

function write() {
  clearTimeout(writeTimer);
  writeTimer = undefined;
  wroteAt = Date.now();
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Private mode: it still holds for this page.
  }
}

function writeSoon() {
  if (!flushOnHide) {
    flushOnHide = true;
    const flush = () => writeTimer !== undefined && write();
    addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());
  }
  if (writeTimer !== undefined) return;
  const wait = WRITE_EVERY_MS - (Date.now() - wroteAt);
  if (wait <= 0) write();
  else writeTimer = setTimeout(write, wait);
}

export function setPractice(patch: Partial<Practice> | ((s: Practice) => Partial<Practice>)) {
  const s = practice();
  current = { ...s, ...(typeof patch === "function" ? patch(s) : patch) };
  if (typeof window !== "undefined") writeSoon();
  for (const l of listeners) l();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  const other = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    current = read();
    fn();
  };
  window.addEventListener("storage", other);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", other);
  };
}

export function usePractice(): Practice {
  return useSyncExternalStore(subscribe, practice, () => DEFAULTS);
}

/**
 * Only the named fields: what reads them renders again when one of them changes, not on every write. The
 * drawings in play are written as each trade judges them and the balance as each piece goes in, many times a
 * second while drawing, and a whole screen reading the store re-rendered for each.
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
