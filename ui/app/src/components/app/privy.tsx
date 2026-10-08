"use client";

import { type PrivyClientConfig, PrivyProvider, type User, useLogin, useLogout, usePrivy, type WalletWithMetadata } from "@privy-io/react-auth";
import { useCreateWallet, useSignMessage, useSignTransaction, useWallets } from "@privy-io/react-auth/solana";
import { useEffect, useMemo, useRef, useState } from "react";
import { shortAddress } from "@/lib/market";
import { type Account, NOT_YET } from "./auth";

/**
 * Privy, mounted beside the app once its chunk is in (auth.tsx). Everything
 * Privy-specific is here, so the first page load never carries it.
 */

export type Bridge = { appId: string; asked: number; onAccount: (account: Account) => void };

/**
 * Never Privy's own confirmation: the relayer builds every transaction and the game asks for each one itself,
 * as the phone does. Signed this way it is the wallet signing the transaction's message in Privy's iframe, with
 * no RPC of ours or Privy's involved: the relayer sends it.
 */
const SILENT = { uiOptions: { showWalletUIs: false } };

const config = (dark: boolean): PrivyClientConfig => ({
  /*
    The ways in. Each one still has to be turned on in Privy's dashboard: this list only picks from what is
    on there, it cannot turn anything on.
  */
  loginMethods: ["email", "sms", "google", "apple"],
  /*
    Light or dark to match the app, for the shades Privy derives and we do not set. The rest of the panel
    reads our own colours, through the variables in globals.css, so it follows the theme switch live.
  */
  appearance: { theme: dark ? "dark" : "light", accentColor: dark ? "#6f92ff" : "#2e5bff", walletChainType: "solana-only" },
  /*
    A Solana wallet for everyone, those who signed in when the game was on Monad included: they have an Ethereum
    wallet, which "users-without-wallets" would count. No Ethereum wallet for anyone new.
  */
  embeddedWallets: { solana: { createOnLogin: "all-users" }, ethereum: { createOnLogin: "off" }, showWalletUIs: false },
});

/** Whether the app is dark right now: the `.dark` class theme-toggle.tsx sets on the root. */
function useDark() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const root = document.documentElement;
    const o = new MutationObserver(() => setDark(root.classList.contains("dark")));
    o.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => o.disconnect();
  }, []);
  return dark;
}

export function PrivyBridge({ appId, asked, onAccount }: Bridge) {
  const dark = useDark();
  const cfg = useMemo(() => config(dark), [dark]);
  return (
    <PrivyProvider appId={appId} config={cfg}>
      <Publish asked={asked} onAccount={onAccount} />
    </PrivyProvider>
  );
}

/** The Solana wallet Privy made for them; never a wallet they linked from elsewhere. */
const embedded = (user: User | null) =>
  user?.linkedAccounts.find((a): a is WalletWithMetadata => a.type === "wallet" && a.chainType === "solana" && Boolean(a.walletClientType?.startsWith("privy")))?.address ?? null;

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const toBase64 = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

/** Reads Privy's hooks. Only ever mounted inside their provider. */
function Publish({ asked, onAccount }: Omit<Bridge, "appId">) {
  const { ready, authenticated, user } = usePrivy();
  const { login } = useLogin();
  const { logout } = useLogout();
  const { wallets } = useWallets();
  const { signTransaction } = useSignTransaction();
  const { signMessage } = useSignMessage();
  const { createWallet } = useCreateWallet();
  const address = embedded(user);
  const wallet = wallets.find((w) => w.address === address) ?? null;
  // Privy's functions are new on most renders; the account is published only when what it says changes.
  const fns = useRef({ logout, signTransaction, signMessage, wallet });
  useEffect(() => {
    fns.current = { logout, signTransaction, signMessage, wallet };
  });

  // Answer each sign-in asked for, once Privy can open: asked before it was ready, it opens when it is.
  const answered = useRef(0);
  useEffect(() => {
    if (!ready || asked === answered.current) return;
    answered.current = asked;
    if (!authenticated) login();
  }, [asked, ready, authenticated, login]);

  // Made at sign-in; anyone signed in without one (a session saved from the Monad game, a failed try) gets one now, once.
  const made = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || !authenticated || !user || address || made.current === user.id) return;
    made.current = user.id;
    createWallet().catch((e) => {
      if (process.env.NODE_ENV !== "production") console.warn("[privy] no Solana wallet made", e);
    });
  }, [ready, authenticated, user, address, createWallet]);

  const email = user?.email?.address ?? user?.google?.email ?? user?.apple?.email ?? null;
  const handle = email ?? user?.phone?.number ?? (address ? shortAddress(address) : null);
  // Signed in is once the wallet is there to sign with: until then it is still being made.
  const signing = Boolean(address && wallet);
  const account = useMemo<Account>(() => {
    if (!ready) return NOT_YET;
    const sign = async (base64: string) => {
      const w = fns.current.wallet;
      if (!w) throw new Error("No wallet yet");
      const { signedTransaction } = await fns.current.signTransaction({ transaction: fromBase64(base64), wallet: w, options: SILENT });
      return toBase64(signedTransaction);
    };
    return {
      ready,
      signedIn: authenticated,
      address: signing ? address : null,
      handle,
      email,
      signOut: () => void fns.current.logout(),
      signTransaction: sign,
      // Nothing to open or approve, so one at a time costs nothing.
      signTransactions: async (base64s) => {
        const out: string[] = [];
        for (const t of base64s) out.push(await sign(t));
        return out;
      },
      signMessage: async (message) => {
        const w = fns.current.wallet;
        if (!w) throw new Error("No wallet yet");
        const { signature } = await fns.current.signMessage({ message: new TextEncoder().encode(message), wallet: w, options: SILENT });
        return toBase64(signature);
      },
    };
  }, [ready, authenticated, address, signing, handle, email]);
  useEffect(() => onAccount(account), [account, onAccount]);
  return null;
}
