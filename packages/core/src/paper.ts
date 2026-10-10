import { DIFFICULTY, MIN_DIFFICULTY } from "./dots";

/**
 * The thirty-second paper run: "Try it free" for someone signed out. Ten
 * dollars of paper money, the live price, the real game screen, and nothing
 * sent anywhere: no relayer, no chain, no wallet.
 *
 * The odds are real play's: the live game's setting when the relayer has
 * said it, else the game's own. A practice run that paid more than the real
 * game would sell a game that isn't there. There are no fees on paper, and
 * a dot costs a cent (`PAPER_PER_DOT`), so ten dollars lasts the run.
 *
 * `scripts/check-paper.ts` measured, on Coinbase BTC-USD, October 7–9 2026,
 * that whether the price touches a stroke is the market's, the same at every
 * setting: 60% of strokes drawn near the price were touched. The setting
 * only moves what a touch pays.
 *
 * Pure functions over a plain record, on the caller's clock (a monotonic one:
 * `performance.now()`), so the web and the phone run the same rules and the
 * tests can drive the clock.
 */

/** How long a run lasts, in ms. */
export const PAPER_MS = 30_000;
/** The paper money a run starts with. */
export const PAPER_START = 10;
/**
 * What a dot costs on paper, fixed for the run: a cent, so ten dollars lasts many strokes in thirty seconds
 * and a first run sees hits and misses, not one stroke spending it all. Real play's least is 10¢.
 */
export const PAPER_PER_DOT = 0.01;
/** The last seconds, when the pill turns urgent. */
export const PAPER_URGENT_MS = 5000;
/** Once the last ink has settled, how long its result shows before the end card. */
export const PAPER_LINGER_MS = 1600;
/** The longest a run waits for its ink to settle after the clock runs out: ink reaches 31 s ahead. */
export const PAPER_SETTLE_MAX_MS = 40_000;
export type PaperPhase = "running" | "settling" | "over";

export type PaperRun = {
  phase: PaperPhase;
  /** What was left on the clock when it was last stopped or started. */
  leftMs: number;
  /** When the clock was last started; null while it is stopped (paused, or run out). */
  since: number | null;
  /** When the clock ran out, and when the last ink settled after it. */
  endedAt: number | null;
  settledAt: number | null;
  balance: number;
  /** What hits have paid into the balance, this run. */
  won: number;
  /** Drawings placed this run. */
  drawings: number;
};

const cents = (n: number) => Math.round(n * 100) / 100;

export function startPaper(now: number): PaperRun {
  return { phase: "running", leftMs: PAPER_MS, since: now, endedAt: null, settledAt: null, balance: PAPER_START, won: 0, drawings: 0 };
}

/** What is left on the clock, in ms. */
export const leftOf = (run: PaperRun, now: number) => (run.phase !== "running" ? 0 : Math.max(0, run.since === null ? run.leftMs : run.leftMs - (now - run.since)));

/** Whether ink can go in: only while the clock runs. A paused run takes none. */
export const canDraw = (run: PaperRun | null, now: number) => run !== null && run.phase === "running" && run.since !== null && leftOf(run, now) > 0;

/** The last seconds. */
export const urgent = (run: PaperRun, now: number) => run.phase === "running" && leftOf(run, now) <= PAPER_URGENT_MS;

/** The clock as the pill shows it: whole seconds, rounded up, so it reads 0:30 at the start and 0:00 only at the end. */
export function clockText(ms: number) {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The page is hidden or the app is in the background: the clock stops where it is. */
export function pausePaper(run: PaperRun, now: number): PaperRun {
  if (run.phase !== "running" || run.since === null) return run;
  return { ...run, leftMs: leftOf(run, now), since: null };
}

/** Back on screen: the clock goes on from where it stopped. */
export function resumePaper(run: PaperRun, now: number): PaperRun {
  if (run.phase !== "running" || run.since !== null) return run;
  return { ...run, since: now };
}

/**
 * Move the run on. `open`: whether any of its ink is still unsettled (or still under the pen). The clock running
 * out stops the ink; the run is over once what was drawn has settled and its result has had a moment on screen.
 */
export function stepPaper(run: PaperRun, now: number, open: boolean): PaperRun {
  if (run.phase === "running") {
    if (run.since === null || leftOf(run, now) > 0) return run;
    run = { ...run, phase: "settling", leftMs: 0, since: null, endedAt: now };
  }
  if (run.phase === "settling") {
    const waited = now - (run.endedAt ?? now);
    if (waited >= PAPER_SETTLE_MAX_MS) return { ...run, phase: "over" };
    if (open) return run.settledAt === null ? run : { ...run, settledAt: null };
    if (run.settledAt === null) return { ...run, settledAt: now };
    if (now - run.settledAt >= PAPER_LINGER_MS) return { ...run, phase: "over" };
  }
  return run;
}

/** A drawing's cost, out of the paper money: null when there is not enough of it, and nothing is taken. */
export function debitPaper(run: PaperRun, amount: number): PaperRun | null {
  if (amount > run.balance + 1e-9) return null;
  return { ...run, balance: cents(run.balance - amount) };
}

/** Money back into the paper balance: `won` of it paid by hits, the rest ink that came back unpriced. */
export function creditPaper(run: PaperRun, amount: number, won = 0): PaperRun {
  return { ...run, balance: cents(run.balance + amount), won: cents(run.won + won) };
}

/** What the run came to: the end card's line, and the change in paper money. */
export function paperResult(run: Pick<PaperRun, "balance" | "drawings">, money: (n: number) => string): { pnl: number; headline: string } {
  const pnl = cents(run.balance - PAPER_START);
  const seconds = Math.round(PAPER_MS / 1000);
  const start = money(PAPER_START);
  if (run.drawings === 0) return { pnl, headline: "You didn’t draw this time" };
  if (pnl > 0) return { pnl, headline: `You turned ${start} into ${money(run.balance)} in ${seconds} seconds` };
  if (pnl < 0) return { pnl, headline: `Your ${start} came to ${money(run.balance)} in ${seconds} seconds` };
  return { pnl, headline: `You kept your ${start} in ${seconds} seconds` };
}

/**
 * The setting a drawing placed now is priced at, and the least it may be: the chain's on chain, the house's
 * slider or the game's own in practice. A paper run plays the real game's: the chain's when known, never the
 * house slider's.
 */
export function levelFor({ paper, chain, house }: { paper: boolean; chain?: number | null; house?: number | null }): { level: number; least: number } {
  if (paper) return { level: chain ?? DIFFICULTY, least: MIN_DIFFICULTY };
  return { level: chain ?? house ?? DIFFICULTY, least: MIN_DIFFICULTY };
}
