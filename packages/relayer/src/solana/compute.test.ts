import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chunksFor, MAX_CU, settleCompute } from "./compute";

const snapshot = JSON.parse(readFileSync(join(import.meta.dir, "../../../contracts/solana/snapshots/compute.json"), "utf8")) as Record<string, number>;

describe("a settlement's compute", () => {
  test("is budgeted by the bands it decides, not only by its bets", () => {
    const one = settleCompute(snapshot, true, [{ sections: 1, decided: 1 }]);
    const full = settleCompute(snapshot, true, [{ sections: 32, decided: 32 }]);
    expect(full).toBeGreaterThan(one + 31 * (snapshot.settle_section + snapshot.settle_decided));
    // A holder to open, and one deep in its bump search, cost more.
    const opening = settleCompute(snapshot, true, [{ sections: 1, decided: 1, openBump: 255 }]);
    expect(opening - one).toBeGreaterThanOrEqual(snapshot.holder_open);
    expect(settleCompute(snapshot, true, [{ sections: 1, decided: 1, openBump: 248 }]) - opening).toBeGreaterThanOrEqual(7 * snapshot.place_per_bump);
  });

  test("never asks for more than a transaction may have", () => {
    const loads = Array.from({ length: 100 }, () => ({ sections: 32, decided: 32, openBump: 240 }));
    expect(settleCompute(snapshot, true, loads)).toBe(MAX_CU);
  });

  // The audit's scenario: one wallet, nine pieces of 32 bands at 1 micro-USDC each, all in one second.
  test("nine full pieces in one second are budgeted for all their bands", () => {
    const bets = Array.from({ length: 9 }, () => ({ sections: 32, decided: 32, openBump: 248 }));
    const chunks = chunksFor(snapshot, true, bets, (b) => b, 9);
    // What LiteSVM measured them at (limits.rs `nine_dust_pieces_in_one_second_settle_within_the_budget`): under.
    const parts = snapshot.post_bar + 9 * (snapshot.settle_bet + 32 * (snapshot.settle_section + snapshot.settle_decided)) + 9 * (snapshot.holder_open + 7 * snapshot.place_per_bump);
    const asked = chunks.reduce((n, c, i) => n + settleCompute(snapshot, i === 0, c), 0);
    expect(asked).toBeGreaterThanOrEqual(parts);
    for (const [i, c] of chunks.entries()) expect(settleCompute(snapshot, i === 0, c)).toBeLessThan(MAX_CU);
  });

  test("cuts bets into settlements by bytes and by compute, in order", () => {
    const bets = Array.from({ length: 30 }, (_, i) => i);
    const small = chunksFor(snapshot, true, bets, () => ({ sections: 1, decided: 1 }), 9);
    expect(small.map((c) => c.length)).toEqual([9, 9, 9, 3]);
    expect(small.flat()).toEqual(bets);
    // A made-up cost so dear that two bets cannot share a settlement: each goes alone.
    const dear = chunksFor({ ...snapshot, settle_bet: 600_000 }, true, bets.slice(0, 4), () => ({ sections: 1, decided: 1 }), 9);
    expect(dear.map((c) => c.length)).toEqual([1, 1, 1, 1]);
    // No bets: one settlement, the bar alone.
    expect(chunksFor(snapshot, true, [], () => ({ sections: 0, decided: 0 }), 9)).toEqual([[]]);
  });
});
