import { Platform, Vibration } from "react-native";
import * as Haptics from "expo-haptics";
import { AudioContext, type AudioBuffer, type AudioBufferSourceNode, type BiquadFilterNode, type GainNode, type OscillatorType } from "react-native-audio-api";
import { hapticPattern, hapticBeats, patternDuration, TILL_AT, hitRate, hitFallback, winFallback, cashFallback, climbRate, feltLevel, type Tier, type Voice, voiceFor, voiceJob } from "@skech/core/cheer";
import { type Cue, type CueDetail, cueQueue, isHit, RANK } from "@skech/core/cue";
import { practice } from "./practice";
import { storage } from "./storage";

/*
  How the game feels: sound and touch, as on the web (ui/app/src/lib/feel.ts), on the phone's own audio and haptics.

  Every sound is synthesized here, nothing is downloaded, so the first tap is
  heard as soon as it lands. Everything runs through one bus.

  The rules the sounds follow:
  - A tap is heard the instant the finger lands, as a drop of ink.
  - Drawing sounds like a pen on paper: a soft scratch that follows the hand's speed and stops with it.
  - Only profit is celebrated. Every hit pays more than its own ink cost, so every hit is heard and felt the instant
    the price touches the ink, in the same frame as its "+$x": a bell, clean and short, a run of correct calls lifting
    it a little each time, a bigger multiple ringing notes over it.
  - A round that came out ahead rings up its chord, fuller the more it made, a step up the scale for each profitable
    round in a row (back to the root after one that was not), and the till rings as the money lands in the balance.
  - A miss, and a round that lost, make no sound and no touch.
  - One at a time: see feel(), at the bottom.
  - Anything refused is a short low double note, never a buzzer.

  The celebrations (packages/core/src/cheer.ts) are made once, a slice at a time while the pen is up, and kept: each
  then plays as one buffer, never a dozen oscillators wired up on the JS thread in the middle of a frame.
*/

let audio: AudioContext | null = null;
let bus: GainNode | null = null;
let noise: AudioBuffer | null = null;

function ctx(): AudioContext | null {
  if (!audio) {
    try {
      audio = new AudioContext();
    } catch {
      return null;
    }
    // No compressor natively: the bus sits lower instead, so ten hits in a second stay clear of clipping.
    bus = audio.createGain();
    bus.gain.value = 0.6;
    bus.connect(audio.destination);
    prepareVoices();
  }
  if (audio.state === "suspended") void audio.resume();
  sleepSoon();
  return audio;
}

/*
  A running context renders silence on its own thread, all the time: about a third of a core on a cheap phone. It
  sleeps once nothing has sounded for 20s, and the next sound wakes it.
*/
// Long enough that a player drawing stroke after stroke never pays to wake it; short enough to sleep when they stop.
const SLEEP_AFTER_MS = 20_000;
let sleeper: ReturnType<typeof setTimeout> | null = null;
function sleepSoon() {
  if (sleeper) clearTimeout(sleeper);
  sleeper = setTimeout(() => {
    sleeper = null;
    if (penVoice) return sleepSoon();
    if (audio?.state === "running") void audio.suspend();
  }, SLEEP_AFTER_MS);
}

/*
  Ink can be drawn thirty seconds ahead, longer than the context stays up with nothing sounding, and waking it is a
  native stream restart: the hit that woke it would be heard late. So while any ink is in play the context is kept
  up (and made, the first time, so the bell is made before the first hit rather than after it).
*/
let awake = 0;
export function stayAwake() {
  const now = performance.now();
  if (now - awake < 1000 || !on()) return;
  awake = now;
  ctx();
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
  o.onEnded = () => {
    o.disconnect();
    g.disconnect();
  };
}

/** A burst of filtered noise: the wet edge of a drop, the click of a piece going in. */
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
  src.onEnded = () => {
    src.disconnect();
    band.disconnect();
    g.disconnect();
  };
}


/*
  The celebrations, made once: from the first sound on, a slice of a few milliseconds every other frame or so, the
  hit's bell first (it is what is heard soonest), never while the pen is down. One asked for before it is ready falls back to the chimes and chords
  below, so nothing is ever late waiting for it. At 24 kHz: half the work of the phone's own rate, and nothing in them
  is anywhere near that high.
*/
const VOICE_RATE = 24_000;
const VOICE_ORDER: Voice[] = ["hit", "win1", "coins", "win2", "win3", "win4"];
const voices = new Map<Voice, AudioBuffer>();
let making: { voice: Voice; run: (n: number) => boolean; result: () => Float32Array<ArrayBuffer> } | null = null;
let preparing = false;

function prepareVoices() {
  if (preparing) return;
  preparing = true;
  setTimeout(makeSome, 400);
}
function makeSome() {
  const a = audio;
  if (!a) return;
  // The pen gets the JS thread to itself: try again once it is up.
  if (penVoice) return void setTimeout(makeSome, 300);
  const until = performance.now() + 3;
  while (performance.now() < until) {
    if (!making) {
      const next = VOICE_ORDER.find((v) => !voices.has(v));
      if (!next) return;
      making = { voice: next, ...voiceJob(next, VOICE_RATE) };
    }
    if (making.run(512)) {
      const data = making.result();
      const buffer = a.createBuffer(1, data.length, VOICE_RATE);
      buffer.copyToChannel(data, 0);
      voices.set(making.voice, buffer);
      making = null;
    }
  }
  setTimeout(makeSome, 32);
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
  src.onEnded = () => {
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
    v.src.onEnded = () => {
      v.src.disconnect();
      v.gain.disconnect();
    };
  },
};

/** How the last hit was heard, for the timing log: the made bell, or the coins standing in for it. */
let heard: "bell" | "coins" = "coins";

export const sound = {
  /** A drop of ink landing: a falling "plip" with a wet edge. Every tap, the instant it lands. */
  drop: () => {
    if (!on()) return;
    tone({ freq: vary(1250, 40), to: vary(240), dur: 0.11, gain: 0.11, attack: 0.002 });
    tone({ freq: vary(2600, 40), to: 900, dur: 0.035, gain: 0.025, attack: 0.001 });
    hiss(0, 0.03, 0.05, 3200, 1.4);
  },

  /** A piece the chain took: a crisp click, an order going in, with a low knock under it. */
  placed: () => {
    if (!on()) return;
    tone({ freq: 330, to: 262, dur: 0.09, gain: 0.03, type: "triangle" });
  },

  /** A hit's bell and extra notes, pitched up a semitone for each hit in a run; shared fallback coins until ready. */
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

  /** A profitable round's shared chord and till; the same fallback score as web while the cached voice prepares. */
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

  /** Money arrived: the shared till, then a bright chord. */
  cash: () => {
    if (!on()) return;
    if (voice("coins") && voice("win2", { at: 0.18, gain: 0.85 })) return;
    sound.hit(4);
    cashFallback(tone);
  },
};

/*
  Touch: the phone's own haptic engine. Few and short, as good apps use it, and only for what is worth feeling: a
  profit most of all. A piece landing is heard, not felt; a miss neither.
*/
/**
 * What can be felt. `hit`, `run` and `big` are a hit (one, one of a run, one at 10× or more); `win`, `great` and
 * `top` a round that came out ahead (cheer.ts's tiers 1-2, 3 and 4).
 */
export type Feel = "tap" | "tick" | Cue;

/** A new pulse sequence replaces smaller ones, while a bigger celebration finishes. */
let pulses: ReturnType<typeof setTimeout>[] = [];
let motorUntil = 0;
let motorRank = 0;
function buzz(kind: Feel, now: number, level: Tier = 0) {
  if (!practice().haptics || kind === "placed") return;
  const rank = kind === "tap" || kind === "tick" ? 0 : isHit(kind) ? RANK.big : RANK[kind];
  if (now < motorUntil && motorRank > rank) return;
  const pattern = hapticPattern(kind, level);
  for (const timer of pulses) clearTimeout(timer);
  pulses = [];
  motorUntil = now + patternDuration(pattern);
  motorRank = rank;
  // Android can play the browser's exact vibration/pause lengths. React Native starts with a wait slot.
  if (Platform.OS === "android") {
    Vibration.cancel();
    Vibration.vibrate([0, ...pattern]);
    return;
  }
  // iOS exposes impact presets rather than pulse durations; preserve the shared beat times and strengths.
  const play = (strength: "light" | "medium" | "heavy") => {
    const style = strength === "light" ? Haptics.ImpactFeedbackStyle.Light : strength === "medium" ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Heavy;
    void Haptics.impactAsync(style).catch(() => {});
  };
  for (const beat of hapticBeats(pattern)) {
    if (beat.at === 0) play(beat.strength);
    else pulses.push(setTimeout(() => play(beat.strength), beat.at));
  }
}

/** Touch alone, for the sheets' buttons: felt at once, unless the motor is in the middle of something bigger. */
export function haptic(kind: Feel) {
  const now = performance.now();
  if ((kind === "tap" || kind === "tick") && now < motorUntil) return;
  buzz(kind, now);
}

function sounds(kind: Cue, detail?: CueDetail) {
  if (kind === "placed") sound.placed();
  else if (isHit(kind)) sound.hit(detail?.multiple ?? 2, detail?.run ?? 0);
  else if (kind === "win" || kind === "great" || kind === "top") sound.win((detail?.tier ?? 1) as Tier, detail?.rounds ?? 1, detail?.till ?? false);
  else if (kind === "nope") sound.nope();
  else if (kind === "cash") sound.cash();
}

/*
  The timing log: from the judge finding a hit, to feel(), to the audio start call, one line a cue. On in development;
  on a release build, open skech://debug?feel=1 (src/app/debug.tsx) and read it from `adb logcat -s ReactNativeJS`,
  every line starting "[skech:feel]". skech://debug?feel=0 turns it off.
*/
const TRACE_KEY = "skech:debug:feel";
let tracing = (() => {
  try {
    return __DEV__ || storage.getBoolean(TRACE_KEY) === true;
  } catch {
    return __DEV__;
  }
})();
export function traceFeel(on: boolean) {
  tracing = on || __DEV__;
  console.info(`[skech:feel] timing log ${tracing ? "on" : "off"}`);
  try {
    storage.set(TRACE_KEY, on);
  } catch {
    /* it still holds for this run */
  }
}
const ms = (n: number) => `${n.toFixed(1)}ms`;
function trace(kind: Cue, detail: CueDetail | undefined, asked: number, played: number, started: number, state: string) {
  const what = isHit(kind) ? `${kind} ×${(detail?.multiple ?? 0).toFixed(1)} ${heard}` : kind;
  const seen = detail?.seen;
  const found = seen === undefined ? "" : `detect→feel ${ms(asked - seen)}, `;
  console.info(`[skech:feel] ${what}: ${found}feel→play ${ms(played - asked)}, play→audio start ${ms(started - played)}, total ${ms(started - (seen ?? asked))}, audio ${state}`);
}

/*
  One thing at a time: what plays when is @skech/core/cue's queue, the web's too. A hit plays the instant it is
  found, over anything smaller; a burst of them is one; a round's result waits for nothing but a hit still ringing.
  The finger is the exception to the queue: a tap is heard and felt the instant it lands.
*/
const cues = cueQueue((kind, detail, asked) => {
  const played = performance.now();
  // Asleep or never woken: the sound below waits on the native stream starting, and the log says so.
  const state = audio?.state ?? "none";
  buzz(kind, played, detail?.tier ? feltLevel(detail.tier as Tier, detail.rounds ?? 1) : 0);
  if (on()) sounds(kind, detail);
  if (tracing) trace(kind, detail, asked, played, performance.now(), state);
});

/** Sound and touch together, which is how nearly everything is felt, in turn. */
export function feel(kind: Feel, detail?: CueDetail) {
  const now = performance.now();
  if (kind === "tap") {
    if (now >= motorUntil) buzz(kind, now);
    if (on()) sound.drop();
    return;
  }
  // The pen's tick: felt only when nothing else is, so drawing never drowns out a hit.
  if (kind === "tick") {
    if (now >= motorUntil && !cues.busy(now)) buzz(kind, now);
    return;
  }
  cues.push(kind, detail);
}

/** A round that came out ahead, felt and heard by its tier, and a step up for each profitable round in a row. */
export function celebrate(tier: Tier, rounds: number) {
  if (tier === 0) return;
  feel(tier >= 4 ? "top" : tier === 3 ? "great" : "win", { tier, rounds, till: true });
}
