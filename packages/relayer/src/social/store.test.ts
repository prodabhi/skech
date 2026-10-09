/**
 * Against a real Postgres, given by SOCIAL_TEST_DATABASE_URL: a database of its own (its name ends in _test), since
 * the schema is dropped first. Skipped without one.
 *
 *   docker run -d --name skech-social-pg -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=skech postgres:17
 *   docker exec skech-social-pg psql -U postgres -c "CREATE DATABASE skech_test"
 *   SOCIAL_TEST_DATABASE_URL=postgres://postgres:skech@127.0.0.1:55432/skech_test bun test src/social
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { encodeStroke } from "@skech/core/chain";
import { SocialStore, strokeHashOf, type Placement } from "./store";

const url = process.env.SOCIAL_TEST_DATABASE_URL;
const usable = !!url && new URL(url).pathname.endsWith("_test");

const A = "7Qfww9Lh2o6ZPQpB81JxnA7sVvHHHfAHgR38aARDNjng";
const B = "3hNNKVAfS95A1Rqqss7xoRS8PZceQbKCS4HCfhDsGe9s";
const C = "CfdwxkjtYH1ULBg3uEFAjqSLLxQGxUcn7tBY2kkvByaj";
const T0 = Date.now() - 60_000;
const section = (second: number, stake: number) => ({ second, lo: "6000000000000", hi: "6000100000000", stake: String(stake), rung: 1 });
const piece = (over: Partial<Placement> = {}): Placement => ({ betId: "bet1", player: A, drawing: "1", openAt: BigInt(T0), staked: 3_000_000n, unit: 1_000_000n, sections: [section(0, 1_000_000), section(1, 2_000_000)], tx: "txA", ...over });

describe.skipIf(!usable)("social store (Postgres)", () => {
  let store: SocialStore;
  beforeAll(async () => {
    const admin = new SQL(url!);
    await admin`DROP SCHEMA IF EXISTS skech_social CASCADE`;
    await admin.close();
    store = new SocialStore(url!, "solana-devnet:Game");
    await store.start();
  });
  afterAll(() => store?.close());

  test("start again on the same database, and refuse another deployment's", async () => {
    await store.start();
    const other = new SocialStore(url!, "solana-mainnet-beta:Other");
    await expect(other.start()).rejects.toThrow("this database is for solana-devnet:Game");
    await other.close();
  });

  test("a placement counts once, and a settlement once, however often they are told", async () => {
    const first = await store.place(piece());
    expect(first?.stake).toBe("3000000");
    expect(first?.complete).toBe(false);
    expect(await store.place(piece())).toBeNull();
    // The first band hits and pays 2.5, the second misses.
    const hit = await store.settle({ betId: "bet1", player: A, hitMask: 1, missMask: 0, paid: 2_500_000n, owed: 0n, tx: "txS1", at: T0 + 2000 });
    expect(hit?.paid).toBe("2500000");
    expect(hit?.settledStake).toBe("1000000");
    expect(await store.settle({ betId: "bet1", player: A, hitMask: 1, missMask: 0, paid: 2_500_000n, owed: 0n, tx: "txS1", at: T0 + 2000 })).toBeNull();
    // The same band told again in another transaction is not counted again.
    await store.settle({ betId: "bet1", player: A, hitMask: 1, missMask: 0, paid: 2_500_000n, owed: 0n, tx: "txS1b", at: T0 + 2500 });
    const done = await store.settle({ betId: "bet1", player: A, hitMask: 0, missMask: 2, paid: 0n, owed: 0n, tx: "txS2", at: T0 + 3000 });
    expect(done?.complete).toBe(true);
    expect(done?.paid).toBe("2500000");
    expect(done?.pnl).toBe("-500000");
    expect(await store.knows("txA")).toBe(true);
    expect(await store.knows("txS2")).toBe(true);
    expect(await store.knows("nope")).toBe(false);
  });

  test("a settlement read before its placement counts when the placement comes", async () => {
    await store.settle({ betId: "bet2", player: B, hitMask: 1, missMask: 0, paid: 4_000_000n, owed: 1_000_000n, tx: "txS3", at: T0 + 2000 });
    const d = await store.place(piece({ betId: "bet2", player: B, drawing: "9", staked: 1_000_000n, sections: [section(0, 1_000_000)], tx: "txB" }));
    expect(d?.complete).toBe(true);
    expect(d?.paid).toBe("4000000");
    expect(d?.owed).toBe("1000000");
    expect(d?.pnl).toBe("4000000");
  });

  test("a band given back counts as settled, its refund as paid: nothing gained", async () => {
    await store.place(piece({ betId: "bet3", player: C, drawing: "5", staked: 2_000_000n, sections: [section(0, 2_000_000)], tx: "txC" }));
    const d = await store.settle({ betId: "bet3", player: C, hitMask: 0, missMask: 0, expiredMask: 1, paid: 2_000_000n, owed: 0n, tx: "txE", at: T0 + 4000 });
    expect(d?.complete).toBe(true);
    expect(d?.pnl).toBe("0");
  });

  test("a stroke from the relayer fills in a piece read from the chain", async () => {
    const stroke = encodeStroke({ t0: T0, p0: 60_000, rt: 300, rp: 5, from: 0, pts: [{ t: 0, p: 0 }, { t: 500, p: 2 }] });
    await store.place(piece({ betId: "bet4", drawing: "2", tx: "txD" }));
    expect((await store.drawing(`${A}:2`))?.pieces[0].stroke).toBeNull();
    const filled = await store.place(piece({ betId: "bet4", drawing: "2", tx: "txD", stroke }));
    expect(filled?.pieces[0].stroke?.pts).toHaveLength(2);
    expect(await store.place(piece({ betId: "bet4", drawing: "2", tx: "txD", stroke }))).toBeNull();
  });

  test("a stroke from a player's app is kept only if it hashes to the chain's, once", async () => {
    const stroke = encodeStroke({ t0: T0, p0: 60_000, rt: 300, rp: 5, from: 0, pts: [{ t: 0, p: 0 }, { t: 400, p: 1 }] });
    const other = encodeStroke({ t0: T0, p0: 60_000, rt: 300, rp: 5, from: 0, pts: [{ t: 0, p: 0 }, { t: 400, p: 9 }] });
    expect((await store.stroke("bet5", stroke)).result).toBe("unknown");
    // From the chain: the hash, no stroke. An app's stroke that is not that one is not kept with it.
    const placed = await store.place(piece({ betId: "bet5", drawing: "6", tx: "txF", strokeHash: strokeHashOf(stroke), stroke: other }));
    expect(placed?.pieces[0].stroke).toBeNull();
    expect((await store.stroke("bet5", other)).result).toBe("mismatch");
    const kept = await store.stroke("bet5", stroke);
    expect(kept.result).toBe("kept");
    expect(kept.drawing?.pieces[0].stroke?.pts).toHaveLength(2);
    expect((await store.stroke("bet5", stroke)).result).toBe("had");
    // With the right one at once, it is kept with the placement.
    const at = await store.place(piece({ betId: "bet6", drawing: "7", tx: "txG", strokeHash: strokeHashOf(stroke), stroke }));
    expect(at?.pieces[0].stroke?.pts).toHaveLength(2);
  });

  test("a chosen Dylan avatar is kept, and cleared back to the address's", async () => {
    expect((await store.edit(C, "dylan_fan", "", undefined, `${C}:4`)).avatarSeed).toBe(`${C}:4`);
    expect((await store.edit(C, "dylan_fan", "", undefined)).avatarSeed).toBe(`${C}:4`);
    expect((await store.board("all", null, false)).find((r) => r.profile.player === C)?.profile.avatarSeed).toBe(`${C}:4`);
    expect((await store.edit(C, "dylan_fan", "", undefined, null)).avatarSeed).toBeNull();
  });

  test("profiles: names are unique, bios kept, avatars as bytes", async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const p = await store.edit(A, "ink_maker", "draws ahead", { mime: "image/png", bytes: png });
    expect(p).toMatchObject({ player: A, username: "ink_maker", bio: "draws ahead", avatar: true });
    expect(await store.avatar(A)).toEqual({ mime: "image/png", bytes: png });
    await expect(store.edit(B, "ink_maker", "", undefined)).rejects.toThrow(/duplicate|unique/i);
    // A name with a quote in it is a value, never SQL.
    const sly = await store.edit(B, "robert", "'); DROP TABLE skech_social.social_pieces; --", undefined);
    expect(sly.bio).toContain("DROP TABLE");
    expect(await store.knows("txA")).toBe(true);
    expect((await store.edit(A, "ink_maker", "", null)).avatar).toBe(false);
  });

  test("follows, and the leaderboard of everyone and of whom one follows", async () => {
    await store.follow(A, B, true);
    await store.follow(A, B, true);
    expect(await store.following(A)).toEqual([B]);
    expect((await store.profile(B)).followers).toBe(1);
    const all = await store.board("all", A, false);
    expect(all.map((r) => r.profile.player)).toEqual([B, C, A]);
    expect(all[0].stats.pnl).toBe("4000000");
    const friends = await store.board("24h", A, true);
    expect(friends.map((r) => r.profile.player).sort()).toEqual([A, B].sort());
    await store.follow(A, B, false);
    expect(await store.following(A)).toEqual([]);
  });

  test("a player's page: numbers, history in pages, the PnL line", async () => {
    for (let i = 0; i < 25; i++) await store.place(piece({ betId: `h${i}`, player: C, drawing: String(100 + i), openAt: BigInt(T0 - i * 1000), staked: 1_000_000n, sections: [section(0, 1_000_000)], tx: `txh${i}` }));
    const page = await store.details(C, "all", A, null);
    expect(page.drawings).toHaveLength(20);
    expect(page.next).not.toBeNull();
    const rest = await store.details(C, "all", A, page.next);
    expect(rest.drawings).toHaveLength(6);
    expect(new Set([...page.drawings, ...rest.drawings].map((d) => d.id)).size).toBe(26);
    expect(page.stats.drawings).toBe(26);
    expect(page.curve.length).toBeGreaterThan(0);
    await expect(store.details(C, "all", null, "not json")).rejects.toThrow("Invalid history cursor");
    await expect(store.details(C, "all", null, JSON.stringify([1, "x".repeat(200)]))).rejects.toThrow("Invalid history cursor");
  });

  test("the live feed and the recent activity", async () => {
    const live = await store.live(T0 + 60_000);
    expect(live.length).toBeGreaterThan(0);
    const recent = await store.recent(5);
    expect(recent).toHaveLength(5);
    expect(recent[0].at).toBeGreaterThanOrEqual(recent[4].at);
  });
});
