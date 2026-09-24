"use client";

import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import { POINT_PRICES } from "@skech/core/odds";
import { Button } from "@/components/ui/button";
import { Popover, PopoverClose, PopoverDescription, PopoverPopup, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import type { Brush } from "@/lib/practice";
import { cn } from "@/lib/utils";
import feedback from "./drawing-feedback.module.css";

/**
 * The game's two settings, in the places the trading screen keeps size and
 * pace, each a button wearing its value and opening a popover, as those are.
 *
 * The pen is how wide the ink is, and so how easily the price catches it: a
 * wider pen is caught more often and pays less for it, and the map redraws
 * its multiples for the pen in hand. The amount is what one point costs,
 * picked with one tap from every price at once, so what a hit pays in
 * dollars: the chart shows those dollars, and the multiples stay as they are.
 */

export const PENS: { id: Brush; name: string; dot: number; says: string }[] = [
  { id: "fine", name: "Fine", dot: 9, says: "Higher multiples" },
  { id: "medium", name: "Medium", dot: 14, says: "Balanced" },
  { id: "wide", name: "Wide", dot: 18, says: "More coverage" },
];
export const penFor = (id: Brush) => PENS.find((p) => p.id === id) ?? PENS[1];
/** A price per dot as it is picked: $0.1, $0.5, $1, $2; no trailing zero. */
export const amountLabel = (n: number) => `$${Number(n.toFixed(2))}`;

/** The pen's nib, in the ink it draws with. */
const Dot = ({ size }: { size: number }) => <span aria-hidden="true" className="block shrink-0 rounded-full bg-brand transition-[width,height] duration-150 ease-out motion-reduce:transition-none" style={{ width: size, height: size }} />;

export function InkControls({ pen, amount, onPen, onAmount, className, fixed }: { pen: Brush; amount: number; onPen: (id: Brush) => void; onAmount: (n: number) => void; className?: string; /** The price is set for this run (paper): shown, not picked. */ fixed?: boolean }) {
  // A tapped price is the pick, and the panel closes on it.
  const [amountOpen, setAmountOpen] = useState(false);
  return (
    <div className={cn(feedback.penControls, className)}>
      <Popover>
        <PopoverTrigger render={<Button aria-label={`Pen: ${penFor(pen).name}`} className={feedback.dockButton} variant="outline" />}>
          <Dot size={penFor(pen).dot} /><span>{penFor(pen).name}</span><ChevronDownIcon className="size-3.5 text-muted-foreground" />
        </PopoverTrigger>
        <PopoverPopup side="top" sideOffset={12} className="w-56">
          <PopoverTitle>Pen size</PopoverTitle>
          <div className="mt-3 flex flex-col gap-1">
            {PENS.map(p => <PopoverClose key={p.id} render={<Button variant="ghost" className="h-12 justify-start px-3" />} onClick={() => onPen(p.id)} aria-label={`Use ${p.name} pen`}>
              <span className="flex w-6 items-center justify-center"><Dot size={p.dot} /></span><span>{p.name}</span>{pen === p.id ? <CheckIcon className="ml-auto text-primary" /> : null}
            </PopoverClose>)}
          </div>
        </PopoverPopup>
      </Popover>
      {fixed ? (
        <span aria-label={`${amountLabel(amount)} per dot`} className={cn(feedback.dockButton, "pointer-events-none inline-flex items-center rounded-full border border-border px-4")}>
          <span className="figures font-semibold">{amountLabel(amount)}</span>
        </span>
      ) : (
      <Popover onOpenChange={setAmountOpen} open={amountOpen}>
        <PopoverTrigger render={<Button aria-label={`${amountLabel(amount)} per dot`} className={feedback.dockButton} variant="outline" />}>
          <span className="figures font-semibold">{amountLabel(amount)}</span><ChevronDownIcon className="size-3.5 text-muted-foreground" />
        </PopoverTrigger>
        {/* Every price at once, a row to each: tens of cents, then dollars. Nothing to scroll past to find one. */}
        <PopoverPopup side="top" sideOffset={12} align="end" className="w-[272px]">
          <PopoverTitle>Per dot</PopoverTitle>
          <div aria-label="What per dot costs" className="mt-3 grid grid-cols-5 gap-1.5" role="radiogroup">
            {POINT_PRICES.values.map((n) => (
              <button
                aria-checked={n === amount}
                className={cn("figures h-10 rounded-[10px] font-semibold text-[13px] transition-colors", n === amount ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-accent dark:bg-accent dark:hover:bg-border")}
                key={n}
                onClick={() => {
                  onAmount(n);
                  setTimeout(() => setAmountOpen(false), 120);
                }}
                role="radio"
                type="button"
              >
                {amountLabel(n)}
              </button>
            ))}
          </div>
          <p className="mt-3 text-[12px] text-muted-foreground">A hit pays it times its multiple.</p>
        </PopoverPopup>
      </Popover>
      )}
    </div>
  );
}

const DEPOSITS = [100, 1000, 10000];

/** Practice money in: it lands in the balance at once. Beside the way in, in the app bar. */
export function DepositButton({ onDeposit, className }: { onDeposit: (amount: number) => void; className?: string }) {
  return (
    <Popover>
      <PopoverTrigger render={<Button className={cn("h-11 rounded-full border-0 bg-secondary px-[18px] font-semibold text-base sm:h-11 sm:px-[18px]", className)} variant="secondary" />}>Deposit</PopoverTrigger>
      <PopoverPopup align="end" className="w-60">
        <PopoverTitle>Add practice money</PopoverTitle>
        <PopoverDescription>It lands in your balance at once. Every point you draw is paid for from there, and every hit paid into it.</PopoverDescription>
        <div className="grid grid-cols-3 gap-1.5 pt-3">
          {DEPOSITS.map((a) => (
            <PopoverClose className="figures h-10 rounded-lg border text-sm transition-colors hover:bg-accent" key={a} onClick={() => onDeposit(a)}>
              ${a.toLocaleString("en-US")}
            </PopoverClose>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
