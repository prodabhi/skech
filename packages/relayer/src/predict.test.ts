/**
 * The same numbers SkechGame.t.sol asserts, worked out here: a hit is judged one unit wider each way, a jump
 * across a band counts, and payouts come from the pool until it is empty.
 */
import { describe, expect, test } from "bun:test";
import type { Hex } from "viem";
import { type Band, hits, predictSettle, type PostedBar } from "./predict";

// The contract tests' grid: $0.20 units on an $83,591 price; a band from $83,591.40 to $83,592.00.
const UNIT = 20_000_000n;
const LO = 8_359_140_000_000n;
const HI = 8_359_200_000_000n;
const T = 1_790_000_001_000;
const band = (stake: bigint, rung: number, lo = LO, hi = HI, second = T): Band => ({ second, lo, hi, stake, rung });
const bar = (prevClose: bigint, high: bigint, low: bigint, second = T): PostedBar => ({ second, prevClose, high, low });
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const bars = (...b: PostedBar[]) => new Map(b.map((x) => [x.second, x]));

describe("a hit", () => {
  test("is judged one unit wider each way, edges inclusive", () => {
    // test_aHitPaysFromThePoolLessTheProfitFee: the price reaches lo - unit, no further.
    expect(hits(band(1n, 150), UNIT, bar(LO - 5n * UNIT, LO - UNIT, LO - 6n * UNIT))).toBe(true);
    expect(hits(band(1n, 150), UNIT, bar(LO - 5n * UNIT, LO - UNIT - 1n, LO - 6n * UNIT))).toBe(false);
    expect(hits(band(1n, 150), UNIT, bar(HI + 5n * UNIT, HI + 6n * UNIT, HI + UNIT))).toBe(true);
    expect(hits(band(1n, 150), UNIT, bar(HI + 5n * UNIT, HI + 6n * UNIT, HI + UNIT + 1n))).toBe(false);
  });
  test("counts a jump from the close before across the band", () => {
    // test_aJumpAcrossTheBandCountsAsCrossingIt: the second before closed below, this one traded only above.
    expect(hits(band(1n, 150), UNIT, bar(LO - 10n * UNIT, HI + 10n * UNIT, HI + 5n * UNIT))).toBe(true);
  });
});

describe("settling", () => {
  test("half a dot at 1.5x: 75,000 gross, 2,500 to the house, paid in full", () => {
    const p = predictSettle([{ betId: id(1), unit: UNIT, bands: [band(50_000n, 150)] }], bars(bar(LO, HI, LO)), 1_008_000n, 1000n);
    expect(p).toMatchObject({ hits: 1, ious: 0, liveSections: 1, poolAfter: 1_008_000n - 75_000n });
    expect(p.due.get(id(1))).toEqual({ gross: 75_000n, fee: 2_500n });
  });
  test("half a dot at 8x on a 48,000 pool: owed", () => {
    // test_whatThePoolCannotPayIsOwedAsIOU: 400,000 gross, 35,000 fee, the pool pays 48,000.
    const p = predictSettle([{ betId: id(1), unit: UNIT, bands: [band(50_000n, 800)] }], bars(bar(LO, HI, LO)), 48_000n, 1000n);
    expect(p).toMatchObject({ hits: 1, ious: 1, poolAfter: 0n });
    expect(p.due.get(id(1))).toEqual({ gross: 400_000n, fee: 35_000n });
  });
  test("a miss costs a read and nothing else", () => {
    const far = 40n * UNIT;
    const p = predictSettle([{ betId: id(1), unit: UNIT, bands: [band(50_000n, 150, LO + far, HI + far)] }], bars(bar(LO, HI, LO)), 0n, 1000n);
    expect(p).toMatchObject({ hits: 0, ious: 0, liveSections: 1, poolAfter: 0n });
  });
  test("bands whose second is not being posted stay live: read, not decided", () => {
    const later = band(50_000n, 150, LO, HI, T + 5000);
    const p = predictSettle([{ betId: id(1), unit: UNIT, bands: [band(50_000n, 150), later] }], bars(bar(LO, HI, LO)), 1_000_000n, 1000n);
    expect(p).toMatchObject({ hits: 1, liveSections: 2 });
    expect(p.due.get(id(1))?.gross).toBe(75_000n);
  });
  test("two hit bands in one second pay once, together", () => {
    const p = predictSettle([{ betId: id(1), unit: UNIT, bands: [band(50_000n, 150), band(50_000n, 200, LO - 3n * UNIT, LO)] }], bars(bar(LO, HI, LO)), 1_000_000n, 1000n);
    expect(p).toMatchObject({ hits: 1, liveSections: 2 });
    // 75,000 + 100,000 gross on 100,000 staked: 75,000 profit, 7,500 to the house.
    expect(p.due.get(id(1))).toEqual({ gross: 175_000n, fee: 7_500n });
  });
  test("the pool pays in order: the first bet in full, the second owed", () => {
    const p = predictSettle(
      [
        { betId: id(1), unit: UNIT, bands: [band(50_000n, 150)] },
        { betId: id(2), unit: UNIT, bands: [band(50_000n, 150)] },
      ],
      bars(bar(LO, HI, LO)),
      100_000n,
      1000n,
    );
    expect(p).toMatchObject({ hits: 2, ious: 1, poolAfter: 0n });
  });
  test("an unknown pool, or unknown bands, assume the worst", () => {
    expect(predictSettle([{ betId: id(1), unit: UNIT, bands: [band(50_000n, 150)] }], bars(bar(LO, HI, LO)), null, 1000n)).toMatchObject({ hits: 1, ious: 1 });
    expect(predictSettle([{ betId: id(1), unit: UNIT, bands: null }], bars(), 5_000_000n, 1000n)).toMatchObject({ hits: 1, ious: 1, liveSections: 1 });
  });
});

