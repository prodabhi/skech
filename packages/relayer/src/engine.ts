/**
 * The relayer as a client of the engine: the last ten minutes of trades on
 * connect, then every signed trade, folded into the same one-second bars the
 * app folds. Also the engine's clock: quotes and bars are timed on it.
 *
 * Bets are priced and settled on these bars, so only trades the engine
 * checked and signed go in: a trade no two venues agreed on is left out, and
 * the bar carries the last checked price through it. The one exception is the
 * history from before the engine's first checked trade (its backfill after a
 * restart): it is folded, so there are five minutes to price on at once and a
 * bet open across the restart still settles, on Coinbase's own record of
 * those seconds. No bet is taken until a checked trade is in.
 */
import { BarBook, mergeHistory } from "@skech/core/bars";
import type { Address, Hex } from "viem";
import { report } from "./sentry";

export type PriceQuote = { price: number; priceE8: bigint; time: number; signature: Hex };
type Message =
  | { type: "hello"; signer: Address; typedData: { domain: { chainId: number; verifyingContract: Address } } }
  | { type: "history"; trades: [id: number, t: number, p: number, checked?: 0 | 1][]; quote?: { p: number; message: { price: string; time: number } | null; signature: Hex | null } }
  | { type: "price"; id: number; t: number; p: number; signed?: boolean; message: { price: string; time: number } | null; signature: Hex | null }
  | { type: "beat"; t: number };

export class Engine {
  book = new BarBook(660, 4000);
  signer: Address | null = null;
  domain: { chainId: number; verifyingContract: Address } | null = null;
  quote: PriceQuote | null = null;
  connected = false;
  /** The engine's clock (Coinbase's) minus this one's. */
  skew = 0;
  /** The time of the first checked trade in the book, 0 before one. */
  checkedFrom = 0;
  private lastId = 0;
  private heard = 0;
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoff = 500;
  private clock: ReturnType<typeof setInterval> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;

  /** `expected`: the engine's signing address, when it is known (RELAYER_ENGINE_SIGNER). An engine that signs as anyone else is not listened to. */
  constructor(
    private readonly url: string,
    private readonly log: (s: string) => void,
    private readonly expected?: Address,
  ) {}

  now() {
    return Date.now() + this.skew;
  }

  start() {
    if (this.clock) return;
    this.stopped = false;
    this.connect();
    this.clock = setInterval(() => {
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) && Date.now() - this.heard > 5000) {
        this.log("engine: silent for 5 s, reconnecting");
        const dead = this.ws;
        this.ws = null;
        dead.onclose = null;
        dead.close();
        this.connected = false;
        this.connect();
      }
      // Quiet seconds still pass.
      if (this.connected) this.book.closeQuiet(this.now());
    }, 200);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.clock);
    this.clock = undefined;
    clearTimeout(this.retry);
    this.connected = false;
    this.ws?.close();
  }

  private connect() {
    if (this.stopped) return;
    const sock = new WebSocket(this.url);
    this.ws = sock;
    this.heard = Date.now();
    // Nothing is taken from an engine until its hello says it signs as the one expected: its prices would be vouched
    // for to the chain, and its bars settled on.
    let trusted = !this.expected;
    sock.onopen = () => {
      if (this.stopped || this.ws !== sock) return;
      this.backoff = 500;
      this.connected = true;
      this.log(`engine: connected to ${this.url}`);
    };
    sock.onmessage = (e) => {
      if (this.stopped || this.ws !== sock) return;
      this.heard = Date.now();
      let msg: Message;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (msg.type === "hello") {
        if (this.expected && msg.signer?.toLowerCase() !== this.expected.toLowerCase()) {
          this.log(`WARNING: engine: ${this.url} signs as ${msg.signer}, not ${this.expected} (RELAYER_ENGINE_SIGNER); not listening to it`);
          report("engine-signer", `the engine at ${this.url} signs as ${msg.signer}, not ${this.expected}`);
          sock.close();
          return;
        }
        trusted = true;
        this.signer = msg.signer;
        this.domain = msg.typedData.domain;
        this.log(`engine: signs as ${msg.signer} for chain ${msg.typedData.domain.chainId}, contract ${msg.typedData.domain.verifyingContract}`);
      } else if (!trusted) {
        return;
      } else if (msg.type === "history") {
        this.lastId = mergeHistory(this.book, msg.trades, this.lastId, (t, p, checked) => this.take(t, p, checked === 1), (t, p) => this.book.fold(t, p));
        const q = msg.quote;
        if (q?.message && q.signature && q.message.time >= (this.quote?.time ?? 0)) {
          this.quote = { price: q.p, priceE8: BigInt(q.message.price), time: q.message.time, signature: q.signature };
        }
        this.log(`engine: ${this.book.bars.length} bars of history${this.book.bars.length <= 320 ? "; waiting for backfill" : ""}`);
      } else if (msg.type === "price") {
        if (msg.id <= this.lastId || !(msg.p > 0)) return;
        this.lastId = msg.id;
        const sample = msg.t + 40 - Date.now();
        this.skew = this.skew === 0 ? sample : this.skew * 0.98 + sample * 0.02;
        const signed = msg.signed !== false && !!msg.message && !!msg.signature;
        if (signed) this.quote = { price: msg.p, priceE8: BigInt(msg.message!.price), time: msg.message!.time, signature: msg.signature! };
        this.take(msg.t, msg.p, signed);
      }
    };
    sock.onclose = () => {
      if (this.ws === sock) this.connected = false;
      if (this.stopped || this.ws !== sock) return;
      this.retry = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(10_000, this.backoff * 2);
    };
    sock.onerror = () => sock.close();
  }

  /** A checked trade into the book; an unchecked one only while there has been no checked one yet. */
  private take(t: number, p: number, checked: boolean) {
    if (checked) {
      if (this.checkedFrom === 0 || t < this.checkedFrom) this.checkedFrom = t;
    } else if (this.checkedFrom !== 0 && t >= this.checkedFrom) return;
    this.book.fold(t, p);
  }

  /** Whether there are enough fresh bars to price on, the newest of them checked. */
  ready() {
    const last = this.book.last;
    // A quiet market is live while heartbeats arrive. Submitted quotes retain their age checks.
    return this.connected && Date.now() - this.heard < 5000 && this.checkedFrom > 0 && !!last && this.book.bars.length > 320 && this.now() - last.t < 5000;
  }
}
