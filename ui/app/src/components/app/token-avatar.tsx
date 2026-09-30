import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { BitcoinMark } from "./bitcoin-mark";
import { EthereumMark } from "./marks";

/** The token's mark. Bitcoin's and Ether's own; a monogram for anything we have no art for. */
export function TokenAvatar({ symbol, className }: { symbol: string; className?: string }) {
  if (symbol === "BTC") return <BitcoinMark className={cn("size-9 shrink-0", className)} />;
  if (symbol === "ETH") return <EthereumMark className={cn("size-9 shrink-0", className)} />;
  return (
    <Avatar className={cn("size-9 rounded-full", className)}>
      <AvatarFallback className="font-semibold text-xs">{symbol.slice(0, 3)}</AvatarFallback>
    </Avatar>
  );
}
