"use client";

import { type ReactElement, type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useChain } from "./chain-context";
import { money } from "@/lib/money";
import { useGate } from "./gate";

/**
 * The wallet menu: the balance, what is owed, and the two ways money moves:
 * Deposit and Withdraw, each its own sheet. Nothing here costs the player a network fee: the relayer pays it. It opens from the
 * balance on the game screen (`render` and `children` make that the
 * trigger), so the balance is shown once.
 */
export function WalletButton({ className, render, children }: { className?: string; render?: ReactElement; children?: ReactNode }) {
  const chain = useChain();
  const [open, setOpen] = useState(false);
  const gate = useGate();
  const owed = chain.account ? Number(chain.account.owed) / 1e6 : 0;
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger render={render ?? <Button className={cn("h-11 rounded-full border-0 bg-secondary px-[18px] font-semibold text-base sm:h-11 sm:px-[18px]", className)} variant="secondary" />}>
        {children ?? (chain.connected ? money(chain.balance) : "Connecting…")}
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-[min(360px,calc(100vw-24px))]">
        <PopoverTitle className="font-normal text-[13px] text-muted-foreground">Your balance</PopoverTitle>
        <p className="figures mt-0.5 font-bold text-[32px] leading-tight">{money(chain.balance)}</p>
        {owed > 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">
            + <span className="figures text-foreground">{money(owed)}</span> owed to you, paid as other players lose
          </p>
        ) : null}
        <div className="mt-4 grid grid-cols-2 gap-2">
          <Button className="h-11 rounded-full font-semibold text-[15px] sm:h-11" onClick={() => { setOpen(false); gate.openDeposit(); }}>
            Deposit
          </Button>
          <Button className="h-11 rounded-full font-semibold text-[15px] sm:h-11" disabled={chain.balance <= 0} onClick={() => { setOpen(false); gate.openWithdraw(); }} variant="secondary">
            Withdraw
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
