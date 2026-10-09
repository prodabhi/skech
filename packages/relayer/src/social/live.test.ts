import { describe, expect, test } from "bun:test";
import { encodeStroke } from "@skech/core/chain";
import type { PlayerProfile } from "@skech/core/social";
import { KEEP_MS, LiveBook, strokeHash } from "./live";
import type { Placement } from "./store";

const A = "7Qfww9Lh2o6ZPQpB81JxnA7sVvHHHfAHgR38aARDNjng";
const profile: PlayerProfile = { player: A, username: null, bio: "", avatar: false, avatarSeed: null, joinedAt: 0, followers: 0, following: 0 };
const T0 = 1_700_000_000_000;
const stroke = encodeStroke({ t0: T0, p0: 60_000, rt: 300, rp: 5, from: 0, pts: [{ t: 0, p: 0 }, { t: 500, p: 2 }] });
const other = encodeStroke({ t0: T0, p0: 60_000, rt: 300, rp: 5, from: 0, pts: [{ t: 0, p: 0 }, { t: 500, p: 7 }] });
const section = (second: number, stake: number) => ({ second, lo: "1", hi: "2", stake: String(stake), rung: 1 });
const piece = (over: Partial<Placement> = {}): Placement => ({ betId: "b1", player: A, drawing: "1", openAt: BigInt(T0), staked: 3n, unit: 1n, sections: [section(0, 1), section(1, 2)], tx: "t", ...over });

describe("the drawings in play, in memory", () => {
  test("placed, settled and totalled as the store totals them; each told once", () => {
    const book = new LiveBook(() => T0);
    const d = book.placed(piece(), profile)!;
    expect(d.stake).toBe("3");
    expect(d.complete).toBe(false);
    expect(book.placed(piece(), profile)).toBeNull();
    expect(book.settled({ betId: "b1", player: A, hitMask: 1, missMask: 0, paid: 5n, owed: 0n, tx: "s1" })?.pnl).toBe("4");
    // The same band again does not count again.
    expect(book.settled({ betId: "b1", player: A, hitMask: 1, missMask: 0, paid: 5n, owed: 0n, tx: "s2" })).toBeNull();
    const done = book.settled({ betId: "b1", player: A, hitMask: 0, missMask: 0, expiredMask: 2, paid: 2n, owed: 0n, tx: "s3" })!;
    expect(done.complete).toBe(true);
    expect(done.pnl).toBe("4");
    expect(book.settled({ betId: "nope", player: A, hitMask: 1, missMask: 0, paid: 1n, owed: 0n, tx: "x" })).toBeNull();
  });

  test("a stroke is kept only if it hashes to the chain's hash, and only the first", () => {
    const book = new LiveBook(() => T0);
    expect(book.placed(piece({ strokeHash: strokeHash(stroke), stroke: other }), profile)?.pieces[0].stroke).toBeNull();
    expect(book.stroke("b1", other)).toBeNull();
    expect(book.stroke("b1", stroke)?.pieces[0].stroke?.pts).toHaveLength(2);
    expect(book.stroke("b1", stroke)).toBeNull();
    // With no hash known, only the relayer's (trusted) stroke is taken.
    book.placed(piece({ betId: "b2", drawing: "2" }), profile);
    expect(book.stroke("b2", stroke)).toBeNull();
    expect(book.stroke("b2", stroke, true)?.pieces[0].stroke).not.toBeNull();
  });

  test("forgets drawings quiet for ten minutes", () => {
    let now = T0;
    const book = new LiveBook(() => now);
    book.placed(piece(), profile);
    expect(book.recent(60_000)).toHaveLength(1);
    now += KEEP_MS + 1;
    book.prune();
    expect(book.size).toBe(0);
  });
});
