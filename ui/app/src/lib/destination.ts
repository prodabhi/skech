import { getAddress, isAddress, type Address } from "viem";

/** A plain EVM address or an EIP-681 payment destination. */
export type Destination = { address: Address; amount?: number; chainId?: number; token?: Address };

export function parseDestination(raw: string, usdc?: string | null, _network = "Arc"): Destination | { error: string } {
  const text = raw.trim().replace(/\s+/g, "");
  if (!text) return { error: "Paste or scan an address" };
  if (isAddress(text, { strict: false })) return { address: getAddress(text) };

  const match = /^(?:ethereum:)?(?:pay-)?(0x[0-9a-fA-F]{40})(?:@(\d+))?(?:\/(\w+))?(?:\?(.*))?$/.exec(text);
  if (!match) return { error: "That isn't an address" };
  const [, target, chain, fn, query] = match;
  const params = new URLSearchParams(query ?? "");
  const chainId = chain ? Number(chain) : undefined;

  if (fn === "transfer") {
    const to = params.get("address");
    if (!to || !isAddress(to, { strict: false })) return { error: "That code has no address to send to" };
    const token = getAddress(target);
    if (usdc && token.toLowerCase() !== usdc.toLowerCase()) return { error: "That code is for a different token, not USDC" };
    const units = params.get("uint256");
    const amount = units !== null && Number.isFinite(Number(units)) && Number(units) > 0 ? Number(units) / 1e6 : undefined;
    return { address: getAddress(to), token, chainId, amount: amount === undefined ? undefined : Math.floor(amount * 100) / 100 };
  }
  if (fn) return { error: "That code asks for something other than a transfer" };

  const human = params.get("amount");
  const amount = human !== null && Number.isFinite(Number(human)) && Number(human) > 0 ? Math.floor(Number(human) * 100) / 100 : undefined;
  return { address: getAddress(target), chainId, amount };
}
