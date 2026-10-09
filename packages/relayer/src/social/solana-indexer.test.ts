import { describe, expect, test } from "bun:test";
import { getPlacedEventEncoder, getSettledEventEncoder } from "@skech/contracts/solana/sdk";
import type { Address } from "@solana/kit";
import { gameEvents } from "./solana-indexer";

const PROGRAM = "2k9WY5YR357AGVVoBW6ouFHijEypTj8953fzSdD7HfRV";
const OTHER = "Evi1Program1111111111111111111111111111111";
const A = "7Qfww9Lh2o6ZPQpB81JxnA7sVvHHHfAHgR38aARDNjng" as Address;
const BET = "3hNNKVAfS95A1Rqqss7xoRS8PZceQbKCS4HCfhDsGe9s" as Address;
const data = (bytes: ArrayLike<number>) => `Program data: ${Buffer.from(Uint8Array.from(bytes)).toString("base64")}`;
const placed = data(getPlacedEventEncoder().encode({ bet: BET, player: A, drawing: 7n, index: 0, market: 0, openAt: 1_700_000_000_000n, perDot: 10_000n, unit: 1_000_000n, staked: 3_000_000n, fee: 0n, refunded: 0n, priceSeen: 0n, priceTime: 0n, strokeHash: new Uint8Array(32), sections: [{ second: 0, lo: 1n, hi: 2n, stake: 3_000_000n, rung: 1 }] }));
const settled = data(getSettledEventEncoder().encode({ bet: BET, player: A, hitMask: 1, missMask: 0, paid: 5_000_000n, owed: 0n, closed: true, expiredMask: 0, refunded: 0n }));

describe("the game's events in a transaction's logs", () => {
  test("its own placements and settlements", () => {
    const events = gameEvents([`Program ${PROGRAM} invoke [1]`, "Program log: Instruction: Place", placed, `Program ${PROGRAM} consumed 1 of 2 compute units`, `Program ${PROGRAM} success`, `Program ${PROGRAM} invoke [1]`, settled, `Program ${PROGRAM} success`], PROGRAM);
    expect(events.map((e) => e.name)).toEqual(["placed", "settled"]);
    const p = events[0].data as { player: string; drawing: bigint; staked: bigint };
    expect(p.player).toBe(A);
    expect(p.drawing).toBe(7n);
    expect(p.staked).toBe(3_000_000n);
  });

  test("never what another program writes, around or inside the game's", () => {
    const events = gameEvents([`Program ${OTHER} invoke [1]`, placed, `Program ${PROGRAM} invoke [2]`, `Program ${PROGRAM} success`, settled, `Program ${OTHER} success`, data([1, 2, 3])], PROGRAM);
    expect(events).toEqual([]);
  });

  test("a failed inner call does not leave the stack off by one", () => {
    const events = gameEvents([`Program ${PROGRAM} invoke [1]`, `Program ${OTHER} invoke [2]`, `Program ${OTHER} failed: custom program error: 0x1`, placed, `Program ${PROGRAM} success`], PROGRAM);
    expect(events.map((e) => e.name)).toEqual(["placed"]);
  });
});
