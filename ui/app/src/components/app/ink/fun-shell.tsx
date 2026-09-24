"use client";

import { AppBar } from "@/components/app/app-bar";
import { useAccount } from "@/components/app/auth";
import { cents, setPractice } from "@/lib/practice";
import { ChainProvider, useChain } from "./chain-context";
import { DepositButton } from "./ink-controls";
import { InkIntro } from "./ink-intro";
import { InkScreen } from "./ink-screen";
import { forReal } from "./onboarding";
import { GateProvider, useGate } from "./gate";
import { SocialProvider } from "./social-provider";
import { Button } from "@/components/ui/button";

/**
 * The page around the game: the app's own bar over the game, the same shell
 * the trading screen sits in, held to the screen's height so a finger
 * drawing never drags the page instead. The bar holds the way to money:
 * Deposit once signed in, or practice money without a game. The balance
 * itself is on the game screen, once. The community (social-provider.tsx)
 * wraps it all: the bar opens it, and the chart draws everyone's ink.
 */
export function FunShell() {
  return (
    <ChainProvider>
      <GateProvider>
      <SocialProvider>
      <div className="fixed inset-0 flex h-dvh w-full flex-col overflow-hidden overscroll-none bg-background [-webkit-touch-callout:none]">
        <div className="absolute inset-x-0 top-0 z-30 [&>header]:border-0 [&>header]:bg-transparent [&>header]:px-4 sm:[&>header]:px-6">
          <AppBar lead={<Money />} />
        </div>
        <main className="absolute inset-0 flex min-h-0 w-full flex-col overflow-hidden">
          <InkScreen />
        </main>
        <InkIntro />
      </div>
      </SocialProvider>
      </GateProvider>
    </ChainProvider>
  );
}

/** Deposit, playing for real and signed in; practice money's own deposit without a game. */
function Money() {
  const chain = useChain();
  const gate = useGate();
  const me = useAccount();
  if (forReal) {
    // Signed out there is nothing to deposit into: the one thing to do is "Sign in to play", in the middle.
    if (!me.signedIn) return null;
    return (
      <div className="flex items-center gap-2">
        <Button className="h-11 rounded-full border-0 bg-secondary px-[18px] font-semibold text-base sm:h-11 sm:px-[18px]" onClick={() => (chain.player ? gate.openDeposit() : undefined)} variant="secondary">
          Deposit
        </Button>
      </div>
    );
  }
  return <DepositButton onDeposit={(amount) => setPractice((st) => ({ balance: cents(st.balance + amount) }))} />;
}
