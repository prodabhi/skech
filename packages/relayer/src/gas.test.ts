/**
 * The TypeScript model must add up exactly as the Solidity one that measured it: the snapshot carries what
 * GasModel.t.sol measured and what its model made of each batch, and this recomputes both sides here.
 */
import { describe, expect, test } from "bun:test";
import snapshot from "@skech/contracts/evm/snapshots/GasModel.json";
import { bareExecutionGas, executionGas, gasLimit, intrinsicGas, MARGIN_BPS, MODEL } from "./gas";

const t = snapshot as Record<string, string>;
const v = (k: string) => BigInt(t[k]);

describe("the snapshot", () => {
  test("has every coefficient, and they are plausible under Monad's prices", () => {
    expect(MODEL.place.piece).toBeGreaterThan(50_000n); // three fresh words and two signatures
    expect(MODEL.place.section).toBeGreaterThan(17_000n); // one fresh word at least
    expect(MODEL.place.byte).toBeGreaterThanOrEqual(8n); // a byte of event data
    expect(MODEL.settle.bar).toBeGreaterThan(17_000n);
    expect(MODEL.settle.iou).toBeGreaterThan(MODEL.settle.hit);
    expect(MODEL.session).toBeGreaterThan(3n * 17_000n);
  });
});

describe("place", () => {
  test("reproduces the Solidity model for the mixed batch and covers what was measured", () => {
    const shape = { kind: "place" as const, pieces: 3, sections: 6, strokeBytes: Number(v("check.place.3x2.mixed.strokeBytes")), coldSlots: 0 };
    expect(bareExecutionGas(shape)).toBe(v("check.place.3x2.mixed.model"));
    expect(bareExecutionGas(shape)).toBeGreaterThanOrEqual(v("check.place.3x2.mixed.measured"));
  });
  test("the first piece in an empty game pays for two fresh words", () => {
    const shape = { kind: "place" as const, pieces: 1, sections: 1, strokeBytes: 8, coldSlots: 2 };
    expect(bareExecutionGas(shape)).toBe(v("check.place.1x1.cold.model"));
    expect(bareExecutionGas(shape)).toBe(v("place.1x1.cold"));
  });
  test("eight bands on one piece, and a 12 KB stroke", () => {
    expect(bareExecutionGas({ kind: "place", pieces: 1, sections: 8, strokeBytes: 8, coldSlots: 0 })).toBe(v("check.place.1x8.model"));
    expect(bareExecutionGas({ kind: "place", pieces: 1, sections: 1, strokeBytes: 12_000, coldSlots: 0 })).toBe(v("check.place.1x1.stroke12k.model"));
  });
  test("page slack is per piece", () => {
    const shape = { kind: "place" as const, pieces: 3, sections: 6, strokeBytes: 100, coldSlots: 0 };
    expect(executionGas(shape) - bareExecutionGas(shape)).toBe(3n * MODEL.place.pageSlack);
  });
});

describe("settle", () => {
  test("three bets, one hit, no bar: the Solidity model exactly, and it covers what was measured", () => {
    const shape = { kind: "settle" as const, bars: 0, bets: 3, liveSections: 5, hits: 1, ious: 0, coldFees: false };
    expect(bareExecutionGas(shape)).toBe(v("check.settle.mixed.model"));
    expect(bareExecutionGas(shape)).toBeGreaterThanOrEqual(v("check.settle.mixed.measured"));
  });
  test("a bar with two bets on it, one hit", () => {
    const shape = { kind: "settle" as const, bars: 1, bets: 2, liveSections: 3, hits: 1, ious: 0, coldFees: false };
    expect(bareExecutionGas(shape)).toBe(v("check.bar.settle.mixed.model"));
    expect(bareExecutionGas(shape)).toBeGreaterThanOrEqual(v("check.bar.settle.mixed.measured"));
  });
  test("a hit into empty fees, a hit the pool cannot pay, a miss with four bands live", () => {
    expect(bareExecutionGas({ kind: "settle", bars: 0, bets: 1, liveSections: 1, hits: 1, ious: 0, coldFees: true })).toBe(v("check.settle.hit1.coldFees.model"));
    expect(bareExecutionGas({ kind: "settle", bars: 0, bets: 1, liveSections: 1, hits: 1, ious: 1, coldFees: false })).toBe(v("check.settle.iou1.model"));
    expect(bareExecutionGas({ kind: "settle", bars: 0, bets: 1, liveSections: 4, hits: 0, ious: 0, coldFees: false })).toBe(v("check.settle.miss1.live4.model"));
  });
  test("bars alone, and more of them", () => {
    expect(bareExecutionGas({ kind: "settle", bars: 1, bets: 0, liveSections: 0, hits: 0, ious: 0, coldFees: false })).toBe(v("bar"));
    expect(bareExecutionGas({ kind: "settle", bars: 2, bets: 0, liveSections: 0, hits: 0, ious: 0, coldFees: false })).toBe(v("bars2"));
  });
  test("cold fees are charged once, and only when something pays", () => {
    const a = bareExecutionGas({ kind: "settle", bars: 1, bets: 2, liveSections: 2, hits: 2, ious: 0, coldFees: true });
    const b = bareExecutionGas({ kind: "settle", bars: 1, bets: 2, liveSections: 2, hits: 2, ious: 0, coldFees: false });
    expect(a - b).toBe(MODEL.settle.coldFees);
    expect(bareExecutionGas({ kind: "settle", bars: 1, bets: 2, liveSections: 2, hits: 0, ious: 0, coldFees: true })).toBe(
      bareExecutionGas({ kind: "settle", bars: 1, bets: 2, liveSections: 2, hits: 0, ious: 0, coldFees: false }),
    );
  });
  test("two misses on an empty pool cost what two misses cost, not two IOUs", () => {
    const misses = bareExecutionGas({ kind: "settle", bars: 1, bets: 2, liveSections: 2, hits: 0, ious: 0, coldFees: false });
    expect(misses).toBe(MODEL.settle.txBase + MODEL.settle.bar + 2n * MODEL.settle.bet);
  });
});

describe("the transaction's own cost", () => {
  test("21,000 and the bytes", () => {
    expect(intrinsicGas("0x").standard).toBe(21_000n);
    expect(intrinsicGas("0x00").standard).toBe(21_004n);
    expect(intrinsicGas("0x11").standard).toBe(21_016n);
    expect(intrinsicGas("0x0011ff00").standard).toBe(21_000n + 4n + 16n + 16n + 4n);
  });
  test("the floor is 10 a token", () => {
    const g = intrinsicGas(`0x${"11".repeat(1000)}`);
    expect(g.standard).toBe(37_000n);
    expect(g.floor).toBe(61_000n);
  });
});

describe("the limit", () => {
  test("is the model, the bytes and the margin, up to the next thousand", () => {
    const shape = { kind: "redeem" as const };
    const data = `0x${"11".repeat(68)}` as const;
    const exact = 21_000n + 16n * 68n + MODEL.redeem;
    const limit = gasLimit(shape, data);
    expect(limit % 1000n).toBe(0n);
    expect(limit).toBeGreaterThanOrEqual(exact + (exact * MARGIN_BPS) / 10_000n);
    expect(limit).toBeLessThan(exact + (exact * MARGIN_BPS) / 10_000n + 1000n);
  });
  test("extra slack widens it", () => {
    const shape = { kind: "session" as const };
    expect(gasLimit(shape, "0x", 1000n)).toBeGreaterThan(gasLimit(shape, "0x"));
  });
  test("a stroke-heavy piece with little to run is charged the floor", () => {
    // 20 KB of set bytes: 10 a token, 4 tokens a byte, is 800,000 on the floor against 320,000 plus the model.
    const data = `0x${"11".repeat(20_000)}` as const;
    const shape = { kind: "place" as const, pieces: 1, sections: 1, strokeBytes: 20_000, coldSlots: 0 };
    const { standard, floor } = intrinsicGas(data);
    const used = standard + executionGas(shape);
    expect(gasLimit(shape, data)).toBeGreaterThanOrEqual(used > floor ? used : floor);
  });
});

