import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { Address, Instruction, Signature } from "@solana/kit";
import { pda, SKECH_PROGRAM_ADDRESS } from "@skech/contracts/solana/sdk";
import type { Engine } from "../engine";
import type { SolanaChain, SolanaEvent } from "./chain";
import type { SolanaConfig } from "./config";
import { type Settled, SolanaSettler } from "./settler";

const snapshot = JSON.parse(readFileSync(join(import.meta.dir, "../../../contracts/solana/snapshots/compute.json"), "utf8")) as Record<string, number>;
const A = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" as Address;
const B = "2k9WY5YR357AGVVoBW6ouFHijEypTj8953fzSdD7HfRV" as Address;
const settled = (bet: string, player: Address, missMask: number) => ({ name: "Settled", data: { bet, player, hitMask: 0, missMask, expiredMask: 0, paid: 0n, owed: 0n, closed: true } }) as SolanaEvent;
const minted = (player: Address, skt: bigint) => ({ name: "Minted", data: { player, skt, rate: 0n, basis: 0n } }) as SolanaEvent;

/** The settler's word to the apps on one settlement's events. */
async function told(events: SolanaEvent[]) {
  const dir = mkdtempSync(join(tmpdir(), "settler-"));
  const out: Settled[] = [];
  const accounts: Address[] = [];
  const chain = { events: async () => events } as unknown as SolanaChain;
  const s = new SolanaSettler({} as SolanaConfig, {} as Engine, chain, { settled: (x) => out.push(x), owed: () => {}, account: (p) => accounts.push(p) }, () => {}, join(dir, "state.json"));
  await (s as unknown as { tell: (sig: Signature) => Promise<void> }).tell("sig" as Signature);
  rmSync(dir, { recursive: true, force: true });
  return { out, accounts };
}

describe("what a settlement minted", () => {
  test("goes with the bet whose misses minted it, the Minted just before its Settled", async () => {
    const { out, accounts } = await told([minted(A, 120_000_000n), settled("bet1", A, 1), settled("bet2", B, 0), minted(A, 5n), settled("bet3", A, 1)]);
    expect(out.map((s) => [String(s.betId), s.minted])).toEqual([
      ["bet1", 120_000_000n],
      ["bet2", 0n],
      ["bet3", 5n],
    ]);
    // Their SKT changed: their account is sent again.
    expect(accounts).toContain(A);
  });

  test("is nothing for a bet that hit", async () => {
    const { out } = await told([settled("bet1", A, 0)]);
    expect(out[0].minted).toBe(0n);
  });
});

/**
 * A chain that runs settlements for what they really cost: `cost` of the bets in each (by address) and the bar, and
 * fails one asked for less compute than that, as Solana does. What it posted and settled, in order.
 */
async function liveSettler(opts: { bets: Map<number, Address[]>; cost: (bets: Address[], bar: boolean) => number; betsPerSettle?: number }) {
  const dir = mkdtempSync(join(tmpdir(), "settler-"));
  const program = SKECH_PROGRAM_ADDRESS;
  const [game, bars, pool, market, signerAddr, rewards] = await Promise.all(["game", "bars", "pool", "market", "signer", "rewards"].map((s) => pda([s], program).then((r) => r[0])));
  const all = new Set([...opts.bets.values()].flat());
  const sent: { label: string; bar: boolean; bets: Address[]; cu: number; ok: boolean }[] = [];
  let n = 0;
  const chain = {
    signer: { address: signerAddr, signTransactions: async () => [] },
    rewards,
    betsPerSettle: opts.betsPerSettle ?? 9,
    send: async (label: string, ixs: Instruction[], cu: number) => {
      const ix = ixs[0];
      const bets = (ix.accounts ?? []).map((a) => a.address).filter((a) => all.has(a));
      const bar = label.startsWith("bar");
      const ok = cu >= opts.cost(bets, bar);
      sent.push({ label, bar, bets, cu, ok });
      return { signature: `sig${n++}`, slot: 1n, err: ok ? null : { InstructionError: [2, "ComputationalBudgetExceeded"] } };
    },
    events: async () => [],
  } as unknown as SolanaChain;
  const engine = { now: () => 10_000_000, ready: () => true, book: { at: () => ({ h: 83_000, l: 83_000, c: 83_000 }), bars: [{ t: 0 }] } } as unknown as Engine;
  const cfg = { compute: snapshot, deployment: { program, game, bars, pool, market }, market: 0 } as unknown as SolanaConfig;
  const s = new SolanaSettler(cfg, engine, chain, { settled: () => {}, owed: () => {}, account: () => {} }, () => {}, join(dir, "state.json"));
  const players = await Promise.all(Array.from({ length: 4 }, (_, i) => pda(["player", Uint8Array.of(i)], program).then((r) => r[0])));
  for (const [second, bets] of opts.bets) for (const [i, bet] of bets.entries()) for (let k = 0; k < 32; k++) s.watch(bet, players[i % players.length], 1n, { second, lo: BigInt(k), hi: BigInt(k + 1), stake: 1n, rung: 150 });
  const tick = () => (s as unknown as { tick: () => Promise<void> }).tick();
  return { s, sent, tick, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const betsAt = (k: number, n: number) => Promise.all(Array.from({ length: n }, (_, i) => pda(["bet", Uint8Array.of(k, i)], SKECH_PROGRAM_ADDRESS).then((r) => r[0])));

describe("a second full of bands", () => {
  // The audit's scenario: one wallet's nine pieces of 32 one-micro-USDC bands in one second, then an ordinary second.
  test("is budgeted for its bands: its bar and every bet settle, and the next second after it", async () => {
    const [heavy, light] = [await betsAt(1, 9), await betsAt(2, 1)];
    // What they really cost: what the budget assumes, so every settlement it asks for runs.
    const real = (bets: Address[], bar: boolean) => (bar ? snapshot.post_bar : snapshot.settle_base) + bets.length * (snapshot.settle_bet + 32 * (snapshot.settle_section + snapshot.settle_decided) + snapshot.holder_open + 7 * snapshot.place_per_bump);
    const t = await liveSettler({ bets: new Map([[5_000_000, heavy], [5_001_000, light]]), cost: real });
    await t.tick();
    expect(t.sent.every((x) => x.ok)).toBe(true);
    expect(t.s.posted(5_000_000) && t.s.posted(5_001_000)).toBe(true);
    expect(new Set(t.sent.flatMap((x) => x.bets))).toEqual(new Set([...heavy, ...light]));
    t.done();
  });

  test("that the budget underestimates: the bar goes alone, the bets split until they fit, and no later second waits", async () => {
    const [heavy, light] = [await betsAt(3, 9), await betsAt(4, 1)];
    // Each heavy bet really costs 150k, far past what the snapshot says; the light one is ordinary.
    const real = (bets: Address[], bar: boolean) => (bar ? snapshot.post_bar : snapshot.settle_base) + bets.reduce((n, b) => n + (heavy.includes(b) ? 150_000 : 30_000), 0);
    const t = await liveSettler({ bets: new Map([[6_000_000, heavy], [6_001_000, light]]), cost: real });
    await t.tick();
    // The first try, the bar with the heavy bets, fails; the bar alone then lands.
    expect(t.sent[0]).toMatchObject({ bar: true, ok: false });
    expect(t.sent.find((x) => x.bar && x.bets.length === 0)?.ok).toBe(true);
    expect(t.s.posted(6_000_000)).toBe(true);
    // Every heavy bet settled in a settlement that landed.
    const settledOk = new Set(t.sent.filter((x) => x.ok).flatMap((x) => x.bets));
    for (const b of heavy) expect(settledOk.has(b)).toBe(true);
    // And the next second was posted in the same tick.
    expect(t.s.posted(6_001_000)).toBe(true);
    expect(settledOk.has(light[0])).toBe(true);
    t.done();
  });

  test("one second that keeps failing holds back no later one", async () => {
    const [stuck, fine] = [await betsAt(5, 1), await betsAt(6, 1)];
    // The first second's bar fails whatever it is given (say the chain refuses it); the next is fine.
    // Its bar alone (no bets in it) or with its bet: refused, however often.
    const t = await liveSettler({ bets: new Map([[7_000_000, stuck], [7_001_000, fine]]), cost: (bets, bar) => (bar && !bets.includes(fine[0]) ? Infinity : 1) });
    await t.tick();
    expect(t.s.posted(7_000_000)).toBe(false);
    expect(t.s.posted(7_001_000)).toBe(true);
    expect(t.sent.some((x) => x.bets.includes(fine[0]) && x.ok)).toBe(true);
    // Tried again on the next tick only once its back-off is over: not every 100 ms.
    const before = t.sent.length;
    await t.tick();
    expect(t.sent.length).toBe(before);
    t.done();
  });
});
