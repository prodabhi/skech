import { useLocalSearchParams } from "expo-router";
import { Text, View } from "react-native";
import { type Account, AccountContext } from "@/components/app/auth";
import { type Chain, ChainContext, useChain } from "@/components/app/ink/chain-context";
import { DeleteAccountSheet } from "@/components/app/sheets/delete-account-sheet";
import { DepositSheet } from "@/components/app/sheets/deposit-sheet";
import { ScoreboardSheet } from "@/components/app/sheets/scoreboard-sheet";
import { TransactionsSheet } from "@/components/app/sheets/transactions-sheet";
import { WithdrawSheet } from "@/components/app/sheets/withdraw-sheet";

/**
 * Development only: the signed-in sheets with a stand-in account, to compare against the web's, screen by screen.
 * skech://preview?sheet=deposit|withdraw|transactions|scoreboard|delete. Renders nothing in a release build.
 */
const ADDRESS = "6d5aJ8Q3wVbTzq2sR4n7hKc9Xy1LmPe8fGu3Wd710b";

export default function Preview() {
  const { sheet } = useLocalSearchParams<{ sheet?: string }>();
  const chain = useChain();
  if (!__DEV__) return null;
  const me: Account = {
    ready: true,
    signedIn: true,
    kind: "privy",
    address: ADDRESS,
    handle: "player@example.com",
    email: "player@example.com",
    signOut: () => undefined,
    signTransaction: async (t) => t,
    signTransactions: async (ts) => ts,
    signMessage: async () => "",
    sendCode: async () => null,
    sendSms: async () => null,
    verify: async () => null,
    connectWallet: async () => null,
    canConnectWallet: false,
  };
  const fake: Chain = {
    ...chain,
    real: true,
    player: ADDRESS,
    connected: true,
    sessionOk: true,
    balance: 20,
    wallet: 0,
    approved: 1_000_000,
    adding: null,
    landed: null,
    account: { player: ADDRESS, balance: "20000000", session: { key: ADDRESS, validUntil: "1790604800", allowance: "100000000000" }, owed: "0", wallet: { usdc: "0", approved: "1000000000000" } },
    hello: chain.hello ?? {
      type: "hello",
      chain: "solana",
      cluster: "devnet",
      label: "Solana devnet",
      program: "2k9WY5YR357AGVVoBW6ouFHijEypTj8953fzSdD7HfRV",
      game: "EQmnM7EP6ewPvjq81cCKmcKKzXFi5WGuciHfDtTCpyxF",
      usdc: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      lookupTable: "",
      domain: "",
      oracle: "",
      relayer: "",
      engineSigner: null,
      market: { id: 0, name: "BTC-USD" },
      difficulty: 40,
      lateMs: 200,
      units: null,
      terms: null,
      faucet: "https://faucet.circle.com/",
      activity: true,
    },
  };
  const close = () => undefined;
  return (
    <AccountContext.Provider value={me}>
      <ChainContext.Provider value={{ ...fake, hello: { ...fake.hello!, label: "Solana devnet", faucet: "https://faucet.circle.com/" } }}>
        <View className="flex-1 items-center justify-center bg-background">
          <Text className="text-muted-foreground">Preview: {sheet}</Text>
        </View>
        <DepositSheet onClose={close} open={sheet === "deposit"} />
        <WithdrawSheet onClose={close} open={sheet === "withdraw"} />
        <TransactionsSheet onClose={close} open={sheet === "transactions"} />
        <ScoreboardSheet onClose={close} open={sheet === "scoreboard"} />
        <DeleteAccountSheet onClose={close} onWithdraw={close} open={sheet === "delete"} />
      </ChainContext.Provider>
    </AccountContext.Provider>
  );
}
