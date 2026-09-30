import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import { ArrowUpRightIcon, CheckIcon, SendIcon } from "@/components/ui/icons";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, Linking, Pressable, Text, useWindowDimensions, View } from "react-native";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { encode } from "uqr";
import { useAccount } from "@/components/app/auth";
import { MIN_DEPOSIT, useChain } from "@/components/app/ink/chain-context";
import { Button, Popover, Sheet, Spinner, useColors } from "@/components/ui";
import { feel, haptic } from "@/lib/feel";
import { shortAddress } from "@/lib/market";
import { money } from "@/lib/money";

/**
 * The way to money while the game plays on, as on the web (ui/app/src/components/app/ink/deposit-modal.tsx):
 * "Send USDC", a QR of the player's address, the address to copy, the network, the balance and the minimum.
 * On Solana the address is the player's own wallet: USDC that lands there is swept into the balance by the
 * relayer (the session gave the game a standing approval), and the sheet turns into the celebration when it has.
 * A wallet on the phone with nothing approved gets one button to move it in, on its own signature.
 */

/** The founder players are sent to, for onboarding and for feedback. One place, so the handle is never out of step. */
export const FOUNDER = { name: "Abhi", handle: "Oxabhii", url: "https://t.me/Oxabhii" } as const;
export const FOUNDER_PHOTO = require("../../../../assets/abhi.jpg") as number;
const SCENE = require("../../../../assets/skech-scene.png") as number;

/**
 * The founder's chat with a message already typed: that they need help to play, and who they are. `who` is their
 * email, or else their phone number or address; left out when there is none.
 */
export function helpLink(who: { email: string | null; phone?: string | null; address?: string | null }): string {
  const me = who.email ? ` My email is ${who.email}.` : who.phone ? ` I signed in with ${who.phone}.` : who.address ? ` My skech address is ${who.address}.` : "";
  return `${FOUNDER.url}?text=${encodeURIComponent(`Hi ${FOUNDER.name}, I need help with playing skech.${me}`)}`;
}

const tabular = { fontVariant: ["tabular-nums" as const] };

/**
 * The gate renders this sheet, so it is read when the sheet renders rather than when this module loads: no
 * require cycle between the two.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const useGate = () => (require("../gate") as typeof import("../gate")).useGate();

export function DepositSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const chain = useChain();
  const me = useAccount();
  const gate = useGate();
  const c = useColors();
  const address = me.address ?? chain.player;
  const label = chain.hello?.label ?? "Solana";
  const faucet = chain.hello?.faucet ?? null;

  // The deposit this sheet is celebrating: the last one to land, of at least the minimum, until it is dismissed.
  const landed = chain.landed;
  const [dismissed, setDismissed] = useState<number | null>(landed?.at ?? null);
  const done = landed && landed.at !== dismissed && landed.amount >= MIN_DEPOSIT ? landed.amount : null;
  // Money in opens the sheet, as on the web; if another sheet is up it waits for that one to close.
  useEffect(() => {
    if (done !== null && !open && gate.open === null) gate.openDeposit("landed");
  }, [done, open, gate]);
  /*
    Closing from the celebration marks it seen at once, which would swap the sheet back to "Send USDC" while it
    slides away. So what was on screen is held until the sheet is gone.
  */
  const [held, setHeld] = useState<number | null>(null);
  useEffect(() => {
    if (open || held === null) return;
    const t = setTimeout(() => setHeld(null), 450);
    return () => clearTimeout(t);
  }, [open, held]);
  const close = () => {
    if (done !== null) setHeld(done);
    if (landed) setDismissed(landed.at);
    onClose();
  };
  const celebrating = done ?? held;

  // A wallet on the phone with USDC the game may not sweep: one signature moves it in.
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [moved, setMoved] = useState<{ amount: number; balance: number } | null>(null);
  const inWallet = chain.wallet ?? 0;
  // Signed and sent: "Adding" until the balance moves or the wallet empties.
  const signed = moved !== null && inWallet >= MIN_DEPOSIT && chain.balance === moved.balance ? moved.amount : null;
  const adding = chain.adding ?? signed;
  const canMove = me.kind === "wallet" && chain.wallet !== null && chain.wallet >= MIN_DEPOSIT && chain.approved < chain.wallet && adding === null;
  const moveIn = async () => {
    if (moving || chain.wallet === null) return;
    const amount = chain.wallet;
    haptic("tap");
    setMoving(true);
    setMoveError(null);
    const why = await chain.deposit(amount);
    setMoving(false);
    if (why) {
      haptic("nope");
      setMoveError(/sign|reject|denied|cancel|declin/i.test(why) ? "Not signed. Nothing moved." : "That didn't go through. Nothing moved, try again.");
      return;
    }
    setMoved({ amount, balance: chain.balance });
  };

  if (celebrating !== null) {
    return (
      <Sheet onClose={close} open={open}>
        <Landed amount={celebrating} balance={chain.balance} onStart={close} />
      </Sheet>
    );
  }

  return (
    <Sheet action={<Founders />} description={`Only send USDC on ${label}. Anything else may be lost.`} onClose={close} open={open} title="Send USDC">
      {address ? (
        <>
          <AddressQR address={address} />
          <CopyCard address={address} />
          {/* The terms, as a statement: one list, label left, value right. */}
          <View className="rounded-[18px] border border-border px-4">
            <Term label="Your balance">
              <Text className="font-semibold text-[15px] text-foreground" style={tabular}>
                {money(chain.balance)}
              </Text>
            </Term>
            <Term divider label="Minimum">
              <Text className="font-medium text-[15px] text-foreground" style={tabular}>
                ${MIN_DEPOSIT.toFixed(2)}
              </Text>
            </Term>
          </View>
          {faucet ? <Faucet href={faucet} /> : null}
          {adding !== null ? (
            <Waiting>{`Adding ${money(adding)} to your balance…`}</Waiting>
          ) : canMove ? (
            <View className="gap-2">
              <Button className="h-[54px]" disabled={moving} onPress={() => void moveIn()}>
                {moving ? <Spinner color={c.bg} /> : null}
                <Text className="font-semibold text-[17px] text-primary-foreground" style={tabular}>
                  {moving ? "Confirm in your wallet…" : `Move ${money(inWallet)} in`}
                </Text>
              </Button>
              <Text className={moveError ? "text-center text-[13px] text-destructive-foreground" : "text-center text-[13px] text-muted-foreground"} style={tabular}>
                {moveError ?? `${money(inWallet)} is in your wallet. Sign once to play with it.`}
              </Text>
            </View>
          ) : chain.balance >= MIN_DEPOSIT ? (
            // Already enough to play: the sheet is for topping up, and says so, with the way back to the game.
            <Button className="h-[54px]" onPress={close}>
              <Text className="font-semibold text-[17px] text-primary-foreground" style={tabular}>
                Play with {money(chain.balance)}
              </Text>
            </Button>
          ) : (
            <Waiting>Waiting for USDC. It lands in your balance in a few seconds.</Waiting>
          )}
        </>
      ) : (
        <View className="flex-row items-center justify-center gap-2 py-10">
          <Spinner />
          <Text className="text-[14px] text-muted-foreground">Getting your address…</Text>
        </View>
      )}
    </Sheet>
  );
}

function Waiting({ children }: { children: string }) {
  return (
    <View accessibilityLiveRegion="polite" className="min-h-5 flex-row items-center justify-center gap-2 px-2">
      <Spinner />
      <Text className="shrink text-center text-[14px] text-muted-foreground" style={tabular}>
        {children}
      </Text>
    </View>
  );
}

function Term({ label, children, divider }: { label: string; children: ReactNode; divider?: boolean }) {
  return (
    <View className={divider ? "min-h-12 flex-row items-center justify-between gap-4 border-border border-t py-3" : "min-h-12 flex-row items-center justify-between gap-4 py-3"}>
      <Text className="text-[15px] text-muted-foreground">{label}</Text>
      {children}
    </View>
  );
}

/** A soft card: the address large, one solid Copy pill that turns into a tick. */
function CopyCard({ address }: { address: string }) {
  const c = useColors();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    try {
      await Clipboard.setStringAsync(address);
      haptic("tick");
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      // No clipboard. It is on screen to read.
    }
  };
  return (
    <View className="flex-row items-center gap-3 rounded-[20px] bg-secondary py-3.5 pr-3.5 pl-5">
      <View className="min-w-0 flex-1">
        <Text className="text-[15px] text-muted-foreground">Your skech address</Text>
        <Text className="font-medium text-[17px] text-foreground" numberOfLines={1} style={tabular}>
          {shortAddress(address)}
        </Text>
      </View>
      <Pressable
        accessibilityLabel={copied ? "Address copied" : "Copy address"}
        accessibilityRole="button"
        className="h-11 min-w-[88px] flex-row items-center justify-center gap-1.5 rounded-full bg-primary px-5"
        onPress={() => void copy()}
        style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.95 : 1 }] })}
      >
        {copied ? <CheckIcon color={c.bg} size={18} strokeWidth={2.6} /> : null}
        <Text className="font-semibold text-[17px] text-primary-foreground">{copied ? "Copied" : "Copy"}</Text>
      </Pressable>
    </View>
  );
}

/**
 * The address as a QR code, with USDC's mark in the middle (what to send; the network is named above). Error
 * correction is at its highest, so the mark still scans. Always black on white, dark mode or not: that is what
 * cameras read. Smaller on a short screen, so the sheet still fits.
 */
function AddressQR({ address }: { address: string }) {
  const { height } = useWindowDimensions();
  const px = height < 720 ? 128 : height < 800 ? 160 : 203;
  const { data, size } = useMemo(() => encode(address, { ecc: "H", border: 0 }), [address]);
  const box = 175;
  const pitch = box / size;
  const dot = pitch * 0.86;
  const mid = box / 2;
  // The clear circle the mark sits in, in the box's units.
  const clear = (x: number, y: number) => Math.hypot(x - mid, y - mid) < 18;
  const dots: ReactNode[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!data[y][x]) continue;
      const cx = x * pitch + pitch / 2;
      const cy = y * pitch + pitch / 2;
      if (clear(cx, cy)) continue;
      dots.push(<Rect fill="#000" height={dot} key={`${x}:${y}`} rx={dot * 0.33} width={dot} x={cx - dot / 2} y={cy - dot / 2} />);
    }
  }
  return (
    <View accessibilityLabel={`QR code for ${address}`} accessible className="self-center" style={{ width: px, height: px }}>
      <Svg height="100%" viewBox={`-14 -14 ${box + 28} ${box + 28}`} width="100%">
        <Rect fill="#FFFFFF" height={box + 28} rx={18} width={box + 28} x={-14} y={-14} />
        {dots}
      </Svg>
      <View className="absolute inset-0 items-center justify-center" pointerEvents="none">
        <View className="items-center justify-center rounded-full bg-white" style={{ width: 40, height: 40 }}>
          <UsdcMark size={34} />
        </View>
      </View>
    </View>
  );
}

/** USDC's mark: the dollar in its brackets, on Circle's blue. */
export function UsdcMark({ size = 28 }: { size?: number }) {
  return (
    <Svg height={size} viewBox="0 0 32 32" width={size}>
      <Circle cx="16" cy="16" fill="#2775CA" r="16" />
      <Path
        d="M20.5 18.5c0-2.4-1.4-3.2-4.3-3.5-2-.3-2.4-.8-2.4-1.8 0-1 .7-1.6 2.1-1.6 1.3 0 2 .4 2.3 1.5.1.2.3.4.5.4h1.1c.3 0 .5-.2.5-.5v-.1a3.6 3.6 0 0 0-3.2-2.9V8.4c0-.3-.2-.5-.6-.6h-1c-.3 0-.5.2-.6.6V10a3.5 3.5 0 0 0-3.2 3.4c0 2.3 1.4 3.2 4.2 3.5 1.9.3 2.5.7 2.5 1.9 0 1.1-1 1.9-2.3 1.9-1.8 0-2.4-.8-2.6-1.8 0-.3-.3-.4-.5-.4h-1.1c-.3 0-.5.2-.5.5v.1c.3 1.7 1.4 2.9 3.5 3.2v1.6c0 .3.2.5.6.6h1c.3 0 .5-.2.6-.6V22a3.7 3.7 0 0 0 3.4-3.5z"
        fill="#fff"
      />
      <Path
        d="M13.1 24.9a9 9 0 0 1 0-17 .6.6 0 0 0 .4-.6v-.9c0-.3-.1-.4-.4-.4h-.1a11 11 0 0 0 0 20.8h.2c.3-.1.4-.3.4-.6v-.9c0-.2-.2-.4-.5-.4zm5.9-18.9h-.2c-.3.1-.4.3-.4.6v.9c0 .3.2.5.4.6a9 9 0 0 1 0 17 .6.6 0 0 0-.4.6v.9c0 .3.1.4.4.4h.2a11 11 0 0 0 0-20.9z"
        fill="#fff"
      />
    </Svg>
  );
}

/**
 * Testnet only: USDC here is free, and this is where it comes from. Circle's faucet asks for the network and the
 * address, so the line says which network to pick; the address is one Copy away, just above.
 */
function Faucet({ href }: { href: string }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="link"
      className="flex-row items-center gap-3 rounded-[20px] bg-secondary px-5 py-3"
      onPress={() => void Linking.openURL(href).catch(() => undefined)}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      <UsdcMark size={28} />
      <View className="min-w-0 flex-1">
        <Text className="font-semibold text-[15px] text-foreground">Get free test USDC</Text>
        <Text className="text-[13px] text-muted-foreground">Pick Solana Devnet, paste address</Text>
      </View>
      <ArrowUpRightIcon color={c.muted} size={16} />
    </Pressable>
  );
}

/**
 * A person instead of a form: a founder's face and "Help", and behind it a promise of a few minutes and one
 * button straight into a Telegram chat. In a popover, not in the sheet, so the sheet stays short.
 */
function Founders() {
  const me = useAccount();
  const { width } = useWindowDimensions();
  const pill = useRef<View>(null);
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  // A phone number is the handle when there is no email; it is only sent if they send the message.
  const href = helpLink({ email: me.email, phone: me.email ? null : me.handle?.startsWith("+") ? me.handle : null, address: me.address });
  const show = () => {
    haptic("tap");
    pill.current?.measureInWindow((x, y, w, h) => setAt({ top: y + h + 8, right: Math.max(16, width - (x + w)) }));
  };
  const message = () => {
    setAt(null);
    void Linking.openURL(href).catch(() => undefined);
  };
  return (
    <>
      <Pressable
        accessibilityLabel={`Talk to ${FOUNDER.name}, a founder`}
        accessibilityRole="button"
        className="h-10 shrink-0 flex-row items-center gap-2 rounded-full bg-secondary pr-3.5 pl-1"
        onPress={show}
        ref={pill}
        style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.95 : 1 }] })}
      >
        <View>
          <Image contentFit="cover" source={FOUNDER_PHOTO} style={{ width: 32, height: 32, borderRadius: 16 }} />
          <View className="absolute right-0 bottom-0 size-2.5 rounded-full border-2 border-secondary bg-success-foreground" />
        </View>
        <Text className="font-semibold text-[15px] text-foreground">Help</Text>
      </Pressable>
      <Popover anchor={at ?? { top: 0, right: 16 }} onClose={() => setAt(null)} open={at !== null} width={Math.min(340, width - 32)}>
        <View className="gap-3.5 p-2.5">
          <View className="flex-row items-center gap-3.5">
            <View className="shrink-0">
              <Image accessibilityLabel={FOUNDER.name} contentFit="cover" source={FOUNDER_PHOTO} style={{ width: 56, height: 56, borderRadius: 28 }} />
              <View accessibilityLabel="Online" className="absolute right-0 bottom-0 size-3.5 rounded-full border-2 border-popover bg-success-foreground" />
            </View>
            <View className="min-w-0 flex-1 gap-0.5">
              <Text className="font-semibold text-[17px] text-foreground">Talk to the founders</Text>
              <Text className="text-[14px] text-muted-foreground leading-[19px]">Get onboarded personally. {FOUNDER.name} will set you up in a few minutes.</Text>
            </View>
          </View>
          <Pressable
            accessibilityRole="link"
            className="h-12 flex-row items-center justify-center gap-2 rounded-full"
            onPress={message}
            style={({ pressed }) => ({ backgroundColor: "#2AABEE", transform: [{ scale: pressed ? 0.98 : 1 }] })}
          >
            <SendIcon color="#ffffff" size={18} strokeWidth={2.2} />
            <Text className="font-semibold text-[16px] text-white">Message @{FOUNDER.handle} on Telegram</Text>
          </Pressable>
        </View>
      </Popover>
    </>
  );
}

/** A value that springs from 0 to 1 after `delay` ms: how each piece of the celebration arrives. */
function useAppear(delay: number) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.sequence([Animated.delay(delay), Animated.spring(v, { toValue: 1, useNativeDriver: true, speed: 14, bounciness: 10 })]);
    a.start();
    return () => a.stop();
  }, [v, delay]);
  return v;
}

const SPARKLES = [
  { left: "8%", top: "22%", delay: 700, size: 10 },
  { left: "62%", top: "4%", delay: 950, size: 14 },
  { left: "88%", top: "30%", delay: 1150, size: 9 },
] as const;

/** The deposit landed: how much, what the balance is now, and the way back to the game. */
function Landed({ amount, balance, onStart }: { amount: number; balance: number; onStart: () => void }) {
  // Money in is the best news the app has: two rising chimes over a soft chord, felt as well as heard.
  useEffect(() => {
    feel("cash");
  }, []);
  // The scene is as wide as the sheet, a little past its padding, as on the web.
  const { width } = useWindowDimensions();
  const sceneW = width - 16;
  const sceneH = (sceneW * 374) / 900;
  // It is drawn in left to right, as the pen would draw it: a window over it opening from the left.
  const draw = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.timing(draw, { toValue: 1, duration: 1100, easing: Easing.bezier(0.35, 0.6, 0.2, 1), useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [draw]);
  const pill = useAppear(600);
  const words = useAppear(750);
  const button = useAppear(880);
  const s0 = useAppear(SPARKLES[0].delay);
  const s1 = useAppear(SPARKLES[1].delay);
  const s2 = useAppear(SPARKLES[2].delay);
  const sparkles = [s0, s1, s2];
  // Then it floats.
  const float = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.sequence([
      Animated.delay(1200),
      Animated.loop(
        Animated.sequence([
          Animated.timing(float, { toValue: 1, duration: 1600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
          Animated.timing(float, { toValue: 0, duration: 1600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        ]),
      ),
    ]);
    a.start();
    return () => a.stop();
  }, [float]);
  const rise = (v: Animated.Value) => ({ opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: "clamp" }), transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] });

  return (
    <View className="items-center gap-4 pt-2">
      {/* The landing page's closing scene: the pen drawing a line up to a rising candle. Sparkles pop around it. */}
      <View className="pt-2" style={{ width: sceneW, height: sceneH + 8 }}>
        <Animated.View
          style={{
            width: sceneW,
            height: sceneH,
            overflow: "hidden",
            opacity: draw.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0.4, 1, 1] }),
            transform: [{ translateY: float.interpolate({ inputRange: [0, 1], outputRange: [0, -4] }) }, { translateX: draw.interpolate({ inputRange: [0, 1], outputRange: [-sceneW, 0] }) }],
          }}
        >
          <Animated.View style={{ transform: [{ translateX: draw.interpolate({ inputRange: [0, 1], outputRange: [sceneW, 0] }) }] }}>
            <Image contentFit="contain" source={SCENE} style={{ width: sceneW, height: sceneH }} />
          </Animated.View>
        </Animated.View>
        {SPARKLES.map((sp, i) => (
          <Animated.Text
            key={sp.left}
            style={{
              position: "absolute",
              left: sp.left,
              top: sp.top,
              fontSize: sp.size,
              color: "#f5c451",
              opacity: sparkles[i].interpolate({ inputRange: [0, 1], outputRange: [0, 0.85], extrapolate: "clamp" }),
              transform: [{ scale: sparkles[i] }, { rotate: sparkles[i].interpolate({ inputRange: [0, 1], outputRange: ["-40deg", "0deg"] }) }],
            }}
          >
            ✦
          </Animated.Text>
        ))}
      </View>
      <Animated.View className="rounded-full bg-success/15 px-3.5 py-1" style={{ opacity: pill.interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: "clamp" }), transform: [{ scale: pill }] }}>
        <Text className="font-bold text-[15px] text-success-foreground" style={tabular}>
          +{money(amount)} added
        </Text>
      </Animated.View>
      <Animated.View className="items-center gap-1.5" style={rise(words)}>
        <Text accessibilityRole="header" className="text-center font-semibold text-[26px] text-foreground" style={{ letterSpacing: -0.5 }}>
          You’re in. Now skech the trade.
        </Text>
        <Text className="text-center text-[15px] text-muted-foreground">
          Draw where Bitcoin goes next. Your balance is{" "}
          <Text className="font-medium text-foreground" style={tabular}>
            {money(balance)}
          </Text>
          .
        </Text>
      </Animated.View>
      <Animated.View className="mt-1 w-full" style={rise(button)}>
        <Button className="h-[54px]" onPress={onStart} textClassName="text-[17px]">
          Start skeching
        </Button>
      </Animated.View>
    </View>
  );
}
