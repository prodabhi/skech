import { expect, test } from "bun:test";
import { advanceConfetti, confettiPiece, hapticBeats, hapticPattern, patternDuration, hitRate, hitFallback, winFallback, cashFallback, type FeedbackTone } from "./feedback";
import { feltLevel, winTier } from "./cheer";

test("win tiers and streak escalation produce the same scheduled haptic beats", () => {
  const level = feltLevel(winTier(4, 1), 3);
  const pattern = hapticPattern("great", level);
  expect(hapticBeats(pattern).map(({ at }) => at)).toEqual([0, 66, 128, 198, 348]);
  expect(patternDuration(pattern)).toBe(428);
  expect(hapticPattern("win", 2)).toEqual([22, 55, 36]);
  expect(hapticBeats(hapticPattern("run"))).toEqual([
    { at: 0, duration: 16, strength: "light" },
    { at: 61, duration: 12, strength: "light" },
  ]);
  expect(hapticPattern("placed")).toEqual([]);
});

test("hit pitch rises by semitones and caps after seven hits", () => {
  expect(hitRate(0)).toBe(1);
  expect(hitRate(3)).toBeCloseTo(2 ** (3 / 12));
  expect(hitRate(20)).toBe(hitRate(7));
});

test("fallback sounds retain the web score's timing and tiers", () => {
  const tones: FeedbackTone[] = [];
  const noise: number[] = [];
  hitFallback(10, 0, (tone) => tones.push(tone), (at) => noise.push(at), () => 0.5);
  expect(noise).toEqual([0, 0.06, 0.12, 0.18]);
  expect(tones).toHaveLength(17);
  expect(tones[0].freq).toBe(1318.5);
  expect(tones[12].at).toBe(0.22);
  tones.length = 0;
  winFallback(1, 1, (tone) => tones.push(tone));
  expect(tones.map(({ at }) => at)).toEqual([0.05, 0.125, 0.2]);
  tones.length = 0;
  winFallback(4, 1, (tone) => tones.push(tone));
  expect(tones).toHaveLength(10);
  expect(tones[5].at).toBe(0.4);
  tones.length = 0;
  cashFallback((tone) => tones.push(tone));
  expect(tones).toHaveLength(4);
});

test("confetti launches upward, falls and expires without advancing dead pieces", () => {
  const piece = confettiPiece(100, 200, 4, 2, () => 0.5);
  expect(piece.life).toBe(2250);
  expect(piece.hue).toBe(2);
  expect(piece.vy).toBeLessThan(0);
  const small = confettiPiece(100, 200, 1, 2, () => 0.5);
  expect(piece.vy).toBeLessThan(small.vy);
  expect(piece.life).toBeGreaterThan(small.life);
  let highest = piece.y;
  for (let frame = 0; frame < 150; frame++) {
    advanceConfetti(piece, 16);
    highest = Math.min(highest, piece.y);
    expect(Number.isFinite(piece.x) && Number.isFinite(piece.y)).toBe(true);
  }
  expect(highest).toBeLessThan(150);
  expect(piece.y).toBeGreaterThan(200);
  expect(piece.life).toBeLessThanOrEqual(0);
  const stopped = { ...piece };
  advanceConfetti(piece, 16);
  expect(piece).toEqual(stopped);
});
