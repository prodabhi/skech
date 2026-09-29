"use client";

import type { ReactNode } from "react";
import { armHaptic, settleHaptic } from "@/lib/feel";
import { cn } from "@/lib/utils";

/**
 * What an iPhone still buzzes for from a web page (iOS 26.5 on): a finger's
 * own click on a label with a switch in it. The game is wrapped in one, so a
 * tap that asks for a haptic gets it; a tap that does not is kept from
 * flipping the switch, and a drag never clicks. Nothing on other devices.
 */
export function HapticHost({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <label className={cn("block", className)} onClick={settleHaptic} onPointerDownCapture={armHaptic}>
      {children}
      <input aria-hidden="true" className="pointer-events-none absolute size-px opacity-0" tabIndex={-1} type="checkbox" {...{ switch: "" }} />
    </label>
  );
}
