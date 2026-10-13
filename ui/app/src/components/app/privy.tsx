"use client";

import { type PrivyClientConfig, PrivyProvider, type User, useLogin, useLogout, usePrivy, useSignMessage, useSignTypedData, type WalletWithMetadata } from "@privy-io/react-auth";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Chain } from "viem";
import { chain } from "@/lib/chain";
import { RPC_URL } from "@/lib/endpoints";
import { shortAddress } from "@/lib/market";
import { type Account, NOT_YET, plain } from "./auth";

/** Privy is lazy-mounted beside the app by auth.tsx. */
export type Bridge = { appId: string; asked: number; onAccount: (account: Account) => void };

/** The Arc chain with the same RPC origin allowed by the page's CSP. */
const CHAIN = { ...chain, rpcUrls: { ...chain.rpcUrls, default: { http: [RPC_URL] } } } as Chain;
const SILENT = { uiOptions: { showWalletUIs: false } };

const config = (dark: boolean): PrivyClientConfig => ({
  loginMethods: ["email", "sms", "google", "apple"],
  appearance: { theme: dark ? "dark" : "light", accentColor: dark ? "#6f92ff" : "#2e5bff", walletChainType: "ethereum-only" },
  // Existing users may only have the Solana wallet from the previous build;
  // all-users ensures they receive the EVM wallet this deployment needs.
  embeddedWallets: { ethereum: { createOnLogin: "all-users" }, showWalletUIs: false },
  defaultChain: CHAIN,
  supportedChains: [CHAIN],
});

function useDark() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setDark(root.classList.contains("dark")));
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
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

/** The embedded EVM wallet Privy made, never an externally linked wallet. */
const embedded = (user: User | null) =>
  user?.linkedAccounts.find((a): a is WalletWithMetadata => a.type === "wallet" && a.chainType === "ethereum" && Boolean(a.walletClientType?.startsWith("privy")))?.address ?? null;

function Publish({ asked, onAccount }: Omit<Bridge, "appId">) {
  const { ready, authenticated, user } = usePrivy();
  const { login } = useLogin();
  const { logout } = useLogout();
  const { signMessage } = useSignMessage();
  const { signTypedData } = useSignTypedData();
  const fns = useRef({ logout, signMessage, signTypedData });
  useEffect(() => {
    fns.current = { logout, signMessage, signTypedData };
  });

  const answered = useRef(0);
  useEffect(() => {
    if (!ready || asked === answered.current) return;
    answered.current = asked;
    if (!authenticated) login();
  }, [asked, ready, authenticated, login]);

  const address = embedded(user);
  const email = user?.email?.address ?? user?.google?.email ?? user?.apple?.email ?? null;
  const handle = email ?? user?.phone?.number ?? (address ? shortAddress(address) : null);
  const account = useMemo<Account>(() => {
    if (!ready) return NOT_YET;
    return {
      ready,
      signedIn: authenticated,
      address,
      handle,
      email,
      signOut: () => void fns.current.logout(),
      signMessage: async (message) => {
        if (!address) throw new Error("No wallet yet");
        const { signature } = await fns.current.signMessage({ message }, { ...SILENT, address });
        return signature;
      },
      signTypedData: async (typedData) => {
        if (!address) throw new Error("No wallet yet");
        const types = {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
          ...typedData.types,
        };
        const { signature } = await fns.current.signTypedData(
          { domain: typedData.domain, types, primaryType: typedData.primaryType, message: plain(typedData.message) as Record<string, unknown> },
          { ...SILENT, address },
        );
        return signature as `0x${string}`;
      },
    };
  }, [ready, authenticated, address, handle, email]);
  useEffect(() => onAccount(account), [account, onAccount]);
  return null;
}
