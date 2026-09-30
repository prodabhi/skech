/**
 * How much one app may ask of the relayer: connections, in all and from one address; messages, of each type, on
 * each connection. Checked at the door, before anything is read from the chain or sent to it. And a bound for
 * every map an app can grow by asking.
 */

/** The largest message: a piece with the longest stroke is about 50 KB. */
export const MESSAGE_BYTES = 64 * 1024;
/** Connections in all, and from one address (a phone network puts many players behind one). */
export const CONNECTIONS = 5_000;
export const PER_IP = 32;
/** A socket that says nothing this long, not even a pong to Bun's pings, is closed: a phone that went away. */
export const IDLE_S = 30;
export const BEAT_MS = 15_000;

/**
 * `{ type: "beat" }` to every socket every 15 s: phone networks and proxies close a socket that is quiet for a while,
 * and the app can tell a dead socket from a quiet one. Apps pass over a type they do not know.
 */
export function beat(clients: Iterable<{ send(text: string): unknown }>, every = BEAT_MS) {
  const text = JSON.stringify({ type: "beat" });
  const timer = setInterval(() => {
    for (const ws of clients) ws.send(text);
  }, every);
  timer.unref?.();
  return timer;
}

/** A token bucket: up to `burst` at once, refilled at `perSec`. */
export class Bucket {
  private tokens: number;
  private at: number;

  constructor(
    private readonly burst: number,
    private readonly perSec: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.at = now();
  }

  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.at) / 1000) * this.perSec);
    this.at = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * Messages one connection may send, by type: [at once, per second]. Pieces come many a second while drawing;
 * what the relayer reads the chain for, or pays to send, a few a minute.
 */
export const RATES: Record<string, [number, number]> = {
  piece: [40, 20],
  hello: [5, 1],
  account: [10, 2],
  watch: [5, 0.5],
  activity: [3, 0.2],
  build: [5, 0.2],
  submit: [5, 0.2],
  sweep: [3, 0.1],
};
/** Every message, whatever its type, bad ones too. */
const ANY: [number, number] = [60, 30];

/** One connection's buckets. */
export class Rates {
  private any: Bucket;
  private byType = new Map<string, Bucket>();

  constructor(private readonly now: () => number = Date.now) {
    this.any = new Bucket(...ANY, now);
  }

  /** Whether a message of `type` may go ahead now. */
  take(type: string): boolean {
    if (!this.any.take()) return false;
    const rate = Object.hasOwn(RATES, type) ? RATES[type] : undefined;
    if (!rate) return true;
    let b = this.byType.get(type);
    if (!b) this.byType.set(type, (b = new Bucket(...rate, this.now)));
    return b.take();
  }
}

/** Connections open, in all and by address. */
export class Door {
  private open = 0;
  private byIp = new Map<string, number>();

  constructor(
    private readonly most = CONNECTIONS,
    private readonly perIp = PER_IP,
  ) {}

  enter(ip: string): boolean {
    const n = this.byIp.get(ip) ?? 0;
    if (this.open >= this.most || n >= this.perIp) return false;
    this.open++;
    this.byIp.set(ip, n + 1);
    return true;
  }

  leave(ip: string) {
    const n = (this.byIp.get(ip) ?? 1) - 1;
    this.open = Math.max(0, this.open - 1);
    if (n > 0) this.byIp.set(ip, n);
    else this.byIp.delete(ip);
  }

  get size() {
    return this.open;
  }
}

const LOCAL = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Who is asking. A connection from this machine is Caddy's, and Caddy puts the player's address last in
 * X-Forwarded-For; from anywhere else the header is whatever the sender wrote, so the peer's own address counts.
 */
export function clientIp(req: Request, peer: string | undefined): string {
  if (!peer || LOCAL.has(peer)) {
    const last = req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
    if (last) return last.slice(0, 64);
  }
  return peer ?? "unknown";
}

/**
 * What the relayer pays for on a wallet's say (a session, a deposit, a withdrawal, and the rent of the accounts
 * they open): a few an hour for one wallet and a few more from one address, whichever connection asks.
 */
export class Sponsor {
  private byIp = new Map<string, Bucket>();
  private byWallet = new Map<string, Bucket>();

  constructor(private readonly now: () => number = Date.now) {}

  take(ip: string, wallet: string): boolean {
    return this.bucket(this.byIp, ip, 20, 1 / 30) && this.bucket(this.byWallet, wallet.toLowerCase(), 6, 1 / 120);
  }

  private bucket(map: Map<string, Bucket>, key: string, burst: number, perSec: number): boolean {
    let b = map.get(key);
    if (!b) remember(map, key, (b = new Bucket(burst, perSec, this.now)), 50_000);
    return b.take();
  }
}

/** Pieces under the batch size (10¢) one wallet may send, whichever connection: [at once, per second]. */
export const SMALL_PIECES: [number, number] = [10, 2];

/**
 * Pieces staking under `BATCH_PIECE_STAKE_E6`, for one wallet across its connections. Each is a transaction the
 * relayer pays more gas for than its 1% fee brings, so they are let through at a pace, not refused: the end of a
 * line or a tap is one, and the apps gather the rest of a line into 10¢ pieces. Bigger pieces only have the
 * connection's own rate.
 */
export class SmallPieces {
  private byWallet = new Map<string, Bucket>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly rate: [number, number] = SMALL_PIECES,
  ) {}

  take(wallet: string): boolean {
    let b = this.byWallet.get(wallet);
    if (!b) remember(this.byWallet, wallet, (b = new Bucket(...this.rate, this.now)), 50_000);
    return b.take();
  }
}

/** Put `key` in `map` as the newest, and let the oldest go past `most`: a cache nobody can grow without end. */
export function remember<K, V>(map: Map<K, V>, key: K, value: V, most: number) {
  map.delete(key);
  map.set(key, value);
  while (map.size > most) map.delete(map.keys().next().value as K);
}
