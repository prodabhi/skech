import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccountRole,
  type Address,
  address,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Signature,
  type Transaction,
} from "@solana/kit";
import { getTransferCheckedInstructionDataDecoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { JUPITER, Keeper, type KeeperConfig, type KeeperIo, type Quote, WSOL } from "./keeper";

const USDC = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const COLD = address("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const OTHER = address("Bob11111111111111111111111111111111111111111");
const relayer = await generateKeyPairSigner();
const SOL = 1_000_000_000n;
const USD = 1_000_000n;
const DAY = 86_400_000;

const dir = mkdtempSync(join(tmpdir(), "relayer-keeper-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;

const config = (over: Partial<KeeperConfig> = {}): KeeperConfig => ({
  enabled: true,
  dryRun: false,
  everyMs: 300_000,
  solFloor: SOL / 10n,
  solTarget: (3n * SOL) / 10n,
  jupiterUrl: "https://jup.test/swap/v1",
  jupiterKey: "k",
  slippageBps: 50,
  minIntervalMs: 3_600_000,
  dailyCapE6: 50n * USD,
  reserveE6: 0n,
  coldWallet: null,
  capE6: 100n * USD,
  keepE6: 20n * USD,
  coldMaxE6: 1000n * USD,
  cluster: "mainnet-beta",
  usdcMint: USDC,
  priorityMax: 2_000_000,
  ...over,
});

/** SOL at 110 USDC: what `lamports` cost, in USDC e6. */
const cost = (lamports: bigint) => (lamports * 110n) / 1000n;

/** Jupiter's transaction for a swap: the relayer pays, Jupiter's program swaps. `bad` puts in something else. */
function swapTx(payer: Address, bad?: "program" | "signer" | "payer") {
  const ixs: Instruction[] = [
    getSetComputeUnitLimitInstruction({ units: 300_000 }),
    getSetComputeUnitPriceInstruction({ microLamports: 10_000n }),
    { programAddress: bad === "program" ? OTHER : JUPITER, accounts: [{ address: payer, role: AccountRole.WRITABLE_SIGNER }, { address: USDC, role: AccountRole.READONLY }, ...(bad === "signer" ? [{ address: COLD, role: AccountRole.WRITABLE_SIGNER }] : [])], data: new Uint8Array([1]) },
  ];
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(bad === "payer" ? COLD : payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as Blockhash, lastValidBlockHeight: 1_000n }, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  return getBase64EncodedWireTransaction(compileTransaction(msg));
}

/** A relayer holding `lamports` and `usdc`, a clock, and a Jupiter that quotes SOL at 110 (`quote` bends its answer). */
function world(o: { lamports: bigint; usdc: bigint | null; cfg?: Partial<KeeperConfig>; quote?: (q: Quote) => Quote; bad?: "program" | "signer" | "payer"; greedy?: bigint; path?: string; at?: number }) {
  const bal = { lamports: o.lamports, usdc: o.usdc };
  const clock = { now: o.at ?? Date.UTC(2026, 9, 9, 12) };
  const asked: { url: string; body: unknown }[] = [];
  const signed: { label: string; tx: Transaction; lastValid: bigint }[] = [];
  const sent: { label: string; instructions: Instruction[] }[] = [];
  const alerts: string[] = [];
  const lines: string[] = [];
  let lastOut = 0n;
  const fetch = async (url: string, init: RequestInit) => {
    asked.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const u = new URL(url);
    if (u.pathname.endsWith("/quote")) {
      lastOut = BigInt(u.searchParams.get("amount")!);
      const inAmount = cost(lastOut);
      const q: Quote = {
        inputMint: u.searchParams.get("inputMint")!,
        inAmount: inAmount.toString(),
        outputMint: u.searchParams.get("outputMint")!,
        outAmount: lastOut.toString(),
        otherAmountThreshold: ((inAmount * 10_050n) / 10_000n).toString(),
        swapMode: u.searchParams.get("swapMode")!,
        slippageBps: Number(u.searchParams.get("slippageBps")),
        routePlan: [{ swapInfo: { label: "Whirlpool" } }],
      };
      return Response.json(o.quote ? o.quote(q) : q);
    }
    if (u.pathname.endsWith("/swap")) return Response.json({ swapTransaction: swapTx(relayer.address, o.bad), lastValidBlockHeight: 1_000 });
    return new Response("no", { status: 404 });
  };
  const io: KeeperIo = {
    relayer,
    usdcAccount: OTHER,
    balances: async () => ({ ...bal }),
    simulate: async () => ({ err: null, lamports: bal.lamports + lastOut - 5_000n, usdc: (bal.usdc ?? 0n) - (o.greedy ?? cost(lastOut)) }),
    signAndSend: async (label, tx, lastValid) => {
      signed.push({ label, tx, lastValid });
      bal.lamports += lastOut;
      bal.usdc = (bal.usdc ?? 0n) - cost(lastOut);
      return { signature: "sig" as Signature, slot: 1n, err: null };
    },
    send: async (label, instructions) => {
      sent.push({ label, instructions });
      return { signature: "sig" as Signature, slot: 1n, err: null };
    },
    priority: () => 10_000,
    fetch,
    now: () => clock.now,
  };
  const path = o.path ?? join(dir, `keeper-${files++}.json`);
  const make = () => new Keeper(config(o.cfg), io, (s) => lines.push(s), path, (kind) => alerts.push(kind));
  return { keeper: make(), make, bal, clock, asked, signed, sent, alerts, lines, path };
}

describe("the gas keeper", () => {
  test("under the floor, buys back to the target: one ExactOut swap for the lamports wanted, signed as checked", async () => {
    const w = world({ lamports: SOL / 20n, usdc: 60n * USD });
    expect(await w.keeper.tick()).toBe("swapped");
    expect(w.signed.length).toBe(1);
    const quote = new URL(w.asked[0].url);
    expect(quote.searchParams.get("amount")).toBe(String(SOL / 4n));
    expect(quote.searchParams.get("swapMode")).toBe("ExactOut");
    expect(quote.searchParams.get("inputMint")).toBe(USDC);
    expect(quote.searchParams.get("outputMint")).toBe(WSOL);
    const swap = w.asked[1].body as { userPublicKey: string; wrapAndUnwrapSol: boolean; quoteResponse: Quote };
    expect(swap.userPublicKey).toBe(relayer.address);
    expect(swap.wrapAndUnwrapSol).toBe(true);
    expect(swap.quoteResponse.outAmount).toBe(String(SOL / 4n));
    expect(w.signed[0].lastValid).toBe(1_000n);
    // Counted at the most it could take: 27.5 USDC and its 0.5%.
    expect(w.keeper.status().swappedToday).toBe(27.6375);
    expect(w.alerts).toEqual(["keeper-swap"]);
  });

  test("within an hour of the last swap, does not swap again", async () => {
    const w = world({ lamports: SOL / 20n, usdc: 60n * USD });
    await w.keeper.tick();
    w.bal.lamports = SOL / 20n;
    w.clock.now += 30 * 60_000;
    const asked = w.asked.length;
    expect(await w.keeper.tick()).toBe("wait");
    expect(w.signed.length).toBe(1);
    expect(w.asked.length).toBe(asked);
    w.clock.now += 31 * 60_000;
    expect(await w.keeper.tick()).toBe("swapped");
  });

  test("buys only what the day's cap allows, and nothing once it is reached, saying so", async () => {
    const w = world({ lamports: SOL / 20n, usdc: 60n * USD, cfg: { dailyCapE6: 20n * USD, minIntervalMs: 60_000 } });
    expect(await w.keeper.tick()).toBe("swapped");
    // 0.25 SOL would cost 27.5: it bought what 20 buys, with room for slippage.
    const out = BigInt(new URL(w.asked.at(-2)!.url).searchParams.get("amount")!);
    expect(out).toBeLessThan(SOL / 4n);
    expect((cost(out) * 10_050n) / 10_000n).toBeLessThanOrEqual(20n * USD);
    w.bal.lamports = SOL / 20n;
    w.clock.now += 2 * 60_000;
    const asked = w.asked.length;
    expect(await w.keeper.tick()).toBe("cap");
    expect(w.asked.length).toBe(asked);
    expect(w.signed.length).toBe(1);
    expect(w.alerts).toEqual(["keeper-swap", "keeper-cap"]);
    // A new UTC day, a new cap.
    w.clock.now += 1 * DAY;
    expect(await w.keeper.tick()).toBe("swapped");
  });

  test("with too little USDC, alerts instead of swapping", async () => {
    const w = world({ lamports: SOL / 20n, usdc: USD / 2n });
    expect(await w.keeper.tick()).toBe("short");
    expect(w.asked.length).toBe(0);
    expect(w.alerts).toEqual(["keeper-usdc-short"]);
    const none = world({ lamports: SOL / 20n, usdc: null });
    expect(await none.keeper.tick()).toBe("short");
    // Nor into the reserve.
    const kept = world({ lamports: SOL / 20n, usdc: 5n * USD, cfg: { reserveE6: 5n * USD } });
    expect(await kept.keeper.tick()).toBe("short");
  });

  test("refuses a quote for the wrong mint, or one that wants more than it may spend: nothing is signed", async () => {
    const mint = world({ lamports: SOL / 20n, usdc: 60n * USD, quote: (q) => ({ ...q, inputMint: OTHER }) });
    expect(await mint.keeper.tick()).toBe("failed");
    expect(mint.keeper.status().lastError).toContain("not USDC for SOL");
    const out = world({ lamports: SOL / 20n, usdc: 60n * USD, quote: (q) => ({ ...q, outputMint: USDC }) });
    expect(await out.keeper.tick()).toBe("failed");
    const dear = world({ lamports: SOL / 20n, usdc: 60n * USD, quote: (q) => ({ ...q, inAmount: String(100n * USD), otherAmountThreshold: String(100n * USD) }) });
    expect(await dear.keeper.tick()).toBe("failed");
    expect(dear.keeper.status().lastError).toContain("over the 50.00 USDC it may spend");
    const slack = world({ lamports: SOL / 20n, usdc: 60n * USD, quote: (q) => ({ ...q, otherAmountThreshold: String(BigInt(q.inAmount) * 2n) }) });
    expect(await slack.keeper.tick()).toBe("failed");
    for (const w of [mint, out, dear, slack]) {
      expect(w.signed.length).toBe(0);
      expect(w.asked.some((a) => a.url.endsWith("/swap"))).toBe(false);
      expect(w.keeper.status().swappedToday).toBe(0);
      expect(w.alerts).toEqual(["keeper-failed"]);
    }
  });

  test("refuses a swap transaction that is not just the relayer's swap, or takes more than quoted", async () => {
    for (const [bad, why] of [
      ["program", `swap calls ${OTHER}`],
      ["signer", "swap wants signatures from"],
      ["payer", `swap's fee payer is ${COLD}`],
    ] as const) {
      const w = world({ lamports: SOL / 20n, usdc: 60n * USD, bad });
      expect(await w.keeper.tick()).toBe("failed");
      expect(w.keeper.status().lastError).toContain(why);
      expect(w.signed.length).toBe(0);
    }
    const greedy = world({ lamports: SOL / 20n, usdc: 60n * USD, greedy: 40n * USD });
    expect(await greedy.keeper.tick()).toBe("failed");
    expect(greedy.keeper.status().lastError).toContain("over the quote's");
    expect(greedy.signed.length).toBe(0);
  });

  test("a dry run sends nothing: on mainnet it quotes, off it only counts", async () => {
    const dry = world({ lamports: SOL / 20n, usdc: 60n * USD, cfg: { dryRun: true } });
    expect(await dry.keeper.tick()).toBe("dry");
    expect(dry.asked.map((a) => new URL(a.url).pathname)).toEqual(["/swap/v1/quote"]);
    expect(dry.lines[0]).toContain("would buy 0.25 SOL for 27.50 USDC");
    // Said, and quoted, once an hour.
    dry.clock.now += 5 * 60_000;
    expect(await dry.keeper.tick()).toBe("dry");
    expect(dry.asked.length).toBe(1);
    expect(dry.lines.length).toBe(1);
    const off = world({ lamports: SOL / 20n, usdc: 60n * USD, cfg: { enabled: false } });
    expect(await off.keeper.tick()).toBe("dry");
    const devnet = world({ lamports: SOL / 20n, usdc: 60n * USD, cfg: { cluster: "devnet" } });
    expect(await devnet.keeper.tick()).toBe("dry");
    expect(devnet.asked.length).toBe(0);
    const cold = world({ lamports: SOL, usdc: 150n * USD, cfg: { coldWallet: COLD, dryRun: true } });
    expect(await cold.keeper.tick()).toBe("dry");
    for (const w of [dry, off, devnet, cold]) {
      expect(w.signed.length + w.sent.length).toBe(0);
      expect(w.alerts).toEqual([]);
      expect(w.keeper.status().dryRun).toBe(true);
    }
  });

  test("sends what is over the keep to the cold wallet, bounded, once an hour", async () => {
    const w = world({ lamports: SOL, usdc: 150n * USD, cfg: { coldWallet: COLD } });
    expect(await w.keeper.tick()).toBe("sent");
    expect(w.sent.length).toBe(1);
    const [create, transfer] = w.sent[0].instructions;
    expect(create.accounts?.[2].address).toBe(COLD);
    expect(transfer.programAddress).toBe(TOKEN_PROGRAM_ADDRESS);
    expect(getTransferCheckedInstructionDataDecoder().decode(transfer.data!).amount).toBe(130n * USD);
    expect(w.alerts).toEqual(["keeper-cold"]);
    expect(await w.keeper.tick()).toBe("wait");
    const lots = world({ lamports: SOL, usdc: 5_000n * USD, cfg: { coldWallet: COLD } });
    await lots.keeper.tick();
    expect(getTransferCheckedInstructionDataDecoder().decode(lots.sent[0].instructions[1].data!).amount).toBe(1_000n * USD);
    // Under the cap, nothing.
    const under = world({ lamports: SOL, usdc: 99n * USD, cfg: { coldWallet: COLD } });
    expect(await under.keeper.tick()).toBe("idle");
  });

  test("remembers its last swap and the day's total across a restart", async () => {
    const w = world({ lamports: SOL / 20n, usdc: 60n * USD });
    await w.keeper.tick();
    const before = w.keeper.status();
    const again = w.make();
    expect(again.status().swappedToday).toBe(before.swappedToday);
    expect(again.status().lastSwapAt).toBe(before.lastSwapAt);
    w.bal.lamports = SOL / 20n;
    w.clock.now += 10 * 60_000;
    expect(await again.tick()).toBe("wait");
    expect(w.signed.length).toBe(1);
  });

  test("will not take the relayer for the cold wallet", () => {
    const w = world({ lamports: SOL, usdc: 0n });
    expect(() => new Keeper(config({ coldWallet: relayer.address }), { relayer } as unknown as KeeperIo, () => {}, w.path)).toThrow("is the relayer itself");
  });
});
