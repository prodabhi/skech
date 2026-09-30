import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useAccount } from "@/components/app/auth";
import { type Account, type Hello, type Kind, type RelayerClient, useRelayer } from "@/lib/relayer";
import { forgetSessionKey, sessionKey, type SessionKey } from "@/lib/session";
import { Holds } from "@skech/core/optimistic";

/**
 * Real money, on Solana: the relayer, the player's account in the game, and the session key that signs their ink,
 * as on the web (`ui/app/src/components/app/ink/chain-context.tsx`). Everything the wallet signs goes through here,
 * and there is little of it: one session (which also lets USDC that lands in the wallet be swept in), and a
 * withdrawal. The relayer builds each transaction and pays for it; the phone only signs.
 */

export type Chain = {
  real: boolean;
  player: string | null;
  client: RelayerClient;
  hello: Hello | null;
  account: Account | null;
  connected: boolean;
  key: SessionKey | null;
  /** Whether the key on chain is this phone's, and still good for an hour. */
  sessionOk: boolean;
  /** Register this phone's key, and the standing approval for deposits, with one signature from the wallet. */
  enableSession: () => Promise<string | null>;
  /** Throw this phone's key away, from the secure store and from here: an account is being deleted. */
  forgetKey: () => Promise<void>;
  registering: boolean;
  /** USDC from the wallet into the balance now, on a signature: for when there is no approval left to sweep on. */
  deposit: (usdc: number) => Promise<string | null>;
  /** Send `usdc` from the balance to `to` (a Solana address): the transaction, or why not. */
  withdraw: (usdc: number, to: string) => Promise<{ tx: string } | { why: string }>;
  /** The player's SKT and the USDC it has earned, as the relayer last said; null before it has. */
  skt: { balance: number; claimable: number } | null;
  /** What the SKT has earned, into the balance: the transaction, or why not. */
  claim: () => Promise<{ tx: string } | { why: string }>;
  claiming: boolean;
  /** USDC in the wallet itself, on its way in; null before the first word. */
  wallet: number | null;
  /** How much of the wallet's USDC the game may sweep in without asking. */
  approved: number;
  adding: number | null;
  landed: { amount: number; at: number } | null;
  balance: number;
  nudge: (usdc: number) => void;
  resync: () => void;
  /**
   * Ink played ahead of the chain: each piece's stake and hits, held in the balance under their own names from the
   * moment they happen until the chain has done them too and its next word on the balance includes them, or until
   * it never will (a refusal: `drop`). See `Holds` in @skech/core/optimistic; the web's is the same.
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

export const ChainContext = createContext<Chain | null>(null);

const SESSION_DAYS = 7;
/** How much a session may put in, in all, before it must be registered again: $100,000. */
const SESSION_ALLOWANCE = 100_000_000_000n;
/** How much USDC landing in the wallet the game may sweep in without asking again: $1,000,000. */
const APPROVE = 1_000_000_000_000n;
export const MIN_DEPOSIT = 1;
/** How long USDC in the wallet may take to move in before the app stops waiting on it. */
const SWEEP_WAIT_MS = 30_000;
/** How long after that, or after a deposit that did not go through, it asks again. */
const SWEEP_BACKOFF_MS = 30_000;

export function ChainProvider({ children }: { children: ReactNode }) {
  const me = useAccount();
  const player = me.signedIn ? me.address : null;
  const { client, hello, account, connected } = useRelayer(player, true);
  const [key, setKey] = useState<SessionKey | null>(null);
  const [registering, setRegistering] = useState(false);
  const [moved, setMoved] = useState<{ said: string | null; by: number }>({ said: null, by: 0 });
  const [now, setNow] = useState(() => Date.now());
  /** What ink played ahead of the chain has moved the balance by, whose it is, and its total, which is what renders. */
  const [book] = useState(() => new Holds());
  const [held, setHeld] = useState<{ player: string | null; usd: number }>({ player: null, usd: 0 });

  useEffect(() => {
    let live = true;
    void sessionKey().then((k) => live && setKey(k), () => undefined);
    return () => {
      live = false;
    };
  }, []);

  const said = account?.balance ?? null;
  const balance = Math.round(((said ? Number(said) / 1e6 : 0) + (moved.said === said ? moved.by : 0) + (held.player === player ? held.usd : 0)) * 1e6) / 1e6;
  const nudge = useCallback((usdc: number) => setMoved((m) => ({ said, by: (m.said === said ? m.by : 0) + usdc })), [said]);
  const playerRef = useRef(player);
  useEffect(() => {
    playerRef.current = player;
  }, [player]);
  const resync = useCallback(() => {
    setMoved({ said: null, by: 0 });
    book.clear();
    setHeld({ player: playerRef.current, usd: 0 });
  }, [book]);
  // Held for one player: someone else signing in starts from nothing.
  const owner = useRef<string | null>(null);
  const holds = useMemo<HoldsApi>(() => {
    // The same total for the same player is no change: the provider, and every screen reading it, need not render.
    const after = <T,>(r: T) => {
      const player = owner.current,
        usd = book.total();
      setHeld((h) => (h.player === player && h.usd === usd ? h : { player, usd }));
      return r;
    };
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
  const saidRef = useRef(said);
  const nudgeRef = useRef(nudge);
  useEffect(() => {
    saidRef.current = said;
    nudgeRef.current = nudge;
  }, [said, nudge]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const sessionOk = useMemo(() => {
    const s = account?.session;
    if (!s || !key) return false;
    return s.key === key.address && Number(s.validUntil) * 1000 > now + 3_600_000 && BigInt(s.allowance) > 0n;
  }, [account, key, now]);

  /** The session's transaction: a key this phone keeps, allowed to place drawings for a while. Makes the key if there is none. */
  const sessionStep = useCallback(async () => {
    let k = key;
    if (!k) {
      k = await sessionKey();
      setKey(k);
    }
    const validUntil = String(Math.floor(Date.now() / 1000) + SESSION_DAYS * 86_400);
    return { kind: "session" as const, params: { key: k.address, validUntil, allowance: SESSION_ALLOWANCE.toString(), approve: APPROVE.toString() } };
  }, [key]);
  // Whoever signs in next gets a new key, made by sessionStep and registered afresh.
  const forgetKey = useCallback(async () => {
    setKey(null);
    await forgetSessionKey();
  }, []);

  const enableSession = useCallback(async (): Promise<string | null> => {
    if (!player || !hello) return "Not connected";
    let step: Awaited<ReturnType<typeof sessionStep>>;
    try {
      step = await sessionStep();
    } catch {
      return "This phone can't keep a key. Try again.";
    }
    setRegistering(true);
    try {
      const r = await client.transact(step.kind, step.params, me.signTransaction);
      if (!r.ok) return r.why;
      client.send({ type: "account" });
      return null;
    } finally {
      setRegistering(false);
    }
  }, [player, hello, sessionStep, client, me.signTransaction]);

  const deposit = useCallback(
    async (usdc: number): Promise<string | null> => {
      if (!player || !hello) return "Not connected";
      const amount = BigInt(Math.round(usdc * 1e6));
      if (amount <= 0n) return "Nothing to deposit";
      const steps: { kind: Kind; params: Record<string, unknown> }[] = [{ kind: "deposit", params: { amount: amount.toString() } }];
      // A wallet on the phone with no session yet signs that too, in the same visit: otherwise it opens again for it
      // the moment the money lands, which reads as the wallet never handing back.
      if (me.kind === "wallet" && !sessionOk) {
        try {
          steps.push(await sessionStep());
        } catch {
          // No key on this phone: deposit anyway, and the setup card asks again.
        }
      }
      const both = steps.length > 1;
      if (both) setRegistering(true);
      try {
        const r = await client.transactAll(steps, me.signTransactions);
        if (r.ok && both) client.send({ type: "account" });
        return r.ok ? null : r.why;
      } finally {
        if (both) setRegistering(false);
      }
    },
    [player, hello, client, me.kind, me.signTransactions, sessionOk, sessionStep],
  );

  const withdraw = useCallback(
    async (usdc: number, to: string): Promise<{ tx: string } | { why: string }> => {
      if (!player) return { why: "Not connected" };
      const amount = BigInt(Math.round(usdc * 1e6));
      if (amount <= 0n) return { why: "Nothing to withdraw" };
      const before = saidRef.current;
      const r = await client.transact("withdraw", { amount: amount.toString(), to }, me.signTransaction);
      if (!r.ok) return { why: r.why };
      if (saidRef.current === before) nudgeRef.current(-usdc);
      return { tx: r.tx };
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
      if (!r.ok) return { why: r.why };
      // As a withdrawal: the relayer sends the new balance first, so it is counted here only if that has not come.
      if (saidRef.current === before) nudgeRef.current(amount);
      return { tx: r.tx };
    } finally {
      setClaiming(false);
    }
  }, [player, client, me.signTransaction, skt]);

  /*
    USDC that lands in the wallet is on its way in. With the session's standing approval the relayer sweeps it in
    by itself; the app asks it to look now rather than on its next round. With no approval left, a Privy wallet
    signs the deposit without asking, as on the web; a wallet on the phone would prompt, so the sheet offers it.
  */
  const wallet = account ? Number(account.wallet.usdc) / 1e6 : null;
  const approved = account ? Number(account.wallet.approved) / 1e6 : 0;
  const [adding, setAdding] = useState<number | null>(null);
  const [landed, setLanded] = useState<{ amount: number; at: number } | null>(null);
  const live = Boolean(player && hello && connected);
  const pending = useRef<{ amount: number; before: string | null; signing: boolean } | null>(null);
  const pausedUntil = useRef(0);
  const [again, setAgain] = useState(0);
  // A sweep that failed, or never emptied the wallet: stop saying "Adding", and look again in a while, as the web does.
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
    else if (me.kind === "privy") {
      ask.signing = true;
      void deposit(wallet).then((why) => {
        ask.signing = false;
        if (pending.current !== ask) return;
        if (why) giveUp();
        else setAgain((n) => n + 1);
      });
    } else {
      pending.current = null;
      setAdding(null);
    }
  }, [live, wallet, approved, client, deposit, me.kind, again, giveUp]);
  useEffect(() => {
    if (adding === null) return;
    const timer = setTimeout(giveUp, SWEEP_WAIT_MS);
    return () => clearTimeout(timer);
  }, [adding, giveUp]);
  // Landed: the wallet emptied into the balance.
  useEffect(() => {
    const p = pending.current;
    if (!p || wallet === null || wallet >= MIN_DEPOSIT) return;
    pending.current = null;
    setAdding(null);
    if (saidRef.current === p.before) nudgeRef.current(p.amount);
    setLanded({ amount: p.amount, at: Date.now() });
  }, [wallet]);

  const value = useMemo<Chain>(
    () => ({ real: live, player, client, hello, account, connected, key, sessionOk, enableSession, forgetKey, registering, deposit, withdraw, skt, claim, claiming, wallet, approved, adding, landed, balance, nudge, resync, holds }),
    [live, player, client, hello, account, connected, key, sessionOk, enableSession, forgetKey, registering, deposit, withdraw, skt, claim, claiming, wallet, approved, adding, landed, balance, nudge, resync, holds],
  );
  return <ChainContext.Provider value={value}>{children}</ChainContext.Provider>;
}

export function useChain(): Chain {
  const c = useContext(ChainContext);
  if (!c) throw new Error("useChain outside ChainProvider");
  return c;
}

export { forgetSessionKey };
