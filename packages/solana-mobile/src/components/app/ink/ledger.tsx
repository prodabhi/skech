import { type ReactNode, useEffect, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import Animated, { Easing, interpolate, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withTiming } from "react-native-reanimated";
import { cents, money } from "@/lib/money";
import { cn } from "@/lib/utils";

/*
  What just moved the balance, under it: money put in as a light minus, a return as a green plus, money back as
  a light plus. The newest sits right under the balance; older ones step down, lighter and smaller, and fade.

  Pieces of one stroke go in every 150 ms, so changes of the same kind that land close together merge into
  one line that keeps counting, rather than a waterfall of dimes.
*/

export type Change = { id: number; amount: number; kind: "stake" | "win" | "back"; at: number };

const SHOW = 3;
const LIFE_MS = 4200;
const MERGE_MS = 900;
/** When a row starts to fade: 900ms before the end of its life, as on the web. */
const OUT_AFTER_MS = 3300;

let rows: Change[] = [];
let next = 1;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

function prune() {
  const now = performance.now();
  const kept = rows.filter((r) => now - r.at < LIFE_MS);
  if (kept.length !== rows.length) {
    rows = kept;
    emit();
  }
  if (rows.length) setTimeout(prune, 250);
}

/** Record a move of the balance. Negative is money put in. Zero is ignored. */
export function addChange(amount: number, kind: Change["kind"]) {
  if (!amount || !Number.isFinite(amount)) return;
  const now = performance.now();
  const top = rows[0];
  const idle = rows.length === 0;
  if (top && top.kind === kind && now - top.at < MERGE_MS) rows = [{ ...top, amount: cents(top.amount + amount), at: now }, ...rows.slice(1)];
  else rows = [{ id: next++, amount: cents(amount), kind, at: now }, ...rows].slice(0, SHOW + 1);
  emit();
  if (idle) setTimeout(prune, 250);
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
const EMPTY: Change[] = [];
const useChanges = () => useSyncExternalStore(subscribe, () => rows, () => EMPTY);

export function Ledger() {
  const changes = useChanges();
  return (
    <View pointerEvents="none" style={{ position: "absolute", right: 0, top: "100%", width: 120, height: 54 }}>
      {changes.slice(0, SHOW).map((c, i) => (
        <Place key={c.id} place={i}>
          {/* The inner one carries the entrance and the fade, the outer one its place in the stack. */}
          <Life key={`${c.id}:${c.amount}`}>
            <Text className={cn("font-semibold text-[14px]", c.kind === "win" ? "text-success-foreground" : "text-muted-foreground")} style={{ fontVariant: ["tabular-nums"] }}>
              {c.amount > 0 ? "+" : "−"}
              {money(c.amount)}
            </Text>
          </Life>
        </Place>
      ))}
    </View>
  );
}

/** A row's place in the stack: stepping down, lighter and smaller, as newer ones come in over it. */
function Place({ place, children }: { place: number; children: ReactNode }) {
  const still = useReducedMotion();
  const at = useSharedValue(place);
  useEffect(() => {
    at.value = still ? place : withTiming(place, { duration: 320, easing: Easing.bezier(0.2, 0.8, 0.2, 1) });
  }, [place, still, at]);
  const style = useAnimatedStyle(() => ({
    opacity: interpolate(at.value, [0, 1, 2], [1, 0.55, 0.28]),
    transform: [{ translateY: at.value * 17 }, { scale: 1 - at.value * 0.08 }],
  }));
  return <Animated.View style={[{ position: "absolute", right: 0, top: 2, transformOrigin: "right top" }, style]}>{children}</Animated.View>;
}

/** A row's life: it drops in with a little spring, and after 3.3s fades down and away. */
function Life({ children }: { children: ReactNode }) {
  const still = useReducedMotion();
  const born = useSharedValue(still ? 1 : 0);
  const gone = useSharedValue(0);
  useEffect(() => {
    if (!still) born.value = withTiming(1, { duration: 360, easing: Easing.bezier(0.2, 1.4, 0.4, 1) });
    gone.value = withDelay(OUT_AFTER_MS, withTiming(1, { duration: still ? 0 : 900, easing: Easing.bezier(0.42, 0, 1, 1) }));
  }, [still, born, gone]);
  const style = useAnimatedStyle(() => ({
    opacity: Math.min(1, born.value) * (1 - gone.value),
    transform: [{ translateY: -8 * (1 - born.value) + 4 * gone.value }, { scale: 0.85 + 0.15 * born.value }],
  }));
  return <Animated.View style={[{ transformOrigin: "right top" }, style]}>{children}</Animated.View>;
}
