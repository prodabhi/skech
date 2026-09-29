"use client";

import { PRIVATE_LINK, track } from "@/lib/analytics";
import { ArrowUpRightIcon, CheckIcon, SendIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { encode } from "uqr";
import { useAccount } from "@/components/app/auth";
import { useCopy } from "@/components/app/copy";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { shortAddress } from "@/lib/market";
import { money } from "@/lib/money";
import { cn } from "@/lib/utils";
import { UsdcMark } from "@/components/app/marks";
import { MIN_DEPOSIT, useChain } from "./chain-context";
import { feel } from "@/lib/feel";
import { FOUNDER, helpLink } from "./founders";
import { NETWORK } from "@/lib/chain";

/**
 * The deposit sheet from the design canvas ("Send USDC"): a QR of the
 * player's address, the address to copy, the network, how fast and how
 * little. USDC that lands there moves into the balance by itself, and the
 * sheet closes when it has. Opened through the gate (gate.tsx).
 */
export function DepositModal({ open, onOpenChange, stuck = false, onPlayable }: { open: boolean; onOpenChange: (open: boolean) => void; stuck?: boolean; onPlayable?: () => void }) {
  const chain = useChain();
  // Money to play with: nobody is stuck any more.
  const playable = chain.account !== null && chain.balance >= MIN_DEPOSIT;
  useEffect(() => {
    if (playable && stuck) onPlayable?.();
  }, [playable, stuck, onPlayable]);
  const address = chain.player;
  // The relayer's word on the network, once it has spoken: what the game is actually on.
  const label = chain.hello?.label ?? NETWORK.label;
  const faucet = chain.hello ? chain.hello.faucet : NETWORK.faucet;
  const { copied, copy } = useCopy(address);
  // The deposit this sheet is celebrating: the last one to land, of at least the minimum, until it is dismissed.
  const landed = chain.landed;
  const [dismissed, setDismissed] = useState<number | null>(landed?.at ?? null);
  const done = landed && landed.at !== dismissed && landed.amount >= MIN_DEPOSIT ? landed.amount : null;
  useEffect(() => {
    if (done !== null && !open) onOpenChange(true);
  }, [done, open, onOpenChange]);
  /*
    Closing from the celebration marks it seen at once, which would swap the sheet back to "Send USDC" while
    its close animation is still playing: the deposit screen flashing up after "Start playing". So what was on
    screen is held until the sheet has finished closing.
  */
  const [held, setHeld] = useState<number | null>(null);
  const close = (next: boolean) => {
    if (!next && done !== null) setHeld(done);
    onOpenChange(next);
    if (!next && landed) setDismissed(landed.at);
  };
  const celebrating = done ?? held;

  return (
    <Dialog onOpenChange={close} onOpenChangeComplete={() => setHeld(null)} open={open}>
      <DialogPopup
        // Taller than a phone's screen with the faucet and the button: it scrolls, within what is visible
        // (dvh, not vh, so the browser's own bars do not hide the bottom), and tightens on a short screen.
        className="gap-[18px] overflow-y-auto overscroll-contain rounded-[28px] border-border bg-raised p-7 sm:max-w-[480px] max-sm:max-h-[calc(100dvh-12px)] max-sm:gap-[14px] [@media(max-height:720px)]:max-sm:gap-[10px] max-sm:rounded-t-[28px] max-sm:px-5 max-sm:pt-2 max-sm:pb-[max(24px,env(safe-area-inset-bottom))]"
        showCloseButton={false}
      >
        <div aria-hidden="true" className="h-[5px] w-9 self-center rounded-full bg-faint sm:hidden" />
        {celebrating !== null ? (
          <Landed amount={celebrating} balance={chain.balance} onStart={() => close(false)} />
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-3">
                <DialogTitle className="font-semibold text-[26px] leading-[1.15] tracking-[-0.02em]">Send USDC</DialogTitle>
                {/* A person, one tap away: beside the close button, so the sheet is no taller for it. */}
                <div className="flex shrink-0 items-center gap-2">
                  <Founders nudge={stuck && !playable} />
                  <CloseButton onClick={() => close(false)} />
                </div>
              </div>
              <DialogDescription className="text-[15px] text-muted-foreground leading-[1.4]">{`Only send USDC on ${label}. Anything else may be lost.`}</DialogDescription>
            </div>
            {address ? (
              <>
                <AddressQR address={address} className="self-center" />
                {/* A soft card that reads on light and dark alike, the address large, one solid Copy pill. */}
                <div className="flex items-center gap-3 rounded-[20px] bg-foreground/[0.06] py-3.5 pr-3.5 pl-5">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-[15px] text-muted-foreground leading-snug">Your skech address</span>
                    <span className="figures truncate font-medium text-[17px] leading-snug">{shortAddress(address)}</span>
                  </span>
                  <button className="flex h-11 min-w-[88px] shrink-0 items-center justify-center gap-1.5 rounded-full bg-foreground px-5 font-semibold text-[17px] text-background transition-transform active:scale-95" onClick={() => void copy()} type="button">
                    {copied ? <CheckIcon className="size-[18px]" strokeWidth={2.6} /> : null}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                {/* The terms, as a statement: one list, label left, value right. The network is under the title and
                    the timing in the waiting line, so the sheet fits a phone's screen without scrolling. */}
                <dl className="divide-y divide-border rounded-[18px] border border-border px-4">
                  <Term label="Your balance">
                    <span className="figures font-semibold">{money(chain.balance)}</span>
                  </Term>
                  <Term label="Minimum">${MIN_DEPOSIT.toFixed(2)}</Term>
                </dl>
                {faucet ? <Faucet href={faucet} /> : null}
                {chain.adding === null && chain.balance >= MIN_DEPOSIT ? (
                  // Already enough to play: the sheet is for topping up, and says so, with the way back to the game.
                  <button className="flex min-h-[54px] w-full items-center justify-center rounded-full bg-foreground font-semibold text-[17px] text-background transition-transform active:scale-[.98]" onClick={() => close(false)} type="button">
                    Play with {money(chain.balance)}
                  </button>
                ) : (
                  <p aria-live="polite" className="flex min-h-5 items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Spinner className="size-3.5" />
                    {chain.adding !== null ? `Adding ${money(chain.adding)} to your balance…` : "Waiting for USDC. It lands in your balance in a few seconds."}
                  </p>
                )}
              </>
            ) : (
              <p className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Spinner className="size-4" /> Getting your address…
              </p>
            )}
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}

function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    // 32px to look at, 44px to hit: the invisible ring around it takes the thumb.
    <button aria-label="Close" className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/[0.06] text-muted-foreground transition-colors before:absolute before:-inset-1.5 before:content-[''] hover:text-foreground" onClick={onClick} type="button">
      <XIcon className="size-[15px]" strokeWidth={2.4} />
    </button>
  );
}

function Term({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-4 py-3 text-[15px] max-sm:min-h-11 max-sm:py-2.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex items-center gap-2 font-medium">{children}</dd>
    </div>
  );
}

/** The deposit landed: how much, what the balance is now, and the way back to the game. */
function Landed({ amount, balance, onStart }: { amount: number; balance: number; onStart: () => void }) {
  // Money in is the best news the app has: a till and a bright chord, felt as well as heard.
  useEffect(() => feel("cash"), []);
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      {/*
        The landing page's closing scene: the pen drawing a line up to a winning candle. It is drawn in, left to
        right, as the pen would draw it, then floats; sparkles pop around it.
      */}
      <div aria-hidden="true" className="relative -mx-2 w-[calc(100%+16px)] pt-2">
        {/* eslint-disable-next-line @next/next/no-img-element -- one local illustration, sized by its box */}
        <img
          alt=""
          className="w-full select-none motion-safe:animate-[scene-draw_1100ms_cubic-bezier(.35,.6,.2,1)_both,scene-float_3.2s_ease-in-out_1.2s_infinite]"
          draggable={false}
          height={374}
          src="/illo/skech-scene.png"
          width={900}
        />
        {[
          { left: "8%", top: "22%", delay: 700, size: 10 },
          { left: "62%", top: "4%", delay: 950, size: 14 },
          { left: "88%", top: "30%", delay: 1150, size: 9 },
        ].map((sp) => (
          <span
            className="absolute text-[#f5c451] motion-safe:animate-[sparkle_900ms_cubic-bezier(.2,1.6,.4,1)_both]"
            key={sp.left}
            style={{ left: sp.left, top: sp.top, fontSize: sp.size, animationDelay: `${sp.delay}ms` }}
          >
            ✦
          </span>
        ))}
      </div>
      <span className="figures rounded-full bg-success/15 px-3.5 py-1 font-bold text-[15px] text-success-foreground motion-safe:animate-[landed-pop_560ms_cubic-bezier(.2,1.6,.35,1)_600ms_both]">
        +{money(amount)} added
      </span>
      <div className="flex flex-col gap-1.5 motion-safe:animate-[row-in_420ms_cubic-bezier(.2,.8,.2,1)_750ms_both]">
        <DialogTitle className="font-semibold text-[26px] leading-[1.15] tracking-[-0.02em]">You&rsquo;re in. Now skech the trade.</DialogTitle>
        <DialogDescription className="text-[15px] text-muted-foreground">
          Draw where Bitcoin goes next. Your balance is <span className="figures font-medium text-foreground">{money(balance)}</span>.
        </DialogDescription>
      </div>
      <button
        autoFocus
        className="mt-1 flex min-h-[54px] w-full items-center justify-center rounded-full bg-foreground font-semibold text-[17px] text-background transition-transform active:scale-[.98] motion-safe:animate-[row-in_420ms_cubic-bezier(.2,.8,.2,1)_880ms_both]"
        onClick={onStart}
        type="button"
      >
        Start skeching
      </button>
    </div>
  );
}

/**
 * The address as a QR code, drawn as the canvas draws it: round-cornered dots on white, with USDC's mark in the
 * middle (what to send; the network is named beside it). Error correction is at its highest, so the mark still scans.
 * Always black on white, dark mode or not: that is what cameras read.
 */
function AddressQR({ address, className }: { address: string; className?: string }) {
  const { data, size } = useMemo(() => encode(address, { ecc: "H", border: 0 }), [address]);
  const box = 175;
  const pitch = box / size;
  const dot = pitch * 0.86;
  const mid = box / 2;
  // The clear circle the mark sits in, in the box's units.
  const clearR = 18;
  const clear = (x: number, y: number) => Math.hypot(x - mid, y - mid) < clearR;
  const dots: ReactNode[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!data[y][x]) continue;
      const cx = x * pitch + pitch / 2;
      const cy = y * pitch + pitch / 2;
      if (clear(cx, cy)) continue;
      dots.push(<rect fill="#000" height={dot} key={`${x}:${y}`} rx={dot * 0.33} width={dot} x={cx - dot / 2} y={cy - dot / 2} />);
    }
  }
  return (
    <div className={cn("relative size-[203px] shrink-0 [@media(max-height:800px)]:size-[160px] [@media(max-height:720px)]:size-[128px]!", className)}>
      <svg aria-label={`QR code for ${address}`} height="100%" role="img" viewBox={`-14 -14 ${box + 28} ${box + 28}`} width="100%">
        <rect fill="#FFFFFF" height={box + 28} rx={18} width={box + 28} x={-14} y={-14} />
        {dots}
      </svg>
      <div aria-hidden="true" className="absolute inset-0 flex items-center justify-center">
        <UsdcMark className="size-[34px] rounded-full ring-[3px] ring-white" />
      </div>
    </div>
  );
}

/**
 * Testnet only: USDC here is free, and this is where it comes from. Circle's faucet asks for the network and
 * the address, so the line says which network to pick; the address is one Copy away, just above.
 */
function Faucet({ href }: { href: string }) {
  return (
    <a
      className="flex items-center gap-3 rounded-[20px] bg-foreground/[0.06] px-5 py-3 outline-none transition-colors hover:bg-foreground/[0.1] focus-visible:ring-2 focus-visible:ring-ring"
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      <UsdcMark className="size-7 shrink-0" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-semibold text-[15px]">Get free test USDC</span>
        <span className="text-[13px] text-muted-foreground">Pick Solana Devnet, paste address</span>
      </span>
      <ArrowUpRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
    </a>
  );
}

/**
 * A person instead of a form: a founder's face beside the close button, and
 * behind it a promise of a few minutes and one button straight into a
 * Telegram chat. In a popover, not in the sheet, so the sheet stays short
 * enough for a phone. For someone who has been stuck here before it says
 * "Help" as well as showing the face.
 */
function Founders({ nudge }: { nudge: boolean }) {
  const me = useAccount();
  // A phone number is the handle when there is no email; it is only sent if they send the message.
  const href = helpLink({ email: me.email, phone: me.email ? null : me.handle?.startsWith("+") ? me.handle : null, address: me.address });
  return (
    <Popover onOpenChange={(open) => open && track("founders_opened", { stuck: nudge })}>
      <PopoverTrigger
        aria-label={`Talk to ${FOUNDER.name}, a founder`}
        render={<button className="flex h-10 shrink-0 items-center gap-2 rounded-full bg-foreground/[0.06] pr-3.5 pl-1 font-semibold text-[15px] transition-transform hover:bg-foreground/10 active:scale-95" type="button" />}
      >
        <span className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element -- a 19 KB local photo; the optimiser adds nothing here */}
          <img alt="" className="size-8 rounded-full object-cover" height={32} src={FOUNDER.photo} width={32} />
          <span aria-hidden="true" className="absolute right-0 bottom-0 size-2.5 rounded-full bg-success-foreground ring-2 ring-raised" />
        </span>
        Help
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-[min(340px,calc(100vw-32px))]" positionerClassName="z-[60]" sideOffset={8}>
        <div className="flex flex-col gap-3.5">
          <div className="flex items-center gap-3.5">
            <span className="relative shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element -- a 19 KB local photo; the optimiser adds nothing here */}
              <img alt={FOUNDER.name} className="size-14 rounded-full object-cover ring-2 ring-background" height={56} src={FOUNDER.photo} width={56} />
              <span aria-hidden="true" className="absolute right-0 bottom-0 size-3.5 rounded-full bg-success-foreground ring-2 ring-background" title="Online" />
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="font-semibold text-[17px] leading-tight">Talk to the founders</p>
              <p className="text-[14px] text-muted-foreground leading-snug">Get onboarded personally. {FOUNDER.name} will set you up in a few minutes.</p>
            </div>
          </div>
          <a
            className={cn("flex h-12 items-center justify-center gap-2 rounded-full bg-[#2AABEE] font-semibold text-[16px] text-white outline-none transition-transform hover:brightness-105 focus-visible:ring-2 focus-visible:ring-ring active:scale-[.98]", PRIVATE_LINK)}
            href={href}
            onClick={() => track("founders_messaged", { stuck: nudge, with_email: Boolean(me.email) })}
            rel="noopener noreferrer"
            target="_blank"
          >
            <SendIcon className="size-[18px]" strokeWidth={2.2} />
            Message @{FOUNDER.handle} on Telegram
          </a>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
