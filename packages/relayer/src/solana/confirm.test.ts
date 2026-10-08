import { describe, expect, test } from "bun:test";
import type { Base64EncodedWireTransaction, Signature } from "@solana/kit";
import { Confirmations, type Io, MAX_STATUSES, type Status, TIMING } from "./confirm";

const FAST = { ...TIMING, fastMs: 5, slowMs: 5, rebroadcastMs: 20, lastLookMs: 10 };
const sig = (i: number) => `sig${i}` as Signature;
const wire = (i: number) => `wire${i}` as Base64EncodedWireTransaction;
const confirmed = (slot: bigint, err: unknown = null): Status => ({ slot, err, confirmationStatus: "confirmed" });

/** An RPC that answers from `chain`, and remembers what it was asked. */
function rpc(chain: Map<Signature, Status>, height = { h: 0n }) {
  const asked: { signatures: Signature[]; history: boolean }[] = [];
  const pushed: string[] = [];
  let failing = 0;
  const io: Io = {
    statuses: async (signatures, history) => {
      asked.push({ signatures, history });
      if (failing > 0) {
        failing--;
        throw new Error("429 Too Many Requests");
      }
      return signatures.map((s) => chain.get(s) ?? null);
    },
    push: async (w) => pushed.push(w),
    height: () => height.h,
  };
  return { io, asked, pushed, height, fail: (n: number) => (failing = n) };
}
const stats = () => ({ sent: 0, landed: 0, failed: 0, expired: 0, rebroadcasts: 0 });

describe("transactions in flight", () => {
  test("are looked for together: one request for all of them, not one each", async () => {
    const chain = new Map<Signature, Status>();
    const r = rpc(chain);
    const c = new Confirmations(r.io, stats(), FAST);
    const waits = Array.from({ length: 40 }, (_, i) => c.watch(`tx ${i}`, wire(i), sig(i), 100n));
    await Bun.sleep(30);
    for (let i = 0; i < 40; i++) chain.set(sig(i), confirmed(BigInt(i)));
    const sent = await Promise.all(waits);
    expect(sent.map((s) => s.slot)).toEqual(Array.from({ length: 40 }, (_, i) => BigInt(i)));
    // Every look carried every signature still out.
    expect(r.asked[0].signatures.length).toBe(40);
    expect(r.asked.every((a) => !a.history)).toBe(true);
    expect(c.polls).toBe(r.asked.length);
    expect(c.size).toBe(0);
  });

  test("more than 256 are taken in turn, the longest unseen first", async () => {
    const chain = new Map<Signature, Status>();
    const r = rpc(chain);
    const c = new Confirmations(r.io, stats(), FAST);
    const n = MAX_STATUSES + 44;
    const waits = Array.from({ length: n }, (_, i) => c.watch(`tx ${i}`, wire(i), sig(i), 100n));
    await Bun.sleep(5);
    for (let i = 0; i < n; i++) chain.set(sig(i), confirmed(1n));
    await Promise.all(waits);
    expect(Math.max(...r.asked.map((a) => a.signatures.length))).toBe(MAX_STATUSES);
    const all = new Set(r.asked.flatMap((a) => a.signatures));
    expect(all.size).toBe(n);
  });

  test("a failed transaction lands with its error; the same one sent twice waits once", async () => {
    const chain = new Map<Signature, Status>([[sig(1), confirmed(7n, { InstructionError: [3, { Custom: 6001 }] })]]);
    const r = rpc(chain);
    const s = stats();
    const c = new Confirmations(r.io, s, FAST);
    const [a, b] = await Promise.all([c.watch("one", wire(1), sig(1), 100n), c.watch("again", wire(1), sig(1), 100n)]);
    expect(a.err).toEqual({ InstructionError: [3, { Custom: 6001 }] });
    expect(b.slot).toBe(7n);
    expect(r.asked[0].signatures).toEqual([sig(1)]);
    expect(s.failed).toBe(2);
  });

  test("is rebroadcast every so often until it lands", async () => {
    const chain = new Map<Signature, Status>();
    const r = rpc(chain);
    const s = stats();
    const c = new Confirmations(r.io, s, FAST);
    const w = c.watch("slow", wire(1), sig(1), 100n);
    await Bun.sleep(70);
    chain.set(sig(1), confirmed(1n));
    await w;
    // Every 20 ms over 70: a few times, and nowhere near once a look.
    expect(r.pushed.length).toBeGreaterThanOrEqual(2);
    expect(r.pushed.length).toBeLessThan(r.asked.length);
    expect(s.rebroadcasts).toBe(r.pushed.length);
  });

  test("past its blockhash: one last look through history, then expired", async () => {
    const chain = new Map<Signature, Status>();
    const r = rpc(chain);
    const s = stats();
    const c = new Confirmations(r.io, s, FAST);
    const w = c.watch("lost", wire(1), sig(1), 100n);
    r.height.h = 101n;
    await expect(w).rejects.toThrow("lost: expired unconfirmed (sig1)");
    expect(r.asked.at(-1)).toEqual({ signatures: [sig(1)], history: true });
    expect(r.asked.filter((a) => a.history).length).toBe(1);
    expect(s.expired).toBe(1);
  });

  test("found on the last look, it landed after all", async () => {
    const chain = new Map<Signature, Status>();
    const r = rpc(chain, { h: 101n });
    const c = new Confirmations(r.io, stats(), FAST);
    const w = c.watch("late", wire(1), sig(1), 100n);
    await Bun.sleep(8);
    chain.set(sig(1), { slot: 3n, err: null, confirmationStatus: "finalized" });
    expect((await w).slot).toBe(3n);
  });

  test("an RPC that does not answer says nothing: not landed, not expired, asked again", async () => {
    const chain = new Map<Signature, Status>();
    const r = rpc(chain);
    const c = new Confirmations(r.io, stats(), FAST);
    r.fail(4);
    const w = c.watch("throttled", wire(1), sig(1), 100n);
    await Bun.sleep(40);
    chain.set(sig(1), confirmed(9n));
    expect((await w).slot).toBe(9n);
  });

  test("a last look the RPC will not answer is tried a few times before giving up", async () => {
    const chain = new Map<Signature, Status>();
    const r = rpc(chain, { h: 101n });
    const c = new Confirmations(r.io, stats(), FAST);
    const w = c.watch("unknown", wire(1), sig(1), 100n);
    await Bun.sleep(8);
    r.fail(3);
    chain.set(sig(1), confirmed(2n));
    expect((await w).slot).toBe(2n);
    expect(r.asked.filter((a) => a.history).length).toBe(4);
  });
});
