import { afterEach, expect, test } from "bun:test";
import { DIFFICULTY, difficulty, MIN_DIFFICULTY, RULES, setDifficulty } from "./dots";
import { ladderSection } from "./ink";
import {
  canDraw,
  clockText,
  creditPaper,
  debitPaper,
  leftOf,
  levelFor,
  PAPER_LINGER_MS,
  PAPER_MS,
  PAPER_SETTLE_MAX_MS,
  PAPER_START,
  paperResult,
  pausePaper,
  resumePaper,
  startPaper,
  stepPaper,
  urgent,
} from "./paper";

const money = (n: number) => `$${Math.abs(n).toFixed(2)}`;
afterEach(() => setDifficulty(DIFFICULTY));

test("a run starts with ten dollars and thirty seconds, and counts down", () => {
  const run = startPaper(1000);
  expect(run.balance).toBe(PAPER_START);
  expect(PAPER_START).toBe(10);
  expect(PAPER_MS).toBe(30_000);
  expect(clockText(leftOf(run, 1000))).toBe("0:30");
  expect(clockText(leftOf(run, 1001))).toBe("0:30");
  expect(clockText(leftOf(run, 7000))).toBe("0:24");
  expect(clockText(leftOf(run, 30_999))).toBe("0:01");
  expect(clockText(leftOf(run, 31_000))).toBe("0:00");
  expect(urgent(run, 25_000)).toBe(false);
  expect(urgent(run, 26_000)).toBe(true);
  expect(canDraw(run, 30_999)).toBe(true);
  expect(canDraw(run, 31_000)).toBe(false);
  expect(canDraw(null, 0)).toBe(false);
});

test("at zero the ink stops, what was drawn settles, its result shows, then the run is over", () => {
  let run = startPaper(0);
  run = stepPaper(run, 29_000, true);
  expect(run.phase).toBe("running");
  run = stepPaper(run, 30_000, true);
  expect(run.phase).toBe("settling");
  expect(canDraw(run, 30_000)).toBe(false);
  expect(clockText(leftOf(run, 30_000))).toBe("0:00");
  // Ink still out: it waits.
  run = stepPaper(run, 45_000, true);
  expect(run.phase).toBe("settling");
  // Settled: the last round's result has its moment before the end card.
  run = stepPaper(run, 46_000, false);
  expect(run.phase).toBe("settling");
  run = stepPaper(run, 46_000 + PAPER_LINGER_MS - 1, false);
  expect(run.phase).toBe("settling");
  run = stepPaper(run, 46_000 + PAPER_LINGER_MS, false);
  expect(run.phase).toBe("over");
});

test("ink that never settles (no prices) does not hold the end card up for ever", () => {
  let run = stepPaper(startPaper(0), PAPER_MS, true);
  run = stepPaper(run, PAPER_MS + PAPER_SETTLE_MAX_MS, true);
  expect(run.phase).toBe("over");
});

test("hidden, the clock stops where it is and goes on from there", () => {
  let run = startPaper(0);
  run = pausePaper(run, 10_000);
  expect(leftOf(run, 60_000)).toBe(20_000);
  expect(canDraw(run, 60_000)).toBe(false);
  expect(stepPaper(run, 60_000, false).phase).toBe("running");
  run = resumePaper(run, 60_000);
  expect(leftOf(run, 65_000)).toBe(15_000);
  expect(stepPaper(run, 80_000, false).phase).toBe("settling");
  // Pausing twice, or resuming a running clock, changes nothing.
  expect(pausePaper(pausePaper(startPaper(0), 5000), 9000).leftMs).toBe(25_000);
  const going = startPaper(0);
  expect(resumePaper(going, 5000)).toBe(going);
});

test("paper money: a drawing it cannot pay for takes nothing; hits count as won, refunds do not", () => {
  let run = startPaper(0);
  run = debitPaper(run, 2.35)!;
  expect(run.balance).toBe(7.65);
  expect(debitPaper(run, 7.66)).toBeNull();
  run = creditPaper(run, 0.4);
  run = creditPaper(run, 3.1, 3.1);
  expect(run.balance).toBe(11.15);
  expect(run.won).toBe(3.1);
});

test("the end card says what happened, win, loss or nothing drawn", () => {
  const run = { ...startPaper(0), phase: "over" as const };
  expect(paperResult({ ...run, drawings: 3, balance: 13.2 }, money)).toEqual({ pnl: 3.2, headline: "You turned $10.00 into $13.20 in 30 seconds" });
  expect(paperResult({ ...run, drawings: 3, balance: 7.4 }, money)).toEqual({ pnl: -2.6, headline: "Your $10.00 came to $7.40 in 30 seconds" });
  expect(paperResult({ ...run, drawings: 1, balance: 10 }, money).headline).toBe("You kept your $10.00 in 30 seconds");
  expect(paperResult(run, money).headline).toBe("You didn’t draw this time");
});

test("the paper run plays the real game's odds", () => {
  expect(levelFor({ paper: true, chain: 51, house: 60 })).toEqual({ level: 51, least: MIN_DIFFICULTY });
  expect(levelFor({ paper: true, house: 60 })).toEqual({ level: DIFFICULTY, least: MIN_DIFFICULTY });
  expect(levelFor({ paper: false, chain: 70, house: 60 })).toEqual({ level: 70, least: MIN_DIFFICULTY });
  expect(levelFor({ paper: false, house: 60 })).toEqual({ level: 60, least: MIN_DIFFICULTY });
  expect(levelFor({ paper: false })).toEqual({ level: DIFFICULTY, least: MIN_DIFFICULTY });
});

test("what the paper map shows is what a paper hit pays: real play\u2019s ladder", () => {
  for (const p of [0.95, 0.6, 0.3, 0.1, 0.03, 0.005]) {
    setDifficulty(DIFFICULTY);
    const real = ladderSection(p, RULES.rtp, 1)!;
    const { level, least } = levelFor({ paper: true });
    setDifficulty(level, least);
    const shown = ladderSection(p, RULES.rtp, 1)!;
    // The opening prices the section by the same function at the same setting: the multiple shown is the one paid.
    expect(ladderSection(p, RULES.rtp, 1)).toEqual(shown);
    expect(shown.multiple).toBe(real.multiple);
    expect(shown.multiple).toBeGreaterThanOrEqual(1);
    expect(shown.multiple * p).toBeLessThanOrEqual(RULES.ladderBest + 1e-9);
  }
});
