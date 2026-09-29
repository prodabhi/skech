"use client";

import { ArrowLeftIcon, ArrowUpRightIcon, CheckIcon, ClipboardPasteIcon, ScanLineIcon, SendIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { explorerTx, NETWORK } from "@/lib/chain";
import { type Destination, parseDestination } from "@/lib/destination";
import { feel, haptic } from "@/lib/feel";
import { shortAddress } from "@/lib/market";
import { cents, money } from "@/lib/money";
import { cn } from "@/lib/utils";
import { useChain } from "./chain-context";
import { FOUNDER } from "./founders";
import { QrScanner } from "./qr-scanner";

/*
  Money out, in four steps, one sheet:
    form    how much (typed, or a quarter, a half, all of it) and where (typed, pasted or scanned)
    scan    the camera, reading a wallet's QR code; an amount in the code fills the amount
    review  exactly what will happen, nothing moved yet; one button sends it
    done    it is on its way, with the transaction; thanks, feedback on Telegram, and back to the game
  Every refusal is said where it happens, in words a player can act on. Closing the sheet while it sends does
  not stop it: a toast says how it ended.
*/

type Step = "form" | "scan" | "review" | "done";

/** Why a withdrawal failed, said so a player can do something about it. */
function plain(why: string): string {
  if (/insufficient|exceeds balance|balance/i.test(why)) return "Not enough in your balance. Nothing moved.";
  if (/sign|reject|denied|cancel/i.test(why)) return "Not signed. Nothing moved.";
  if (/No answer/i.test(why)) return "No answer yet. Check your balance before trying again.";
  return "That didn't go through. Nothing moved, try again.";
}

export function WithdrawSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const chain = useChain();
  const available = Math.max(0, chain.balance);
  const [step, setStep] = useState<Step>("form");
  const [amountText, setAmountText] = useState("");
  const [all, setAll] = useState(false);
  const [toText, setToText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ amount: number; to: string; tx: string } | null>(null);
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  // What was typed, as money: at most two decimals. "All" sends the balance to the micro-dollar, leaving no dust.
  const typed = Number(amountText);
  const amount = all ? available : Number.isFinite(typed) ? typed : 0;
  const amountError = amountText === "" && !all ? null : amount <= 0 ? "Enter an amount" : amount < 0.01 ? "At least $0.01" : amount > available + 1e-9 ? "More than your balance" : null;

  const label = chain.hello?.label ?? NETWORK.label;
  const usdc = chain.hello?.usdc ?? NETWORK.usdc;
  const parsed = toText.trim() ? parseDestination(toText, usdc, label) : null;
  const dest: Destination | null = parsed && "address" in parsed ? parsed : null;
  // The game's own accounts take no USDC a player sends: base58, so compared exactly.
  const contracts = [chain.hello?.program, chain.hello?.game, chain.hello?.lookupTable, usdc].filter(Boolean);
  const toError = !parsed
    ? null
    : "error" in parsed
      ? parsed.error
      : chain.player === dest!.address
        ? "That's your deposit address: it would land straight back in your balance."
        : contracts.includes(dest!.address)
          ? "That's a contract, not a wallet. Money sent there is lost."
          : null;
  const ready = !amountError && amount > 0 && dest !== null && !toError;

  const reset = () => {
    setStep("form");
    setAmountText("");
    setAll(false);
    setToText("");
    setError(null);
    setSent(null);
  };
  const close = (next: boolean) => {
    onOpenChange(next);
  };

  const typeAmount = (raw: string) => {
    // Digits and one point, two decimals at most: what a keyboard of money should allow.
    const clean = raw.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");
    const [whole, frac] = clean.split(".");
    setAll(false);
    setAmountText(frac === undefined ? whole.slice(0, 7) : `${whole.slice(0, 7)}.${frac.slice(0, 2)}`);
  };
  const share = (part: number) => {
    haptic("tick");
    if (part === 1) {
      setAll(true);
      setAmountText(String(Math.floor(available * 100) / 100));
    } else {
      setAll(false);
      setAmountText(String(Math.floor(available * part * 100) / 100));
    }
  };
  const take = (text: string) => {
    setToText(text.trim());
    const d = parseDestination(text, usdc, label);
    // A code that names an amount fills it in, unless one is already typed.
    if ("address" in d && d.amount && !amountText) {
      setAll(false);
      setAmountText(String(Math.min(d.amount, Math.floor(available * 100) / 100)));
    }
  };
  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) take(text);
    } catch {
      setError("Couldn't read the clipboard. Long-press the field to paste.");
    }
  };

  const send = async () => {
    if (!ready || busy || !dest) return;
    setBusy(true);
    setError(null);
    const value = all ? available : cents(amount);
    const r = await chain.withdraw(value, dest.address);
    setBusy(false);
    if ("why" in r) {
      if (!openRef.current) toastManager.add({ title: "Withdrawal didn't go through", description: plain(r.why), type: "error" });
      return setError(plain(r.why));
    }
    setSent({ amount: value, to: dest.address, tx: r.tx });
    feel("win", { tier: 1 });
    if (!openRef.current) toastManager.add({ title: `${money(value)} is on its way`, description: `to ${shortAddress(dest.address)}`, type: "success" });
    setStep("done");
  };

  return (
    <Dialog onOpenChange={close} onOpenChangeComplete={(isOpen) => !isOpen && !busy && reset()} open={open}>
      <DialogPopup
        className="gap-[18px] rounded-[28px] border-border bg-raised p-7 sm:max-w-[440px] max-sm:gap-4 max-sm:rounded-t-[28px] max-sm:px-5 max-sm:pt-2 max-sm:pb-[max(28px,env(safe-area-inset-bottom))]"
        showCloseButton={false}
      >
        <div aria-hidden="true" className="h-[5px] w-9 self-center rounded-full bg-faint sm:hidden" />
        {step === "done" && sent ? (
          <Done balance={available} cluster={chain.hello?.cluster} onPlay={() => close(false)} sent={sent} />
        ) : (
          <>
            <div className="flex items-center gap-2">
              {step === "review" || step === "scan" ? (
                <IconButton disabled={busy} label="Back" onClick={() => (setError(null), setStep("form"))}>
                  <ArrowLeftIcon className="size-[17px]" strokeWidth={2.2} />
                </IconButton>
              ) : null}
              <div className="flex min-w-0 flex-1 flex-col">
                <DialogTitle className="font-semibold text-[24px] leading-tight tracking-[-0.02em]">{step === "scan" ? "Scan an address" : step === "review" ? "Check and send" : "Withdraw"}</DialogTitle>
                <DialogDescription className="text-[14px] text-muted-foreground">USDC on {label}</DialogDescription>
              </div>
              <IconButton label="Close" onClick={() => close(false)}>
                <XIcon className="size-[15px]" strokeWidth={2.4} />
              </IconButton>
            </div>

            {step === "scan" ? (
              <QrScanner
                onClose={() => setStep("form")}
                onResult={(text) => {
                  take(text);
                  setStep("form");
                }}
              />
            ) : step === "review" && dest ? (
              <Review address={dest.address} label={label} after={Math.max(0, available - (all ? available : amount))} amount={all ? available : amount} busy={busy} error={error} onSend={() => void send()} />
            ) : (
              <>
                {/* How much: typed big, or a share of the balance. */}
                <div className="flex flex-col items-center gap-3 pt-1">
                  <label className="flex items-baseline justify-center font-bold text-[44px] leading-none tracking-[-0.03em]">
                    <span className={cn(amountText ? "text-foreground" : "text-faint")}>$</span>
                    <input
                      aria-label="Amount to withdraw"
                      autoComplete="off"
                      className="figures w-[6ch] min-w-[1ch] bg-transparent text-center outline-none placeholder:text-faint"
                      inputMode="decimal"
                      onChange={(e) => typeAmount(e.target.value)}
                      placeholder="0"
                      style={{ width: `${Math.max(1, (amountText || "0").length) + 0.4}ch` }}
                      value={amountText}
                    />
                  </label>
                  <p className={cn("figures min-h-5 text-[14px]", amountError ? "text-destructive-foreground" : "text-muted-foreground")}>{amountError ?? `Available ${money(available)}`}</p>
                  <div className="flex w-full gap-2">
                    {[
                      { label: "25%", part: 0.25 },
                      { label: "50%", part: 0.5 },
                      { label: "Max", part: 1 },
                    ].map((c) => (
                      <button
                        className={cn("h-10 flex-1 rounded-full font-semibold text-[15px] transition-colors active:scale-[.97] disabled:opacity-40", c.part === 1 && all ? "bg-foreground text-background" : "bg-foreground/[0.06] hover:bg-foreground/[0.1]")}
                        disabled={available <= 0}
                        key={c.label}
                        onClick={() => share(c.part)}
                        type="button"
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Where: typed, pasted or scanned. */}
                <div className="flex flex-col gap-2">
                  <div className={cn("flex items-center gap-1.5 rounded-[18px] bg-foreground/[0.06] py-1.5 pr-1.5 pl-4 ring-inset transition-shadow focus-within:ring-2 focus-within:ring-ring", toError && "ring-2 ring-destructive/50")}>
                    <input
                      aria-invalid={Boolean(toError)}
                      aria-label="Address to send to"
                      autoCapitalize="off"
                      autoComplete="off"
                      autoCorrect="off"
                      className="figures h-10 min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-muted-foreground"
                      onChange={(e) => take(e.target.value)}
                      placeholder="Solana address"
                      spellCheck={false}
                      value={toText}
                    />
                    {toText ? (
                      <IconButton label="Clear address" onClick={() => setToText("")} small>
                        <XIcon className="size-[14px]" strokeWidth={2.4} />
                      </IconButton>
                    ) : (
                      <button className="flex h-10 items-center gap-1.5 rounded-full px-3 font-semibold text-[14px] transition-colors hover:bg-foreground/[0.08]" onClick={() => void paste()} type="button">
                        <ClipboardPasteIcon className="size-[16px]" /> Paste
                      </button>
                    )}
                    <button aria-label="Scan a QR code" className="flex size-10 items-center justify-center rounded-full bg-foreground text-background transition-transform active:scale-95" onClick={() => (setError(null), setStep("scan"))} type="button">
                      <ScanLineIcon className="size-[18px]" strokeWidth={2.2} />
                    </button>
                  </div>
                  <p className={cn("min-h-5 px-1 text-[13px] leading-snug", toError || error ? "text-destructive-foreground" : "text-muted-foreground")}>
                    {toError ?? error ?? (dest ? `Sending to ${shortAddress(dest.address)} on ${label}` : `Only an address on ${label}. Anything else may be lost.`)}
                  </p>
                </div>

                <PrimaryButton disabled={!ready} onClick={() => (setError(null), setStep("review"))}>
                  {ready ? `Review ${money(all ? available : amount)}` : !amountText && !all ? "Enter an amount" : !dest ? "Add an address" : "Review"}
                </PrimaryButton>
              </>
            )}
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}

function Review({ amount, address, label, after, busy, error, onSend }: { amount: number; address: string; label: string; after: number; busy: boolean; error: string | null; onSend: () => void }) {
  return (
    <div className="flex flex-col gap-4 motion-safe:animate-[row-in_260ms_cubic-bezier(.2,.8,.2,1)_both]">
      <div className="flex flex-col items-center gap-1 pt-1 text-center">
        <span className="figures font-bold text-[40px] leading-none tracking-[-0.03em]">{money(amount)}</span>
        <span className="text-[14px] text-muted-foreground">to</span>
        {/* The whole address, to check against the wallet it came from. */}
        <span className="figures max-w-full break-all rounded-[14px] bg-foreground/[0.06] px-3 py-2 text-[14px] leading-snug">{address}</span>
      </div>
      <dl className="divide-y divide-border rounded-[18px] border border-border px-4">
        <Row label="Network">{label}</Row>
        <Row label="Fee">Free</Row>
        <Row label="Arrives in">A few seconds</Row>
        <Row label="Left to play with">{money(after)}</Row>
      </dl>
      <PrimaryButton busy={busy} disabled={busy} onClick={onSend}>
        {busy ? "Sending…" : `Withdraw ${money(amount)}`}
      </PrimaryButton>
      <p aria-live="polite" className={cn("-mt-1 min-h-5 text-center text-[13px]", error ? "text-destructive-foreground" : "text-muted-foreground")}>
        {error ?? "It can't be undone once sent."}
      </p>
    </div>
  );
}

/** Sent: what, where, the proof, and then the people behind the game: thanks, feedback, come back. */
function Done({ sent, cluster, balance, onPlay }: { sent: { amount: number; to: string; tx: string }; cluster?: string; balance: number; onPlay: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 pt-2 text-center">
      <span className="flex size-16 items-center justify-center rounded-full bg-success/15 text-success-foreground motion-safe:animate-[landed-pop_560ms_cubic-bezier(.2,1.6,.35,1)_both]">
        <CheckIcon className="size-8 motion-safe:animate-[landed-tick_420ms_ease-out_220ms_both]" strokeWidth={2.6} />
      </span>
      <div className="flex flex-col gap-1">
        <DialogTitle className="font-semibold text-[24px] leading-tight tracking-[-0.02em]">{money(sent.amount)} is on its way</DialogTitle>
        <DialogDescription className="text-[14px] text-muted-foreground">
          to <span className="figures text-foreground">{shortAddress(sent.to)}</span>
          {sent.tx ? (
            <>
              {" · "}
              <a className="inline-flex items-center gap-0.5 font-medium text-foreground underline-offset-2 hover:underline" href={explorerTx(sent.tx, cluster)} rel="noopener noreferrer" target="_blank">
                View transaction <ArrowUpRightIcon className="size-3.5" />
              </a>
            </>
          ) : null}
        </DialogDescription>
      </div>

      <div className="flex w-full flex-col gap-3 rounded-[20px] border border-foreground/10 bg-foreground/[0.04] p-4 text-left motion-safe:animate-[row-in_380ms_cubic-bezier(.2,.8,.2,1)_300ms_both]">
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- a 19 KB local photo */}
          <img alt={FOUNDER.name} className="size-11 shrink-0 rounded-full object-cover" height={44} src={FOUNDER.photo} width={44} />
          <div className="flex min-w-0 flex-col">
            <p className="font-semibold text-[16px] leading-tight">Hope you enjoyed skech</p>
            <p className="text-[13px] text-muted-foreground leading-snug">Tell us what to make better. {FOUNDER.name} reads every message.</p>
          </div>
        </div>
        <a
          className="flex h-11 items-center justify-center gap-2 rounded-full bg-[#2AABEE] font-semibold text-[15px] text-white transition-transform hover:brightness-105 active:scale-[.98]"
          href={FOUNDER.url}
          rel="noopener noreferrer"
          target="_blank"
        >
          <SendIcon className="size-4" strokeWidth={2.2} /> Share feedback on Telegram
        </a>
      </div>

      <div className="flex w-full flex-col gap-2 motion-safe:animate-[row-in_380ms_cubic-bezier(.2,.8,.2,1)_420ms_both]">
        <PrimaryButton autoFocus onClick={onPlay}>
          {balance >= 0.1 ? `Keep playing with ${money(balance)}` : "Back to the game"}
        </PrimaryButton>
        <p className="text-[13px] text-muted-foreground">{balance >= 0.1 ? "Bitcoin never closes." : "Come back anytime. Bitcoin never closes, and neither do we."}</p>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-4 py-2.5 text-[15px]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="figures font-medium">{children}</dd>
    </div>
  );
}

function PrimaryButton({ children, disabled, busy, onClick, autoFocus }: { children: ReactNode; disabled?: boolean; busy?: boolean; onClick: () => void; autoFocus?: boolean }) {
  return (
    <button
      autoFocus={autoFocus}
      className="flex min-h-[52px] w-full items-center justify-center gap-2 rounded-full bg-foreground font-semibold text-[17px] text-background transition-[transform,opacity] active:scale-[.98] disabled:opacity-35 disabled:active:scale-100"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {busy ? <Spinner className="size-4" /> : null}
      {children}
    </button>
  );
}

function IconButton({ label, onClick, children, disabled, small }: { label: string; onClick: () => void; children: ReactNode; disabled?: boolean; small?: boolean }) {
  return (
    <button
      aria-label={label}
      className={cn(
        "relative flex shrink-0 items-center justify-center rounded-full bg-foreground/[0.06] text-muted-foreground transition-colors before:absolute before:-inset-1.5 before:content-[''] hover:text-foreground disabled:opacity-40",
        small ? "size-7" : "size-8",
      )}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}
