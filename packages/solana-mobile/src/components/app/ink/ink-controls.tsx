import { CheckIcon, ChevronDownIcon } from "@/components/ui/icons";
import { useRef, useState } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";
import { POINT_PRICES } from "@skech/core/odds";
import { Button, Popover, useColors } from "@/components/ui";
import type { Brush } from "@/lib/practice";
import { cn } from "@/lib/utils";

/**
 * The game's two settings, in the dock: the pen (how wide the ink is) and what one dot costs, each a pill wearing
 * its value that opens a card above it. As on the web (ui/app/src/components/app/ink/ink-controls.tsx).
 */

export const PENS: { id: Brush; name: string; dot: number; says: string }[] = [
  { id: "fine", name: "Fine", dot: 9, says: "Higher multiples" },
  { id: "medium", name: "Medium", dot: 14, says: "Balanced" },
  { id: "wide", name: "Wide", dot: 18, says: "More coverage" },
];
export const penFor = (id: Brush) => PENS.find((p) => p.id === id) ?? PENS[1];
export const amountLabel = (n: number) => `$${Number(n.toFixed(2))}`;

const PEN_MENU = 224;

const Dot = ({ size }: { size: number }) => <View className="rounded-full bg-brand" style={{ width: size, height: size }} />;

function DockButton({ onPress, children, label, ref, disabled }: { onPress: () => void; children: React.ReactNode; label: string; ref?: React.Ref<View>; disabled?: boolean }) {
  return (
    <Pressable accessibilityLabel={label} disabled={disabled} className="h-12 min-w-0 flex-1 flex-row items-center justify-center gap-2 rounded-full bg-raised px-3" onPress={onPress} ref={ref} style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.97 : 1 }] })}>
      {children}
    </Pressable>
  );
}

export function InkControls({ pen, amount, onPen, onAmount, bottom, fixed }: { pen: Brush; amount: number; onPen: (id: Brush) => void; onAmount: (n: number) => void; bottom: number; /** The price is set for this run (paper): shown, not picked. */ fixed?: boolean }) {
  const c = useColors();
  const { width, height } = useWindowDimensions();
  const [open, setOpen] = useState<"pen" | "amount" | null>(null);
  // The pen's card opens above its button, centred on it, as the web's does.
  const penButton = useRef<View>(null);
  const [penAt, setPenAt] = useState({ bottom: bottom + 76, left: 16 });
  const openPen = () => {
    if (!penButton.current) return setOpen("pen");
    penButton.current.measureInWindow((x, y, w) => {
      setPenAt({ bottom: height - y + 12, left: Math.min(width - PEN_MENU - 12, Math.max(12, x + w / 2 - PEN_MENU / 2)) });
      setOpen("pen");
    });
  };
  return (
    <View className="min-w-0 flex-1 flex-row gap-2">
      <DockButton label={`Pen:${penFor(pen).name}`} onPress={openPen} ref={penButton}>
        <Dot size={penFor(pen).dot} />
        <Text className="font-semibold text-[16px] text-foreground">{penFor(pen).name}</Text>
        <ChevronDownIcon color={c.muted} size={14} />
      </DockButton>
      <DockButton disabled={fixed} label={`${amountLabel(amount)} per dot`} onPress={() => setOpen("amount")}>
        <Text className="font-semibold text-[16px] text-foreground" style={{ fontVariant: ["tabular-nums"] }}>
          {amountLabel(amount)}
        </Text>
        {fixed ? null : <ChevronDownIcon color={c.muted} size={14} />}
      </DockButton>

      <Popover anchor={penAt} onClose={() => setOpen(null)} open={open === "pen"} width={PEN_MENU}>
        <Text className="px-2 pt-2 font-semibold text-[15px] text-foreground">Pen size</Text>
        <View className="mt-2 gap-1">
          {PENS.map((p) => (
            <Pressable
              accessibilityLabel={`Use ${p.name} pen`}
              className="h-12 flex-row items-center gap-3 rounded-xl px-3"
              key={p.id}
              onPress={() => {
                onPen(p.id);
                setOpen(null);
              }}
              style={({ pressed }) => ({ backgroundColor: pressed ? "rgba(127,127,127,0.12)" : "transparent" })}
            >
              <View className="w-6 items-center justify-center">
                <Dot size={p.dot} />
              </View>
              <Text className="flex-1 text-[16px] text-foreground">{p.name}</Text>
              {pen === p.id ? <CheckIcon color={c.fg} size={18} /> : null}
            </Pressable>
          ))}
        </View>
      </Popover>

      <Popover anchor={{ bottom: bottom + 76, right: 16 }} onClose={() => setOpen(null)} open={open === "amount"} width={272}>
        <Text className="px-2 pt-2 font-semibold text-[15px] text-foreground">Per dot</Text>
        <View accessibilityRole="radiogroup" className="mt-3 flex-row flex-wrap gap-1.5 px-1">
          {POINT_PRICES.values.map((n) => (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ checked: n === amount }}
              className={cn("h-10 items-center justify-center rounded-[10px]", n === amount ? "bg-primary" : "bg-muted")}
              key={n}
              onPress={() => {
                onAmount(n);
                setTimeout(() => setOpen(null), 120);
              }}
              style={{ width: "18.4%" }}
            >
              <Text className={cn("font-semibold text-[13px]", n === amount ? "text-primary-foreground" : "text-foreground")} style={{ fontVariant: ["tabular-nums"] }}>
                {amountLabel(n)}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text className="mt-3 px-2 pb-2 text-[12px] text-muted-foreground">A correct call returns it times its multiple.</Text>
      </Popover>
    </View>
  );
}

const DEPOSITS = [100, 1000, 10000];
const DEPOSIT_MENU = 240;

/** Practice money in: it lands in the balance at once. In the settings, beside the practice balance. */
export function DepositButton({ onDeposit }: { onDeposit: (amount: number) => void }) {
  const { width } = useWindowDimensions();
  const trigger = useRef<View>(null);
  // Under the button, its right edge on the button's, and never off the screen.
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const show = () => trigger.current?.measureInWindow((x, y, w, h) => setAt({ top: y + h + 4, right: Math.min(width - DEPOSIT_MENU - 12, Math.max(12, width - (x + w))) }));  return (
    <>
      <View ref={trigger}>
        <Button onPress={show} size="md" variant="raised">
          Deposit
        </Button>
      </View>
      <Popover anchor={at ?? { top: 0, right: 12 }} onClose={() => setAt(null)} open={at !== null} width={DEPOSIT_MENU}>
        <View className="p-2.5">
          <Text className="font-semibold text-[17px] text-foreground">Add practice money</Text>
          <Text className="mt-1 text-[14px] text-muted-foreground">It lands in your balance at once. Every point you draw is paid for from there, and every correct call paid into it.</Text>
          <View className="flex-row gap-1.5 pt-3">
            {DEPOSITS.map((a) => (
              <Pressable
                className="h-10 flex-1 items-center justify-center rounded-lg border border-border"
                key={a}
                onPress={() => {
                  onDeposit(a);
                  setAt(null);
                }}
                style={({ pressed }) => ({ backgroundColor: pressed ? "rgba(127,127,127,0.12)" : "transparent" })}
              >
                <Text className="text-[14px] text-foreground" style={{ fontVariant: ["tabular-nums"] }}>
                  ${a.toLocaleString("en-US")}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      </Popover>
    </>
  );
}
