import type { Tier } from "./cheer";
import type { Cue } from "./cue";

export type FeedbackKind = "tap" | "tick" | Cue;
/** Alternating vibration/pause lengths, in milliseconds, shared by native and web. */
const PATTERNS: Record<FeedbackKind, number[]> = {
  tap: [10], tick: [4], placed: [], hit: [18], run: [16, 45, 12],
  big: [24, 40, 24, 40, 60], win: [18, 70, 26], great: [18, 45, 24, 45, 40],
  top: [26, 40, 22, 40, 30, 40, 40, 110, 80], nope: [18, 60, 18], cash: [12, 40, 12, 40, 40],
};
const WIN_PATTERNS = { 1: [18, 70, 26], 2: [22, 55, 36], 3: [18, 45, 24, 45, 40], 4: PATTERNS.top };
export function hapticPattern(kind: FeedbackKind, level: Tier = 0): number[] {
  return level > 0 && (kind === "win" || kind === "great" || kind === "top")
    ? WIN_PATTERNS[level as 1 | 2 | 3 | 4] : PATTERNS[kind];
}
export function hapticBeats(pattern: readonly number[]) {
  let at = 0;
  const beats: { at: number; duration: number; strength: "light" | "medium" | "heavy" }[] = [];
  pattern.forEach((duration, i) => {
    if (i % 2 === 0) beats.push({ at, duration, strength: duration < 18 ? "light" : duration < 24 ? "medium" : "heavy" });
    at += duration;
  });
  return beats;
}
export const patternDuration = (pattern: readonly number[]) => pattern.reduce((total, ms) => total + ms, 0);
export const TILL_AT: Record<Tier, number> = { 0: 0, 1: 0.26, 2: 0.32, 3: 0.42, 4: 0.62 };
export const hitRate = (run: number) => 2 ** (Math.min(run, 7) / 12);
export type FeedbackTone = { freq: number; to?: number; at?: number; dur: number; gain: number; type?: "sine" | "triangle"; attack?: number };
type TonePlayer = (tone: FeedbackTone) => void;
type NoisePlayer = (at: number, dur: number, gain: number, freq: number, q?: number) => void;
const PENTA = [0, 2, 4, 7, 9];
const note = (step: number, base = 880) => base * 2 ** ((12 * Math.floor(step / 5) + PENTA[((step % 5) + 5) % 5]) / 12);

/** The same fallback score plays on both platforms while cached voices are being prepared. */
export function hitFallback(multiple: number, run: number, tone: TonePlayer, hiss: NoisePlayer, random = Math.random) {
  const lift = hitRate(run);
  const coins = multiple >= 10 ? 4 : multiple >= 4 ? 3 : 2;
  for (let i = 0; i < coins; i++) {
    const at = i * 0.06;
    const freq = 1318.5 * lift * (1 + i * 0.12) * 2 ** (((random() * 2 - 1) * 10) / 1200);
    tone({ freq, at, dur: 0.2, gain: 0.05 });
    tone({ freq: freq * 1.5, at, dur: 0.11, gain: 0.02 });
    tone({ freq: freq * 2.01, at, dur: 0.06, gain: 0.012 });
    hiss(at, 0.025, 0.02, 6000, 2);
  }
  if (multiple >= 10) for (let i = 0; i < 5; i++) tone({ freq: note(10 + i) * lift, at: 0.22 + i * 0.045, dur: 0.16, gain: 0.03, type: "triangle" });
}
export function winFallback(tier: Tier, lift: number, tone: TonePlayer) {
  const steps = tier >= 3 ? [0, 2, 4, 5, 7] : [0, 2, 4];
  steps.forEach((s, i) => tone({ freq: note(5 + s, 440) * lift, at: 0.05 + i * 0.075, dur: 0.35, gain: 0.045, type: "triangle" }));
  if (tier >= 3) steps.forEach((s, i) => tone({ freq: note(10 + s, 440) * lift, at: 0.4 + i * 0.05, dur: 0.25, gain: 0.02 }));
}
export function cashFallback(tone: TonePlayer) {
  [0, 2, 4, 7].forEach((s, i) => tone({ freq: note(5 + s, 440), at: 0.2 + i * 0.07, dur: 0.4, gain: 0.04, type: "triangle" }));
}

export const EFFECT_MS = 1500;
export const BURST_MS = 2600;
export const CONFETTI_POOL = 240;
export type ConfettiPiece = { x: number; y: number; vx: number; vy: number; spin: number; turn: number; size: number; life: number; hue: number };
export function confettiPiece(x: number, y: number, tier: number, hue: number, random = Math.random): ConfettiPiece {
  const reach = 0.75 + tier * 0.18;
  const a = -Math.PI / 2 + (random() - 0.5) * Math.PI * 0.95;
  const v = (0.32 + random() * 0.38) * reach;
  return { x: x + (random() - 0.5) * 8, y: y + (random() - 0.5) * 8,
    vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.12 * reach,
    spin: random() * Math.PI * 2, turn: (random() - 0.5) * 0.024,
    size: 4 + random() * 4, life: 1300 + random() * 700 + tier * 150, hue };
}
/** Shared integration, also callable on Reanimated's UI thread. */
export function advanceConfetti(p: ConfettiPiece, dt: number) {
  "worklet";
  if (p.life <= 0) return;
  p.life -= dt;
  if (p.life <= 0) return;
  const drag = Math.exp(-dt / 900);
  p.vx *= drag;
  p.vy = p.vy * drag + 0.0011 * dt;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  p.spin += p.turn * dt;
}
