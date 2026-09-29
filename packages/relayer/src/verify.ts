/**
 * Checking the price a player saw before paying to put their piece on chain: the engine's EIP-712 signature over
 * it, under the domain the engine announces (`packages/engine/src/quote.rs`).
 */
import { TYPES } from "@skech/core/chain";
import { type Address, type Hex, type TypedDataDomain, verifyTypedData } from "viem";

/** Whether the engine signed this price at this time, under its domain. */
export function verifyPrice(domain: TypedDataDomain, signer: Address, market: string, priceE8: bigint, time: bigint, sig: Hex): Promise<boolean> {
  return verifyTypedData({ address: signer, domain, types: TYPES, primaryType: "Price", message: { market, price: priceE8, time }, signature: sig }).catch(() => false);
}
