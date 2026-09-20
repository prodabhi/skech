"use client";

import { type ComponentType, createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { identify, track } from "@/lib/analytics";
import type { Bridge } from "./privy";

/**
 * Signing in.
 *
 * Privy embedded wallets: email, phone, Google or Apple, no extension to
 * install and no seed phrase to write down. The wallet is a Solana account
 * Privy makes at sign-in and keeps; it signs the relayer's transactions in
 * Privy's iframe without a prompt, so a session or a deposit is one tap.
 *
 * With no app id configured the app runs signed out and everything else
 * still works, which is what the tests and screenshots use. Privy's hooks
 * only work inside their provider, so they are read in one component that
 * only mounts there (privy.tsx) and published through context; everyone else
 * reads the context and calls exactly one hook however the build is configured.
 *
 * Privy's SDK is over half a megabyte, so it is not in the page's first load: it
 * comes in its own chunk once the page is up, and mounts beside the app, not
 * around it, so its arrival re-renders nothing but the account.
 */

const APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";

/** Whether this build can sign anyone in at all. */
export const hasAuth = APP_ID !== "";

export type Account = {
  /**
   * Whether Privy has finished reading the saved session. Until it has, `signedIn` is false for everyone,
   * someone signed in included: that is not knowing yet, not signed out, and nothing may ask them to sign in.
   */
  ready: boolean;
  signedIn: boolean;
  /** The wallet's Solana address, base58, once there is one. */
  address: string | null;
  /** Whatever they signed in with, for the greeting. */
  handle: string | null;
  /** Their email, whether they signed in with it or with Google or Apple; null for a phone number. */
  email: string | null;
  signOut: () => void;
  /**
   * Sign a transaction the relayer built (base64), returning it signed (base64): a session, a deposit, a
   * withdrawal. Published through this context like everything else, so a screen can ask for a signature
   * without knowing whether Privy's provider is mounted.
   */
  signTransaction: (base64: string) => Promise<string>;
  /** Several, in order. */
  signTransactions: (base64s: string[]) => Promise<string[]>;
  /**
   * Sign words with the wallet's key, returning the Ed25519 signature (base64): the community's challenges, which
   * say who is changing their profile or whom they follow. No prompt, as for a transaction.
   */
  signMessage: (message: string) => Promise<string>;
};

const notSignedIn = async (): Promise<never> => {
  throw new Error("Not signed in");
};

/** The longest the app waits for Privy to read a saved session before treating someone as signed out. */
const READY_WITHIN_MS = 8000;

const SIGNED_OUT: Account = { ready: true, signedIn: false, address: null, handle: null, email: null, signOut: () => undefined, signTransaction: notSignedIn, signTransactions: notSignedIn, signMessage: notSignedIn };
export const NOT_YET: Account = { ...SIGNED_OUT, ready: false };
const Ctx = createContext<Account>(SIGNED_OUT);
const SignInCtx = createContext<() => void>(() => undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const testing = useTestAccount();
  if (testing) return <Ctx.Provider value={testing}>{children}</Ctx.Provider>;
  if (!hasAuth) return <Ctx.Provider value={SIGNED_OUT}>{children}</Ctx.Provider>;
  return <WithPrivy>{children}</WithPrivy>;
}

/**
 * For tests in development only (`next dev`; never in a production build): `?as=<address>` shows the page as that
 * wallet, signed in, with nothing to sign with. Two browsers can then be two players without email codes.
 */
const noChange = () => () => undefined;
function useTestAccount(): Account | null {
  // The server renders without it; the page takes it on hydrating.
  const as = useSyncExternalStore(noChange, () => (process.env.NODE_ENV === "production" ? null : new URLSearchParams(window.location.search).get("as")), () => null);
  return useMemo(() => (as && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(as) ? { ...SIGNED_OUT, signedIn: true, address: as, handle: "Test player" } : null), [as]);
}

function WithPrivy({ children }: { children: ReactNode }) {
  const [Loaded, setLoaded] = useState<ComponentType<Bridge> | null>(null);
  useEffect(() => {
    let live = true;
    // Blocked or offline: it never comes, and the wait below lets them in signed out.
    import("./privy").then((m) => live && setLoaded(() => m.PrivyBridge)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const [reported, setReported] = useState<Account>(NOT_YET);
  // If Privy cannot be reached at all (blocked, offline), it never says; after a while, stop waiting and let them sign in.
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setWaited(true), READY_WITHIN_MS);
    return () => clearTimeout(t);
  }, []);
  const ready = reported.ready || waited;
  const account = useMemo<Account>(() => ({ ...reported, ready }), [reported, ready]);
  // Who is playing, for analytics: the wallet once known. Signed in is counted only when it happens in this visit,
  // not each time a saved session is read back; signed out likewise.
  const was = useRef<"in" | "out" | null>(null);
  useEffect(() => {
    if (!ready) return;
    if (account.signedIn && account.address) {
      identify(account.address);
      if (was.current === "out") track("signed_in");
      was.current = "in";
    } else if (!account.signedIn) {
      if (was.current === "in") {
        track("signed_out");
        identify(null);
      }
      was.current = "out";
    }
  }, [ready, account.signedIn, account.address]);
  // Each ask is a number the bridge answers once, when Privy is ready: a tap before its chunk lands still opens it.
  const [asked, setAsked] = useState(0);
  const signIn = useCallback(() => setAsked((n) => n + 1), []);
  return (
    <Ctx.Provider value={account}>
      <SignInCtx.Provider value={signIn}>
        {children}
        {Loaded ? <Loaded appId={APP_ID} asked={asked} onAccount={setReported} /> : null}
      </SignInCtx.Provider>
    </Ctx.Provider>
  );
}

/** Who is signed in. Answers signed out rather than throwing where there is no auth. */
export function useAccount(): Account {
  return useContext(Ctx);
}

/** Opens Privy's sign-in. Does nothing where there is no auth. */
export function useSignIn(): () => void {
  return useContext(SignInCtx);
}
