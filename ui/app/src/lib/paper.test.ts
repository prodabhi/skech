import { afterEach, expect, spyOn, test } from "bun:test";
import { PAPER_LINGER_MS, PAPER_MS } from "@skech/core/paper";
import { endPaperRun, paper, paperCredit, paperDebit, paperDrew, paperTick, pausePaperRun, resumePaperRun, startPaperRun } from "./paper";

let now = 1000;
const clock = spyOn(performance, "now").mockImplementation(() => now);
afterEach(() => {
  endPaperRun();
  now = 1000;
});

test("a run is ten paper dollars that only drawings and hits move, gone when it ends", () => {
  startPaperRun();
  expect(paper()?.balance).toBe(10);
  expect(paperDebit(4)).toBe(true);
  expect(paperDebit(6.01)).toBe(false);
  paperDrew();
  paperCredit(2.5, 2);
  expect(paper()).toMatchObject({ balance: 8.5, won: 2, drawings: 1 });
  endPaperRun();
  expect(paper()).toBeNull();
  // With no run, paper money cannot be spent.
  expect(paperDebit(0.1)).toBe(false);
});

test("the clock runs out, ink settles, and the run is over; hidden, it stops", () => {
  startPaperRun();
  now += 10_000;
  pausePaperRun();
  now += 60_000;
  paperTick(false);
  expect(paper()?.phase).toBe("running");
  resumePaperRun();
  now += PAPER_MS - 10_000;
  paperTick(true);
  expect(paper()?.phase).toBe("settling");
  now += 5000;
  paperTick(false);
  now += PAPER_LINGER_MS;
  paperTick(false);
  expect(paper()?.phase).toBe("over");
  expect(clock).toHaveBeenCalled();
});
