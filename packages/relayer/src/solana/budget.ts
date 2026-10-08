/**
 * What the Solana relayer may ask of its RPC: a request budget, shared by everything it asks. The public devnet RPC
 * turned it away (HTTP 429) every two seconds, until transactions expired unsent; a private one has a plan's limit,
 * and on mainnet every request is billed.
 *
 * - A token bucket, `SOLANA_RPC_RPS` a second. Requests wait their turn by what they are for: a transaction going
 *   out first, then looking for those in flight, then the blockhash and fee, then reads for players, then the sweep.
 * - A 429 stops every request, for the RPC's `Retry-After` or, without one, a wait that doubles while they keep
 *   coming, with jitter. A request turned away goes again after it, a few times; a status look does not, since the
 *   next look asks again anyway, and the poller takes no answer as "not known yet" (confirm.ts).
 * - Two reads of the same thing at once are one request.
 * - 429s are logged at most every 30 s, with how many there were.
 */
import { isJsonRpcPayload, type RpcTransport } from "@solana/kit";
import { redact } from "../rpc";

export const PRIORITIES = ["send", "status", "blockhash", "read", "sweep"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** What a request is for, from its method. */
export function priorityOf(method: string): Priority {
  if (method === "sendTransaction") return "send";
  if (method === "getSignatureStatuses") return "status";
  if (method === "getLatestBlockhash" || method === "getRecentPrioritizationFees" || method === "getBlockHeight") return "blockhash";
  return "read";
}

/** Waits after a 429 with no Retry-After: doubling from this, up to the most. */
const BACKOFF_MS = 250;
const BACKOFF_MOST_MS = 10_000;
/** Tries for a request the RPC turned away, after the first. */
const RETRIES = 3;
const LOG_EVERY_MS = 30_000;

export class Budget {
  private tokens: number;
  private at: number;
  private queues: (() => void)[][] = PRIORITIES.map(() => []);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pausedUntil = 0;
  /** 429s in a row: each doubles the wait. */
  private strikes = 0;
  private logged = 0;
  private unlogged = 0;
  stats = { requests: 0, throttled: 0, deduped: 0 };

  constructor(
    readonly perSec: number,
    private readonly log: (s: string) => void = () => {},
    private readonly now: () => number = Date.now,
    private readonly burst = Math.max(1, perSec),
    private readonly random: () => number = Math.random,
    /** The setting that sets `perSec`, for the log. */
    private readonly knob = "SOLANA_RPC_RPS",
  ) {
    this.tokens = this.burst;
    this.at = now();
  }

  get waiting() {
    return this.queues.reduce((n, q) => n + q.length, 0);
  }

  private refill() {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.at) / 1000) * this.perSec);
    this.at = t;
  }

  /** Resolves when a request for `p` may go: at once if a token is there and nobody is ahead of it. */
  take(p: Priority): Promise<void> {
    this.refill();
    if (!this.waiting && this.tokens >= 1 && this.now() >= this.pausedUntil) {
      this.tokens -= 1;
      this.stats.requests++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queues[PRIORITIES.indexOf(p)].push(resolve);
      this.pump();
    });
  }

  /** Let as many go as there are tokens, the most urgent first; then wake when the next token is due. */
  private pump() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.refill();
    const now = this.now();
    while (this.waiting && this.tokens >= 1 && now >= this.pausedUntil) {
      this.tokens -= 1;
      this.stats.requests++;
      this.queues.find((q) => q.length)!.shift()!();
    }
    if (!this.waiting) return;
    const wait = Math.max(this.pausedUntil - now, this.tokens >= 1 ? 0 : ((1 - this.tokens) / this.perSec) * 1000);
    this.timer = setTimeout(() => this.pump(), Math.max(1, Math.ceil(wait)));
  }

  /** The RPC answered: the next 429 starts the waits again from the shortest. */
  ok() {
    this.strikes = 0;
  }

  /**
   * The RPC turned a request away: nothing goes until `retryAfterMs` is up, or, without one, a wait that doubles with
   * every 429 in a row, give or take a quarter so requests held together do not all go again together. The wait.
   */
  throttled(method: string, retryAfterMs: number | null, url: string): number {
    const backoff = Math.min(BACKOFF_MOST_MS, BACKOFF_MS * 2 ** Math.min(this.strikes, 10));
    this.strikes++;
    const wait = Math.round((retryAfterMs ?? backoff) * (0.75 + this.random() * 0.5));
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
    this.stats.throttled++;
    this.unlogged++;
    const now = this.now();
    if (now - this.logged >= LOG_EVERY_MS) {
      this.log(
        `rpc: ${redact(url)} turned away ${this.unlogged} request${this.unlogged === 1 ? "" : "s"}${this.logged ? ` in ${Math.round((now - this.logged) / 1000)} s` : ""} (429, last ${method}); waiting ${wait} ms. Asking ${this.perSec}/s (${this.knob})`,
      );
      this.logged = now;
      this.unlogged = 0;
    }
    if (this.waiting) this.pump();
    return wait;
  }
}

/** Retry-After in ms: seconds, or an HTTP date. */
function retryAfter(headers: unknown, now: number): number | null {
  const v = (headers as Headers | undefined)?.get?.("retry-after");
  if (!v) return null;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/**
 * A 429, thrown by the HTTP transport or answered as a JSON-RPC error: its Retry-After, or null for none; undefined if
 * it is not one. Known by its words, not by code: Solana's -32005 is a node behind, -32007 a skipped slot.
 */
export function rateLimit(thrown: unknown, answered: unknown, now = Date.now()): number | null | undefined {
  const ctx = (thrown as { context?: { statusCode?: number; headers?: unknown } } | undefined)?.context;
  if (ctx?.statusCode === 429) return retryAfter(ctx.headers, now);
  const err = (answered as { error?: { code?: number | bigint; message?: string } } | undefined)?.error;
  if (err && (Number(err.code) === 429 || /rate limit|too many requests|request limit/i.test(String(err.message ?? "")))) return null;
  return undefined;
}

const stringify = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `${x}n` : x));

/**
 * `inner`, asking only within `budget`. `floor` holds every request it makes to that priority at best: the sweep's
 * reads go after players'. Identical reads at once share one request.
 */
export function budgeted(inner: RpcTransport, budget: Budget, url: string, floor: Priority = "send"): RpcTransport {
  const flying = new Map<string, Promise<unknown>>();
  const send = async (config: Parameters<RpcTransport>[0], method: string): Promise<unknown> => {
    const p = PRIORITIES[Math.max(PRIORITIES.indexOf(priorityOf(method)), PRIORITIES.indexOf(floor))];
    for (let attempt = 0; ; attempt++) {
      await budget.take(p);
      let answered: unknown;
      try {
        answered = await inner(config);
      } catch (e) {
        const after = rateLimit(e, undefined);
        if (after === undefined) throw e;
        budget.throttled(method, after, url);
        if (method === "getSignatureStatuses" || attempt >= RETRIES) throw e;
        continue;
      }
      const after = rateLimit(undefined, answered);
      if (after === undefined) {
        budget.ok();
        return answered;
      }
      budget.throttled(method, after, url);
      if (method === "getSignatureStatuses" || attempt >= RETRIES) return answered;
    }
  };
  return (async (config: Parameters<RpcTransport>[0]) => {
    const payload = config.payload;
    const method = isJsonRpcPayload(payload) ? payload.method : "";
    // A transaction is never folded into another: each send is a rebroadcast that is meant.
    if (!method || method === "sendTransaction") return send(config, method);
    const key = `${method}:${stringify((payload as { params: unknown }).params)}`;
    const same = flying.get(key);
    if (same) {
      budget.stats.deduped++;
      return same;
    }
    const p = send(config, method).finally(() => flying.delete(key));
    flying.set(key, p);
    return p;
  }) as RpcTransport;
}
