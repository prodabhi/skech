"use client";

import { address } from "@solana/kit";
import { ArrowUpRightIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { playerAddress } from "@skech/contracts/solana/sdk";
import { Sheet, SheetDescription, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { explorerAddress, explorerTx, NETWORK } from "@/lib/chain";
import type { ActivityMsg, Incoming } from "@/lib/relayer";
import { cn } from "@/lib/utils";
import { useChain } from "./chain-context";

/** How often the count is asked for while the sheet is open: it climbs as they play. The relayer answers one every five seconds. */
const EVERY_MS = 5_000;

/** A player's transactions on Solana, as the relayer counts them from their game account's signatures; asked for while `on`. */
export function useActivity(on: boolean): ActivityMsg | null {
  const chain = useChain();
  const [a, setA] = useState<ActivityMsg | null>(null);
  useEffect(() => {
    if (!on || !chain.player) return;
    let alive = true;
    let asking = false;
    const ask = async () => {
      if (asking) return;
      asking = true;
      const m = await chain.client.request({ type: "activity", player: chain.player }, (x: Incoming): x is ActivityMsg => x.type === "activity", 15_000);
      asking = false;
      if (alive && m) setA(m);
    };
    void ask();
    const timer = setInterval(() => void ask(), EVERY_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [on, chain.client, chain.player]);
  // Base58 is case-sensitive: the same account, exactly.
  return a && chain.player && a.player === chain.player ? a : null;
}

/** 12s ago, 4 min ago, 3 h ago, 2 d ago. */
function ago(seconds: number | null, now: number): string {
  if (seconds === null) return "just now";
  const s = Math.max(0, Math.round(now / 1000 - seconds));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/**
 * How hard they have played Solana: every transaction their play went out in,
 * counted from the chain, and the latest of them to look up. A bottom sheet
 * on a phone, a side panel on a desk.
 */
export function TransactionsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const chain = useChain();
  const a = useActivity(open);
  const cluster = chain.hello?.cluster;
  const label = chain.hello?.label ?? NETWORK.label;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 10_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [open]);
  // Their account in the game, whose history is every transaction counted here.
  const [account, setAccount] = useState<string | null>(null);
  const program = chain.hello?.program;
  useEffect(() => {
    if (!chain.player || !program) return;
    let live = true;
    void playerAddress(address(chain.player), address(program)).then((a) => live && setAccount(a), () => undefined);
    return () => {
      live = false;
    };
  }, [chain.player, program]);
  const n = (v: number | undefined) => (v ?? 0).toLocaleString("en-US");
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetPopup className="sm:max-w-md" side="right" variant="inset">
        <SheetHeader className="px-5 pt-6 sm:px-6 sm:pt-8">
          <SheetTitle className="font-bold text-xl">Your transactions</SheetTitle>
          <SheetDescription>Every piece you draw goes on {label}.</SheetDescription>
        </SheetHeader>
        <SheetPanel className="flex flex-col gap-3.5 px-5 pb-10 sm:px-6">
          <div className="flex flex-col gap-1 rounded-[18px] bg-muted px-4 pt-4 pb-4">
            <span className="text-[13px] text-muted-foreground">You spammed Solana with</span>
            <span className={cn("figures font-bold text-[44px] leading-none tracking-[-0.02em]", !a && "animate-pulse text-muted-foreground")} key={a?.txs}>
              {a ? n(a.txs) : "–"}
            </span>
            <span className="font-medium text-[15px]">{a?.txs === 1 ? "transaction" : "transactions"}</span>
            {a?.counting ? <span className="figures mt-1 text-[13px] text-muted-foreground">Still counting your history · {Math.round(a.progress * 100)}%</span> : null}
          </div>
          {a?.recent.length ? (
            <div className="flex flex-col gap-1.5">
              <span className="px-1 text-[13px] text-muted-foreground">Latest</span>
              <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-[18px] bg-muted">
                {a.recent.map((r) => (
                  <li key={r.signature}>
                    <a className="flex items-center justify-between gap-3 px-4 py-3 text-sm transition-colors hover:bg-foreground/5" href={explorerTx(r.signature, cluster)} rel="noopener noreferrer" target="_blank">
                      <span className="figures truncate">{`${r.signature.slice(0, 8)}…${r.signature.slice(-6)}`}</span>
                      <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
                        <span className="figures text-[13px]">{ago(r.time, now)}</span>
                        <ArrowUpRightIcon className="size-4" />
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {a && account ? (
            <a className="inline-flex items-center gap-1 self-start px-1 font-medium text-[15px] underline-offset-2 hover:underline" href={explorerAddress(account, cluster)} rel="noopener noreferrer" target="_blank">
              View all on Solana Explorer <ArrowUpRightIcon className="size-4" />
            </a>
          ) : null}
          <p className="px-1 text-[13px] text-muted-foreground">Counted once per transaction your play was in, read from your game account on chain.</p>
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}
