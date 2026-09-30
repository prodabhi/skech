import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { hasAuth } from "@/lib/config";
import { leastPiece } from "@/lib/relayer";
import { useAccount } from "@/components/app/auth";
import { useGate } from "@/components/app/gate";
import { Button, raised, Spinner } from "@/components/ui";
import { useChain } from "./chain-context";
import { Arrive, Breathe, MOTION } from "./motion";

/**
 * The way in for someone new: sign in, deposit USDC, draw. One quiet line over the chart, one step at a time,
 * gone once there is money to draw with, as on the web (ui/app/src/components/app/ink/onboarding.tsx).
 */

/** Whether this build plays for real money: a way to sign in. */
export const forReal = hasAuth || Platform.OS === "android";

export type Step = "signin" | "connecting" | "deposit" | "setup" | null;

export function useOnboarding(live: number): { step: Step; setupError: string | null; retrySetup: () => void } {
  const me = useAccount();
  const chain = useChain();
  const [setupError, setSetupError] = useState<string | null>(null);
  const known = chain.account !== null;
  // Not enough for one piece (1¢, the least the relayer takes), with nothing in play.
  const empty = known && chain.balance < Number(leastPiece(chain.hello)) / 1e6 && live === 0;

  let step: Step = null;
  if (!forReal) step = null;
  else if (!me.ready) step = "connecting";
  else if (!me.signedIn) step = "signin";
  else if (!chain.real || !known) step = "connecting";
  else if (empty) step = "deposit";
  else if (!chain.sessionOk) step = "setup";

  // The drawing key registers by itself, once, the moment there is money to draw with; a failure shows the card.
  // Not for a wallet on the phone: that would open the wallet unasked, so the card asks first.
  const tried = useRef(false);
  useEffect(() => {
    if (step !== "setup" || tried.current || chain.registering || !chain.key || me.kind === "wallet") return;
    tried.current = true;
    void chain.enableSession().then((why) => why && setSetupError(why));
  }, [step, chain, me.kind]);
  const retrySetup = () => {
    setSetupError(null);
    void chain.enableSession().then((why) => why && setSetupError(why));
  };
  return { step, setupError, retrySetup };
}

/** A pill over the chart, at the web's `hintPill` place. It arrives, then breathes. */
export function Pill({ children, onPress, top }: { children: React.ReactNode; onPress?: () => void; top: number }) {
  const body = (
    <Breathe>
      <View className="flex-row items-center gap-2 rounded-full border-[0.5px] border-border bg-raised px-4 py-2.5" style={raised}>
        {children}
      </View>
    </Breathe>
  );
  return (
    <View className="absolute inset-x-0 z-20 items-center" pointerEvents="box-none" style={{ top }}>
      <Arrive motion={MOTION.hintIn} pointerEvents="box-none">
        {onPress ? (
          <Pressable onPress={onPress} style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.97 : 1 }] })}>
            {body}
          </Pressable>
        ) : (
          <View pointerEvents="none">{body}</View>
        )}
      </Arrive>
    </View>
  );
}

export function Onboarding({ step, setupError, retrySetup, top }: ReturnType<typeof useOnboarding> & { top: number }) {
  const gate = useGate();
  const chain = useChain();
  const me = useAccount();
  const wallet = me.kind === "wallet";
  if (step === null || step === "signin" || step === "connecting") return null;
  if (step === "setup" && (setupError || wallet)) {
    return (
      <View className="absolute inset-0 z-20 items-center justify-center px-4" pointerEvents="box-none">
        <View className="w-full max-w-[360px] rounded-[28px] bg-raised p-6" style={raised}>
          <Text className="font-semibold text-[22px] text-foreground">One last step.</Text>
          <Text className="mt-1.5 text-[15px] text-muted-foreground">
            {wallet ? "Approve once in your wallet, and this phone places your drawings without opening it each time." : "Let this phone place your drawings."}
          </Text>
          <Button className="mt-5" disabled={chain.registering} onPress={retrySetup}>
            {chain.registering ? (
              <View className="flex-row items-center gap-2">
                <Spinner color="#fff" />
                <Text className="font-semibold text-base text-primary-foreground">Getting ready…</Text>
              </View>
            ) : (
              wallet ? "Approve in wallet" : "Allow"
            )}
          </Button>
          {setupError ? <Text className="mt-3 text-center text-destructive-foreground text-sm">{`That didn\u2019t go through: ${setupError}`}</Text> : null}
        </View>
      </View>
    );
  }
  if (step === "deposit" && chain.adding === null) {
    return (
      <Pill onPress={() => gate.openDeposit()} top={top}>
        <Text className="font-semibold text-[15px] text-foreground">Deposit USDC to play</Text>
      </Pill>
    );
  }
  const busy = step === "setup" || chain.adding !== null;
  const text = step === "deposit" ? `Adding $${chain.adding!.toFixed(2)}…` : "Getting ready…";
  return (
    <Pill top={top}>
      {busy ? <Spinner /> : null}
      <Text className="font-semibold text-[15px] text-foreground">{text}</Text>
    </Pill>
  );
}
