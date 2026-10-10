import { describe, expect, test } from "bun:test";
import { BURST, climb, climbRate, feltLevel, renderVoice, VOICE_PEAK, type Voice, voiceFor, voiceJob, winTier } from "./cheer";

const VOICES: Voice[] = ["hit", "win1", "win2", "win3", "win4", "coins"];

describe("what counts as a profit", () => {
  test("a loss, an even round and a round a cent short are never celebrated", () => {
    expect(winTier(0, 1)).toBe(0);
    expect(winTier(0.9, 1)).toBe(0);
    expect(winTier(1, 1)).toBe(0);
    expect(winTier(1.004, 1)).toBe(0);
    // A hit at a big multiple in a round that still lost is not a win.
    expect(winTier(0.5, 1, 40)).toBe(0);
  });
  test("bigger profits are bigger tiers", () => {
    expect(winTier(1.2, 1)).toBe(1);
    expect(winTier(2, 1)).toBe(2);
    expect(winTier(3, 1)).toBe(3);
    expect(winTier(1.5, 1, 10)).toBe(3);
    expect(winTier(8, 1)).toBe(4);
    expect(winTier(1.5, 1, 32)).toBe(4);
    // The round card's "big win" (three times back, or a 10× hit) is tier 3 or more.
    for (const [won, cost, best] of [[3, 1, 0], [1.1, 1, 10], [30, 1, 0]]) expect(winTier(won, cost, best)).toBeGreaterThanOrEqual(3);
  });
  test("the bigger the tier, the more confetti", () => {
    expect(BURST[0]).toBe(0);
    for (let t = 1; t <= 4; t++) expect(BURST[t as 1 | 2 | 3 | 4]).toBeGreaterThan(BURST[(t - 1) as 0 | 1 | 2 | 3]);
  });
});

describe("a run of profitable rounds", () => {
  test("climbs a pentatonic step a round, from the root, to an octave and no further", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 20].map(climb)).toEqual([0, 0, 2, 4, 7, 9, 12, 12, 12]);
    expect(climbRate(1)).toBe(1);
    expect(climbRate(6)).toBeCloseTo(2, 10);
    for (let n = 1; n < 8; n++) expect(climbRate(n + 1)).toBeGreaterThanOrEqual(climbRate(n));
  });
  test("is felt more strongly as it grows, and a non-profit is never felt", () => {
    expect(feltLevel(0, 9)).toBe(0);
    expect(feltLevel(1, 1)).toBe(1);
    expect(feltLevel(1, 3)).toBe(2);
    expect(feltLevel(1, 6)).toBe(3);
    expect(feltLevel(4, 6)).toBe(4);
  });
  test("each tier has its own sound", () => {
    expect([1, 2, 3, 4].map((t) => voiceFor(t as 1 | 2 | 3 | 4))).toEqual(["win1", "win2", "win3", "win4"]);
  });
});

describe("the sounds", () => {
  for (const rate of [24000, 32000, 48000])
    test(`at ${rate} Hz each is finite, peaks exactly where it should and ends in silence`, () => {
      for (const v of VOICES) {
        const out = renderVoice(v, rate);
        let peak = 0,
          broken = 0;
        for (const x of out) {
          if (!Number.isFinite(x)) broken++;
          peak = Math.max(peak, Math.abs(x));
        }
        expect(broken).toBe(0);
        expect(peak).toBeCloseTo(VOICE_PEAK[v], 5);
        expect(Math.abs(out[out.length - 1])).toBeLessThan(1e-3 * peak);
        // Each starts within a few milliseconds: nothing waits on a silence at its head.
        let first = 0;
        while (Math.abs(out[first]) < 0.05 * peak) first++;
        expect(first / rate).toBeLessThan(0.02);
      }
    });

  test("made a slice at a time, a sound is sample for sample the one made in one go", () => {
    for (const v of VOICES) {
      const whole = renderVoice(v, 32000);
      for (const n of [1, 127, 4096]) {
        const job = voiceJob(v, 32000);
        while (!job.run(n));
        expect(job.result()).toEqual(whole);
      }
    }
  });

  test("the loudest that can sound together cannot clip, at any step of the climb", () => {
    // A top round's sound with its coins over it, and a hit's tail still ringing: the most the queue lets overlap.
    const win = renderVoice("win4", 32000);
    const coins = renderVoice("coins", 32000);
    const hit = renderVoice("hit", 32000);
    let worst = 0;
    for (let i = 0; i < win.length; i++) worst = Math.max(worst, Math.abs(win[i] + (coins[i] ?? 0) + (hit[i] ?? 0)));
    // The web's bus is 0.9 over a compressor; the phone's 0.6 with none.
    expect(worst * 0.9).toBeLessThan(1);
    expect(worst * 0.6).toBeLessThan(0.5);
  });

  test("are made the same every time", () => {
    for (const v of VOICES) expect(renderVoice(v, 24000)).toEqual(renderVoice(v, 24000));
  });
});
