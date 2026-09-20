"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { shortAddress } from "@/lib/market";
import { cn } from "@/lib/utils";

/**
 * Copying, in the four places that needed it.
 *
 * An address on screen is not much use: nobody retypes 42 characters, and a
 * typo in one of them sends money nowhere it can be got back from. So every
 * address the app shows is one press away from the clipboard, and says so by
 * turning into a tick.
 *
 * The clipboard is not always there. An insecure origin, an old browser and a
 * locked-down one all refuse, so every caller still prints the address to read.
 */
export function useCopy(text: string | null, hold = 1600) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), hold);
    } catch {
      // No clipboard. It is on screen to read.
    }
  };
  return { copied, copy };
}

/** The address, short, pressable, in running text or under a name. */
export function CopyAddress({ address, className, full = false }: { address: string; className?: string; full?: boolean }) {
  const { copied, copy } = useCopy(address);
  return (
    <button
      aria-label={copied ? "Address copied" : `Copy address ${address}`}
      className={cn(
        "-mx-1 flex max-w-full cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-left transition-colors hover:bg-accent hover:text-foreground",
        className,
      )}
      onClick={() => void copy()}
      type="button"
    >
      <span className={cn("figures", full ? "break-all" : "truncate")}>{full ? address : shortAddress(address)}</span>
      {copied ? <CheckIcon className="size-3 shrink-0" /> : <CopyIcon className="size-3 shrink-0" />}
    </button>
  );
}
