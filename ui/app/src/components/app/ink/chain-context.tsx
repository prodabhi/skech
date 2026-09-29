"use client";

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { reportError, track } from "@/lib/analytics";
import { hasAuth, useAccount } from "@/components/app/auth";
import { type Account, type Hello, RelayerClient, useRelayer } from "@/lib/relayer";
import { canHoldSession, forgetSessionKey, sessionKey, type SessionKey } from "@/lib/session";
import { Holds } from "@skech/core/optimistic";

/**
 * Real money, on Solana, once someone has signed in: the relayer, the
 * player's account in the game, and the session key that signs their ink,
 * as on the phone (packages/solana-mobile/src/components/app/ink/chain-context.tsx).
 * Everything the wallet signs goes through here, and there is little of it:
 * one session (which also lets USDC that lands in the wallet be swept in),
 * a deposit when there is no approval left to sweep on, and a withdrawal.
 * The relayer builds each transaction and pays its fee; the browser only signs.
 *
 * Signed out, or with no way to sign in, `real` is false and the game plays
 * for practice money as it always has.
 */

export type Chain = {
  /** Playing for real: signed in and connected. */
  real: boolean;
  player: string | null;
  client: RelayerClient;
  hello: Hello | null;
  account: Account | null;
  connected: boolean;
  /** The browser's session key, once it exists. */
  key: SessionKey | null;
  /** Whether the key on chain is this browser's, and still good for an hour. */
  sessionOk: boolean;
  /** Register this browser's key, and the standing approval for deposits, with one signature from the wallet. */
  enableSession: () => Promise<string | null>;
  registering: boolean;
  /** USDC from the wallet into the balance now, on a signature: for when there is no approval left to sweep on. */
  deposit: (usdc: number) => Promise<string | null>;
  /** Send `usdc` from the balance to `to` (a Solana address): the transaction on success, or why not, in the relayer's words. */
  withdraw: (usdc: number, to: string) => Promise<{ tx: string } | { why: string }>;
  /** The player's SKT and the USDC it has earned, as the relayer last said; null before it has. */
  skt: { balance: number; claimable: number } | null;
  /** What the SKT has earned, into the balance: the transaction on success, or why not. */
  claim: () => Promise<{ tx: string } | { why: string }>;
  claiming: boolean;
  /** USDC sitting in the wallet on its way in, as the relayer last said; null before it has. */
  wallet: number | null;
  /** How much of the wallet's USDC the game may sweep in without asking. */
  approved: number;
  /** What is being moved into the balance right now, if anything. */
  adding: number | null;
  /** The last deposit that landed this visit: how much, and when. The deposit sheet says so. */
  landed: { amount: number; at: number } | null;
  /** What the app owes the player's own reckoning: the balance the relayer last said, in USDC, moved by what has happened since. */
  balance: number;
  /** Move the local balance by `usdc` until the relayer says otherwise. */
  nudge: (usdc: number) => void;
  /** Take the relayer's last word as the balance, dropping what was counted since: for when nothing is in flight. */
  resync: () => void;
  /**
   * Ink played ahead of the chain: each piece's stake and hits, held in the balance under their own names from the
   * moment they happen until the chain has done them too and its next word on the balance includes them, or until
   * it never will (a refusal: `drop`). See `Holds` in @skech/core/optimistic.
   */
  holds: HoldsApi;
};

export type HoldsApi = {
  hold: (id: string, usd: number) => void;
  land: (id: string, usd?: number) => void;
  landAll: (prefix: string) => void;
  drop: (id: string) => number;
  dropAll: (prefix: string) => number;
};

const Ctx = createContext<Chain | null>(null);

const SESSION_DAYS = 7;
/** How much a session may stake in all before it must be registered again: $100,000. */
const SESSION_ALLOWANCE = 100_000_000_000n;
/** How much USDC landing in the wallet the game may sweep in without asking again: $1,000,000. */
const APPROVE = 1_000_000_000_000n;
/** The least USDC moved in at once, in dollars, as the relayer has it. */
export const MIN_DEPOSIT = 1;
/** How often the relayer is asked about the wallet while USDC may be on its way, and the longest it is left. */
const LOOK_MS = 4000;
const LOOK_MAX_MS = 15_000;
/** How long USDC in the wallet may take to move in before the app stops waiting on it. */
const SWEEP_WAIT_MS = 30_000;
/** How long after that, or after a deposit that did not go through, it asks again. */
const SWEEP_BACKOFF_MS = 30_000;

const why = (e: unknown) => String((e as Error).message ?? e);

export function ChainProvider({ children }: { children: ReactNode }) {
  const me = useAccount();
  const player = hasAuth && me.signedIn ? me.address : null;
  const { client, hello, account, connected } = useRelayer(player, hasAuth);
  const [key, setKey] = useState<SessionKey | null>(null);
  const [registering, setRegistering] = useState(false);
  /** What has happened since the relayer last said the balance, against that word: forgotten when it speaks again. */
  const [moved, setMoved] = useState<{ said: string | null; by: number }>({ said: null, by: 0 });
  const [now, setNow] = useState(() => Date.now());
  /** What ink played ahead of the chain has moved the balance by, whose it is, and its total, which is what renders. */
  const [book] = useState(() => new Holds());
  const [held, setHeld] = useState<{ player: string | null; usd: number }>({ player: null, usd: 0 });

  useEffect(() => {
    if (!hasAuth || !canHoldSession()) return;
    let live = true;
    void sessionKey().then((k) => live && setKey(k), () => undefined);
    return () => {
      live = false;
    };
  }, []);
  /*
    Signing out throws the browser's key away, from storage and from this page: the session it was registered
    for can sign nothing more here, and whoever signs in next registers a key of their own.
  */
  const wasSignedIn = useRef(false);
  useEffect(() => {
    if (me.signedIn) {
      wasSignedIn.current = true;
      return;
    }
    if (!wasSignedIn.current) return;
    wasSignedIn.current = false;
    setKey(null);
    if (canHoldSession()) void forgetSessionKey().catch(() => undefined);
  }, [me.signedIn]);

  // The relayer's word on the balance is the balance; between its words, what we know moves it.
  const said = account?.balance ?? null;
  const balance = Math.round(((said ? Number(said) / 1e6 : 0) + (moved.said === said ? moved.by : 0) + (held.player === player ? held.usd : 0)) * 1e6) / 1e6;
  const nudge = useCallback((usdc: number) => setMoved((m) => ({ said, by: (m.said === said ? m.by : 0) + usdc })), [said]);
  const playerRef = useRef(player);
  useEffect(() => {
    playerRef.current = player;
  }, [player]);
  // Nothing in flight: the relayer's word is the whole of it, and what the app counted since is let go, even
  // when the word is the same number (keyed on the number alone, a drift outlived every word that repeated it).
  const resync = useCallback(() => {
    setMoved({ said: null, by: 0 });
    book.clear();
    setHeld({ player: playerRef.current, usd: 0 });
  }, [book]);
  // Held for one player: someone else signing in starts from nothing.
  const owner = useRef<string | null>(null);
  const holds = useMemo<HoldsApi>(() => {
    const after = <T,>(r: T) => (setHeld({ player: owner.current, usd: book.total() }), r);
    const own = () => {
      if (owner.current === playerRef.current) return;
      owner.current = playerRef.current;
      book.clear();
    };
    return {
      hold: (id, usd) => (own(), after(book.hold(id, usd))),
      land: (id, usd) => (own(), after(book.land(id, usd))),
      landAll: (prefix) => (own(), after(book.landAll(prefix))),
      drop: (id) => (own(), after(book.drop(id))),
      dropAll: (prefix) => (own(), after(book.dropAll(prefix))),
    };
  }, [book]);
  /*
    The relayer's word on the balance includes everything the chain has done: what was held for it is let go in the
    same breath (React renders both together, as they are set in the same message), so the figure does not move.
  */
  useEffect(() => {
    const off = client.on((m) => {
      if (m.type === "account" && m.player === playerRef.current && book.heard()) setHeld({ player: m.player, usd: book.total() });
    });
    return () => void off();
  }, [client, book]);
  // The relayer's latest word, for async code that must know whether it has spoken since it started.
  const saidRef = useRef(said);
  const nudgeRef = useRef(nudge);
  useEffect(() => {
    saidRef.current = said;
    nudgeRef.current = nudge;
  }, [said, nudge]);

  // A session is good for an hour at least: checked against a clock that ticks now and then.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const sessionOk = useMemo(() => {
    const s = account?.session;
    if (!s || !key) return false;
    return s.key === key.address && Number(s.validUntil) * 1000 > now + 3_600_000 && BigInt(s.allowance) > 0n;
  }, [account, key, now]);

  const enableSession = useCallback(async (): Promise<string | null> => {
    if (!player || !hello) return "Not connected";
    let k = key;
    if (!k) {
      try {
        k = await sessionKey();
        setKey(k);
      } catch {
        return "This browser can't play. Try another one.";
      }
    }
    setRegistering(true);
    try {
      // The key, allowed to place drawings for a week; and the standing approval that sweeps USDC in as it lands.
      const validUntil = String(Math.floor(Date.now() / 1000) + SESSION_DAYS * 86_400);
      const r = await client.transact("session", { key: k.address, validUntil, allowance: SESSION_ALLOWANCE.toString(), approve: APPROVE.toString() }, me.signTransaction);
      if (!r.ok) {
        track("drawing_key_failed", { why: r.why.slice(0, 120) });
        return r.why;
      }
      track("drawing_key_ready");
      client.send({ type: "account" });
      return null;
    } catch (e) {
      track("drawing_key_failed", { why: why(e).slice(0, 120) });
      reportError(e, { flow: "drawing_key" });
      return why(e);
    } finally {
      setRegistering(false);
    }
  }, [player, hello, key, me.signTransaction, client]);

  const deposit = useCallback(
    async (usdc: number): Promise<string | null> => {
      if (!player || !hello) return "Not connected";
      const amount = BigInt(Math.round(usdc * 1e6));
      if (amount <= 0n) return "Nothing to deposit";
      try {
        const r = await client.transact("deposit", { amount: amount.toString() }, me.signTransaction);
        if (!r.ok) {
          track("deposit_failed", { amount: usdc, why: r.why.slice(0, 120) });
          return r.why;
        }
        track("deposit_completed", { amount: usdc });
        return null;
      } catch (e) {
        track("deposit_failed", { amount: usdc, why: why(e).slice(0, 120) });
        reportError(e, { flow: "deposit", amount: usdc });
        return why(e);
      }
    },
    [player, hello, client, me.signTransaction],
  );

  const withdraw = useCallback(
    async (usdc: number, to: string): Promise<{ tx: string } | { why: string }> => {
      if (!player) return { why: "Not connected" };
      const amount = BigInt(Math.round(usdc * 1e6));
      if (amount <= 0n) return { why: "Nothing to withdraw" };
      try {
        const before = saidRef.current;
        const r = await client.transact("withdraw", { amount: amount.toString(), to }, me.signTransaction);
        if (!r.ok) {
          track("withdraw_failed", { amount: usdc, why: r.why.slice(0, 120) });
          return { why: r.why };
        }
        track("withdraw_completed", { amount: usdc });
        // The relayer sends the new balance before it answers; counted here only if that has not arrived, so it
        // can never be taken off twice.
        if (saidRef.current === before) nudgeRef.current(-usdc);
        return { tx: r.tx };
      } catch (e) {
        track("withdraw_failed", { amount: usdc, why: why(e).slice(0, 120) });
        reportError(e, { flow: "withdraw", amount: usdc });
        return { why: why(e) };
      }
    },
    [player, client, me.signTransaction],
  );

  const [sktBalance, sktClaimable] = [account?.skt?.balance, account?.skt?.claimable];
  const skt = useMemo(() => (sktBalance !== undefined && sktClaimable !== undefined ? { balance: Number(sktBalance), claimable: Number(sktClaimable) / 1e6 } : null), [sktBalance, sktClaimable]);
  const [claiming, setClaiming] = useState(false);
  const claim = useCallback(async (): Promise<{ tx: string } | { why: string }> => {
    if (!player) return { why: "Not connected" };
    const amount = skt?.claimable ?? 0;
    setClaiming(true);
    try {
      const before = saidRef.current;
      const r = await client.transact("claim", {}, me.signTransaction);
      if (!r.ok) {
        track("claim_failed", { amount, why: r.why.slice(0, 120) });
        return { why: r.why };
      }
      track("claim_completed", { amount });
      // As a withdrawal: the relayer sends the new balance first, so it is counted here only if that has not come.
      if (saidRef.current === before) nudgeRef.current(amount);
      return { tx: r.tx };
    } catch (e) {
      track("claim_failed", { amount, why: why(e).slice(0, 120) });
      reportError(e, { flow: "claim", amount });
      return { why: why(e) };
    } finally {
      setClaiming(false);
    }
  }, [player, client, me.signTransaction, skt]);

  /*
    The wallet is this game's own, made at sign-in, so USDC that lands in it is on its way in. The relayer says
    what is in it with the account; nothing tells it when USDC arrives, so it is asked every few seconds, less
    often the longer the wallet stays empty, and not at all while the page is hidden: it is asked again the moment
    the page is back, which is when someone who went to send it from elsewhere returns.
  */
  const wallet = account ? Number(account.wallet.usdc) / 1e6 : null;
  const approved = account ? Number(account.wallet.approved) / 1e6 : 0;
  const live = Boolean(player && hello && connected);
  const walletRef = useRef(wallet);
  useEffect(() => {
    walletRef.current = wallet;
  }, [wallet]);
  useEffect(() => {
    if (!live) return;
    let wait = LOOK_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = () => {
      clearTimeout(timer);
      if (document.hidden) return;
      client.send({ type: "account" });
      wait = (walletRef.current ?? 0) >= MIN_DEPOSIT ? LOOK_MS : Math.min(LOOK_MAX_MS, wait * 1.5);
      timer = setTimeout(look, wait);
    };
    const back = () => {
      if (document.hidden) return;
      wait = LOOK_MS;
      look();
    };
    document.addEventListener("visibilitychange", back);
    timer = setTimeout(look, LOOK_MS);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", back);
    };
  }, [live, client]);

  /*
    With the session's standing approval the relayer sweeps it in by itself; the app asks it to look now rather
    than on its next round. With no approval left, the wallet signs the deposit without asking. The player sees
    one address and one balance.
  */
  const [adding, setAdding] = useState<number | null>(null);
  const [landed, setLanded] = useState<{ amount: number; at: number } | null>(null);
  const pending = useRef<{ amount: number; before: string | null; signing: boolean } | null>(null);
  const pausedUntil = useRef(0);
  const [again, setAgain] = useState(0);
  // A sweep that failed, or never emptied the wallet: stop saying "Adding", and look again in a while.
  const giveUp = useCallback(() => {
    pending.current = null;
    setAdding(null);
    pausedUntil.current = Date.now() + SWEEP_BACKOFF_MS;
    setTimeout(() => setAgain((n) => n + 1), SWEEP_BACKOFF_MS);
  }, []);
  useEffect(() => {
    if (!live || wallet === null || wallet < MIN_DEPOSIT || Date.now() < pausedUntil.current) return;
    // One on its way for what is there now. USDC that arrived since is asked for again, all of it.
    const p = pending.current;
    if (p && (p.signing || p.amount === wallet)) return;
    const ask = { amount: wallet, before: saidRef.current, signing: false };
    pending.current = ask;
    setAdding(wallet);
    if (approved >= wallet) client.send({ type: "sweep" });
    else {
      ask.signing = true;
      void deposit(wallet).then((no) => {
        ask.signing = false;
        if (pending.current !== ask) return;
        if (no) {
          if (process.env.NODE_ENV !== "production") console.warn(`[chain] could not move ${wallet} USDC in: ${no}`);
          giveUp();
        } else setAgain((n) => n + 1);
      });
    }
  }, [live, wallet, approved, client, deposit, again, giveUp]);
  useEffect(() => {
    if (adding === null) return;
    const timer = setTimeout(giveUp, SWEEP_WAIT_MS);
    return () => clearTimeout(timer);
  }, [adding, giveUp]);
  // Landed: the wallet emptied into the balance. The balance must hold it before the sheet says "added", or the
  // next tap would find the old one: counted here only if the relayer's new word has not come.
  useEffect(() => {
    const p = pending.current;
    if (!p || wallet === null || wallet >= MIN_DEPOSIT) return;
    pending.current = null;
    setAdding(null);
    if (saidRef.current === p.before) nudgeRef.current(p.amount);
    setLanded({ amount: p.amount, at: Date.now() });
  }, [wallet]);

  const value = useMemo<Chain>(
    () => ({ real: live, player, client, hello, account, connected, key, sessionOk, enableSession, registering, deposit, withdraw, skt, claim, claiming, wallet, approved, adding, landed, balance, nudge, resync, holds }),
    [live, player, client, hello, account, connected, key, sessionOk, enableSession, registering, deposit, withdraw, skt, claim, claiming, wallet, approved, adding, landed, balance, nudge, resync, holds],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const OFF: Chain = {
  real: false,
  player: null,
  // Never started: it sends nothing, answers every request with null, and hears nothing.
  client: new RelayerClient(),
  hello: null,
  account: null,
  connected: false,
  key: null,
  sessionOk: false,
  enableSession: async () => "Not signed in",
  registering: false,
  deposit: async () => "Not signed in",
  withdraw: async () => ({ why: "Not signed in" }),
  skt: null,
  claim: async () => ({ why: "Not signed in" }),
  claiming: false,
  wallet: null,
  approved: 0,
  adding: null,
  landed: null,
  balance: 0,
  nudge: () => undefined,
  resync: () => undefined,
  holds: { hold: () => undefined, land: () => undefined, landAll: () => undefined, drop: () => 0, dropAll: () => 0 },
};

export function useChain(): Chain {
  return useContext(Ctx) ?? OFF;
}
