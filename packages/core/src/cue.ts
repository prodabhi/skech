/**
 * When each moment of the game is heard and felt: one queue, for the web (ui/app/src/lib/feel.ts) and the phone
 * (packages/solana-mobile/src/lib/feel.ts), which hands each cue to the platform's own sound and touch the moment
 * its turn comes.
 *
 * - A hit is the money landing, so it never waits: it plays the instant it is asked for, over whatever smaller cue
 *   (a piece going in, a refusal) is still sounding. Hits asked for in the same pass of the judge, or within
 *   `MERGE_MS` of the last one played, are one burst and play once, the biggest of it; a bigger multiple asked for
 *   inside that window still rings.
 * - A round's result (and money arriving) waits for nothing smaller, but never lands on a hit that is still ringing:
 *   it starts as that hit ends, `AFTER_HIT_MS` at most after it.
 * - Everything else takes its turn, the most important first, after the last has had its say. A burst of one kind
 *   becomes one; whatever waited too long to still mean something is dropped.
 *
 * Pure: the clock and the timers are passed in, so the tests drive it on a fake clock.
 */

export type Cue = "placed" | "nope" | "hit" | "run" | "big" | "cash" | "win" | "great" | "top";
/**
 * `run`: correct calls in a row before this one. `tier` and `rounds`: a profitable round's size, and how many in a row.
 * `seen`: when the judge found it (performance.now()), for the timing log.
 */
export type CueDetail = { multiple?: number; run?: number; tier?: number; rounds?: number; till?: boolean; seen?: number };

export const RANK: Record<Cue, number> = { placed: 2, nope: 3, hit: 4, run: 5, big: 6, cash: 7, win: 7, great: 8, top: 9 };
/** How long each has the stage before the next may play, ms: a round's chord and its till ring out in full. */
export const HOLD: Record<Cue, number> = { placed: 140, nope: 220, hit: 240, run: 260, big: 420, cash: 600, win: 900, great: 1300, top: 1900 };
/** How long each may wait its turn and still mean something, ms. */
export const FRESH: Record<Cue, number> = { placed: 400, nope: 400, hit: 700, run: 700, big: 1000, cash: 2000, win: 2000, great: 2500, top: 3000 };
/** A hit this soon after the last one played is part of its burst. */
export const MERGE_MS = 80;
/** The longest a round's result waits for a hit that is still ringing. */
export const AFTER_HIT_MS = 400;

export const isHit = (k: Cue) => k === "hit" || k === "run" || k === "big";
const isResult = (k: Cue) => RANK[k] >= RANK.cash;
const family = (k: Cue) => (isHit(k) ? "hit" : k === "great" || k === "top" ? "win" : k);
/** How loud a hit rings, by its multiple: one note, a second from 4×, a third from 10× (see sound.hit). */
const notes = (k: Cue, d?: CueDetail) => (k === "big" || (d?.multiple ?? 0) >= 10 ? 2 : (d?.multiple ?? 0) >= 4 ? 1 : 0);

function merged(a: CueDetail | undefined, b: CueDetail | undefined): CueDetail {
  const x = a ?? {},
    y = b ?? {};
  // The earliest a hit in the burst was found: its wait is the burst's.
  const seen = Math.min(x.seen ?? Infinity, y.seen ?? Infinity);
  return {
    multiple: Math.max(x.multiple ?? 0, y.multiple ?? 0) || undefined,
    run: Math.max(x.run ?? 0, y.run ?? 0),
    tier: Math.max(x.tier ?? 0, y.tier ?? 0) || undefined,
    rounds: Math.max(x.rounds ?? 0, y.rounds ?? 0) || undefined,
    till: x.till || y.till || undefined,
    seen: Number.isFinite(seen) ? seen : undefined,
  };
}

export type CueClock = {
  now: () => number;
  /** Calls `fn` in `ms`; what it returns is handed to `cancel`. */
  after: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  /** Calls `fn` once the code running now is done, before the next frame: a microtask. */
  soon: (fn: () => void) => void;
};

export const realClock: CueClock = {
  now: () => performance.now(),
  after: (fn, ms) => setTimeout(fn, ms),
  cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  soon: (fn) => queueMicrotask(fn),
};

/**
 * The queue. `play` is called with each cue as it starts, and when it was asked for (`asked`, on the clock), so a
 * platform can say how long it waited.
 */
export function cueQueue(play: (kind: Cue, detail: CueDetail | undefined, asked: number) => void, clock: CueClock = realClock) {
  let queue: { kind: Cue; detail?: CueDetail; at: number }[] = [];
  let stageUntil = 0;
  let stageRank = -1;
  /** When the last hit played and what it was, and until when a round's result leaves it the stage. */
  let lastHit: { at: number; kind: Cue; detail?: CueDetail } | null = null;
  let hitUntil = 0;
  /** Hits asked for in the pass running now, played together as soon as it is done. */
  let burst: { kind: Cue; detail?: CueDetail; at: number } | null = null;
  let pump: unknown = null;

  function start(kind: Cue, detail: CueDetail | undefined, asked: number, now: number) {
    if (isHit(kind)) {
      lastHit = { at: now, kind, detail };
      hitUntil = now + Math.min(HOLD[kind], AFTER_HIT_MS);
      // Over a bigger cue still sounding (another round's chord), it rings without cutting that one's turn short.
      if (now >= stageUntil || RANK[kind] >= stageRank) {
        stageUntil = now + HOLD[kind];
        stageRank = RANK[kind];
      }
    } else {
      stageUntil = now + HOLD[kind];
      stageRank = RANK[kind];
    }
    play(kind, detail, asked);
  }

  /** How long the first in line must wait, ms: 0 to play now. */
  function wait(kind: Cue, now: number) {
    if (isResult(kind) && now < hitUntil) return hitUntil - now;
    if (now < stageUntil && RANK[kind] < stageRank + 3) return stageUntil - now;
    return 0;
  }

  function next() {
    if (pump !== null) clock.cancel(pump);
    pump = null;
    // A burst about to play goes first: whatever is waiting is lined up after it.
    if (burst) return;
    const now = clock.now();
    queue = queue.filter((q) => now - q.at <= FRESH[q.kind]);
    if (!queue.length) return;
    queue.sort((a, b) => RANK[b.kind] - RANK[a.kind] || a.at - b.at);
    const top = queue[0];
    const ms = wait(top.kind, now);
    if (ms > 0) {
      pump = clock.after(next, ms);
      return;
    }
    queue.shift();
    start(top.kind, top.detail, top.at, now);
    if (queue.length) pump = clock.after(next, HOLD[top.kind]);
  }

  function flush() {
    const b = burst;
    burst = null;
    if (b) {
      const now = clock.now();
      const last = lastHit;
      // Part of the burst just heard: only a bigger multiple rings again.
      const echo = last && now - last.at < MERGE_MS && notes(b.kind, b.detail) <= notes(last.kind, last.detail);
      if (!echo) start(b.kind, b.detail, b.at, now);
    }
    next();
  }

  return {
    push(kind: Cue, detail?: CueDetail) {
      const now = clock.now();
      if (isHit(kind)) {
        if (burst) {
          if (RANK[kind] > RANK[burst.kind]) burst.kind = kind;
          burst.detail = merged(burst.detail, detail);
        } else {
          burst = { kind, detail, at: now };
          clock.soon(flush);
        }
        return;
      }
      const same = queue.find((q) => family(q.kind) === family(kind));
      if (same) {
        if (RANK[kind] > RANK[same.kind]) same.kind = kind;
        same.detail = merged(same.detail, detail);
      } else queue.push({ kind, detail, at: now });
      next();
    },
    /** Whether a cue still has the stage: the pen's tick is felt only when nothing else is. */
    busy: (now = clock.now()) => now < stageUntil || burst !== null,
  };
}
