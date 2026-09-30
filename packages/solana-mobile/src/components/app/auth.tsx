import { PrivyProvider, useEmbeddedSolanaWallet, useLoginWithEmail, useLoginWithSMS, usePrivy } from "@privy-io/expo";
import type { transact as Transact } from "@solana-mobile/mobile-wallet-adapter-protocol";
import { getAddressDecoder } from "@solana/kit";
import { Buffer } from "buffer";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";
import { hasAuth, PRIVY_APP_ID, PRIVY_CLIENT_ID } from "@/lib/config";
import { clearWallet, persistWallet, restoreWallet, type SavedWallet as Saved } from "@/lib/wallet-storage";
import { shortAddress } from "@/lib/market";

/**
 * Signing in, two ways, one account shape.
 *
 * - Privy's embedded wallet: an email or a phone and a one-time code, no seed phrase, a Solana account made at
 *   sign-in and kept by Privy. It signs without prompting, so a deposit or a session is one tap.
 * - A Solana wallet on the phone, through the Mobile Wallet Adapter (Android: Phantom, Solflare, the Seeker's Seed
 *   Vault). Every signature is the wallet's own prompt.
 *
 * Either way the app reads one `Account`: who, and a way to sign a transaction the relayer built. Privy's hooks
 * only work inside their provider, so they are read in one component that mounts there.
 */

export type WalletKind = "privy" | "wallet";
export type Account = {
  /** Whether the saved session has been read. Until then nobody is asked to sign in. */
  ready: boolean;
  signedIn: boolean;
  kind: WalletKind | null;
  /** The Solana address, base58, once there is one. */
  address: string | null;
  /** Whatever they signed in with, for the greeting. */
  handle: string | null;
  email: string | null;
  signOut: () => void;
  /** Sign a transaction (base64, the relayer's), returning it signed (base64). */
  signTransaction: (base64: string) => Promise<string>;
  /** Several at once, in order: a wallet on the phone signs them all in one visit rather than opening once each. */
  signTransactions: (base64s: string[]) => Promise<string[]>;
  /**
   * Sign words with the wallet's key, returning the Ed25519 signature (base64): the community's challenges (a
   * profile, a follow). Privy signs without asking; a wallet on the phone asks.
   */
  signMessage: (message: string) => Promise<string>;
  /** Privy: send a one-time code to an email or a phone (E.164); then `verify` it. What went wrong, or null. */
  sendCode: (email: string) => Promise<string | null>;
  sendSms: (phone: string) => Promise<string | null>;
  verify: (code: string) => Promise<string | null>;
  /** A wallet on the phone, through the Mobile Wallet Adapter. Android only. */
  connectWallet: () => Promise<string | null>;
  canConnectWallet: boolean;
};

const READY_WITHIN_MS = 8000;
/** The Mobile Wallet Adapter is Android's: its native module is not in the iPhone build, and importing it there throws. */
const transact: typeof Transact = (...args) => {
  if (Platform.OS !== "android") return Promise.reject(new Error("Solana wallets on the phone connect on Android"));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("@solana-mobile/mobile-wallet-adapter-protocol") as { transact: typeof Transact }).transact(...args);
};
// www, not the bare domain: that redirects, and a wallet checks this site's .well-known/assetlinks.json for this app and its key.
const IDENTITY = { name: "skech", uri: "https://www.skech.trade", icon: "icon.png" };
const b64ToBase58 = (b64: string) => getAddressDecoder().decode(Uint8Array.from(Buffer.from(b64, "base64")));
/** The cluster the relayer is on, for the wallet to sign for: devnet unless the build says mainnet. */
const CHAIN = process.env.EXPO_PUBLIC_SOLANA_CLUSTER === "mainnet-beta" ? "solana:mainnet" : "solana:devnet";

const nobody = { ready: true, signedIn: false, kind: null, address: null, handle: null, email: null } as const;
export const AccountContext = createContext<Account>({
  ...nobody,
  signOut: () => undefined,
  signTransaction: async () => {
    throw new Error("Not signed in");
  },
  signTransactions: async () => {
    throw new Error("Not signed in");
  },
  signMessage: async () => {
    throw new Error("Not signed in");
  },
  sendCode: async () => "Sign-in is not set up in this build",
  sendSms: async () => "Sign-in is not set up in this build",
  verify: async () => "Sign-in is not set up in this build",
  connectWallet: async () => "Not available",
  canConnectWallet: false,
});

/**
 * The Mobile Wallet Adapter half: an address and an auth token, kept in the secure store so the wallet does not ask
 * again. `generation` counts connects and sign-outs: anything that was waiting on the wallet when one happened (a
 * restore, a token rotation, a signature) finds it moved on and does not write the old account back.
 */
function useMobileWallet() {
  const [saved, setSaved] = useState<Saved | null>(null);
  const [ready, setReady] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    let live = true;
    const revision = generation.current;
    void restoreWallet(CHAIN)
      .then(
        (wallet) => {
          if (live && generation.current === revision) setSaved(wallet);
        },
        (e) => console.warn("wallet: the saved wallet could not be read", e),
      )
      .finally(() => {
        if (live) setReady(true);
      });
    return () => {
      live = false;
    };
  }, []);
  const connect = useCallback(async (): Promise<string | null> => {
    const revision = ++generation.current;
    try {
      const auth = await transact((wallet) => wallet.authorize({ identity: IDENTITY, chain: CHAIN }));
      const address = b64ToBase58(auth.accounts[0].address);
      const s = { address, authToken: auth.auth_token, cluster: CHAIN };
      if (generation.current !== revision) return "Wallet connection changed. Try again.";
      await persistWallet(s);
      if (generation.current === revision) setSaved(s);
      return null;
    } catch (e) {
      return String((e as Error).message ?? e) || "The wallet said no";
    }
  }, []);
  /** Reauthorized for the account that connected, or not at all: a wallet that hands back another account is refused. */
  const authorized = useCallback(
    async (wallet: Parameters<Parameters<typeof Transact>[0]>[0], s: Saved, revision: number) => {
      const auth = await wallet.reauthorize({ auth_token: s.authToken, identity: IDENTITY }).catch(() => wallet.authorize({ identity: IDENTITY, chain: CHAIN }));
      const account = auth.accounts.find((a) => b64ToBase58(a.address) === s.address);
      if (generation.current !== revision || !account) throw new Error("The wallet account changed. Connect again.");
      if (auth.auth_token !== s.authToken) {
        const next = { ...s, authToken: auth.auth_token };
        await persistWallet(next);
        if (generation.current === revision) setSaved(next);
      }
      if (generation.current !== revision) throw new Error("Wallet disconnected");
      return account;
    },
    [],
  );
  const signAll = useCallback(
    async (base64s: string[]) => {
      if (!saved) throw new Error("No wallet connected");
      const revision = generation.current;
      return transact(async (wallet) => {
        await authorized(wallet, saved, revision);
        const { signed_payloads } = await wallet.signTransactions({ payloads: base64s });
        return signed_payloads;
      });
    },
    [saved, authorized],
  );
  const sign = useCallback(async (base64: string) => (await signAll([base64]))[0], [signAll]);
  /** The wallet signs words; it answers with them and its signature after, the last 64 bytes. */
  const signMessage = useCallback(
    async (message: string) => {
      if (!saved) throw new Error("No wallet connected");
      const revision = generation.current;
      return transact(async (wallet) => {
        const account = await authorized(wallet, saved, revision);
        const { signed_payloads } = await wallet.signMessages({ addresses: [account.address], payloads: [Buffer.from(message, "utf8").toString("base64")] });
        const signed = Buffer.from(signed_payloads[0], "base64");
        return signed.subarray(signed.length - 64).toString("base64");
      });
    },
    [saved, authorized],
  );
  const disconnect = useCallback(() => {
    generation.current++;
    setSaved(null);
    clearWallet().catch((e) => console.warn("wallet: the saved wallet could not be deleted", e));
  }, []);
  return useMemo(() => ({ saved, ready, connect, sign, signAll, signMessage, disconnect }), [saved, ready, connect, sign, signAll, signMessage, disconnect]);
}

/** A wrong or stale code, as Privy says it: whatever the words, the code is what to fix. */
const WRONG_CODE = "invalid_credentials";
const toBytes = (b64: string) => Uint8Array.from(Buffer.from(b64, "base64"));

/** Reads Privy's hooks. Only ever mounted inside their provider. */
function Publish({ children }: { children: ReactNode }) {
  const mwa = useMobileWallet();
  const { isReady, user, logout } = usePrivy();
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setWaited(true), READY_WITHIN_MS);
    return () => clearTimeout(t);
  }, []);
  const solana = useEmbeddedSolanaWallet();
  const { sendCode: sendEmailCode, loginWithCode: loginWithEmail } = useLoginWithEmail();
  const { sendCode: sendSmsCode, loginWithCode: loginWithSms } = useLoginWithSMS();
  const [flow, setFlow] = useState<{ to: string; by: "email" | "sms" } | null>(null);
  // The wallet on the phone is read from the secure store first, so a saved one is never shown signed out.
  const ready = (isReady || waited) && mwa.ready;
  const wallet = solana.wallets?.[0] ?? null;

  // The wallet is made at sign-in; anyone who signed in without one (an older account, a failed try) gets one now,
  // once. Not while a code is being checked: that sign-in is still making its own.
  const made = useRef<string | null>(null);
  const create = solana.create;
  useEffect(() => {
    if (!user || wallet || flow || !create || made.current === user.id) return;
    made.current = user.id;
    create().catch((e) => console.warn("sign-in: no Solana wallet made", e));
  }, [user, wallet, flow, create]);

  /*
    Bumped on signing out and whenever the account changes: a signature asked for before is not handed back after,
    so nothing the old account signed can be sent as the new one's (or as nobody's).
  */
  const epoch = useRef(0);
  const who = user && wallet ? wallet.address : (mwa.saved?.address ?? null);
  const lastWho = useRef(who);
  if (lastWho.current !== who) {
    lastWho.current = who;
    epoch.current++;
  }

  const account = useMemo<Account>(() => {
    const privy = Boolean(user && wallet);
    const asked = epoch.current;
    const still = <T,>(value: T) => {
      if (epoch.current !== asked) throw new Error("The account changed while signing. Try again.");
      return value;
    };
    const linked = user?.linked_accounts ?? [];
    const email = linked.find((a) => a.type === "email")?.address ?? linked.find((a) => a.type === "google_oauth" || a.type === "apple_oauth")?.email ?? null;
    const phone = linked.find((a) => a.type === "phone")?.phoneNumber ?? null;
    const address = privy ? wallet!.address : (mwa.saved?.address ?? null);
    // Privy signs in the app, without asking: a deposit or a session is one tap, as on the web.
    const sign = async (base64: string) => {
      const provider = await wallet!.getProvider();
      const { signedTransaction } = await provider.request({ method: "signTransaction", params: { transaction: toBytes(base64) } });
      return still(Buffer.from(signedTransaction).toString("base64"));
    };
    return {
      ready,
      signedIn: privy || Boolean(mwa.saved),
      kind: privy ? "privy" : mwa.saved ? "wallet" : null,
      address,
      handle: privy ? (email ?? phone ?? (address ? shortAddress(address) : null)) : address ? shortAddress(address) : null,
      email: privy ? email : null,
      signOut: () => {
        epoch.current++;
        if (user) void logout();
        mwa.disconnect();
      },
      signTransaction: async (base64) => (privy ? sign(base64) : mwa.sign(base64)),
      signTransactions: async (base64s) => {
        if (!privy) return mwa.signAll(base64s);
        // Nothing to open or approve, so one at a time costs nothing.
        const out: string[] = [];
        for (const t of base64s) out.push(await sign(t));
        return out;
      },
      signMessage: async (message) => {
        if (!privy) return mwa.signMessage(message);
        const provider = await wallet!.getProvider();
        const { signature } = await provider.request({ method: "signMessage", params: { message: Buffer.from(message, "utf8").toString("base64") } });
        // Base64 as the service reads it, padding and all, whatever form it came in.
        return still(Buffer.from(signature, "base64").toString("base64"));
      },
      sendCode: async (e) => {
        try {
          const to = e.trim();
          await sendEmailCode({ email: to });
          console.info("sign-in: a code went out by email");
          setFlow({ to, by: "email" });
          return null;
        } catch (err) {
          return String((err as Error).message ?? err);
        }
      },
      sendSms: async (phone) => {
        try {
          await sendSmsCode({ phone });
          console.info("sign-in: a code went out by text");
          setFlow({ to: phone, by: "sms" });
          return null;
        } catch (err) {
          return String((err as Error).message ?? err);
        }
      },
      verify: async (code) => {
        if (!flow) return "Ask for a code first";
        try {
          // Said again rather than left to the hook's memory, as Privy asks.
          if (flow.by === "sms") await loginWithSms({ code: code.trim(), phone: flow.to });
          else await loginWithEmail({ code: code.trim(), email: flow.to });
          setFlow(null);
          return null;
        } catch (err) {
          console.warn("sign-in: the code was not accepted", err);
          if ((err as { code?: string }).code === WRONG_CODE) return `That code didn't match. Check the ${flow.by === "sms" ? "text" : "email"}, or tap Resend code for a new one.`;
          return String((err as Error).message ?? err);
        }
      },
      connectWallet: mwa.connect,
      canConnectWallet: Platform.OS === "android",
    };
  }, [ready, user, wallet, mwa, logout, sendEmailCode, loginWithEmail, sendSmsCode, loginWithSms, flow]);
  return <AccountContext.Provider value={account}>{children}</AccountContext.Provider>;
}

/** Without a Privy app, the wallet on the phone is still a way in. */
function WalletOnly({ children }: { children: ReactNode }) {
  const mwa = useMobileWallet();
  const account = useMemo<Account>(
    () => ({
      ready: mwa.ready,
      signedIn: Boolean(mwa.saved),
      kind: mwa.saved ? "wallet" : null,
      address: mwa.saved?.address ?? null,
      handle: mwa.saved ? shortAddress(mwa.saved.address) : null,
      email: null,
      signOut: mwa.disconnect,
      signTransaction: mwa.sign,
      signTransactions: mwa.signAll,
      signMessage: mwa.signMessage,
      sendCode: async () => "Email sign-in is not set up in this build",
      sendSms: async () => "Phone sign-in is not set up in this build",
      verify: async () => "Email sign-in is not set up in this build",
      connectWallet: mwa.connect,
      canConnectWallet: Platform.OS === "android",
    }),
    [mwa],
  );
  return <AccountContext.Provider value={account}>{children}</AccountContext.Provider>;
}

// A Solana wallet for everyone who signs in without one; no Ethereum wallet, the game is on Solana.
const config = { embedded: { solana: { createOnLogin: "users-without-wallets" } } } as const;

export function AuthProvider({ children }: { children: ReactNode }) {
  if (!hasAuth) return <WalletOnly>{children}</WalletOnly>;
  return (
    <PrivyProvider appId={PRIVY_APP_ID} clientId={PRIVY_CLIENT_ID} config={config}>
      <Publish>{children}</Publish>
    </PrivyProvider>
  );
}

export function useAccount(): Account {
  return useContext(AccountContext);
}
