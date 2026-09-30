"use client";

import dynamic from "next/dynamic";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { useSignIn } from "@/components/app/auth";
import { track } from "@/lib/analytics";

/**
 * The way to money while the game plays on: tap the game without a balance
 * and this opens, signed in or not. Signed out it is Privy's sign-in;
 * signed in, the deposit sheet (deposit-modal.tsx); from the account menu,
 * the withdrawal (withdraw-sheet.tsx).
 *
 * The two sheets are always mounted, as the deposit sheet has to be to
 * open itself when a deposit lands, but their code (the QR code, the
 * camera's scanner) is not in the page's first load: each comes in its own
 * chunk once the page is up. Privy's panel is mounted by auth.tsx, likewise
 * after the page.
 *
 * Settings and How it works are the game's own sheets (ink-screen.tsx), held
 * open here so the account menu can open them too: `useGate` opens them,
 * `useGatePanels` is the game's hold on them.
 */

const DepositModal = dynamic(() => import("./deposit-modal").then((m) => m.DepositModal), { ssr: false });
const WithdrawSheet = dynamic(() => import("./withdraw-sheet").then((m) => m.WithdrawSheet), { ssr: false });

/** `"tap"`: opened because a tap on the game could not be played. Those are counted: see FOUNDERS_AFTER. */
type Gate = { openDeposit: (why?: "tap" | "short" | "account_menu") => void; openSignIn: (from?: string) => void; openWithdraw: () => void; openSettings: () => void; openHelp: () => void };
const GateCtx = createContext<Gate>({ openDeposit: () => undefined, openSignIn: () => undefined, openWithdraw: () => undefined, openSettings: () => undefined, openHelp: () => undefined });
export const useGate = () => useContext(GateCtx);

/** Whether Settings and How it works are open, apart from the gate so opening one re-renders only the game. */
type Panels = { settings: boolean; setSettings: (open: boolean) => void; help: boolean; setHelp: (open: boolean) => void };
const PanelsCtx = createContext<Panels>({ settings: false, setSettings: () => undefined, help: false, setHelp: () => undefined });
export const useGatePanels = () => useContext(PanelsCtx);

/*
  Someone who has tapped the game five times with nothing to play with and still not deposited is stuck, not
  uninterested. From then on the sheet leads with a person: a founder, on Telegram, who will get them in. The
  count lives in this browser across reloads, and resets once there is money to play with.
*/
const FOUNDERS_AFTER = 5;
const TAPS_KEY = "skech:blocked-taps";
const readTaps = () => {
  try {
    return Number(localStorage.getItem(TAPS_KEY)) || 0;
  } catch {
    return 0;
  }
};
const writeTaps = (n: number) => {
  try {
    localStorage.setItem(TAPS_KEY, String(n));
  } catch {
    /* private mode: counted for this page only */
  }
};

export function GateProvider({ children }: { children: ReactNode }) {
  const [deposit, setDeposit] = useState(false);
  const signIn = useSignIn();
  // Read once, at start: on the server there is no storage and it is 0; the sheet is closed there anyway.
  const [taps, setTaps] = useState(readTaps);
  const openDeposit = useCallback((why?: "tap" | "short" | "account_menu") => {
    track("deposit_opened", { why: why ?? "button" });
    if (why === "tap") {
      const n = readTaps() + 1;
      writeTaps(n);
      setTaps(n);
    }
    setDeposit(true);
  }, []);
  const openSignIn = useCallback((from = "button") => {
    track("sign_in_opened", { from });
    signIn();
  }, [signIn]);
  const [withdraw, setWithdraw] = useState(false);
  const openWithdraw = useCallback(() => setWithdraw(true), []);
  const [settings, setSettings] = useState(false);
  const [help, setHelp] = useState(false);
  const openSettings = useCallback(() => setSettings(true), []);
  const openHelp = useCallback(() => setHelp(true), []);
  const gate = useMemo(() => ({ openDeposit, openSignIn, openWithdraw, openSettings, openHelp }), [openDeposit, openSignIn, openWithdraw, openSettings, openHelp]);
  const panels = useMemo(() => ({ settings, setSettings, help, setHelp }), [settings, help]);
  return (
    <GateCtx.Provider value={gate}>
      <PanelsCtx.Provider value={panels}>{children}</PanelsCtx.Provider>
      <DepositModal
        onOpenChange={setDeposit}
        onPlayable={() => {
          writeTaps(0);
          setTaps(0);
        }}
        open={deposit}
        stuck={taps >= FOUNDERS_AFTER}
      />
      <WithdrawSheet onOpenChange={setWithdraw} open={withdraw} />
    </GateCtx.Provider>
  );
}
