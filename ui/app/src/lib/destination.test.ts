import { describe, expect, test } from "bun:test";
import { parseDestination } from "./destination";

const A = "7Qfww9Lh2o6ZPQpB81JxnA7sVvHHHfAHgR38aARDNjng";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

describe("parseDestination", () => {
  test("a plain address, with stray whitespace", () => {
    expect(parseDestination(`  ${A}\n`)).toEqual({ address: A });
  });
  test("Solana Pay transfers", () => {
    expect(parseDestination(`solana:${A}`)).toEqual({ address: A, amount: undefined, token: undefined });
    expect(parseDestination(`solana:${A}?amount=12.345`)).toEqual({ address: A, amount: 12.34, token: undefined });
    expect(parseDestination(`solana:${A}?amount=5&spl-token=${USDC}&label=skech`, USDC)).toEqual({ address: A, amount: 5, token: USDC });
  });
  test("refuses what it cannot send to", () => {
    expect(parseDestination("")).toEqual({ error: "Paste or scan an address" });
    expect(parseDestination("hello")).toEqual({ error: "That isn't an address" });
    expect(parseDestination(`${A.slice(0, 20)}`)).toEqual({ error: "That isn't an address" });
    expect(parseDestination("0x6d5a88C06e0345Eb673bc96A86918a89a0FB710b", USDC, "Solana devnet")).toEqual({ error: "That's an address on another network. Send only to an address on Solana devnet." });
    expect(parseDestination(`solana:${A}?spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, USDC)).toEqual({ error: "That code is for a different token, not USDC" });
    expect(parseDestination("solana:https%3A%2F%2Fexample.com%2Fpay")).toEqual({ error: "That code asks for something other than a transfer" });
    expect(parseDestination("solana:nope")).toEqual({ error: "That code has no address to send to" });
  });
});
