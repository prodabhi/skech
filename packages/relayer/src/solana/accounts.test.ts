import { describe, expect, test } from "bun:test";
import type { Address } from "@solana/kit";
import type { Player, Pool } from "@skech/contracts/solana/sdk";
import { Accounts, type Snapshot } from "./accounts";
import { Holds } from "@skech/core/optimistic";

const A = "Alice111111111111111111111111111111111111111" as Address;
const B = "Bob11111111111111111111111111111111111111111" as Address;

/** A chain whose player balance is `balance.v` when read; reads take `ms`. */
function chain(ms = 5, exists = true) {
  const balance = { v: 1n };
  const reads: { wallet: Address; at: number }[] = [];
  const fetch = async (wallet: Address): Promise<Omit<Snapshot, "at">> => {
    reads.push({ wallet, at: performance.now() });
    const v = balance.v;
    await Bun.sleep(ms);
    return { player: exists ? ({ balance: v } as unknown as Player) : null, pool: {} as Pool, token: null, holder: null, rewards: null };
  };
  return { fetch, reads, balance };
}

describe("a player's accounts", () => {
  test("asked for at once by many, are read once", async () => {
    const c = chain();
    const a = new Accounts(c.fetch, 100);
    const got = await Promise.all([a.get(A), a.get(A), a.get(A, 1_000), a.get(A)]);
    expect(c.reads.length).toBe(1);
    expect(got.every((s) => s.player?.balance === 1n)).toBe(true);
  });

  test("asked for afresh within the second, are read once more, a second after the last, for everyone who asked", async () => {
    const c = chain();
    const a = new Accounts(c.fetch, 100);
    await a.get(A);
    c.balance.v = 2n;
    const later = await Promise.all([a.get(A), a.get(A), a.get(A)]);
    expect(c.reads.length).toBe(2);
    expect(c.reads[1].at - c.reads[0].at).toBeGreaterThanOrEqual(95);
    // Read after the asking: it sees what changed.
    expect(later.map((s) => s.player?.balance)).toEqual([2n, 2n, 2n]);
  });

  test("one player's reads do not hold up another's", async () => {
    const c = chain();
    const a = new Accounts(c.fetch, 100);
    await a.get(A);
    const t0 = performance.now();
    await a.get(B);
    expect(performance.now() - t0).toBeLessThan(60);
    expect(c.reads.map((r) => r.wallet)).toEqual([A, B]);
  });

  test("a read fresh enough is given again, not made again", async () => {
    const c = chain();
    const a = new Accounts(c.fetch, 100);
    const first = await a.get(A);
    expect(await a.get(A, 1_000)).toBe(first);
    expect(c.reads.length).toBe(1);
  });

  test("once their own transaction lands, what was read before is not given again", async () => {
    const c = chain();
    const a = new Accounts(c.fetch, 20);
    await a.get(A);
    c.balance.v = 5n;
    a.invalidate(A);
    expect((await a.get(A, 1_000)).player?.balance).toBe(5n);
    expect(c.reads.length).toBe(2);
  });

  test("an address with no game account is known for 30 s at a time", async () => {
    let t = 1_000_000;
    const c = chain(1, false);
    const a = new Accounts(c.fetch, 0, () => t);
    expect((await a.get(A, 1_000, 30_000)).player).toBeNull();
    t += 29_000;
    await a.get(A, 1_000, 30_000);
    expect(c.reads.length).toBe(1);
    // Asked for afresh (the app's own `account`), it is read.
    await a.get(A);
    expect(c.reads.length).toBe(2);
    t += 31_000;
    await a.get(A, 1_000, 30_000);
    expect(c.reads.length).toBe(3);
  });

  test("a slow read never stands in for a later one that answered first", async () => {
    let n = 0;
    const fetch = async (): Promise<Omit<Snapshot, "at">> => {
      const mine = ++n;
      await Bun.sleep(mine === 1 ? 80 : 1);
      return { player: { balance: BigInt(mine) } as unknown as Player, pool: {} as Pool, token: null, holder: null, rewards: null };
    };
    const a = new Accounts(fetch, 10);
    const slow = a.get(A);
    await Bun.sleep(15);
    a.invalidate(A);
    expect((await a.get(A)).player?.balance).toBe(2n);
    expect((await slow).player?.balance).toBe(2n);
    expect((await a.get(A, 10_000)).player?.balance).toBe(2n);
  });

  test.each([["stake", -1], ["payout", 2]] as const)("an earlier balance read cannot acknowledge a %s", async (kind, delta) => {
    let finish!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => (started = resolve));
    const gate = new Promise<void>((resolve) => (finish = resolve));
    let balance = 10n;
    const holds = new Holds();
    holds.hold(kind, delta);
    let reads = 0;
    const a = new Accounts(async () => {
      const captured = balance;
      if (++reads === 1) {
        started();
        await gate;
      }
      return { player: { balance: captured } as unknown as Player, pool: {} as Pool, token: null, holder: null, rewards: null };
    }, 0);
    const before = a.get(A);
    await began;
    balance += BigInt(delta);
    a.invalidate(A);
    holds.land(kind);
    finish();
    // The app marks the adjustment as landed before receiving this account.
    // A stale $10 snapshot would clear it and change the displayed balance.
    const said = Number((await before).player?.balance);
    holds.heard();
    expect(said + holds.total()).toBe(10 + delta);
    expect(reads).toBe(2);
  });

  test("a read that fails fails for everyone who waited on it, and the next is tried afresh", async () => {
    let fail = true;
    const fetch = async (): Promise<Omit<Snapshot, "at">> => {
      if (fail) throw new Error("429");
      return { player: null, pool: {} as Pool, token: null, holder: null, rewards: null };
    };
    const a = new Accounts(fetch, 10);
    const all = await Promise.allSettled([a.get(A), a.get(A)]);
    expect(all.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    fail = false;
    expect((await a.get(A)).player).toBeNull();
  });
});
