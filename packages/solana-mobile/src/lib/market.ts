/** Formatting prices, money and addresses, as on the web (ui/app/src/lib/market.ts). */

import { grouped } from "./money";

// --- formatting ------------------------------------------------------------

/** One rounding rule everywhere: two places over a dollar, more as the price gets small. */
export function priceDp(price: number): number {
  // Zero carries no precision, and asking it for seven decimal places is how
  // an axis ends up labelled "0.000000".
  if (!Number.isFinite(price) || price === 0) return 2;
  if (price >= 100) return 2;
  if (price >= 1) return 3;
  if (price >= 0.01) return 5;
  return 7;
}

export function usd(n: number, dp = 2): string {
  return grouped(n, dp);
}

/** A price, formatted at its own precision. */
export function price(n: number): string {
  return usd(n, priceDp(n));
}

/** Money with its sign, and a plain "$0.00" when there is nothing in it. */
export function signedUsd(n: number, dp = 2): string {
  if (Math.abs(n) < 10 ** -dp / 2) return `$${usd(0, dp)}`;
  return `${n > 0 ? "+" : "−"}$${usd(Math.abs(n), dp)}`;
}

export function signedPct(n: number, dp = 2): string {
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${usd(Math.abs(n), dp)}%`;
}

/** `0x1234…cdef`. Long enough to compare two by eye, short enough for a chip. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
