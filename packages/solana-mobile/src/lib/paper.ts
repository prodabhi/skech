import { useSyncExternalStore } from "react";
import { clockText, creditPaper, debitPaper, leftOf, type PaperPhase, type PaperRun, pausePaper, resumePaper, startPaper, stepPaper, urgent } from "@skech/core/paper";

/**
 * The paper run under way, if any: "Try it free", for someone signed out. The rules are
 * `@skech/core/paper`; this holds the one run, in memory only. Nothing is written to storage, so closing the app
 * ends it, and none of it is ever the practice balance or a real one.
 */

/** What the screen shows of a run: it changes once a second at most, with the money, or with the phase. */
export type PaperView = { phase: PaperPhase; clock: string; urgent: boolean; balance: number; won: number; drawings: number };

let run: PaperRun | null = null;
let view: PaperView | null = null;
const listeners = new Set<() => void>();

function set(next: PaperRun | null) {
  run = next;
  const now = performance.now();
  const v: PaperView | null = run && { phase: run.phase, clock: clockText(leftOf(run, now)), urgent: urgent(run, now), balance: run.balance, won: run.won, drawings: run.drawings };
  // A tick that changes nothing on screen renders nothing.
  if (v && view && (Object.keys(v) as (keyof PaperView)[]).every((k) => v[k] === view![k])) return;
  view = v;
  for (const l of listeners) l();
}

export const paper = () => run;
export const startPaperRun = () => set(startPaper(performance.now()));
export const endPaperRun = () => set(null);
/** Takes a drawing's cost from the paper money; false, and nothing taken, when there is not enough. */
export function paperDebit(amount: number): boolean {
  const next = run && debitPaper(run, amount);
  if (!next) return false;
  set(next);
  return true;
}
/** Money back into the paper balance; `won` of it paid by hits. */
export const paperCredit = (amount: number, won: number) => void (run && set(creditPaper(run, amount, won)));
export const paperDrew = () => void (run && set({ ...run, drawings: run.drawings + 1 }));
/** Moves the run on: `open`, whether any of its ink is still unsettled or under the pen. */
export const paperTick = (open: boolean) => void (run && set(stepPaper(run, performance.now(), open)));
export const pausePaperRun = () => void (run && set(pausePaper(run, performance.now())));
export const resumePaperRun = () => void (run && set(resumePaper(run, performance.now())));

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** The run as shown: the clock's second, the money, the phase. */
export function usePaper(): PaperView | null {
  return useSyncExternalStore(subscribe, () => view, () => null);
}

/** Only the phase: for the screen around the run, which need not render each second. */
export function usePaperPhase(): PaperPhase | null {
  return useSyncExternalStore(subscribe, () => view?.phase ?? null, () => null);
}
