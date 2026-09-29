"use client";

import { useEffect, useState } from "react";
import { jitter, RELAYER_URL, STEADY_MS } from "./endpoints";
import { MIN_PIECE_STAKE_E6 } from "@skech/core/chain";

/**
 * The Solana relayer: where the app sends what it draws, signed by the session key, and hears back what the
 * chain made of it; and where every transaction the wallet signs is built and sent, the relayer paying. One
 * socket, reopened when it drops; every message is JSON with the chain's numbers as strings and addresses in
 * base58. The phone speaks the same (packages/solana-mobile/src/lib/relayer.ts); the server is
 * packages/relayer/src/solana/server.ts.
 */

export type Hello = {
  type: "hello";
  chain: "solana";
  cluster: "devnet" | "mainnet-beta" | "localnet";
  label: string;
  program: string;
  game: string;
  usdc: string;
  lookupTable: string;
  /** What every signed piece starts with: this deployment on this cluster, hex. */
  domain: string;
  oracle: string;
  relayer: string;
  engineSigner: string | null;
  market: { id: number; name: string };
  difficulty: number | null;
  lateMs: number;
  units: string[] | null;
  /** The game's terms, fees included, as the program has them. */
  terms: { minPerDot: string; maxPerDot: string; maxPieceStake: string; minPieceStake?: string; maxPriceAgeMs: number; feeBps: number; profitFeeBps: number; holderFeeBps?: number; holderProfitFeeBps?: number; sktHalfLifeSecs?: number; surplusHolderBps?: number } | null;
  faucet: string | null;
  /** The relayer counts each player's transactions and answers `activity`. */
  activity?: boolean;
};
/** The least one piece may stake, USDC e6: the relayer's figure, or the game's 1¢ until it has said. */
export const leastPiece = (hello: Hello | null | undefined) => BigInt(hello?.terms?.minPieceStake ?? MIN_PIECE_STAKE_E6);
export type Account = {
  player: string;
  balance: string;
  session: { key: string; validUntil: string; allowance: string } | null;
  owed: string;
  /** USDC in the wallet itself, and how much of it the game may sweep in. */
  wallet: { usdc: string; approved: string };
  /** The player's SKT (e6) and the USDC (e6) it has earned that a claim would pay now; absent from an older relayer. */
  skt?: { balance: string; claimable: string };
};
export type Band = { second: number; lo: string; hi: string; stake: string; rung: number };
export type PlacedMsg = { type: "placed"; betId: string; player: string; drawing: string; index: number; openAt: string; staked: string; fee: string; refunded: string; sections: Band[]; tx: string };
export type RefusedMsg = { type: "refused"; betId?: string; player: string; drawing: string; index: number; why: string; tx?: string };
export type SettledMsg = { type: "settled"; betId: string; player: string; hitMask: number; missMask: number; /** Bands given their stake back: their second's bar was never posted. */ expiredMask?: number; paid: string; owed: string; closed: boolean; /** SKT e6 this bet's misses minted. */ minted?: string; tx: string };
export type AckMsg = { type: "ack"; ok: boolean; betId?: string; why?: string; drawing?: string; index?: number };
/** A player's transactions, counted by the relayer from their game account's signatures. `counting`: still reading the history. */
export type ActivityMsg = { type: "activity"; player: string | null; txs: number; recent: { signature: string; time: number | null }[]; explorer?: string; counting: boolean; progress: number };
/** What the wallet signs and the relayer pays for. */
export type Kind = "session" | "deposit" | "withdraw" | "revoke" | "claim";
export type BuiltMsg = { type: "built"; kind: string; id?: string; tx?: string; ok?: false; why?: string };
export type SubmittedMsg = { type: "submitted"; id: string; kind?: string; ok: boolean; tx?: string; why?: string };
export type Incoming =
  | Hello
  | ({ type: "account" } & Account)
  | PlacedMsg
  | RefusedMsg
  | SettledMsg
  | AckMsg
  | ActivityMsg
  | BuiltMsg
  | SubmittedMsg
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
  player: string | null = null;

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

  /**
   * A transaction the wallet signs and the relayer pays for: built there, signed here by `sign` (Privy's embedded
   * wallet, with no prompt), sent there. Its signature, or what went wrong.
   */
  async transact(kind: Kind, params: Record<string, unknown>, sign: (base64: string) => Promise<string>): Promise<{ ok: true; tx: string } | { ok: false; why: string }> {
    return this.transactAll([{ kind, params }], async ([t]) => [await sign(t)]);
  }

  /** Several, signed together and sent in order. Stops at the first that fails. */
  async transactAll(steps: { kind: Kind; params: Record<string, unknown> }[], signAll: (base64s: string[]) => Promise<string[]>): Promise<{ ok: true; tx: string } | { ok: false; why: string }> {
    const built: BuiltMsg[] = [];
    for (const { kind, params } of steps) {
      const b = await this.request({ type: "build", kind, player: this.player, ...params }, (m): m is BuiltMsg => m.type === "built" && m.kind === kind, 15_000);
      if (!b?.id || !b.tx) return fail(kind, "build", b?.why ?? "No answer");
      built.push(b);
    }
    let signed: string[];
    try {
      signed = await signAll(built.map((b) => b.tx!));
    } catch (e) {
      return fail(steps.map((x) => x.kind).join("+"), "sign", String((e as Error).message ?? e) || "Not signed");
    }
    let last = "";
    for (const [i, b] of built.entries()) {
      const done = await this.request({ type: "submit", id: b.id, tx: signed[i] }, (m): m is SubmittedMsg => m.type === "submitted" && m.id === b.id, 60_000);
      if (!done) return fail(steps[i].kind, "submit", "No answer");
      if (!done.ok || !done.tx) return fail(steps[i].kind, "submit", done.why ?? "Not sent");
      last = done.tx;
    }
    return { ok: true, tx: last };
  }

  /** Follow one player's account and bets. */
  watch(player: string | null) {
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

/** A wallet transaction that did not go through, said in the console in development: the screen only has room for a line. */
function fail(kind: string, at: "build" | "sign" | "submit", why: string): { ok: false; why: string } {
  if (process.env.NODE_ENV !== "production") console.warn(`[relayer] ${kind} failed at ${at}: ${why}`);
  return { ok: false, why };
}

/** The same account, to the micro-dollar and the key: the relayer sends it often (after payouts, on request), mostly unchanged. */
const sameAccount = (a: Account | null, b: Account) =>
  !!a &&
  a.player === b.player &&
  a.balance === b.balance &&
  a.owed === b.owed &&
  a.wallet.usdc === b.wallet.usdc &&
  a.wallet.approved === b.wallet.approved &&
  a.skt?.balance === b.skt?.balance &&
  a.skt?.claimable === b.skt?.claimable &&
  (a.session?.key ?? null) === (b.session?.key ?? null) &&
  (a.session?.validUntil ?? null) === (b.session?.validUntil ?? null) &&
  (a.session?.allowance ?? null) === (b.session?.allowance ?? null);

/** One relayer for the page, following `player`. */
export function useRelayer(player: string | null, enabled: boolean) {
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
  // An account is only the player's while they are the player. Base58 is case-sensitive: the same address, exactly.
  const own = player && account && account.player === player ? account : null;
  return { client, hello, account: own, connected };
}
