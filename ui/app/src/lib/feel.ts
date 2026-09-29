"use client";

import { hapticPattern, hapticBeats, patternDuration, TILL_AT, hitRate, hitFallback, winFallback, cashFallback, climbRate, feltLevel, type Tier, type Voice, voiceFor, voiceJob } from "@skech/core/cheer";
import { type Cue, type CueDetail, cueQueue, isHit, RANK } from "@skech/core/cue";
import { practice } from "./practice";

/*
  How the game feels: sound and touch.

  Every sound is synthesized here, nothing is downloaded, so the first tap is
  heard as soon as it lands. Everything runs through one bus with a
  compressor on it: ten hits in one second stay loud without clipping.

  The rules the sounds follow:
  - A tap is heard the instant the finger lands, as a drop of ink.
  - Drawing sounds like a pen on paper: a soft scratch that follows the hand's speed and stops with it.
  - Only profit is celebrated. Every hit pays more than its own ink cost, so every hit is heard the instant the price
    touches the ink, in the same frame as its "+$x": a bell, a step higher for each hit in a row, a big one with notes
    over it.
  - A round that came out ahead rings up its chord, fuller the more it made, a step up the scale for each profitable
    round in a row (back to the root after one that was not), and the till rings as the money lands in the balance.
  - A round that lost makes no sound and no touch.
  - One at a time: see feel(), at the bottom.
  - Anything refused is a short low double note, never a buzzer.

  The celebrations (packages/core/src/cheer.ts) are made once, a slice at a time while the page is idle, and kept:
  each then plays as one buffer, never a dozen oscillators wired up in the middle of a frame.
*/

let audio: AudioContext | null = null;
let bus: GainNode | null = null;
let noise: AudioBuffer | null = null;

function ctx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!audio) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    audio = new Ctor({ latencyHint: "interactive" });
    const squash = audio.createDynamicsCompressor();
    squash.threshold.value = -16;
    squash.knee.value = 8;
    squash.ratio.value = 4;
    squash.attack.value = 0.002;
    squash.release.value = 0.12;
    bus = audio.createGain();
    bus.gain.value = 0.9;
    bus.connect(squash).connect(audio.destination);
    prepareVoices();
  }
  if (audio.state === "suspended") void audio.resume();
  return audio;
}

/*
  Browsers start audio suspended and only let a completed gesture start it: a pointerup, a click, a key, never a
  pointerdown from a finger. So the first finished tap anywhere on the page unlocks it, and on iPhones plays one
  silent sample inside that gesture, which is what Safari needs before it will play anything later.
*/
function unlock() {
  const a = ctx();
  if (!a) return;
  const b = a.createBuffer(1, 1, a.sampleRate);
  const src = a.createBufferSource();
  src.buffer = b;
  src.connect(a.destination);
  src.start(0);
  if (a.state === "running") {
    for (const type of ["pointerup", "touchend", "keydown", "click"]) document.removeEventListener(type, unlock, true);
  }
}
if (typeof document !== "undefined") {
  for (const type of ["pointerup", "touchend", "keydown", "click"]) document.addEventListener(type, unlock, true);
}

/** Half a second of white noise, made once: every hiss and the pen's scratch are cut from it. */
function noiseBuffer(a: AudioContext): AudioBuffer {
  if (!noise) {
    noise = a.createBuffer(1, Math.floor(a.sampleRate * 0.5), a.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  return noise;
}

const on = () => practice().sound;
/** A few cents either way, so the same sound twice never sounds like a machine. */
const vary = (f: number, cents = 18) => f * 2 ** (((Math.random() * 2 - 1) * cents) / 1200);

type Tone = { freq: number; to?: number; at?: number; dur: number; gain: number; type?: OscillatorType; attack?: number };

function tone({ freq, to, at = 0, dur, gain, type = "sine", attack = 0.004 }: Tone) {
  const a = ctx();
  if (!a || !bus) return;
  const t = a.currentTime + at;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur * 0.8);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(bus);
  o.start(t);
  o.stop(t + dur + 0.03);
  o.onended = () => {
    o.disconnect();
    g.disconnect();
  };
}

/** A burst of filtered noise: the wet edge of a drop, the rattle of a coin. */
function hiss(at: number, dur: number, gain: number, freq: number, q = 1.2) {
  const a = ctx();
  if (!a || !bus) return;
  const t = a.currentTime + at;
  const src = a.createBufferSource();
  src.buffer = noiseBuffer(a);
  const band = a.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = freq;
  band.Q.value = q;
  const g = a.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(band).connect(g).connect(bus);
  src.start(t, Math.random() * 0.4);
  src.stop(t + dur + 0.02);
  src.onended = () => {
    src.disconnect();
    band.disconnect();
    g.disconnect();
  };
}


/*
  The celebrations, made once. Not at load: the first finished tap starts audio, and from then on they are made in
  the page's idle time, a few milliseconds a slice, the hit's bell first (it is what is heard soonest), never while the pen is down. One asked for
  before it is ready falls back to the oscillators below, so nothing is ever late waiting for it.
*/
const VOICE_RATE = 32_000;
const VOICE_ORDER: Voice[] = ["hit", "win1", "coins", "win2", "win3", "win4"];
const voices = new Map<Voice, AudioBuffer>();
let making: { voice: Voice; run: (n: number) => boolean; result: () => Float32Array<ArrayBuffer> } | null = null;
let preparing = false;

function prepareVoices() {
  if (preparing) return;
  preparing = true;
  later();
}
function later() {
  if (typeof requestIdleCallback === "function") requestIdleCallback(makeSome, { timeout: 1500 });
  else setTimeout(() => makeSome(), 60);
}
function makeSome(idle?: IdleDeadline) {
  const a = audio;
  if (!a) return;
  // The pen gets the frame to itself: try again once it is up.
  if (penVoice) return void setTimeout(later, 250);
  const until = performance.now() + Math.min(6, idle ? idle.timeRemaining() : 4);
  while (performance.now() < until) {
    if (!making) {
      const next = VOICE_ORDER.find((v) => !voices.has(v));
      if (!next) return;
      making = { voice: next, ...voiceJob(next, VOICE_RATE) };
    }
    if (making.run(1024)) {
      const data = making.result();
      const buffer = a.createBuffer(1, data.length, VOICE_RATE);
      buffer.copyToChannel(data, 0);
      voices.set(making.voice, buffer);
      making = null;
    }
  }
  later();
}

/** Plays a made celebration, `at` seconds from now, `rate` times as fast (and so as high). False if not made yet. */
function voice(v: Voice, { at = 0, rate = 1, gain = 1 }: { at?: number; rate?: number; gain?: number } = {}): boolean {
  const a = ctx();
  const buffer = voices.get(v);
  if (!a || !bus || !buffer) return false;
  const src = a.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;
  const g = a.createGain();
  g.gain.value = gain;
  src.connect(g).connect(bus);
  src.start(a.currentTime + at);
  src.onended = () => {
    src.disconnect();
    g.disconnect();
  };
  return true;
}

/*
  The pen: looped noise shaped into the scratch of a nib on paper. A bandpass high in the treble is the nib,
  a quieter low band the paper under it. The voice runs while the pen is down; its loudness follows how fast
  the hand moves, and its colour wanders a little, as a real stroke's does. Still pen, silent pen.
*/
type PenVoice = { src: AudioBufferSourceNode; nib: BiquadFilterNode; gain: GainNode; stopAt: number };
let penVoice: PenVoice | null = null;

export const pen = {
  down: () => {
    const a = ctx();
    if (!a || !bus || !on()) return;
    pen.up();
    const src = a.createBufferSource();
    src.buffer = noiseBuffer(a);
    src.loop = true;
    const nib = a.createBiquadFilter();
    nib.type = "bandpass";
    nib.frequency.value = 3400;
    nib.Q.value = 0.9;
    const paper = a.createBiquadFilter();
    paper.type = "bandpass";
    paper.frequency.value = 950;
    paper.Q.value = 0.7;
    const paperGain = a.createGain();
    paperGain.gain.value = 0.35;
    const gain = a.createGain();
    gain.gain.value = 0;
    src.connect(nib).connect(gain);
    src.connect(paper).connect(paperGain).connect(gain);
    gain.connect(bus);
    src.start(a.currentTime, Math.random() * 0.4);
    penVoice = { src, nib, gain, stopAt: 0 };
  },
  /** How fast the pen is moving, in pixels a millisecond: louder and a touch brighter the faster it goes. */
  move: (speed: number) => {
    const a = audio;
    if (!a || !penVoice) return;
    const t = a.currentTime;
    const level = Math.min(0.09, 0.012 + speed * 0.05);
    // Each move replaces the last one's fade-out, so a steady stroke is a steady scratch.
    penVoice.gain.gain.cancelScheduledValues(t);
    penVoice.gain.gain.setTargetAtTime(level, t, 0.02);
    // Nothing moving for a moment and the scratch dies away by itself.
    penVoice.gain.gain.setTargetAtTime(0, t + 0.06, 0.05);
    penVoice.nib.frequency.setTargetAtTime(vary(2900 + Math.min(speed, 2) * 900, 60), t, 0.03);
  },
  up: () => {
    const a = audio;
    const v = penVoice;
    if (!a || !v) return;
    penVoice = null;
    v.gain.gain.cancelScheduledValues(a.currentTime);
    v.gain.gain.setTargetAtTime(0, a.currentTime, 0.025);
    v.src.stop(a.currentTime + 0.15);
    v.src.onended = () => {
      v.src.disconnect();
      v.gain.disconnect();
    };
  },
};

/** How the last hit was heard, for the timing log: the made bell, or the coins standing in for it. */
let heard: "bell" | "coins" = "coins";

export const sound = {
  /** Unlock audio from inside a completed gesture. The page does this by itself; see `unlock`. */
  wake: unlock,

  /** A drop of ink landing: a falling "plip" with a wet edge. Every tap, the instant it lands. */
  drop: () => {
    if (!on()) return;
    tone({ freq: vary(1250, 40), to: vary(240), dur: 0.11, gain: 0.11, attack: 0.002 });
    tone({ freq: vary(2600, 40), to: 900, dur: 0.035, gain: 0.025, attack: 0.001 });
    hiss(0, 0.03, 0.05, 3200, 1.4);
  },

  /** A piece the chain took: a soft, low seal under the drop. */
  placed: () => {
    if (!on()) return;
    tone({ freq: 330, to: 262, dur: 0.09, gain: 0.03, type: "triangle" });
  },

  /**
   * A hit: a bell, a step up for every hit in a row; four times its stake or more rings a
   * fifth over it, ten or more the octave too. Until the bell is made, coins.
   */
  hit: (multiple: number, run = 0) => {
    if (!on()) return;
    const lift = hitRate(run);
    if (voice("hit", { rate: vary(lift, 6) })) {
      heard = "bell";
      if (multiple >= 4) voice("hit", { at: 0.07, rate: lift * 2 ** (7 / 12), gain: 0.7 });
      if (multiple >= 10) voice("hit", { at: 0.14, rate: lift * 2, gain: 0.55 });
      return;
    }
    heard = "coins";
    hitFallback(multiple, run, tone, hiss);
  },

  /**
   * A round that came out ahead: its tier's chord (cheer.ts), a step up the scale for each profitable round in a
   * row, and the till as the money lands. Until the chord is made, a rising triangle chord.
   */
  win: (tier: Tier, rounds = 1, till = true) => {
    if (!on() || tier === 0) return;
    const lift = climbRate(rounds);
    if (!voice(voiceFor(tier), { rate: lift })) winFallback(tier, lift, tone);
    if (till) voice("coins", { at: TILL_AT[tier], gain: 0.75 + tier * 0.08 });
  },

  /** Refused: ink that could not go in, not enough money. Short, low, twice. */
  nope: () => {
    if (!on()) return;
    tone({ freq: 220, dur: 0.07, gain: 0.05, type: "triangle" });
    tone({ freq: 196, at: 0.09, dur: 0.09, gain: 0.05, type: "triangle" });
  },

  /** Money arrived: the till, then a bright chord. */
  cash: () => {
    if (!on()) return;
    if (voice("coins") && voice("win2", { at: 0.18, gain: 0.85 })) return;
    sound.hit(4);
    cashFallback(tone);
  },
};

/*
  Touch. Android has navigator.vibrate. iPhones do not, but Safari gives a
  system haptic when a switch control is flipped, so a hidden one is flipped
  instead. From iOS 17.4 to 26.4 a switch flipped from script did it. iOS
  26.5 (WebKit bug 309082) ended that: a script's label.click() now reaches
  the switch as an untrusted click, and those do not buzz. Only a finger on a
  real label with a switch in it still does: see HapticHost, which wraps the
  game. A haptic asked for during a tap on it is owed to that tap's own click,
  and plays then, once; every other tap on it is kept from flipping the
  switch. A haptic with no finger behind it (a hit, seconds on) cannot be felt
  on an iPhone any more; it still plays on older iOS, and on Android.
*/
/**
 * What can be felt. `hit`, `run` and `big` are a hit (one, one of a run, one at 10× or more); `win`, `great` and
 * `top` a round that came out ahead (cheer.ts's tiers 1-2, 3 and 4).
 */
export type Feel = "tap" | "tick" | Exclude<Cue, "placed">;

/** A pattern's later flips, so the next pattern cancels them instead of buzzing over them. */
let flips: ReturnType<typeof setTimeout>[] = [];

let flipper: HTMLLabelElement | null = null;
const ios = () =>
  typeof navigator !== "undefined" && (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

function flip() {
  if (!flipper) {
    flipper = document.createElement("label");
    flipper.setAttribute("aria-hidden", "true");
    flipper.style.cssText = "position:fixed;left:-100px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("switch", "");
    input.tabIndex = -1;
    flipper.append(input);
    document.body.append(flipper);
  }
  flipper.click();
}

/** When a finger last came down on a HapticHost, and whether a haptic was asked for since. */
let armedAt = -Infinity;
let owed = false;
/** A tap on a HapticHost began: a haptic asked for now is played by its click. */
export function armHaptic() {
  armedAt = performance.now();
  owed = false;
}
/** That tap's click, on the host's label: the switch flips (and buzzes) only if a haptic is owed. */
export function settleHaptic(e: { preventDefault(): void }) {
  if (owed) owed = false;
  else e.preventDefault();
}

/** Touch: `level` is how strongly a profitable round is felt (1-4); a new pattern replaces whatever was still playing. */
export function haptic(kind: Feel, level: Tier = 0) {
  if (typeof window === "undefined" || !practice().haptics) return;
  if ((kind === "tap" || kind === "tick") && performance.now() < buzzUntil) return;
  const pattern = hapticPattern(kind, level);
  const beats = hapticBeats(pattern);
  try {
    if (typeof navigator.vibrate === "function") {
      navigator.vibrate(pattern);
      return;
    }
    if (!ios() || !beats.length) return;
    for (const f of flips) clearTimeout(f);
    flips = [];
    // A finger is on the host: its own click plays it, on every iOS from 17.4 on. One buzz: a tap has one click.
    if (performance.now() - armedAt < 1000) {
      owed = true;
      return;
    }
    for (const beat of beats) {
      if (beat.at === 0) flip();
      else flips.push(setTimeout(flip, beat.at));
    }
  } catch {
    /* not on this device */
  }
}

function sounds(kind: Cue, detail?: CueDetail) {
  if (isHit(kind)) sound.hit(detail?.multiple ?? 2, detail?.run ?? 0);
  else if (kind === "win" || kind === "great" || kind === "top") sound.win((detail?.tier ?? 1) as Tier, detail?.rounds ?? 1, detail?.till ?? false);
  else if (kind === "nope") sound.nope();
  else if (kind === "cash") sound.cash();
}

/*
  A new vibration replaces the one still running, whole. So a cue's touch cuts off a smaller (or same-sized) one at
  once, a hit's most of all, but never a bigger one still rolling: another round's celebration is left to finish,
  and the hit is heard over it.
*/
let buzzUntil = 0;
let buzzRank = 0;
function touch(kind: Feel, level: Tier, now: number) {
  // Hits are one kind here: a new one replaces the last, whichever was bigger.
  const rank = isHit(kind as Cue) ? RANK.big : RANK[kind as Cue];
  if (now < buzzUntil && buzzRank > rank) return;
  buzzUntil = now + patternDuration(hapticPattern(kind, level));
  buzzRank = rank;
  haptic(kind, level);
}

/*
  The timing log: from the judge finding a hit, to feel(), to the audio start call, one line a cue, in the console. On
  in development; anywhere else only after localStorage.setItem("skech:debug:feel", "1") and a reload. Never on its
  own in production.
*/
const tracing = (() => {
  if (process.env.NODE_ENV !== "production") return true;
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("skech:debug:feel") === "1";
  } catch {
    return false;
  }
})();
const ms = (n: number) => `${n.toFixed(1)}ms`;
function trace(kind: Cue, detail: CueDetail | undefined, asked: number, played: number, started: number, state: string) {
  const what = isHit(kind) ? `${kind} ×${(detail?.multiple ?? 0).toFixed(1)} ${heard}` : kind;
  const seen = detail?.seen;
  const found = seen === undefined ? "" : `detect→feel ${ms(asked - seen)}, `;
  console.info(`[skech:feel] ${what}: ${found}feel→play ${ms(played - asked)}, play→audio start ${ms(started - played)}, total ${ms(started - (seen ?? asked))}, audio ${state}`);
}

/*
  One thing at a time, as on the phone (packages/solana-mobile/src/lib/feel.ts): what plays when is @skech/core/cue's
  queue. A hit plays the instant it is found, over anything smaller; a burst of them is one; a round's result waits
  for nothing but a hit still ringing. The finger is the exception to the queue: a tap is heard and felt the instant
  it lands.
*/
const cues = cueQueue((kind, detail, asked) => {
  const played = performance.now();
  const state = audio?.state ?? "none";
  touch(kind as Feel, detail?.tier ? feltLevel(detail.tier as Tier, detail.rounds ?? 1) : 0, played);
  sounds(kind, detail);
  if (tracing) trace(kind, detail, asked, played, performance.now(), state);
});

/** Sound and touch together, which is how nearly everything is felt, in turn. */
export function feel(kind: Feel, detail?: CueDetail) {
  if (kind === "tap") {
    haptic(kind);
    sound.drop();
    return;
  }
  // The pen's tick: felt only when nothing else is, so drawing never drowns out a win. Touch only: the pen's own
  // sound comes from pen.move.
  if (kind === "tick") {
    if (!cues.busy()) haptic(kind);
    return;
  }
  cues.push(kind, detail);
}

/** A round that came out ahead, felt and heard by its tier, and a step up for each profitable round in a row. */
export function celebrate(tier: Tier, rounds: number) {
  if (tier === 0) return;
  feel(tier >= 4 ? "top" : tier === 3 ? "great" : "win", { tier, rounds, till: true });
}
