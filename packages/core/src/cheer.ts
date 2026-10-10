/**
 * How a profit is celebrated, worked out once for the web and the phone.
 *
 * - `winTier`: how big a round's profit is. Nothing below a profit is celebrated: a loss, or a round that only
 *   broke even, is tier 0, and is neither heard nor felt.
 * - `climb`: how far up the scale a run of profitable rounds has gone. Each one in a row rings a step higher, up to
 *   an octave; a round that does not come out ahead starts it again from the root.
 * - The sounds themselves (`voiceJob`): made here, sample by sample, rather than wired up from oscillators each time
 *   one plays. Each is made once, a slice at a time while nothing else is going on, and kept; playing one is then a
 *   single buffer, pitched up the scale by its playback rate. Each is a bright bell-like main tone, a soft shimmer
 *   over it (two partials a few cents apart, beating slowly), and a small room's reverb under it, and each is scaled
 *   to its own peak, so none can clip however they overlap on the way out.
 *
 * Pure functions over plain numbers: no audio API is touched here, so the tests can hear (and measure) every sample.
 */

export type Tier = 0 | 1 | 2 | 3 | 4;

/**
 * 0 for no profit; 1 a profit; 2 at least twice the stake back; 3 a strong round, three times the stake back or a hit
 * at 10× or more (the round card's "big win"); 4 a top round, eight times the stake back or a hit at 32× or more.
 */
export function winTier(won: number, cost: number, best = 0): Tier {
  if (!(won > cost) || !(won - cost >= 0.005)) return 0;
  const ratio = cost > 0 ? won / cost : Infinity;
  if (ratio >= 8 || best >= 32) return 4;
  if (ratio >= 3 || best >= 10) return 3;
  if (ratio >= 2) return 2;
  return 1;
}

/** Semitones up for the nth profitable round in a row: a major pentatonic from the root, an octave at most. */
const CLIMB = [0, 2, 4, 7, 9, 12];
export const climb = (streak: number) => CLIMB[Math.max(0, Math.min(CLIMB.length - 1, Math.floor(streak) - 1))];
/** The playback rate that puts a sound `climb(streak)` semitones up. */
export const climbRate = (streak: number) => 2 ** (climb(streak) / 12);

/** How strongly a profit is felt in the hand: the tier, one stronger from three in a row, two from six. Never past 4. */
export const feltLevel = (tier: Tier, streak: number): Tier =>
  tier === 0 ? 0 : (Math.min(4, tier + (streak >= 3 ? 1 : 0) + (streak >= 6 ? 1 : 0)) as Tier);

/** The confetti a profit throws, by tier: none for no profit, a handful for a small one, a shower for a top one. */
export const BURST: Record<Tier, number> = { 0: 0, 1: 26, 2: 40, 3: 70, 4: 120 };

// ---- The sounds ------------------------------------------------------------------------------------------------

export type Voice = "hit" | "win1" | "win2" | "win3" | "win4" | "coins";
export const voiceFor = (tier: Tier): Voice => (tier >= 4 ? "win4" : tier === 3 ? "win3" : tier === 2 ? "win2" : "win1");

/**
 * Each sound's loudest sample. Under the web's compressor threshold for the small ones, a little into it for the big
 * ones; the phone's bus has no compressor and sits lower. Summed, the loudest two that can overlap stay well under 1.
 */
export const VOICE_PEAK: Record<Voice, number> = { hit: 0.16, win1: 0.2, win2: 0.22, win3: 0.26, win4: 0.3, coins: 0.15 };

// The notes, a C major chord's: whatever order they ring in, they never clash.
const C5 = 523.25,
  E5 = 659.26,
  G5 = 783.99,
  C6 = 1046.5,
  D6 = 1174.66,
  E6 = 1318.51,
  G6 = 1567.98,
  C7 = 2093.0,
  D7 = 2349.32,
  E7 = 2637.02,
  G7 = 3135.96;

/** One ringing partial: a sine from `at` (s), up over `attack` (s), then dying away with time constant `tau` (s). */
type Partial = { at: number; f: number; amp: number; attack: number; tau: number };
/** A burst of noise through a band-pass: the "ka" of a till, the tick of a coin landing. */
type Burst = { at: number; f: number; q: number; amp: number; tau: number; seed: number };
type Score = { seconds: number; wet: number; partials: Partial[]; bursts: Burst[] };

/** The bright main tone: a bell's partials, the higher ones quieter and shorter, so it rings clear and glassy. */
const bell = (s: Score, at: number, f: number, gain: number, tau = 0.3, bright = 1) => {
  const ratios = [1, 2, 3, 4.2];
  const amps = [1, 0.4 * bright, 0.13 * bright, 0.05 * bright];
  const taus = [1, 0.62, 0.42, 0.3];
  ratios.forEach((r, i) => s.partials.push({ at, f: f * r, amp: gain * amps[i], attack: 0.0025, tau: tau * taus[i] }));
};
/** The shimmer: two partials a few cents either side of an octave up, coming in softly and beating slowly. */
const shimmer = (s: Score, at: number, f: number, gain: number, tau = 0.5) => {
  for (const d of [0.9988, 1.0012]) s.partials.push({ at: at + 0.02, f: f * 2 * d, amp: gain * 0.5, attack: 0.07, tau });
};
/** A soft chord under it all: sines with a quiet octave, swelling in rather than struck. */
const pad = (s: Score, at: number, fs: number[], gain: number, tau = 0.7, attack = 0.04) => {
  for (const f of fs) {
    s.partials.push({ at, f, amp: gain, attack, tau });
    s.partials.push({ at, f: f * 2, amp: gain * 0.18, attack, tau: tau * 0.6 });
  }
};
/** A coin landing: a struck disc's partials (not a harmonic series: that is what makes it metal), short, with a tick. */
const coin = (s: Score, at: number, f: number, gain: number, seed: number) => {
  const ratios = [1, 2.76, 5.4, 8.93];
  const amps = [1, 0.5, 0.28, 0.12];
  ratios.forEach((r, i) => s.partials.push({ at, f: f * r, amp: gain * amps[i], attack: 0.0008, tau: 0.075 / (1 + i * 0.6) }));
  s.bursts.push({ at, f: 6200, q: 2.2, amp: gain * 0.35, tau: 0.006, seed });
};

/** A small, seeded random: the same sound every time it is made, so the tests can measure it. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

function score(voice: Voice): Score {
  const s: Score = { seconds: 1, wet: 0.2, partials: [], bursts: [] };
  switch (voice) {
    case "hit":
      // A hit in a round that is ahead: one clear note, an octave of shimmer over it.
      s.seconds = 0.9;
      s.wet = 0.18;
      bell(s, 0, C6, 1, 0.22, 0.8);
      shimmer(s, 0, C6, 0.32, 0.3);
      break;
    case "win1":
      // A profit: two notes up a major third, over a soft fifth.
      s.seconds = 1.4;
      s.wet = 0.22;
      pad(s, 0, [C5, G5], 0.22, 0.5);
      bell(s, 0, C6, 1, 0.28);
      bell(s, 0.075, E6, 0.9, 0.32);
      shimmer(s, 0.075, E6, 0.3, 0.45);
      break;
    case "win2":
      // Twice the stake back: the whole chord, rising.
      s.seconds = 1.6;
      s.wet = 0.24;
      pad(s, 0, [C5, E5, G5], 0.2, 0.6);
      bell(s, 0, C6, 1, 0.3);
      bell(s, 0.07, E6, 0.95, 0.32);
      bell(s, 0.14, G6, 0.95, 0.38);
      shimmer(s, 0.14, G6, 0.32, 0.55);
      break;
    case "win3":
      // A strong round: up the chord to the octave, a chord blooming under it, a sparkle over the top.
      s.seconds = 2.1;
      s.wet = 0.28;
      pad(s, 0.02, [C5, E5, G5, C6], 0.22, 0.8, 0.05);
      [C6, E6, G6, C7].forEach((f, i) => bell(s, i * 0.055, f, 0.9, 0.4));
      shimmer(s, 0.165, C7, 0.34, 0.7);
      [E7, G7, C7 * 2].forEach((f, i) => bell(s, 0.3 + i * 0.045, f, 0.22, 0.12, 0.5));
      break;
    case "win4":
      // A top round: two octaves of the chord running up, the whole chord held under a shimmer, sparkle falling.
      s.seconds = 2.8;
      s.wet = 0.32;
      [C5, E5, G5, C6, E6, G6, C7].forEach((f, i) => bell(s, i * 0.045, f, 0.6 + i * 0.065, 0.36));
      pad(s, 0.34, [C5, E5, G5, C6, E6], 0.26, 1.1, 0.06);
      shimmer(s, 0.34, C7, 0.36, 1);
      shimmer(s, 0.36, G6, 0.28, 0.9);
      [G7, E7, D7, C7, D6 * 2].forEach((f, i) => bell(s, 0.5 + i * 0.06, f, 0.24 - i * 0.025, 0.14, 0.5));
      break;
    case "coins": {
      // Money landing in the balance: the till's "ka", its bell, and a few coins settling, each sooner and softer.
      s.seconds = 1.0;
      s.wet = 0.14;
      s.bursts.push({ at: 0, f: 1800, q: 1.1, amp: 0.55, tau: 0.022, seed: 7 });
      bell(s, 0.03, E7, 0.5, 0.32, 0.4);
      bell(s, 0.03, C7, 0.32, 0.38, 0.4);
      const r = random(42);
      const times = [0.09, 0.155, 0.21, 0.255, 0.29, 0.315];
      times.forEach((t, i) => coin(s, t + r() * 0.008, 2600 + r() * 1000, 0.5 - i * 0.065, 100 + i));
      break;
    }
  }
  return s;
}

export type VoiceJob = {
  /** Make the next `samples` samples (of whichever pass it is on). True once the sound is finished. */
  run: (samples: number) => boolean;
  /** The finished sound, mono, scaled to its `VOICE_PEAK`. */
  result: () => Float32Array<ArrayBuffer>;
  /** How many samples it is. */
  length: number;
};

/**
 * A sound, made a slice at a time: `run(n)` makes `n` more samples. Four passes over the buffer: the notes, the
 * reverb, the peak, the scaling. The same sums in the same order however it is sliced, so the result is exact.
 */
export function voiceJob(voice: Voice, sampleRate: number): VoiceJob {
  const s = score(voice);
  const length = Math.ceil(s.seconds * sampleRate);
  const dry = new Float32Array(length);
  const wet = new Float32Array(length);
  const nyquist = sampleRate * 0.45;

  // The partials: each a sine by recurrence (two multiplies a sample, no Math.sin), with an envelope by multiplier.
  const parts = s.partials
    .filter((p) => p.f < nyquist && p.amp > 0)
    .map((p) => {
      const w = (2 * Math.PI * p.f) / sampleRate;
      return {
        start: Math.round(p.at * sampleRate),
        attack: Math.max(1, Math.round(p.attack * sampleRate)),
        decay: Math.exp(-1 / (p.tau * sampleRate)),
        k: 2 * Math.cos(w),
        y1: -Math.sin(w),
        y2: -Math.sin(2 * w),
        n: 0,
        env: 1,
        amp: p.amp,
        done: false,
      };
    });
  // The bursts: seeded noise through an RBJ band-pass.
  const bursts = s.bursts.map((b) => {
    const w = (2 * Math.PI * Math.min(b.f, nyquist)) / sampleRate;
    const alpha = Math.sin(w) / (2 * b.q);
    const a0 = 1 + alpha;
    return {
      start: Math.round(b.at * sampleRate),
      decay: Math.exp(-1 / (b.tau * sampleRate)),
      b0: alpha / a0,
      b2: -alpha / a0,
      a1: (-2 * Math.cos(w)) / a0,
      a2: (1 - alpha) / a0,
      x1: 0,
      x2: 0,
      y1: 0,
      y2: 0,
      env: 1,
      amp: b.amp,
      rand: random(b.seed),
      done: false,
    };
  });

  // A small room (Freeverb's, mono): four damped combs in parallel, two all-passes after them, after a short gap.
  const scale = sampleRate / 44100;
  const combs = [1116, 1188, 1277, 1356].map((d) => ({ buf: new Float32Array(Math.round(d * scale)), i: 0, store: 0 }));
  const passes = [556, 441].map((d) => ({ buf: new Float32Array(Math.round(d * scale)), i: 0 }));
  const FEEDBACK = 0.76,
    DAMP = 0.3,
    PASS = 0.5;
  const gap = Math.round(0.012 * sampleRate);

  let pass: "dry" | "wet" | "peak" | "scale" | "done" = "dry";
  let at = 0;
  let peak = 0;

  const run = (samples: number) => {
    let budget = samples;
    while (budget > 0 && pass !== "done") {
      const to = Math.min(length, at + budget);
      budget -= to - at;
      if (pass === "dry") {
        for (const p of parts) {
          if (p.done || p.start >= to) continue;
          for (let i = Math.max(at, p.start); i < to; i++) {
            const y = p.k * p.y1 - p.y2;
            p.y2 = p.y1;
            p.y1 = y;
            const level = p.n < p.attack ? p.n / p.attack : (p.env *= p.decay);
            p.n++;
            dry[i] += y * level * p.amp;
            if (level < 1e-5 && p.n > p.attack) {
              p.done = true;
              break;
            }
          }
        }
        for (const b of bursts) {
          if (b.done || b.start >= to) continue;
          for (let i = Math.max(at, b.start); i < to; i++) {
            const x = b.rand() * 2 - 1;
            const y = b.b0 * x + b.b2 * b.x2 - b.a1 * b.y1 - b.a2 * b.y2;
            b.x2 = b.x1;
            b.x1 = x;
            b.y2 = b.y1;
            b.y1 = y;
            b.env *= b.decay;
            dry[i] += y * b.env * b.amp;
            if (b.env < 1e-5) {
              b.done = true;
              break;
            }
          }
        }
      } else if (pass === "wet") {
        for (let i = at; i < to; i++) {
          const x = i >= gap ? dry[i - gap] * 0.25 : 0;
          let y = 0;
          for (const c of combs) {
            const out = c.buf[c.i];
            c.store = out * (1 - DAMP) + c.store * DAMP;
            c.buf[c.i] = x + c.store * FEEDBACK;
            if (++c.i >= c.buf.length) c.i = 0;
            y += out;
          }
          for (const a of passes) {
            const held = a.buf[a.i];
            const out = held - y;
            a.buf[a.i] = y + held * PASS;
            if (++a.i >= a.buf.length) a.i = 0;
            y = out;
          }
          wet[i] = y;
        }
      } else if (pass === "peak") {
        for (let i = at; i < to; i++) {
          const v = Math.abs(dry[i] + s.wet * wet[i]);
          if (v > peak) peak = v;
        }
      } else {
        const k = peak > 0 ? VOICE_PEAK[voice] / peak : 0;
        // The last 150 ms fade to nothing, so the end of the room's tail is never heard as a cut.
        const fade = Math.round(0.15 * sampleRate);
        for (let i = at; i < to; i++) {
          const tail = length - i < fade ? (length - i) / fade : 1;
          dry[i] = (dry[i] + s.wet * wet[i]) * k * tail;
        }
      }
      at = to;
      if (at >= length) {
        at = 0;
        pass = pass === "dry" ? "wet" : pass === "wet" ? "peak" : pass === "peak" ? "scale" : "done";
      }
    }
    return pass === "done";
  };
  return {
    run,
    result: () => {
      if (pass !== "done") throw new Error("voiceJob: not finished");
      return dry;
    },
    length,
  };
}

/** A sound made in one go. */
export function renderVoice(voice: Voice, sampleRate: number): Float32Array<ArrayBuffer> {
  const job = voiceJob(voice, sampleRate);
  job.run(Infinity);
  return job.result();
}

export { hapticPattern, hapticBeats, patternDuration, TILL_AT, hitRate, hitFallback, winFallback, cashFallback, EFFECT_MS, BURST_MS, CONFETTI_POOL, confettiPiece, advanceConfetti, type ConfettiPiece } from "./feedback";
