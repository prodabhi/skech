import { describe, expect, test } from "bun:test";
import { AFTER_HIT_MS, type Cue, type CueClock, type CueDetail, cueQueue, HOLD } from "./cue";

/** A clock that moves only when told: timers fire in order, microtasks when `settle` runs them. */
function fake() {
  let t = 0;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let micro: (() => void)[] = [];
  let ids = 0;
  const settle = () => {
    while (micro.length) micro.shift()!();
  };
  const clock: CueClock = {
    now: () => t,
    after: (fn, ms) => {
      const id = ++ids;
      timers.push({ at: t + ms, fn, id });
      return id;
    },
    cancel: (h) => void (timers = timers.filter((x) => x.id !== h)),
    soon: (fn) => void micro.push(fn),
  };
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      settle();
      timers.sort((a, b) => a.at - b.at);
      const due = timers[0];
      if (!due || due.at > end) break;
      timers.shift();
      t = due.at;
      due.fn();
    }
    t = end;
    settle();
  };
  return { clock, settle, advance };
}

function harness() {
  const f = fake();
  const played: { kind: Cue; detail?: CueDetail; at: number; waited: number }[] = [];
  const q = cueQueue((kind, detail, asked) => played.push({ kind, detail, at: f.clock.now(), waited: f.clock.now() - asked }), f.clock);
  return { ...f, q, played };
}

describe("a hit", () => {
  test("plays the moment it is asked for, before the next frame", () => {
    const h = harness();
    h.advance(1000);
    h.q.push("hit", { multiple: 2 });
    // The judge's pass is still running: the burst is collected, then played as it ends.
    expect(h.played).toHaveLength(0);
    h.settle();
    expect(h.played).toEqual([{ kind: "hit", detail: { multiple: 2 }, at: 1000, waited: 0 }]);
  });

  test("never waits behind a smaller cue still sounding", () => {
    for (const before of ["placed", "nope"] as Cue[]) {
      const h = harness();
      h.q.push(before);
      h.advance(10);
      h.q.push("hit", { multiple: 2 });
      h.settle();
      expect(h.played.map((p) => [p.kind, p.at, p.waited])).toEqual([
        [before, 0, 0],
        ["hit", 10, 0],
      ]);
    }
  });

  test("rings over another round's chord without waiting for it", () => {
    const h = harness();
    h.q.push("win", { tier: 1, rounds: 1 });
    h.advance(100);
    h.q.push("hit", { multiple: 2 });
    h.settle();
    expect(h.played.at(-1)).toMatchObject({ kind: "hit", at: 100, waited: 0 });
    // The chord keeps its turn: a piece going in still waits for it, not for the hit.
    h.advance(500);
    h.q.push("placed");
    h.advance(1000);
    expect(h.played.at(-1)).toMatchObject({ kind: "placed", at: HOLD.win });
  });

  test("a burst in one pass plays once, the biggest of it", () => {
    const h = harness();
    h.q.push("hit", { multiple: 2, run: 0 });
    h.q.push("run", { multiple: 4, run: 2 });
    h.q.push("hit", { multiple: 3, run: 1 });
    h.settle();
    expect(h.played).toHaveLength(1);
    expect(h.played[0]).toMatchObject({ kind: "run", detail: { multiple: 4, run: 2 }, waited: 0 });
  });

  test("a newer hit within 80 ms merges into the one just heard, unless it rings more notes", () => {
    const h = harness();
    h.q.push("hit", { multiple: 2 });
    h.advance(50);
    h.q.push("hit", { multiple: 3 });
    h.advance(10);
    expect(h.played).toHaveLength(1);
    h.q.push("big", { multiple: 12 });
    h.settle();
    expect(h.played.map((p) => [p.kind, p.at])).toEqual([
      ["hit", 0],
      ["big", 60],
    ]);
    // Past the window, every hit is its own, at once.
    h.advance(100);
    h.q.push("hit", { multiple: 2 });
    h.settle();
    expect(h.played.at(-1)).toMatchObject({ kind: "hit", at: 160, waited: 0 });
  });
});

describe("a round's result", () => {
  test("with no hit ringing, plays at once", () => {
    const h = harness();
    h.q.push("placed");
    h.advance(20);
    h.q.push("great", { tier: 3, rounds: 1, till: true });
    expect(h.played.at(-1)).toMatchObject({ kind: "great", at: 20, waited: 0 });
  });

  test("never lands on the hit that ended the round: it starts as that hit ends", () => {
    const h = harness();
    h.advance(500);
    // The last hit and the round's close, in the same pass of the judge.
    h.q.push("hit", { multiple: 2 });
    h.q.push("win", { tier: 1, rounds: 1, till: true });
    h.advance(2000);
    expect(h.played.map((p) => [p.kind, p.at])).toEqual([
      ["hit", 500],
      ["win", 500 + HOLD.hit],
    ]);
  });

  test("waits at most AFTER_HIT_MS, even after a big hit", () => {
    const h = harness();
    h.q.push("big", { multiple: 20 });
    h.settle();
    h.advance(30);
    h.q.push("top", { tier: 4, rounds: 2, till: true });
    h.advance(3000);
    expect(h.played.map((p) => [p.kind, p.at])).toEqual([
      ["big", 0],
      ["top", AFTER_HIT_MS],
    ]);
  });

  test("two results in a row merge into one, the bigger", () => {
    const h = harness();
    h.q.push("hit");
    h.q.push("win", { tier: 1, rounds: 1 });
    h.q.push("great", { tier: 3, rounds: 2 });
    h.advance(3000);
    expect(h.played.map((p) => p.kind)).toEqual(["hit", "great"]);
    expect(h.played[1].detail).toMatchObject({ tier: 3, rounds: 2 });
  });
});

describe("the rest", () => {
  test("a piece going in waits for a hit still ringing, and is dropped once too stale to mean anything", () => {
    const h = harness();
    h.q.push("big", { multiple: 12 });
    h.settle();
    h.q.push("placed");
    h.advance(1000);
    expect(h.played.map((p) => [p.kind, p.at])).toEqual([
      ["big", 0],
      // It waited out the big hit's 420 ms, past its own 400 ms of meaning: gone.
    ]);
    h.q.push("big", { multiple: 12 });
    h.settle();
    h.advance(100);
    h.q.push("placed");
    h.advance(1000);
    expect(h.played.at(-1)).toMatchObject({ kind: "placed", at: 1000 + HOLD.big });
  });

  test("is busy while a cue has the stage, so the pen's tick stays out of its way", () => {
    const h = harness();
    expect(h.q.busy()).toBe(false);
    h.q.push("hit");
    expect(h.q.busy()).toBe(true);
    h.settle();
    expect(h.q.busy()).toBe(true);
    h.advance(HOLD.hit);
    expect(h.q.busy()).toBe(false);
  });
});
