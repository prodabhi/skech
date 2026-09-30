import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Animated, type GestureResponderEvent, type LayoutChangeEvent, Text, View } from "react-native";
import Svg, { Circle, Line as SvgLine, Path } from "react-native-svg";
import { fmtMultiple } from "@/components/app/ink/stage";
import { Button, Sheet, useColors } from "@/components/ui";
import { money, signed } from "@/lib/money";
import { usePracticeOf } from "@/lib/practice";
import { curve, resetScoreboard, type Scoreboard, useScoreboard } from "@/lib/scoreboard";
import { useDark } from "@/lib/theme";
import { cn } from "@/lib/utils";

const figures = { fontVariant: ["tabular-nums" as const] };

/** `--success-foreground`, as `src/global.css` has it, for the line: the icons' green is a shade lighter. */
function useSuccessInk() {
  return useDark() ? "#30d158" : "#248a3d";
}

/**
 * This session's returns: what they came to, how they built up, and the best of them. Only what came back is
 * shown here; the balance is the full picture, losses and all. Opened from the number beside the balance. The
 * web's scoreboard (ui/app/src/components/app/ink/scoreboard-sheet.tsx).
 */
export function ScoreboardSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useScoreboard();
  // Only the all-time bests: the rest of the store moves with every piece placed.
  const all = usePracticeOf("bestHit", "bestStreak");
  const rounds = s.rounds.length;
  const ahead = s.rounds.filter((r) => r.won > r.cost);
  // From the first round to the last: pure, and what the session actually spanned.
  const minutes = rounds ? Math.max(1, Math.round((s.lastAt - Math.min(...s.rounds.map((r) => r.at))) / 60_000)) : 0;
  return (
    <Sheet description={rounds ? `${rounds} ${rounds === 1 ? "round" : "rounds"} over ${minutes} min` : "Nothing yet. Draw ahead of the price."} onClose={onClose} open={open} title="This session">
      <View className="gap-1 rounded-[18px] bg-muted px-4 pt-4 pb-3">
        <Text className="text-[13px] text-muted-foreground">Earned this session</Text>
        <Pop k={s.won}>
          <Text className={cn("font-bold text-[40px]", s.won > 0 ? "text-success-foreground" : "text-foreground")} style={[figures, { letterSpacing: -0.8, lineHeight: 46 }]}>
            {s.won > 0 ? `+${money(s.won)}` : money(0)}
          </Text>
        </Pop>
        {s.streak >= 2 ? (
          <View className="mt-1 self-start rounded-full bg-brand/12 px-2.5 py-0.5">
            <Text className="font-semibold text-[13px] text-brand">{s.streak} profitable rounds running</Text>
          </View>
        ) : null}
        {rounds >= 2 ? <Line s={s} /> : null}
      </View>

      <View className="flex-row flex-wrap gap-2">
        <Stat label="Rounds in profit" value={s.wins ? String(s.wins) : "–"} />
        <Stat label="Best call" value={s.best ? fmtMultiple(s.best) : "–"} />
        <Stat good={s.biggest > 0} label="Best round" value={s.biggest > 0 ? signed(s.biggest) : "–"} />
        <Stat label="Run now" value={s.streak ? String(s.streak) : "–"} />
        <Stat label="Longest run" value={s.bestStreak ? String(s.bestStreak) : "–"} />
        <Stat label="Correct calls" value={s.hits ? String(Math.round(s.hits)) : "–"} />
      </View>

      {ahead.length ? (
        <View className="gap-1.5">
          <Text className="px-1 text-[13px] text-muted-foreground">Rounds in profit</Text>
          <View className="overflow-hidden rounded-[18px] bg-muted">
            {ahead.slice(0, 25).map((r, i) => {
              const n = Math.round((r.won - r.cost) * 100) / 100;
              return (
                <View className={cn("flex-row items-center justify-between gap-3 px-4 py-3", i > 0 && "border-border border-t")} key={r.id}>
                  <View className="min-w-0 flex-1">
                    <Text className="font-medium text-[15px] text-foreground">{r.best >= 10 ? "Strong call" : "Profit"}</Text>
                    <Text className="text-[13px] text-muted-foreground" numberOfLines={1} style={figures}>
                      {new Date(r.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · {money(r.cost)}
                      {r.best ? ` · best ${fmtMultiple(r.best)}` : ""}
                    </Text>
                  </View>
                  <Text className="font-semibold text-[15px] text-success-foreground" style={figures}>
                    {signed(n)}
                  </Text>
                </View>
              );
            })}
          </View>
        </View>
      ) : null}

      {all.bestHit || all.bestStreak ? (
        <Text className="px-1 text-[13px] text-muted-foreground" style={figures}>
          All time: best call {all.bestHit ? fmtMultiple(all.bestHit) : "–"}, longest run {all.bestStreak}
        </Text>
      ) : null}

      {rounds ? (
        <Button className="self-start" onPress={resetScoreboard} size="md" variant="ghost">
          Start a new session
        </Button>
      ) : null}
    </Sheet>
  );
}

/** Two to a row, as the web's grid is on a phone. */
function Stat({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <View className="gap-0.5 rounded-[14px] bg-muted px-3.5 py-2.5" style={{ flexBasis: "47%", flexGrow: 1 }}>
      <Text className="text-[12px] text-muted-foreground">{label}</Text>
      <Text className={cn("font-semibold text-[17px]", good ? "text-success-foreground" : "text-foreground")} style={figures}>
        {value}
      </Text>
    </View>
  );
}

/** The web's landed pop: the number grows a touch and settles each time it changes. */
function Pop({ k, children }: { k: number; children: ReactNode }) {
  const a = useRef(new Animated.Value(1)).current;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    a.setValue(0.9);
    Animated.spring(a, { toValue: 1, useNativeDriver: true, speed: 18, bounciness: 14 }).start();
  }, [k, a]);
  return <Animated.View style={{ alignSelf: "flex-start", transform: [{ scale: a }] }}>{children}</Animated.View>;
}

/**
 * What came back in total after each round, from zero: it only climbs. One series, so no legend: the card's
 * title names it. A finger on it reads a round.
 */
function Line({ s }: { s: Scoreboard }) {
  const pts = useMemo(() => curve(s), [s]);
  const [at, setAt] = useState<number | null>(null);
  const [W, setW] = useState(0);
  const c = useColors();
  const colour = useSuccessInk();
  const reveal = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(reveal, { toValue: 1, duration: 900, useNativeDriver: true }).start();
  }, [reveal]);

  const H = 72;
  const pad = 4;
  const lo = Math.min(0, ...pts);
  const hi = Math.max(0, ...pts);
  const span = hi - lo || 1;
  const x = (i: number) => pad + (i / (pts.length - 1)) * (W - 2 * pad);
  const y = (v: number) => pad + (1 - (v - lo) / span) * (H - 2 * pad);
  const d = W ? pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("") : "";
  const last = pts.at(-1)!;

  const pick = (e: GestureResponderEvent) => {
    if (!W) return;
    const i = Math.round((e.nativeEvent.locationX / W) * (pts.length - 1));
    setAt(Math.max(1, Math.min(pts.length - 1, i)));
  };
  const round = at !== null ? pts[at] - pts[at - 1] : 0;

  return (
    <View className="mt-2">
      <Text accessibilityLiveRegion="polite" className="h-5 text-[13px] text-muted-foreground" numberOfLines={1} style={figures}>
        {at !== null ? (
          <>
            Round {at}: {round > 0 ? <Text className="text-success-foreground">+{money(round)}</Text> : "nothing back"}, {money(pts[at])} earned so far
          </>
        ) : (
          "Your earnings, round by round"
        )}
      </Text>
      <Animated.View
        accessibilityLabel={`Earnings after each of ${pts.length - 1} rounds, ${money(last)} in all`}
        accessible
        onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={pick}
        onResponderMove={pick}
        onResponderRelease={() => setAt(null)}
        onResponderTerminate={() => setAt(null)}
        onResponderTerminationRequest={() => false}
        onStartShouldSetResponder={() => true}
        style={{ height: H, opacity: reveal }}
      >
        {W ? (
          <Svg height={H} pointerEvents="none" width={W}>
            <SvgLine stroke={c.border} strokeDasharray="3 4" strokeWidth={1} x1={0} x2={W} y1={y(0)} y2={y(0)} />
            <Path d={d} fill="none" stroke={colour} strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
            {at !== null ? (
              <>
                <SvgLine opacity={0.4} stroke={c.muted} strokeWidth={1} x1={x(at)} x2={x(at)} y1={0} y2={H} />
                <Circle cx={x(at)} cy={y(pts[at])} fill={colour} r={5} stroke={c.secondary} strokeWidth={2} />
              </>
            ) : null}
          </Svg>
        ) : null}
      </Animated.View>
    </View>
  );
}
