"use client";

import { useSyncExternalStore } from "react";
import { cents } from "./money";
import type { DrawingResult } from "./practice";

/*
  This session: every round since the game was opened, for the scoreboard.

  A session is this tab, and it ends after half an hour with no round, so a
  player coming back tomorrow starts from zero rather than from yesterday's
  losses. Kept in sessionStorage: a reload keeps it, a new tab starts fresh.
*/

export type Scoreboard = {
  lastAt: number;
  /** Newest first. */
  rounds: DrawingResult[];
  won: number;
  hits: number;
  /** Rounds that came out ahead. */
  wins: number;
  /** The biggest multiple hit this session. */
  best: number;
  /** The most a single round made, net. */
  biggest: number;
  /** Rounds in a row that came out ahead, and the most this session. */
  streak: number;
  bestStreak: number;
};

const KEY = "skech:scoreboard";
const IDLE_MS = 30 * 60_000;
const empty = (): Scoreboard => ({ lastAt: 0, rounds: [], won: 0, hits: 0, wins: 0, best: 0, biggest: 0, streak: 0, bestStreak: 0 });
const EMPTY = empty();

let current: Scoreboard | null = null;
const listeners = new Set<() => void>();

function read(): Scoreboard {
  try {
    const raw = sessionStorage.getItem(KEY);
    const s = raw ? (JSON.parse(raw) as Scoreboard) : null;
    if (s && s.lastAt && Date.now() - s.lastAt < IDLE_MS) return s;
  } catch {
    /* blocked storage: a fresh session */
  }
  return empty();
}

export function scoreboard(): Scoreboard {
  if (current === null) current = typeof window === "undefined" ? EMPTY : read();
  return current;
}

function write(next: Scoreboard) {
  current = next;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* still holds for this page */
  }
  for (const l of listeners) l();
}

/** A finished round goes on the board. Called once per round, wherever the books are kept. */
export function addRound(r: DrawingResult) {
  let s = scoreboard();
  if (s.lastAt && Date.now() - s.lastAt >= IDLE_MS) s = empty();
  const net = cents(r.won - r.cost);
  const streak = net > 0 ? s.streak + 1 : 0;
  write({
    ...s,
    lastAt: Date.now(),
    rounds: [r, ...s.rounds].slice(0, 100),
    won: cents(s.won + r.won),
    hits: s.hits + r.hits,
    wins: s.wins + (net > 0 ? 1 : 0),
    best: Math.max(s.best, r.best),
    biggest: Math.max(s.biggest, net),
    streak,
    bestStreak: Math.max(s.bestStreak, streak),
  });
}

export const resetScoreboard = () => write(empty());

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function useScoreboard(): Scoreboard {
  return useSyncExternalStore(subscribe, scoreboard, () => EMPTY);
}

/** What was won in total after each round, oldest first, from zero: the session's line, which only climbs. */
export function curve(s: Scoreboard): number[] {
  const out = [0];
  for (const r of [...s.rounds].reverse()) out.push(cents(out.at(-1)! + r.won));
  return out;
}
