/**
 * Every transaction in flight, looked for together: one `getSignatureStatuses` for up to 256 of them at a time, rather
 * than one poll per transaction. Ten drawing players kept the RPC busy with nothing but "has it landed yet?".
 *
 * What each transaction is told is what it was told when it polled for itself: landed (confirmed or finalized, its
 * error if it failed) as soon as the RPC says so; and, once its blockhash has run out (or two minutes on), one last
 * look a second later through the RPC's history, then expired. Meanwhile its bytes go again every two seconds: the RPC
 * forwards once, and leaders drop under load.
 */
import type { Base64EncodedWireTransaction, Signature } from "@solana/kit";

export type Status = { slot: bigint; err: unknown | null; confirmationStatus: string | null } | null;
export type Sent = { signature: Signature; slot: bigint; err: unknown | null };
export type SendStats = { sent: number; landed: number; failed: number; expired: number; rebroadcasts: number };

export type Io = {
  /** The statuses of `signatures`, in order: null for one the RPC does not know. Throws when the RPC could not be asked. */
  statuses: (signatures: Signature[], searchTransactionHistory: boolean) => Promise<readonly Status[]>;
  /** Send the bytes once more. Never throws. */
  push: (wire: Base64EncodedWireTransaction) => Promise<unknown>;
  /** The chain's block height, as best known. */
  height: () => bigint;
};

/** The most signatures `getSignatureStatuses` takes at once. */
export const MAX_STATUSES = 256;

export const TIMING = {
  /** Between looks while something went out in the last few seconds, and otherwise. */
  fastMs: 400,
  slowMs: 1_000,
  youngMs: 5_000,
  rebroadcastMs: 2_000,
  /** After its blockhash runs out, how long before the last look. */
  lastLookMs: 1_000,
  /** With no word of the height, how long before a transaction is taken to be past it. */
  maxAgeMs: 120_000,
  /** Last looks the RPC failed to answer before the transaction is given up. */
  lastLookTries: 5,
};

type Waiter = { label: string; resolve: (s: Sent) => void; reject: (e: Error) => void };
type Watch = { signature: Signature; wire: Base64EncodedWireTransaction; lastValid: bigint; started: number; pushed: number; polled: number; lookAt: number | null; looks: number; waiters: Waiter[] };

const landed = (s: Status) => !!s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized");

export class Confirmations {
  private watching = new Map<Signature, Watch>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextAt = 0;
  private running = false;
  /** How many `getSignatureStatuses` were asked: one a tick, whatever the number in flight. */
  polls = 0;

  constructor(
    private readonly io: Io,
    readonly stats: SendStats,
    private readonly t: typeof TIMING = TIMING,
    private readonly now: () => number = Date.now,
  ) {}

  get size() {
    return this.watching.size;
  }

  /** Wait for a transaction already sent once to land, rebroadcasting it meanwhile. Rejects when it expired unseen. */
  watch(label: string, wire: Base64EncodedWireTransaction, signature: Signature, lastValid: bigint): Promise<Sent> {
    return new Promise<Sent>((resolve, reject) => {
      const waiter = { label, resolve, reject };
      // The same message twice (same instructions, same blockhash) is the same transaction: it lands once, for both.
      const w = this.watching.get(signature);
      if (w) w.waiters.push(waiter);
      else {
        const at = this.now();
        this.watching.set(signature, { signature, wire, lastValid, started: at, pushed: at, polled: 0, lookAt: null, looks: 0, waiters: [waiter] });
      }
      this.schedule(this.t.fastMs);
    });
  }

  private schedule(ms: number) {
    if (this.running) return;
    const at = this.now() + ms;
    if (this.timer && this.nextAt <= at) return;
    if (this.timer) clearTimeout(this.timer);
    this.nextAt = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, ms);
  }

  private done(w: Watch, s: NonNullable<Status>) {
    this.watching.delete(w.signature);
    if (s.err) this.stats.failed += w.waiters.length;
    else this.stats.landed += w.waiters.length;
    for (const x of w.waiters) x.resolve({ signature: w.signature, slot: s.slot, err: s.err });
  }

  private expire(w: Watch) {
    this.watching.delete(w.signature);
    this.stats.expired += w.waiters.length;
    for (const x of w.waiters) x.reject(new Error(`${x.label}: expired unconfirmed (${w.signature})`));
  }

  /** The statuses of `ws`, or null when the RPC could not be asked: that says nothing of them. */
  private async ask(ws: Watch[], history: boolean): Promise<readonly Status[] | null> {
    if (!ws.length) return [];
    this.polls++;
    const at = this.now();
    for (const w of ws) w.polled = at;
    return this.io.statuses(
      ws.map((w) => w.signature),
      history,
    ).then(
      (v) => v,
      () => null,
    );
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      // The ones looked at longest ago first, so more than 256 in flight are all looked at in turn.
      const live = [...this.watching.values()].filter((w) => w.lookAt === null).sort((a, b) => a.polled - b.polled).slice(0, MAX_STATUSES);
      const seen = await this.ask(live, false);
      const now = this.now();
      const height = this.io.height();
      for (const [i, w] of live.entries()) {
        const s = seen?.[i] ?? null;
        if (landed(s)) {
          this.done(w, s!);
          continue;
        }
        // An RPC that fails to answer says nothing of the transaction: it may land all the same, so it is looked for
        // until its blockhash has run out, never given up on the first error. Past it (or, with no word of the
        // height, two minutes on) it can no longer land: one last look.
        if (height > w.lastValid || now - w.started > this.t.maxAgeMs) {
          w.lookAt = now + this.t.lastLookMs;
          continue;
        }
        if (now - w.pushed >= this.t.rebroadcastMs) {
          w.pushed = now;
          this.stats.rebroadcasts++;
          void this.io.push(w.wire);
        }
      }
      const due = [...this.watching.values()].filter((w) => w.lookAt !== null && w.lookAt <= now).slice(0, MAX_STATUSES);
      const last = await this.ask(due, true);
      for (const [i, w] of due.entries()) {
        const s = last?.[i] ?? null;
        if (landed(s)) this.done(w, s!);
        // No answer at all is not "not landed": asked again on the next tick, a few times.
        else if (last || ++w.looks >= this.t.lastLookTries) this.expire(w);
      }
    } finally {
      this.running = false;
    }
    if (!this.watching.size) return;
    const now = this.now();
    const young = [...this.watching.values()].some((w) => now - w.started < this.t.youngMs);
    this.schedule(young ? this.t.fastMs : this.t.slowMs);
  }
}
