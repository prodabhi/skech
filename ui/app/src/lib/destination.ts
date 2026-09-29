import { isAddress } from "@solana/kit";

/*
  Where a withdrawal goes, from whatever the player pasted or scanned.

  People paste an address, and wallets put one of these in their "receive" QR codes:
    7xKX…                                      the address alone, base58
    solana:7xKX…                               Solana Pay, a transfer to it
    solana:7xKX…?amount=5&spl-token=EPjF…      Solana Pay with an amount, in dollars, of a token
  plus stray spaces and a trailing newline. A Solana Pay transaction request (solana:https://…) is not a
  transfer, and an Ethereum address is on another network. What comes back is the recipient, and whatever else
  the code said: an amount of USDC, a token. The phone reads them the same way.
*/

export type Destination = { address: string; amount?: number; token?: string };

export function parseDestination(raw: string, usdc?: string | null, network = "Solana"): Destination | { error: string } {
  const text = raw.trim().replace(/\s+/g, "");
  if (!text) return { error: "Paste or scan an address" };
  if (isAddress(text)) return { address: text };
  if (/^(?:ethereum:)?(?:pay-)?0x[0-9a-fA-F]{40}/.test(text)) return { error: `That's an address on another network. Send only to an address on ${network}.` };
  const m = /^solana:([^?]+)(?:\?(.*))?$/i.exec(text);
  if (!m) return { error: "That isn't an address" };
  let target = m[1];
  try {
    target = decodeURIComponent(target);
  } catch {
    /* as it is */
  }
  if (/^https?:/i.test(target)) return { error: "That code asks for something other than a transfer" };
  if (!isAddress(target)) return { error: "That code has no address to send to" };
  const params = new URLSearchParams(m[2] ?? "");
  const token = params.get("spl-token") ?? undefined;
  if (token && usdc && token !== usdc) return { error: "That code is for a different token, not USDC" };
  const human = params.get("amount");
  const amount = human !== null && Number.isFinite(Number(human)) && Number(human) > 0 ? Math.floor(Number(human) * 100) / 100 : undefined;
  return { address: target, amount, token };
}
