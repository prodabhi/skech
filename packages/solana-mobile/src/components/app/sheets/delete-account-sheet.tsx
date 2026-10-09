import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import { Linking, Text, View } from "react-native";
import { useAccount } from "@/components/app/auth";
import { useChain } from "@/components/app/ink/chain-context";
import { Button, Sheet, Spinner } from "@/components/ui";
import { haptic } from "@/lib/feel";
import { money } from "@/lib/money";
import { resetPractice } from "@/lib/practice";
import { resetScoreboard } from "@/lib/scoreboard";
import { storage } from "@/lib/storage";

/*
  Deleting an account, as the stores ask an app to offer from inside it. The request itself is completed on the
  site, which can check who is asking; here the phone says plainly what deleting does and does not do, sends them
  there, then signs out and forgets everything it kept: the session key, practice money, the session's rounds,
  the saved wallet. Light or dark stays: it is the phone's look, not the person's.
*/

const DELETE_URL = "https://www.skech.trade/delete-account";
/** theme.ts's key. */
const THEME = "theme";

export function DeleteAccountSheet({ open, onClose, onWithdraw }: { open: boolean; onClose: () => void; onWithdraw: () => void }) {
  const me = useAccount();
  const chain = useChain();
  const [busy, setBusy] = useState(false);
  const label = chain.hello?.label ?? "Solana";
  const balance = chain.real ? chain.balance : 0;

  const remove = async () => {
    haptic("tap");
    setBusy(true);
    try {
      await WebBrowser.openBrowserAsync(DELETE_URL);
    } catch {
      // No in-app browser on this phone: the default one will do.
      await Linking.openURL(DELETE_URL).catch(() => undefined);
    }
    await chain.forgetKey().catch(() => undefined);
    me.signOut();
    resetPractice();
    resetScoreboard();
    const theme = storage.getString(THEME);
    storage.clearAll();
    if (theme) storage.set(THEME, theme);
    setBusy(false);
    onClose();
  };

  return (
    <Sheet description="Deleting your account removes your sign-in and your personal details, such as your email or phone number, from skech." onClose={onClose} open={open} title="Delete account">
      <View className="gap-3 rounded-[14px] bg-muted px-4 py-3.5">
        <Text className="font-semibold text-[15px] text-foreground">Withdraw your balance first</Text>
        <Text className="text-[14px] text-muted-foreground leading-[20px]">Once your account is deleted, you may not be able to get back what is left in it.</Text>
        {balance > 0 ? (
          <View className="flex-row items-center justify-between gap-3">
            <View>
              <Text className="text-[13px] text-muted-foreground">Your balance</Text>
              <Text className="font-semibold text-[17px] text-foreground" style={{ fontVariant: ["tabular-nums"] }}>
                {money(balance)}
              </Text>
            </View>
            <Button onPress={onWithdraw} size="md" variant="raised">
              Withdraw
            </Button>
          </View>
        ) : null}
      </View>
      <Text className="px-1 text-[14px] text-muted-foreground leading-[20px]">
        {`Records on the public ${label} blockchain, such as your deposits, drawings and withdrawals, can’t be erased by skech or anyone else.`}
      </Text>
      <Text className="px-1 text-[14px] text-muted-foreground leading-[20px]">You’ll finish the request on skech.trade. This phone then signs you out and forgets everything skech kept on it.</Text>
      <Button className="bg-destructive" disabled={busy} onPress={() => void remove()}>
        {busy ? <Spinner color="#fff" /> : <Text className="font-semibold text-base text-white">Delete account</Text>}
      </Button>
      <Button disabled={busy} onPress={onClose} variant="ghost">
        Cancel
      </Button>
    </Sheet>
  );
}
