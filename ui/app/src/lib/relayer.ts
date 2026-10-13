"use client";

import { useEffect, useState } from "react";
import type { Address, Hex } from "viem";
import { jitter, RELAYER_URL, STEADY_MS } from "./endpoints";
import { MIN_PIECE_STAKE_E6 } from "@skech/core/chain";

/**
 * The Arc relayer: pieces and wallet authorizations go in, chain events and
 * account state come back. Wallet actions are EIP-712 signatures, so the
 * relayer can submit them and sponsor gas without holding a player's key.
 */

export type Hello = {
  type: "hello";
  chain: "evm";
  chainId: number;
  label: string;
  game: Address;
  iou: Address | null;
  revenue?: Address | null;
  usdc: Address;
  oracle: Address | null;
  relayer: Address;
  engineSigner: string | null;
  market: { id: number; name: string };
  difficulty: number | null;
  lateMs: number;
  units: string[] | null;
  /** The game's terms, fees included, as the program has them. */
  terms: { minPerDot: string; maxPerDot: string; maxPieceStake: string; minPieceStake?: string; maxPriceAgeMs: number; feeBps: number; profitFeeBps: number } | null;
  faucet: string | null;
  /** The relayer counts each player's transactions and answers `activity`. */
  activity?: boolean;
};
/** The least one piece may stake, USDC e6: the relayer's figure, or the game's 1¢ until it has said. */
export const leastPiece = (hello: Hello | null | undefined) => BigInt(hello?.terms?.minPieceStake ?? MIN_PIECE_STAKE_E6);
export type Account = {
  player: Address;
  balance: string;
  session: { key: Address; x: Hex; y: Hex; validUntil: string; allowance: string };
  owed: string;
  /** The next EIP-712 nonce; absent only while an older relayer starts. */
  nonce?: string | null;
};
export type Band = { second: number; lo: string; hi: string; stake: string; rung: number };
export type PlacedMsg = { type: "placed"; betId: Hex; player: Address; drawing: string; index: number; openAt: string; staked: string; fee: string; refunded: string; sections: Band[]; tx: Hex };
export type RefusedMsg = { type: "refused"; betId?: Hex; player: Address; drawing: string; index: number; why: string; tx?: Hex };
export type SettledMsg = { type: "settled"; betId: string; player: string; hitMask: number; missMask: number; /** Bands given their stake back: their second's bar was never posted. */ expiredMask?: number; paid: string; owed: string; closed: boolean; /** SKT e6 this bet's misses minted. */ minted?: string; tx: string };
export type AckMsg = { type: "ack"; ok: boolean; betId?: string; why?: string; drawing?: string; index?: number };
/** A player's transactions, counted by the relayer from their game account's signatures. `counting`: still reading the history. */
export type ActivityMsg = { type: "activity"; player: Address | null; txs: number; recent: { signature: Hex; time: number | null }[]; explorer?: string; counting: boolean; progress: number };
export type Done = { ok: boolean; why?: string; tx?: Hex; amount?: string };
export type Incoming =
  | Hello
  | ({ type: "account" } & Account)
  | PlacedMsg
  | RefusedMsg
  | SettledMsg
  | AckMsg
  | ActivityMsg
  | ({ type: "session-set" } & Done)
  | ({ type: "deposited" } & Done)
  | ({ type: "withdrawn" } & Done)
  | { type: "owed"; value: string }
  | { type: "error"; why: string };

type Handler = (m: Incoming) => void;
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

export class RelayerClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private connectionHandlers = new Set<(connected: boolean) => void>();
  private stopped = false;
  private backoff = 500;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private steady: ReturnType<typeof setTimeout> | undefined;
  hello: Hello | null = null;
  connected = false;
  player: Address | null = null;

  constructor(private readonly url = RELAYER_URL) {}

  start() {
    if (!this.stopped && this.ws) return;
    this.stopped = false;
    clearTimeout(this.retry);
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearTimeout(this.steady);
    const sock = this.ws;
    this.ws = null;
    this.setConnected(false);
    // Closing a socket still connecting logs a warning; it closes as soon as it opens instead.
    if (sock?.readyState === WebSocket.CONNECTING) sock.onopen = () => sock.close();
    else sock?.close();
  }

  on(h: Handler) {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  /** Hear the socket open and close. */
  onConnection(h: (connected: boolean) => void) {
    this.connectionHandlers.add(h);
    return () => void this.connectionHandlers.delete(h);
  }

  send(msg: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(json(msg));
    return true;
  }

  /** Send, and resolve with the first message `match` accepts, or null after `ms`. */
  request<T extends Incoming>(msg: unknown, match: (m: Incoming) => m is T, ms = 20_000): Promise<T | null> {
    return new Promise((resolve) => {
      const off = this.on((m) => {
        if (!match(m)) return;
        off();
        clearTimeout(timer);
        resolve(m);
      });
      const timer = setTimeout(() => (off(), resolve(null)), ms);
      if (!this.send(msg)) {
        off();
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  /** Follow one player's account and bets. */
  watch(player: Address | null) {
    this.player = player;
    if (player) this.send({ type: "watch", player });
  }

  private connect() {
    if (this.stopped) return;
    const sock = new WebSocket(this.url);
    this.ws = sock;
    sock.onopen = () => {
      clearTimeout(this.steady);
      this.steady = setTimeout(() => (this.backoff = 500), STEADY_MS);
      this.setConnected(true);
      if (this.player) this.send({ type: "watch", player: this.player });
    };
    sock.onmessage = (e) => {
      let m: Incoming;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (m.type === "hello") this.hello = m;
      this.emit(m);
    };
    sock.onclose = () => {
      if (this.ws === sock) this.setConnected(false);
      if (this.stopped || this.ws !== sock) return;
      clearTimeout(this.steady);
      this.retry = setTimeout(() => this.connect(), jitter(this.backoff));
      this.backoff = Math.min(10_000, this.backoff * 2);
    };
    sock.onerror = () => sock.close();
  }

  private setConnected(connected: boolean) {
    if (connected === this.connected) return;
    this.connected = connected;
    for (const h of this.connectionHandlers) h(connected);
  }

  private emit(m: Incoming) {
    for (const h of this.handlers) h(m);
  }
}

/** The same account, to the micro-dollar and the key: the relayer sends it often (after payouts, on request), mostly unchanged. */
const sameAccount = (a: Account | null, b: Account) =>
  !!a &&
  a.player.toLowerCase() === b.player.toLowerCase() &&
  a.balance === b.balance &&
  a.owed === b.owed &&
  (a.nonce ?? null) === (b.nonce ?? null) &&
  a.session.key.toLowerCase() === b.session.key.toLowerCase() &&
  a.session.x.toLowerCase() === b.session.x.toLowerCase() &&
  a.session.y.toLowerCase() === b.session.y.toLowerCase() &&
  a.session.validUntil === b.session.validUntil &&
  a.session.allowance === b.session.allowance;

/** One relayer for the page, following `player`. */
export function useRelayer(player: Address | null, enabled: boolean) {
  const [client] = useState(() => new RelayerClient());
  const [hello, setHello] = useState<Hello | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    client.start();
    const off = client.on((m) => {
      if (m.type === "hello") setHello(m);
      // Kept as it was when nothing in it changed, so nothing that reads it re-renders for a repeat.
      else if (m.type === "account") setAccount((a) => (sameAccount(a, m) ? a : m));
    });
    const offConnection = client.onConnection(setConnected);
    // Gone from the page: the socket closes, and nothing reopens it.
    return () => {
      off();
      offConnection();
      client.stop();
    };
  }, [client, enabled]);
  useEffect(() => {
    if (enabled) client.watch(player);
  }, [client, player, enabled]);
  const own = player && account && account.player.toLowerCase() === player.toLowerCase() ? account : null;
  return { client, hello, account: own, connected };
}
