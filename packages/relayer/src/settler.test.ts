/**
 * Settling when the chain says no: a bar the chain already has, different from ours, reverts every time it is
 * sent. The settler backs off, and posts the chain's own bar instead, so the bets in that second settle.
 */
import { expect, test } from "bun:test";
import type { Hex } from "viem";
import { type ChainClient, Reverted } from "./chain";
import type { Config } from "./config";
import type { Engine } from "./engine";
import { Settler } from "./settler";

const T = 1_790_000_000_000;
const PLAYER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const sent: { fn: string; args: unknown[] }[] = [];
let refuse = true;
const chain = {
  ledger: { pool: 10n ** 12n, coldFees: false, charge: () => {} },
  wallet: { signTypedData: async () => "0x" },
  events: () => [],
  // The chain has its own bar for T, from before a restart: another close.
  barAt: async (_: number, second: bigint) => (second === BigInt(T) ? [8_000_000_000_000n, 8_000_200_000_000n, 7_999_900_000_000n, 8_000_100_000_000n] : [0n, 0n, 0n, 0n]),
  send: async (fn: string, args: unknown[]) => {
    sent.push({ fn, args });
    if (refuse) throw new Reverted("bar reverted: BarConflict", "BarConflict");
    return { transactionHash: "0x01" };
  },
} as unknown as ChainClient;
const engine = {
  now: () => T + 3_000,
  ready: () => true,
  book: { bars: [{ t: T - 600_000 }], at: (s: number) => (s === T ? { h: 80_003, l: 79_999, c: 80_002 } : s === T - 1000 ? { c: 80_000 } : undefined) },
} as unknown as Engine;
const logs: string[] = [];
const settler = new Settler({ market: 0, chainId: 31337, game: "0x0000000000000000000000000000000000000001", sweepEveryMs: 1e12 } as unknown as Config, engine, chain, { settled: () => {}, owed: () => {}, account: () => {} }, (s) => logs.push(s), "/nonexistent/state.json");
const tick = () => (settler as unknown as { tick: () => Promise<void> }).tick();

test("a conflicting bar is backed off from, then posted as the chain has it", async () => {
  settler.watch(`0x${"ab".repeat(32)}` as Hex, PLAYER, 20_000_000n, { second: T, lo: 1n, hi: 2n, stake: 1n, rung: 150 });
  await tick();
  expect(sent).toHaveLength(1);
  expect((sent[0].args[0] as { close: bigint }).close).toBe(8_000_200_000_000n); // ours, from the book
  // Not sent again at once: backed off.
  await tick();
  expect(sent).toHaveLength(1);
  expect(logs.some((l) => l.includes("posting the chain's own bars"))).toBe(true);
  refuse = false;
  (settler as unknown as { retryAt: number }).retryAt = 0;
  await tick();
  expect(sent).toHaveLength(2);
  expect(sent[1].args[0]).toMatchObject({ second: BigInt(T), prevClose: 8_000_000_000_000n, high: 8_000_200_000_000n, low: 7_999_900_000_000n, close: 8_000_100_000_000n });
  expect(settler.watchers()).toBe(0);
});

