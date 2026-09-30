import { useEffect, useRef, useState } from "react";
import type { Bar } from "@skech/core/dots";
import { mergeHistory } from "@skech/core/bars";
import { ENGINE_URL } from "./config";
import { useAppActive } from "./lifecycle";
import { carryBars, KEEP_BARS, validTrade } from "./market-buffer";

/**
 * Bitcoin as the game is priced and judged on: Coinbase BTC-USD, trade by
 * trade, through the engine (`packages/engine`).
 *
 * The chances are measured on Coinbase's own trades, folded into one-second
 * bars (`packages/core/scripts/fetch-coinbase.ts`), so the game is played on
 * the same market, folded the same way. On connect the engine sends the last
 * ten minutes of trades, then every trade as it lands. Each is checked against
 * Binance and Kraken and signed by the engine's wallet as EIP-712 typed data a
 * contract can check (`packages/contracts/evm`); on Solana the relayer checks it before placing. The price shown is always the
 * price signed: what a trade placed now would post on chain. What is signed,
 * and on whose agreement, is in the engine's log.
 *
 * The engine passes on Coinbase's heartbeat every second, so a stream that
 * goes quiet without closing is caught and reopened rather than left showing
 * a stale price.
 */

const STREAM = ENGINE_URL;
const KEEP_TICKS = 4000;
/** Trades are trimmed a chunk at a time: one off the front per trade moved all four thousand along, every trade. */
const TRIM_TICKS = 500;
/** No message at all for this long (heartbeats included) and the socket is reopened. */
const SILENT_MS = 5000;

export type Tick = { t: number; p: number };
/** The EIP-712 `Price` a trade's signature is over: price with 8 decimals, as a string; time in ms. */
export type PriceMessage = { market: string; price: string; time: number };
/** Everything of an `eth_signTypedData_v4` payload but the message, as the engine sends it on connect. */
export type TypedData = {
  domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
  primaryType: "Price";
  types: Record<string, { name: string; type: string }[]>;
};
/**
 * The newest price, as a trade placed now would post it: the same price the
 * chart shows. `message` and `signature` are null when no attester could
 * check it: nothing to post. `source` is "attesters" when Coinbase was outside
 * the band and their median was signed instead.
 */
export type Quote = {
  price: number;
  source: "coinbase" | "attesters";
  message: PriceMessage | null;
  signature: `0x${string}` | null;
};
export type Market = {
  /** One-second bars, oldest first; the last is still forming. Times in ms, Coinbase's clock. */
  bars: Bar[];
  /** Every trade of the last minute or so, for drawing the line smoothly. */
  ticks: Tick[];
  /** Coinbase's clock minus this one's. */
  skew: number;
  connected: boolean;
  /** Bumped on every trade batch, so a page can react without copying arrays. */
  version: number;
  /**
   * Hear every trade batch, after it is folded in: for what must follow each trade (the price shown, the judging)
   * without re-rendering the screen around it, as the web's feed does. Returns the way to stop.
   */
  subscribe: (fn: () => void) => () => void;
  /** The engine's wallet and the domain it signs under, once connected. */
  signer: `0x${string}` | null;
  typedData: TypedData | null;
  quote: Quote | null;
};

type Message =
  | { type: "hello"; signer: `0x${string}`; typedData: TypedData }
  | { type: "history"; trades: [id: number, t: number, p: number][]; quote?: Omit<Quote, "price"> & { p: number } }
  | ({ type: "price"; id: number; t: number; p: number } & Omit<Quote, "price">)
  | { type: "beat" };

export function useEngine(): Market {
  const active = useAppActive();
  const newestId = useRef(0);
  // Only for re-rendering when the connection comes or goes: the value itself is `m.connected`.
  const [, setConnected] = useState(false);
  /*
    One mutable store for the life of the page: trades arrive faster than React should re-render, and arrays this
    long are not copied per trade. The screen gets the store itself, so what it reads is always the latest, and a
    trade batch re-renders only what subscribes to it. (Each batch used to re-render the whole game screen, up to
    twenty times a second, on the JS thread the pen and the chart share.)
  */
  const [{ m, listeners }] = useState(() => {
    const listeners = new Set<() => void>();
    const m: Market = {
      bars: [],
      ticks: [],
      skew: 0,
      connected: false,
      version: 0,
      signer: null,
      typedData: null,
      quote: null,
      subscribe: (fn) => {
        listeners.add(fn);
        return () => void listeners.delete(fn);
      },
    };
    return { m, listeners };
  });

  useEffect(() => {
    if (!active) {
      m.connected = false;
      setConnected(false);
      return;
    }
    let stopped = false;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    let late: ReturnType<typeof setTimeout> | undefined;
    let backoff = 500;
    let heard = 0;
    /** The newest trade folded in, so the history a reconnect is sent is not counted twice. */
    let lastId = newestId.current;
    /*
      Tell the page on the next frame, at most twenty times a second (every
      50 ms), so the price shown moves with each trade as it lands. A browser
      stops giving frames to a hidden or covered window, so if no frame comes
      within a quarter second a timer tells it instead; the chart itself reads
      the trades straight from this store, so it moves every frame regardless.
    */
    let told = 0;
    const bump = () => {
      if (frame || late) return;
      const tell = () => {
        cancelAnimationFrame(frame);
        clearTimeout(late);
        frame = 0;
        late = undefined;
        told = performance.now();
        m.version++;
        for (const fn of listeners) fn();
      };
      const wait = Math.max(0, 50 - (performance.now() - told));
      if (wait > 0) late = setTimeout(tell, wait);
      else {
        frame = requestAnimationFrame(tell);
        late = setTimeout(tell, 250);
      }
    };
    const fold = (t: number, p: number) => {
      const sec = Math.floor(t / 1000) * 1000;
      const last = m.bars[m.bars.length - 1];
      // A trade that arrives after its second was closed by the clock still belongs to it.
      const own = last && sec <= last.t ? m.bars.findLast((b) => b.t === sec) : undefined;
      if (own) {
        own.h = Math.max(own.h, p);
        own.l = Math.min(own.l, p);
        if (own === last) own.c = p;
      } else if (!last || sec > last.t) {
        // Seconds with no trade still pass: carry the price through them, so a gap is flat rather than missing.
        if (last) carryBars(m.bars, sec - 1000);
        m.bars.push({ t: sec, h: p, l: p, c: p });
        if (m.bars.length > KEEP_BARS) m.bars.splice(0, m.bars.length - KEEP_BARS);
      }
      m.ticks.push({ t, p });
      if (m.ticks.length > KEEP_TICKS + TRIM_TICKS) m.ticks.splice(0, m.ticks.length - KEEP_TICKS);
    };

    const connect = () => {
      if (stopped) return;
      const sock = new WebSocket(STREAM);
      ws = sock;
      heard = Date.now();
      sock.onopen = () => {
        if (stopped || ws !== sock) return;
        backoff = 500;
        m.connected = true;
        setConnected(true);
      };
      sock.onmessage = (e) => {
        if (stopped || ws !== sock) return;
        heard = Date.now();
        let msg: Message;
        try {
          msg = JSON.parse(String(e.data));
        } catch {
          return;
        }
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "hello") {
          m.signer = msg.signer;
          m.typedData = msg.typedData;
        } else if (msg.type === "history") {
          if (!Array.isArray(msg.trades)) return;
          newestId.current = lastId = mergeHistory(m, msg.trades.filter(Array.isArray), lastId, fold);
          const q = msg.quote;
          if (q && (q.message?.time ?? 0) >= (m.quote?.message?.time ?? 0)) m.quote = { price: q.p, source: q.source, message: q.message, signature: q.signature };
          bump();
        } else if (msg.type === "price") {
          if (msg.id <= lastId || !validTrade(msg.id, msg.t, msg.p)) return;
          newestId.current = lastId = msg.id;
          // A trade has just happened: Coinbase's clock is its time, give or take the trip here.
          const sample = msg.t + 40 - Date.now();
          m.skew = m.skew === 0 ? sample : m.skew * 0.98 + sample * 0.02;
          m.quote = { price: msg.p, source: msg.source, message: msg.message, signature: msg.signature };
          fold(msg.t, msg.p);
          bump();
        }
      };
      sock.onclose = () => {
        if (!stopped && ws === sock) {
          m.connected = false;
          setConnected(false);
        }
        if (stopped || ws !== sock) return;
        retry = setTimeout(connect, backoff);
        backoff = Math.min(10_000, backoff * 2);
      };
      sock.onerror = () => sock.close();
    };
    connect();
    /*
      A second with no trade in it still passes, and ink whose window ended in
      one is still missed. Once a second is 600 ms old with nothing in it, it
      is closed at the last price, so a quiet market judges on time. The
      margin is for trades that arrive late: they still land in their own second.
    */
    const clock = setInterval(() => {
      // Silent without closing: reopen, rather than show a price that has stopped.
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) && Date.now() - heard > SILENT_MS) {
        const dead = ws;
        ws = null;
        dead.onclose = null;
        dead.close();
        m.connected = false;
        setConnected(false);
        connect();
      }
      const last = m.bars[m.bars.length - 1];
      if (!last || !m.connected) return;
      const now = Date.now() + m.skew;
      const until = Math.floor((now - 600) / 1000) * 1000;
      if (carryBars(m.bars, until)) bump();
    }, 200);
    return () => {
      clearInterval(clock);
      stopped = true;
      clearTimeout(retry);
      clearTimeout(late);
      cancelAnimationFrame(frame);
      // Closing a socket still connecting logs a warning; it closes as soon as it opens instead.
      if (ws?.readyState === WebSocket.CONNECTING) {
        const opening = ws;
        opening.onopen = () => opening.close();
        opening.onmessage = null;
        opening.onclose = null;
      } else ws?.close();
    };
  }, [m, listeners, active]);

  return m;
}
