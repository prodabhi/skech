import { isAddress } from "@solana/kit";
import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import { ArrowLeftIcon, ArrowUpRightIcon, CheckIcon, ClipboardPasteIcon, ScanLineIcon, SendIcon, XIcon } from "@/components/ui/icons";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Alert, Animated, Linking, Pressable, Text, TextInput, View } from "react-native";
import { useAccount } from "@/components/app/auth";
import { useChain } from "@/components/app/ink/chain-context";
import { Button, Sheet, Spinner, useColors } from "@/components/ui";
import { feel, haptic } from "@/lib/feel";
import { shortAddress } from "@/lib/market";
import { cents, money } from "@/lib/money";
import { FOUNDER, FOUNDER_PHOTO } from "./deposit-sheet";
import { QrScanner } from "./qr-scanner";

/*
  Money out, in four steps, one sheet, as on the web (ui/app/src/components/app/ink/withdraw-sheet.tsx):
    form    how much (typed, or a quarter, a half, all of it) and where (typed, pasted or scanned)
    scan    the camera, reading a wallet's QR code; an amount in the code fills the amount
    review  exactly what will happen, nothing moved yet; one button sends it
    done    it is on its way, with the transaction; thanks, feedback on Telegram, and back to the game
  Every refusal is said where it happens, in words a player can act on. Closing the sheet while it sends does
  not stop it: an alert says how it ended.
*/

type Step = "form" | "scan" | "review" | "done";
type Destination = { address: string; amount?: number };
const tabular = { fontVariant: ["tabular-nums" as const] };

/** Why a withdrawal failed, said so a player can do something about it. */
function plain(why: string): string {
  if (/insufficient|exceeds balance|balance/i.test(why)) return "Not enough in your balance. Nothing moved.";
  if (/sign|reject|denied|cancel|declin/i.test(why)) return "Not signed. Nothing moved.";
  if (/No answer/i.test(why)) return "No answer yet. Check your balance before trying again.";
  return "That didn't go through. Nothing moved, try again.";
}

/** `a=1&b=2`, decoded. React Native's URLSearchParams cannot read, so this does. */
function query(q: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of q.split("&")) {
    if (!part) continue;
    const [k, v = ""] = part.split("=");
    try {
      out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, " "));
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/*
  Where a withdrawal goes, from whatever the player pasted or scanned. People paste an address, and wallets put
  one of these in their "receive" QR codes:
    7xKX…                                      the address alone, base58
    solana:7xKX…                               Solana Pay, a transfer to it
    solana:7xKX…?amount=5&spl-token=EPjF…      Solana Pay with an amount, in dollars, of a token
  plus stray spaces and a trailing newline. A Solana Pay transaction request (solana:https://…) is not a
  transfer, and an Ethereum address is on another network.
*/
function parseDestination(raw: string, usdc: string | null, label: string): Destination | { error: string } {
  const text = raw.trim().replace(/\s+/g, "");
  if (!text) return { error: "Paste or scan an address" };
  if (isAddress(text)) return { address: text };
  if (/^(?:ethereum:)?(?:pay-)?0x[0-9a-fA-F]{40}/.test(text)) return { error: `That's an address on another network. Send only to an address on ${label}.` };
  const m = /^solana:([^?]+)(?:\?(.*))?$/i.exec(text);
  if (!m) return { error: "That isn't an address" };
  let target = m[1];
  try {
    target = decodeURIComponent(target);
  } catch {
    /* as it is */
  }
  if (/^https?:/i.test(target)) return { error: "That code asks for something other than a transfer" };
  if (!isAddress(target)) return { error: "That code has no address to send to" };
  const params = query(m[2] ?? "");
  const token = params["spl-token"];
  if (token && usdc && token !== usdc) return { error: "That code is for a different token, not USDC" };
  const human = params.amount;
  const amount = human !== undefined && Number.isFinite(Number(human)) && Number(human) > 0 ? Math.floor(Number(human) * 100) / 100 : undefined;
  return { address: target, amount };
}

/** A transaction on Solscan, on the cluster the game is on. */
function explorerTx(sig: string, cluster: string | undefined): string {
  return `https://solscan.io/tx/${sig}${cluster === "mainnet-beta" ? "" : "?cluster=devnet"}`;
}

export function WithdrawSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const chain = useChain();
  const me = useAccount();
  const c = useColors();
  const label = chain.hello?.label ?? "Solana";
  const available = Math.max(0, chain.balance);
  const [step, setStep] = useState<Step>("form");
  const [amountText, setAmountText] = useState("");
  const [all, setAll] = useState(false);
  const [toText, setToText] = useState("");
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ amount: number; to: string; tx: string } | null>(null);
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  // Closed, and nothing on its way: start afresh, once the sheet has slid away.
  useEffect(() => {
    if (open || busy) return;
    const t = setTimeout(() => {
      setStep("form");
      setAmountText("");
      setAll(false);
      setToText("");
      setError(null);
      setSent(null);
    }, 450);
    return () => clearTimeout(t);
  }, [open, busy]);

  // What was typed, as money: at most two decimals. "All" sends the balance to the micro-dollar, leaving no dust.
  const typed = Number(amountText);
  const amount = all ? available : Number.isFinite(typed) ? typed : 0;
  const amountError = amountText === "" && !all ? null : amount <= 0 ? "Enter an amount" : amount < 0.01 ? "At least $0.01" : amount > available + 1e-9 ? "More than your balance" : null;

  const usdc = chain.hello?.usdc ?? null;
  const parsed = toText.trim() ? parseDestination(toText, usdc, label) : null;
  const dest: Destination | null = parsed && "address" in parsed ? parsed : null;
  const contracts = [chain.hello?.program, chain.hello?.game, chain.hello?.usdc, chain.hello?.lookupTable].filter((a): a is string => Boolean(a));
  const toError = !parsed
    ? null
    : "error" in parsed
      ? parsed.error
      : (me.address ?? chain.player) === parsed.address
        ? "That's your deposit address: it would land straight back in your balance."
        : contracts.includes(parsed.address)
          ? "That's a contract, not a wallet. Money sent there is lost."
          : null;
  const ready = !amountError && amount > 0 && dest !== null && !toError;
  const value = all ? available : amount;

  const typeAmount = (raw: string) => {
    // Digits and one point, two decimals at most: what a keyboard of money should allow. A comma is a point.
    const clean = raw
      .replace(/,/g, ".")
      .replace(/[^\d.]/g, "")
      .replace(/(\..*)\./g, "$1");
    const [whole, frac] = clean.split(".");
    setAll(false);
    setAmountText(frac === undefined ? whole.slice(0, 7) : `${whole.slice(0, 7)}.${frac.slice(0, 2)}`);
  };
  const share = (part: number) => {
    haptic("tick");
    setAll(part === 1);
    setAmountText(String(Math.floor(available * part * 100) / 100));
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
      const text = await Clipboard.getStringAsync();
      if (text) {
        haptic("tick");
        take(text);
      }
    } catch {
      setError("Couldn't read the clipboard. Long-press the field to paste.");
    }
  };

  const send = async () => {
    if (!ready || busy || !dest) return;
    setBusy(true);
    setError(null);
    const usd = all ? available : cents(amount);
    const r = await chain.withdraw(usd, dest.address);
    setBusy(false);
    if ("why" in r) {
      haptic("nope");
      if (!openRef.current) Alert.alert("Withdrawal didn't go through", plain(r.why));
      return setError(plain(r.why));
    }
    setSent({ amount: usd, to: dest.address, tx: r.tx });
    feel("win", { tier: 1 });
    if (!openRef.current) Alert.alert(`${money(usd)} is on its way`, `to ${shortAddress(dest.address)}`);
    setStep("done");
  };

  const back = () => {
    setError(null);
    setStep("form");
  };

  if (step === "done" && sent) {
    return (
      <Sheet onClose={onClose} open={open}>
        <Done balance={available} cluster={chain.hello?.cluster} onPlay={onClose} sent={sent} />
      </Sheet>
    );
  }

  return (
    <Sheet description={`USDC on ${label}`} onClose={onClose} open={open} title={step === "scan" ? "Scan an address" : step === "review" ? "Check and send" : "Withdraw"}>
      {step === "review" || step === "scan" ? (
        <Pressable
          accessibilityLabel="Back"
          accessibilityRole="button"
          className="-mt-1 h-8 flex-row items-center gap-1 self-start rounded-full bg-secondary pr-3 pl-2"
          disabled={busy}
          hitSlop={6}
          onPress={back}
          style={({ pressed }) => ({ opacity: busy ? 0.4 : 1, transform: [{ scale: pressed ? 0.95 : 1 }] })}
        >
          <ArrowLeftIcon color={c.muted} size={16} strokeWidth={2.2} />
          <Text className="font-semibold text-[14px] text-muted-foreground">Back</Text>
        </Pressable>
      ) : null}

      {step === "scan" ? (
        <QrScanner
          onClose={back}
          onResult={(text) => {
            take(text);
            setStep("form");
          }}
        />
      ) : step === "review" && dest ? (
        <Review address={dest.address} after={Math.max(0, available - value)} amount={value} busy={busy} error={error} label={label} onSend={() => void send()} />
      ) : (
        <>
          {/* How much: typed big, or a share of the balance. */}
          <View className="items-center gap-3 pt-1">
            <View className="flex-row items-center justify-center">
              <Text className={amountText ? "text-foreground" : "text-faint"} style={{ fontSize: 44, fontWeight: "700", letterSpacing: -1.3 }}>
                $
              </Text>
              <TextInput
                accessibilityLabel="Amount to withdraw"
                autoComplete="off"
                keyboardType="decimal-pad"
                onChangeText={typeAmount}
                placeholder="0"
                placeholderTextColor={c.faint}
                selectionColor={c.brand}
                style={{ fontSize: 44, fontWeight: "700", letterSpacing: -1.3, color: c.fg, fontVariant: ["tabular-nums"], textAlign: "center", padding: 0, height: 56, width: Math.max(1, (amountText || "0").length) * 27 + 10 }}
                value={amountText}
              />
            </View>
            <Text className={amountError ? "min-h-5 text-[14px] text-destructive-foreground" : "min-h-5 text-[14px] text-muted-foreground"} style={tabular}>
              {amountError ?? `Available ${money(available)}`}
            </Text>
            <View className="w-full flex-row gap-2">
              {[
                { label: "25%", part: 0.25 },
                { label: "50%", part: 0.5 },
                { label: "Max", part: 1 },
              ].map((chip) => {
                const on = chip.part === 1 && all;
                return (
                  <Pressable
                    accessibilityRole="button"
                    className={on ? "h-10 flex-1 items-center justify-center rounded-full bg-primary" : "h-10 flex-1 items-center justify-center rounded-full bg-secondary"}
                    disabled={available <= 0}
                    key={chip.label}
                    onPress={() => share(chip.part)}
                    style={({ pressed }) => ({ opacity: available <= 0 ? 0.4 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] })}
                  >
                    <Text className={on ? "font-semibold text-[15px] text-primary-foreground" : "font-semibold text-[15px] text-foreground"}>{chip.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* Where: typed, pasted or scanned. */}
          <View className="gap-2">
            <View
              className="flex-row items-center gap-1.5 rounded-[18px] bg-secondary py-1.5 pr-1.5 pl-4"
              style={{ borderWidth: 2, borderColor: toError ? "rgba(255,59,48,0.5)" : focused ? c.faint : "transparent" }}
            >
              <TextInput
                accessibilityLabel="Address to send to"
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect={false}
                className="min-w-0 flex-1"
                onBlur={() => setFocused(false)}
                onChangeText={take}
                onFocus={() => setFocused(true)}
                placeholder="Solana address"
                placeholderTextColor={c.muted}
                selectionColor={c.brand}
                spellCheck={false}
                style={{ fontSize: 16, color: c.fg, height: 40, padding: 0, fontVariant: ["tabular-nums"] }}
                value={toText}
              />
              {toText ? (
                <Pressable accessibilityLabel="Clear address" className="size-7 items-center justify-center rounded-full bg-accent" hitSlop={8} onPress={() => setToText("")}>
                  <XIcon color={c.muted} size={14} strokeWidth={2.4} />
                </Pressable>
              ) : (
                <Pressable accessibilityRole="button" className="h-10 flex-row items-center gap-1.5 rounded-full px-3" onPress={() => void paste()} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
                  <ClipboardPasteIcon color={c.fg} size={16} />
                  <Text className="font-semibold text-[14px] text-foreground">Paste</Text>
                </Pressable>
              )}
              <Pressable
                accessibilityLabel="Scan a QR code"
                accessibilityRole="button"
                className="size-10 items-center justify-center rounded-full bg-primary"
                onPress={() => {
                  setError(null);
                  setStep("scan");
                }}
                style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.95 : 1 }] })}
              >
                <ScanLineIcon color={c.bg} size={18} strokeWidth={2.2} />
              </Pressable>
            </View>
            <Text adjustsFontSizeToFit minimumFontScale={0.85} numberOfLines={toError || error ? 2 : 1} className={toError || error ? "min-h-5 px-1 text-[13px] text-destructive-foreground leading-[18px]" : "min-h-5 px-1 text-[13px] text-muted-foreground leading-[18px]"}>
              {toError ?? error ?? (dest ? `Sending to ${shortAddress(dest.address)} on ${label}` : `Only an address on ${label}. Anything else may be lost.`)}
            </Text>
          </View>

          <Button className="h-[52px]" disabled={!ready} onPress={() => {
              setError(null);
              setStep("review");
            }} textClassName="text-[17px]">
            {ready ? `Review ${money(value)}` : !amountText && !all ? "Enter an amount" : !dest ? "Add an address" : "Review"}
          </Button>
        </>
      )}
    </Sheet>
  );
}

function Review({ amount, address, after, busy, error, label, onSend }: { amount: number; address: string; after: number; busy: boolean; error: string | null; label: string; onSend: () => void }) {
  const c = useColors();
  return (
    <View className="gap-4">
      <View className="items-center gap-1 pt-1">
        <Text className="font-bold text-[40px] text-foreground" style={[tabular, { letterSpacing: -1.2 }]}>
          {money(amount)}
        </Text>
        <Text className="text-[14px] text-muted-foreground">to</Text>
        {/* The whole address, to check against the wallet it came from. */}
        <View className="max-w-full rounded-[14px] bg-secondary px-3 py-2">
          <Text className="text-center text-[14px] text-foreground leading-[20px]" selectable style={tabular}>
            {address}
          </Text>
        </View>
      </View>
      <View className="rounded-[18px] border border-border px-4">
        <Row label="Network">{label}</Row>
        <Row divider label="Fee">
          Free
        </Row>
        <Row divider label="Arrives in">
          A few seconds
        </Row>
        <Row divider label="Left to play with">
          {money(after)}
        </Row>
      </View>
      <Button className="h-[52px]" disabled={busy} onPress={onSend}>
        {busy ? <Spinner color={c.bg} /> : null}
        <Text className="font-semibold text-[17px] text-primary-foreground" style={tabular}>
          {busy ? "Sending…" : `Withdraw ${money(amount)}`}
        </Text>
      </Button>
      <Text accessibilityLiveRegion="polite" className={error ? "-mt-1 min-h-5 text-center text-[13px] text-destructive-foreground" : "-mt-1 min-h-5 text-center text-[13px] text-muted-foreground"}>
        {error ?? "It can't be undone once sent."}
      </Text>
    </View>
  );
}

/** Sent: what, where, the proof, and then the people behind the game: thanks, feedback, come back. */
function Done({ sent, balance, cluster, onPlay }: { sent: { amount: number; to: string; tx: string }; balance: number; cluster: string | undefined; onPlay: () => void }) {
  const c = useColors();
  const pop = useRef(new Animated.Value(0)).current;
  const rest = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.parallel([
      Animated.spring(pop, { toValue: 1, useNativeDriver: true, speed: 14, bounciness: 12 }),
      Animated.sequence([Animated.delay(300), Animated.timing(rest, { toValue: 1, duration: 380, useNativeDriver: true })]),
    ]);
    a.start();
    return () => a.stop();
  }, [pop, rest]);
  const rise = { opacity: rest, transform: [{ translateY: rest.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] };
  const open = (url: string) => void Linking.openURL(url).catch(() => undefined);

  return (
    <View className="items-center gap-4 pt-2">
      <Animated.View className="size-16 items-center justify-center rounded-full bg-success/15" style={{ transform: [{ scale: pop }] }}>
        <CheckIcon color={c.success} size={32} strokeWidth={2.6} />
      </Animated.View>
      <View className="items-center gap-1">
        <Text accessibilityRole="header" className="text-center font-semibold text-[24px] text-foreground" style={[tabular, { letterSpacing: -0.5 }]}>
          {money(sent.amount)} is on its way
        </Text>
        <View className="flex-row flex-wrap items-center justify-center">
          <Text className="text-[14px] text-muted-foreground">
            to{" "}
            <Text className="text-foreground" style={tabular}>
              {shortAddress(sent.to)}
            </Text>
          </Text>
          {sent.tx ? (
            <>
              <Text className="text-[14px] text-muted-foreground">{" · "}</Text>
              <Pressable accessibilityRole="link" className="flex-row items-center gap-0.5" hitSlop={8} onPress={() => open(explorerTx(sent.tx, cluster))}>
                <Text className="font-medium text-[14px] text-foreground">View transaction</Text>
                <ArrowUpRightIcon color={c.fg} size={14} />
              </Pressable>
            </>
          ) : null}
        </View>
      </View>

      <Animated.View className="w-full gap-3 rounded-[20px] border border-border bg-secondary p-4" style={rise}>
        <View className="flex-row items-center gap-3">
          <Image accessibilityLabel={FOUNDER.name} contentFit="cover" source={FOUNDER_PHOTO} style={{ width: 44, height: 44, borderRadius: 22 }} />
          <View className="min-w-0 flex-1">
            <Text className="font-semibold text-[16px] text-foreground">Hope you enjoyed skech</Text>
            <Text className="text-[13px] text-muted-foreground leading-[18px]">Tell us what to make better. {FOUNDER.name} reads every message.</Text>
          </View>
        </View>
        <Pressable
          accessibilityRole="link"
          className="h-11 flex-row items-center justify-center gap-2 rounded-full"
          onPress={() => open(FOUNDER.url)}
          style={({ pressed }) => ({ backgroundColor: "#2AABEE", transform: [{ scale: pressed ? 0.98 : 1 }] })}
        >
          <SendIcon color="#ffffff" size={16} strokeWidth={2.2} />
          <Text className="font-semibold text-[15px] text-white">Share feedback on Telegram</Text>
        </Pressable>
      </Animated.View>

      <Animated.View className="w-full items-center gap-2" style={rise}>
        <Button className="h-[52px] w-full" onPress={onPlay}>
          <Text className="font-semibold text-[17px] text-primary-foreground" style={tabular}>
            {balance >= 0.1 ? `Keep playing with ${money(balance)}` : "Back to the game"}
          </Text>
        </Button>
        <Text className="text-center text-[13px] text-muted-foreground">{balance >= 0.1 ? "Bitcoin never closes." : "Come back anytime. Bitcoin never closes, and neither do we."}</Text>
      </Animated.View>
    </View>
  );
}

function Row({ label, children, divider }: { label: string; children: ReactNode; divider?: boolean }) {
  return (
    <View className={divider ? "min-h-11 flex-row items-center justify-between gap-4 border-border border-t py-2.5" : "min-h-11 flex-row items-center justify-between gap-4 py-2.5"}>
      <Text className="text-[15px] text-muted-foreground">{label}</Text>
      <Text className="shrink text-right font-medium text-[15px] text-foreground" style={tabular}>
        {children}
      </Text>
    </View>
  );
}
