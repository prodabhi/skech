import { Image } from "expo-image";
import { useEffect, useState } from "react";
import { type LayoutChangeEvent, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Animated, { Easing, useAnimatedProps, useAnimatedStyle, useFrameCallback, useReducedMotion, useSharedValue, withTiming } from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { scheduleOnRN } from "react-native-worklets";
import { useColors } from "@/components/ui";
import { useDark } from "@/lib/theme";

/**
 * The way in, on every load: the pen runs across the screen scribbling in blue until the screen is inked over,
 * "skech" wobbles in the middle, and the ink wipes away off the game underneath. The web's intro
 * (ui/app/src/components/app/ink/ink-intro.tsx), same path, same timings.
 *
 * One stroke along one zigzag, as a pen would draw it: the ink grows as it goes, so it covers the screen by the time
 * the pen is out, then drains from its tail. Drawn on a viewBox stretched to the screen, so it covers any shape of
 * phone. Every frame is worked out on the UI thread, so a busy JS thread (the game loading underneath) cannot
 * stutter it.
 */

/* A zigzag down the screen, from off its top left to off its bottom, in a 1000 by 1000 box. */
const SCRIBBLE =
  "M -120 60 C 300 -60, 900 40, 1120 140 C 900 300, 300 200, -120 360 C 300 520, 800 380, 1120 560 C 800 760, 200 600, -120 780 C 300 980, 800 860, 1120 1000 C 900 1120, 500 1060, 400 1160";
/** How long the pen takes to ink the screen over, and the ink to drain away, in ms: slow enough to follow the pen. */
const IN_MS = 2250;
const OUT_MS = 2475;
/** How thick the ink is at its thinnest and when the screen is covered, in the box's units. */
const THIN = 60;
const THICK = 390;
/** Where the nib is on the pen's picture, as shares of its width and height. */
const NIB = { x: 0.517, y: 0.892 };
const PEN_W = 360;
const PEN_H = 459;
/** How wide the pen is drawn on a phone, in points (the web's 110px below its `sm` breakpoint). */
const PEN_SIZE = 110;
const PEN_HEIGHT = (PEN_SIZE * PEN_H) / PEN_W;

/** The longest the name holds, once the screen is inked over, before the ink drains anyway: prices or sign-in still
 *  on their way show up in the game instead of keeping everyone on the name. In ms. */
const MAX_HOLD_MS = 1800;

/*
  Whether the game has live prices to show. The ink holds, covering the screen, until it does, so the way in never
  ends on "Waiting for live prices". Set by the screen; read by the running intro (the listeners pass it on to the
  UI thread).
*/
let ready = false;
const listeners = new Set<() => void>();
export function introReady() {
  if (ready) return;
  ready = true;
  for (const l of listeners) l();
}

/*
  RN SVG has no getPointAtLength, so the path is measured here once: each cubic sampled finely, then resampled
  into points evenly spaced along its length, which the pen reads by share of the way along.
*/
const SAMPLES = 1024;
const { xs: PATH_X, ys: PATH_Y, length: PATH_LENGTH } = measure(SCRIBBLE);

function measure(d: string) {
  const n = (d.match(/-?\d*\.?\d+/g) ?? []).map(Number);
  const fine: { x: number; y: number; at: number }[] = [{ x: n[0], y: n[1], at: 0 }];
  let x0 = n[0];
  let y0 = n[1];
  for (let i = 2; i + 5 < n.length; i += 6) {
    const [x1, y1, x2, y2, x3, y3] = n.slice(i, i + 6);
    for (let s = 1; s <= 256; s++) {
      const u = s / 256;
      const v = 1 - u;
      const x = v * v * v * x0 + 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u * x3;
      const y = v * v * v * y0 + 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u * y3;
      const last = fine[fine.length - 1];
      fine.push({ x, y, at: last.at + Math.hypot(x - last.x, y - last.y) });
    }
    x0 = x3;
    y0 = y3;
  }
  const length = fine[fine.length - 1].at;
  const xs: number[] = [];
  const ys: number[] = [];
  let j = 0;
  for (let i = 0; i <= SAMPLES; i++) {
    const want = (i / SAMPLES) * length;
    while (j < fine.length - 2 && fine[j + 1].at < want) j++;
    const a = fine[j];
    const b = fine[j + 1];
    const k = b.at > a.at ? (want - a.at) / (b.at - a.at) : 0;
    xs.push(a.x + (b.x - a.x) * Math.min(1, Math.max(0, k)));
    ys.push(a.y + (b.y - a.y) * Math.min(1, Math.max(0, k)));
  }
  return { xs, ys, length };
}

/*
  The web draws the ink as one dash from tail to head (pathLength 1, dasharray "head-tail 2"). Here the dash pattern
  stays fixed, one path long with three paths of gap, and only its offset moves, which is the one dash prop every
  platform animates cleanly: offset L(1 - head) puts the dash on [0, head], and offset 4L - tail·L on [tail, 1].
*/
const DASH = [PATH_LENGTH, PATH_LENGTH * 3];

const inOut = (k: number) => {
  "worklet";
  return k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
};
const clamp = (k: number) => {
  "worklet";
  return Math.min(1, Math.max(0, k));
};

const AnimatedPath = Animated.createAnimatedComponent(Path);
 
const PEN = require("../../../../assets/pen-mascot.png");
 
const MARK = require("../../../../assets/logo-mark-alpha.webp");

export function InkIntro() {
  const still = useReducedMotion();
  const dark = useDark();
  const c = useColors();
  const brand = dark ? "#6f92ff" : "#2e5bff";
  const win = useWindowDimensions();
  const [size, setSize] = useState({ width: win.width, height: win.height });
  const [draining, setDraining] = useState(false);
  const [done, setDone] = useState(false);

  /** Time since the first frame, in ms; when the ink started to drain (-1 until it does); the prices, on the UI thread. */
  const time = useSharedValue(0);
  // When the first frame ran. useFrameCallback registers again on every render, and its own clock restarts with it.
  const startAt = useSharedValue(-1);
  const drainAt = useSharedValue(-1);
  const live = useSharedValue(ready);
  const markOpacity = useSharedValue(still ? 1 : 0);
  const fade = useSharedValue(1);
  const finished = useSharedValue(false);

  useEffect(() => {
    const on = () => {
      live.value = true;
    };
    if (ready) on();
    listeners.add(on);
    return () => void listeners.delete(on);
  }, [live]);

  // No scribble: the name until the prices are in, then the game.
  useEffect(() => {
    if (!still) return;
    markOpacity.value = 1;
    const start = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const wait = () => {
      if (!ready && Date.now() - start <= 500 + MAX_HOLD_MS) {
        timer = setTimeout(wait, 100);
        return;
      }
      setDraining(true);
      fade.value = withTiming(0, { duration: 250, easing: Easing.out(Easing.ease) });
      timer = setTimeout(() => setDone(true), 260);
    };
    timer = setTimeout(wait, 500);
    return () => clearTimeout(timer);
  }, [still, fade, markOpacity]);

  useFrameCallback((info) => {
    if (finished.value) return;
    if (startAt.value < 0) startAt.value = info.timestamp;
    const t = info.timestamp - startAt.value;
    time.value = t;
    // When the ink starts to drain: once it has covered the screen and the prices are in.
    if (drainAt.value < 0 && t >= IN_MS && (live.value || t > IN_MS + MAX_HOLD_MS)) {
      drainAt.value = t;
      scheduleOnRN(setDraining, true);
    }
    const drain = drainAt.value < 0 ? Number.POSITIVE_INFINITY : drainAt.value;
    // The name shows while the screen is inked over, fading in and out over 150ms as the web's transition does.
    const showing = t > IN_MS * 0.55 && t < drain + OUT_MS * 0.45;
    const step = (info.timeSincePreviousFrame ?? 16) / 150;
    markOpacity.value = showing ? Math.min(1, markOpacity.value + step) : Math.max(0, markOpacity.value - step);
    if (t >= drain + OUT_MS) {
      finished.value = true;
      scheduleOnRN(setDone, true);
    }
  }, !still);

  const inkProps = useAnimatedProps(() => {
    const t = time.value;
    const drain = drainAt.value;
    if (t < IN_MS) {
      const k = inOut(t / IN_MS);
      return { strokeDashoffset: PATH_LENGTH * (1 - k), strokeWidth: THIN + (THICK - THIN) * k };
    }
    if (drain < 0 || t < drain) return { strokeDashoffset: 0, strokeWidth: THICK };
    const k = inOut(clamp((t - drain) / OUT_MS));
    return { strokeDashoffset: PATH_LENGTH * (4 - k), strokeWidth: THICK - (THICK - THIN) * k };
  });

  const { width: W, height: H } = size;
  // The pen rides the head of the ink, nib on it, until it has run off the screen.
  const penStyle = useAnimatedStyle(() => {
    const t = time.value;
    if (t >= IN_MS) return { opacity: 0 };
    const at = inOut(t / IN_MS) * SAMPLES;
    const i = Math.min(SAMPLES - 1, Math.floor(at));
    const f = at - i;
    const x = ((PATH_X[i] + (PATH_X[i + 1] - PATH_X[i]) * f) / 1000) * W;
    const y = ((PATH_Y[i] + (PATH_Y[i + 1] - PATH_Y[i]) * f) / 1000) * H;
    const wobble = Math.sin(t / 70) * 5;
    return { opacity: 1, transform: [{ translateX: x - PEN_SIZE * NIB.x }, { translateY: y - PEN_HEIGHT * NIB.y }, { rotate: `${wobble}deg` }] };
  });

  // Ticking side to side, every 150ms.
  const markStyle = useAnimatedStyle(() => ({
    opacity: markOpacity.value,
    transform: [{ rotate: still ? "0deg" : `${Math.floor(time.value / 150) % 2 ? 4 : -4}deg` }],
  }));

  // Covered: the page underneath is uncovered as the ink drains, not before.
  const boxStyle = useAnimatedStyle(() => ({
    opacity: fade.value,
    backgroundColor: drainAt.value >= 0 && time.value >= drainAt.value ? "transparent" : c.bg,
  }));

  if (done) return null;
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      onLayout={(e: LayoutChangeEvent) => {
        const { width, height } = e.nativeEvent.layout;
        if (width !== size.width || height !== size.height) setSize({ width, height });
      }}
      pointerEvents={draining ? "none" : "auto"}
      style={[StyleSheet.absoluteFill, { zIndex: 1000, elevation: 1000, overflow: "hidden" }, boxStyle]}
    >
      {still ? null : (
        <Svg height="100%" preserveAspectRatio="none" style={StyleSheet.absoluteFill} viewBox="0 0 1000 1000" width="100%">
          <AnimatedPath
            animatedProps={inkProps}
            d={SCRIBBLE}
            fill="none"
            stroke={brand}
            strokeDasharray={DASH}
            strokeDashoffset={PATH_LENGTH}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={THIN}
          />
        </Svg>
      )}
      <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}>
        <Animated.View style={[{ flexDirection: "row", alignItems: "center", gap: 12 }, markStyle]}>
          <Image contentFit="contain" source={MARK} style={{ width: 56, height: 44 }} tintColor={c.bg} />
          <Text className="font-bold" style={{ color: c.bg, fontSize: 44, letterSpacing: -1.32 }}>
            skech
          </Text>
        </Animated.View>
      </View>
      {still ? null : (
        <Animated.View style={[{ position: "absolute", top: 0, left: 0, width: PEN_SIZE, height: PEN_HEIGHT, opacity: 0 }, styles.glow, penStyle]}>
          <View style={styles.shadow}>
            <Image contentFit="contain" source={PEN} style={{ width: PEN_SIZE, height: PEN_HEIGHT }} />
          </View>
        </Animated.View>
      )}
    </Animated.View>
  );
}

/* The web's two drop shadows on the pen: a thin white rim, then a soft grey one below. They follow the picture's shape on iOS. */
const styles = StyleSheet.create({
  glow: { shadowColor: "#ffffff", shadowOpacity: 1, shadowRadius: 1, shadowOffset: { width: 0, height: 0 } },
  shadow: { shadowColor: "#000000", shadowOpacity: 0.18, shadowRadius: 7, shadowOffset: { width: 0, height: 8 } },
});
