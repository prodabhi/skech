import { ArrowUpRightIcon } from "@/components/ui/icons";
import { useEffect, useRef, useState } from "react";
import { Animated, Linking, Pressable, Text, View } from "react-native";
import { useChain } from "@/components/app/ink/chain-context";
import { Sheet, useColors } from "@/components/ui";
import type { ActivityMsg, Incoming } from "@/lib/relayer";
import { cn } from "@/lib/utils";

/** How often the count is asked for while the sheet is open: it climbs as they play. */
const EVERY_MS = 3_000;
const figures = { fontVariant: ["tabular-nums" as const] };

/**
 * A player's transactions on Solana, as the relayer counts them: every signature that touched their account in
 * the game. Asked for as the sheet opens, and again while it stays open.
 */
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

/** 12s ago, 4 min ago, 3 h ago, 2 d ago; or nothing when the chain has no time for it yet. */
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

const short = (sig: string) => `${sig.slice(0, 6)}…${sig.slice(-4)}`;

/**
 * How hard they have played Solana: every transaction their play went out in, counted from the chain, and the
 * latest of them to look up on Solscan. The web's transactions sheet (ui/app/src/components/app/ink/transactions-sheet.tsx).
 */
export function TransactionsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const chain = useChain();
  const a = useActivity(open);
  const c = useColors();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, [open]);
  const cluster = chain.hello?.cluster === "mainnet-beta" ? "" : "?cluster=devnet";
  const label = chain.hello?.label ?? "Solana";
  const n = (v: number | undefined) => (v ?? 0).toLocaleString("en-US");
  const txUrl = (sig: string) => `https://solscan.io/tx/${sig}${cluster}`;
  const openUrl = (url: string) => void Linking.openURL(url).catch(() => undefined);

  return (
    <Sheet description={`Every piece you draw goes on ${label}.`} onClose={onClose} open={open} title="Your transactions">
      <View className="gap-1 rounded-[18px] bg-muted px-4 py-4">
        <Text className="text-[13px] text-muted-foreground">You spammed Solana with</Text>
        {a ? (
          <Text className="font-bold text-[44px] text-foreground" style={[figures, { letterSpacing: -0.9, lineHeight: 50 }]}>
            {n(a.txs)}
          </Text>
        ) : (
          <Pulse />
        )}
        <Text className="font-medium text-[15px] text-foreground">{a?.txs === 1 ? "transaction" : "transactions"}</Text>
        {a?.counting ? (
          <Text className="mt-1 text-[13px] text-muted-foreground" style={figures}>
            Still counting your history · {Math.round(a.progress * 100)}%
          </Text>
        ) : null}
      </View>

      {a?.recent.length ? (
        <View className="gap-1.5">
          <Text className="px-1 text-[13px] text-muted-foreground">Latest</Text>
          <View className="overflow-hidden rounded-[18px] bg-muted">
            {a.recent.map((r, i) => (
              <Pressable
                accessibilityHint="Opens Solscan"
                accessibilityLabel={`Transaction ${short(r.signature)}, ${ago(r.time, now)}`}
                accessibilityRole="link"
                className={cn("min-h-12 flex-row items-center justify-between gap-3 px-4 py-3", i > 0 && "border-border border-t")}
                key={r.signature}
                onPress={() => openUrl(txUrl(r.signature))}
                style={({ pressed }) => ({ backgroundColor: pressed ? "rgba(127,127,127,0.12)" : "transparent" })}
              >
                <Text className="text-[15px] text-foreground" numberOfLines={1} style={figures}>
                  {short(r.signature)}
                </Text>
                <View className="flex-row items-center gap-2">
                  <Text className="text-[13px] text-muted-foreground" style={figures}>
                    {ago(r.time, now)}
                  </Text>
                  <ArrowUpRightIcon color={c.muted} size={16} />
                </View>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      {a?.explorer ? (
        <Pressable accessibilityRole="link" className="flex-row items-center gap-1 self-start px-1 py-1" hitSlop={8} onPress={() => openUrl(a.explorer!)}>
          <Text className="font-medium text-[15px] text-brand">View all on Solscan</Text>
          <ArrowUpRightIcon color={c.brand} size={16} />
        </Pressable>
      ) : null}

      <Text className="px-1 text-[13px] text-muted-foreground">Counted once per transaction your play was in, read from your game account on chain.</Text>
    </Sheet>
  );
}

/** The dash that stands in for the count until the relayer answers, breathing as the web's does. */
function Pulse() {
  const o = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(o, { toValue: 0.4, duration: 1000, useNativeDriver: true }),
        Animated.timing(o, { toValue: 1, duration: 1000, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [o]);
  return (
    <Animated.Text className="font-bold text-[44px] text-muted-foreground" style={[figures, { opacity: o, letterSpacing: -0.9, lineHeight: 50 }]}>
      –
    </Animated.Text>
  );
}
