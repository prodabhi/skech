import { type ReactNode, useRef, useState } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";
import { useGate } from "@/components/app/gate";
import { Button, Popover } from "@/components/ui";
import { haptic } from "@/lib/feel";
import { money } from "@/lib/money";
import { useChain } from "./chain-context";

/**
 * The wallet menu: the balance, what is owed, and the two ways money moves: Deposit and Withdraw, each its own
 * sheet. It opens from the balance on the game screen, which is its `children`, so the balance is shown once. As on
 * the web (ui/app/src/components/app/ink/wallet-button.tsx).
 */
export function WalletButton({ accessibilityLabel, className, children }: { accessibilityLabel: string; className?: string; children: ReactNode }) {
  const chain = useChain();
  const gate = useGate();
  const { width } = useWindowDimensions();
  const trigger = useRef<View>(null);
  // Under the balance, its right edge on the balance's, and never off the screen.
  const menu = Math.min(360, width - 24);
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const owed = chain.account ? Number(chain.account.owed) / 1e6 : 0;
  const show = () => {
    haptic("tap");
    trigger.current?.measureInWindow((x, y, w, h) => setAt({ top: y + h + 4, right: Math.min(width - menu - 12, Math.max(12, width - (x + w))) }));
  };
  const then = (open: () => void) => () => {
    setAt(null);
    open();
  };
  return (
    <>
      <Pressable accessibilityLabel={accessibilityLabel} accessibilityRole="button" className={className} onPress={show} ref={trigger} style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.96 : 1 }] })}>
        {children}
      </Pressable>
      <Popover anchor={at ?? { top: 0, right: 12 }} onClose={() => setAt(null)} open={at !== null} width={menu}>
        <View className="p-2.5">
          <Text className="text-[13px] text-muted-foreground">Your balance</Text>
          <Text className="mt-0.5 font-bold text-[32px] text-foreground" style={{ fontVariant: ["tabular-nums"] }}>
            {money(chain.balance)}
          </Text>
          {owed > 0 ? (
            <Text className="mt-1 text-[14px] text-muted-foreground">
              + <Text className="text-foreground" style={{ fontVariant: ["tabular-nums"] }}>{money(owed)}</Text> owed to you, paid as other players lose
            </Text>
          ) : null}
          <View className="mt-4 flex-row gap-2">
            <Button className="flex-1" onPress={then(gate.openDeposit)} size="md" textClassName="text-[15px]">
              Deposit
            </Button>
            <Button className="flex-1" disabled={chain.balance <= 0} onPress={then(gate.openWithdraw)} size="md" textClassName="text-[15px]" variant="secondary">
              Withdraw
            </Button>
          </View>
        </View>
      </Popover>
    </>
  );
}
