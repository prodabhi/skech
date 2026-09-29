"use client";

import { useEffect, useRef, useState } from "react";
import { hasAuth, useAccount } from "@/components/app/auth";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { leastPiece } from "@/lib/relayer";
import { useChain } from "./chain-context";
import { useGate } from "./gate";
import feedback from "./drawing-feedback.module.css";

/**
 * The way in for someone new: sign in, deposit USDC, draw. One card over the
 * chart, one step at a time, gone once there is money to draw with.
 * Without a way to sign in the app plays for practice and none of it shows.
 */

/** Whether this build plays for real money: a way to sign in. The game is the relayer's to name. */
export const forReal = hasAuth;

export type Step = "signin" | "connecting" | "deposit" | "setup" | null;

/** Where someone is on the way in. `live`: ink of theirs still out, which counts as money in play. */
export function useOnboarding(live: number): { step: Step; setupError: string | null; retrySetup: () => void } {
  const me = useAccount();
  const chain = useChain();
  const [setupError, setSetupError] = useState<string | null>(null);
  // Only once the relayer has said the balance: before that it reads zero, and the deposit sheet would open on
  // someone with money. Not enough for one piece (1¢, the least the relayer takes), with nothing in play, is
  // when to offer it: the same line the game draws for taps. It used to be the minimum deposit, a dollar, which
  // told someone with 72¢ to deposit while the game let them draw.
  const known = chain.account !== null;
  const empty = known && chain.balance < Number(leastPiece(chain.hello)) / 1e6 && live === 0;

  let step: Step = null;
  if (!forReal) step = null;
  // Not yet known is connecting, not signed out: a saved session is being read, and asking to sign in would start over.
  else if (!me.ready) step = "connecting";
  else if (!me.signedIn) step = "signin";
  else if (!chain.real || !known) step = "connecting";
  else if (empty) step = "deposit";
  else if (!chain.sessionOk) step = "setup";

  // The drawing key registers by itself, once, the moment there is money to draw with; a failure shows the card.
  const tried = useRef(false);
  useEffect(() => {
    if (step !== "setup" || tried.current || chain.registering || !chain.key) return;
    tried.current = true;
    void chain.enableSession().then((why) => why && setSetupError(why));
  }, [step, chain]);
  const retrySetup = () => {
    setSetupError(null);
    void chain.enableSession().then((why) => why && setSetupError(why));
  };
  return { step, setupError, retrySetup };
}

/**
 * Where someone is, as one quiet line over the game: the game itself stays in play. Only a failed setup needs more.
 * Signed out and connecting are the screen's own to say (ink-screen), once, in place of the game.
 */
export function Onboarding({ step, setupError, retrySetup }: ReturnType<typeof useOnboarding>) {
  const gate = useGate();
  const chain = useChain();
  if (step === null || step === "signin" || step === "connecting") return null;
  if (step === "setup" && setupError) {
    return (
      <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center px-4" role="dialog" aria-label="Finish setting up">
        <div className={cn(feedback.notice, "pointer-events-auto w-full max-w-[360px] rounded-[28px] bg-raised p-6 shadow-[var(--raised-shadow)]")}>
          <h2 className="font-semibold text-[22px] leading-tight">One last step.</h2>
          <p className="mt-1.5 text-[15px] text-muted-foreground">Let this browser place your drawings.</p>
          <Button className="mt-5 h-12 w-full rounded-full font-semibold text-base sm:h-12" disabled={chain.registering} onClick={retrySetup}>
            {chain.registering ? <><Spinner /> Getting ready…</> : "Allow"}
          </Button>
          <p className="mt-3 text-center text-sm text-destructive-foreground">That didn&rsquo;t go through. Try again.</p>
        </div>
      </div>
    );
  }
  // Nothing to draw with: the pill opens the deposit sheet (a tap on the game still does too).
  if (step === "deposit" && chain.adding === null) {
    return (
      <button className={feedback.depositPill} onClick={() => gate.openDeposit()} type="button">
        Deposit USDC to play
      </button>
    );
  }
  const busy = step === "setup" || chain.adding !== null;
  const text = step === "deposit" ? `Adding $${chain.adding!.toFixed(2)}…` : "Getting ready…";
  return (
    <div className={cn(feedback.hintPill, "flex items-center gap-2")} role="status">
      {busy ? <Spinner className="size-4" /> : null} {text}
    </div>
  );
}
