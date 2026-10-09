/**
 * The gas keeper: the relayer pays every fee and rent in SOL, and the game's fees land in its wallet as USDC (on
 * mainnet the treasury is the relayer's own USDC account). Every few minutes it reads both, in one request at the
 * sweep's priority, and:
 *
 * - **SOL under the floor:** buys back up to the target with USDC through Jupiter: an ExactOut quote for the lamports
 *   wanted, its transaction checked before it is signed (below), sent like any of the relayer's own. One swap an hour
 *   at most, a daily cap in USDC, never into the reserve; what it swapped survives a restart in a state file.
 * - **USDC over the cap:** sends what is above the keep to a cold wallet, once an hour at most, a bounded amount.
 *
 * Off mainnet, with KEEPER_DRY_RUN=1, or without KEEPER_ENABLED=1, it only says what it would do (with the quote it
 * would take, on mainnet). A dry run logs; it never pages.
 *
 * Jupiter: the Metis API (`/swap/v1/quote`, `/swap/v1/swap`). Swap V2's `/build` is ExactIn only, and `/order` lands
 * through Jupiter's `/execute`; Metis quotes ExactOut and hands back a transaction the relayer sends itself.
 */
import {
  type Address,
  address,
  fetchEncodedAccounts,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Instruction,
  type Transaction,
  type TransactionSigner,
} from "@solana/kit";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  decodeToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTokenDecoder,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { report } from "../sentry";
import { readState, writeAtomic } from "../state";
import type { Sent, SolanaChain } from "./chain";
import type { SolanaConfig } from "./config";

export const WSOL = address("So11111111111111111111111111111111111111112");
/** Jupiter's swap program, the one program a swap may call besides the token, ATA, system and compute budget ones. */
export const JUPITER = address("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const COMPUTE_BUDGET = address("ComputeBudget111111111111111111111111111111");
const SYSTEM = address("11111111111111111111111111111111");
const TOKEN_2022 = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const PROGRAMS = new Set<Address>([COMPUTE_BUDGET, SYSTEM, TOKEN_PROGRAM_ADDRESS, TOKEN_2022, ASSOCIATED_TOKEN_PROGRAM_ADDRESS, JUPITER]);
/** A transaction's most compute units. */
const MAX_CU = 1_400_000;
const USDC_DECIMALS = 6;
/** Less than this in a day's budget is no swap worth a fee. */
const LEAST_SWAP_E6 = 1_000_000n;
/** Once an hour at most to the cold wallet. */
const COLD_EVERY_MS = 3_600_000;
/** What the fee and a wSOL account's rent may take off a swap's SOL, seen in its simulation. */
const SOL_SLACK = 10_000_000n;
/** A waiting decision said again at most this often. */
const SAY_AGAIN_MS = 3_600_000;

export type KeeperConfig = SolanaConfig["keeper"] & { cluster: string; usdcMint: Address; priorityMax: number };

/** What `/swap/v1/quote` answers: amounts in the smallest unit, as strings. */
export type Quote = {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  /** ExactOut: the most that goes in, slippage and all. */
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct?: string;
  routePlan?: { swapInfo?: { label?: string } }[];
};
/** `fetch`, or a test's stand-in for it. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export type Jupiter = { url: string; key: string | null; fetch: Fetch };

async function ask<T>(j: Jupiter, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (j.key) headers["x-api-key"] = j.key;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await j.fetch(`${j.url}${path}`, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`jupiter ${path.split("?")[0]}: HTTP ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return (await r.json()) as T;
}

/** What `lamports` of SOL cost in USDC: a quote, read only. */
export function quoteExactOut(j: Jupiter, usdcMint: Address, lamports: bigint, slippageBps: number): Promise<Quote> {
  const q = new URLSearchParams({ inputMint: usdcMint, outputMint: WSOL, amount: lamports.toString(), swapMode: "ExactOut", slippageBps: String(slippageBps), restrictIntermediateTokens: "true" });
  return ask<Quote>(j, `/quote?${q}`);
}

export type KeeperIo = {
  relayer: TransactionSigner;
  /** The relayer's USDC account, where the fees land. */
  usdcAccount: Address;
  /** The relayer's SOL and USDC (null: no USDC account), in one read. */
  balances: () => Promise<{ lamports: bigint; usdc: bigint | null }>;
  /** The transaction run against the chain unsigned: its error, and the relayer's SOL and USDC after it. */
  simulate: (tx: Transaction) => Promise<{ err: unknown | null; lamports: bigint | null; usdc: bigint | null }>;
  signAndSend: (label: string, tx: Transaction, lastValid: bigint) => Promise<Sent>;
  send: (label: string, instructions: Instruction[], computeUnits: number) => Promise<Sent>;
  /** The relayer's priority fee now, micro-lamports per compute unit. */
  priority: () => number;
  fetch: Fetch;
  now: () => number;
};

const b64 = getBase64Encoder();

/** The keeper's hands on the relayer's chain. */
export async function keeperIo(chain: SolanaChain, usdcMint: Address): Promise<KeeperIo> {
  const me = chain.signer.address;
  const [usdcAccount] = await findAssociatedTokenPda({ mint: usdcMint, owner: me, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return {
    relayer: chain.signer,
    usdcAccount,
    balances: async () => {
      const [sol, usdc] = await fetchEncodedAccounts(chain.sweepRpc, [me, usdcAccount]);
      return { lamports: sol.exists ? sol.lamports : 0n, usdc: usdc.exists ? decodeToken(usdc).data.amount : null };
    },
    simulate: async (tx) => {
      const wire = getBase64EncodedWireTransaction(tx);
      const { value } = await chain.rpc
        .simulateTransaction(wire, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { addresses: [me, usdcAccount], encoding: "base64" } })
        .send();
      const [sol, usdc] = value.accounts;
      return { err: value.err, lamports: sol ? sol.lamports : null, usdc: usdc ? getTokenDecoder().decode(b64.encode(usdc.data[0])).amount : null };
    },
    signAndSend: (label, tx, lastValid) => chain.signAndSend(label, tx, lastValid),
    send: (label, instructions, computeUnits) => chain.send(label, instructions, computeUnits),
    priority: () => chain.priority,
    fetch: (url, init) => fetch(url, init),
    now: Date.now,
  };
}

type State = { lastSwapAt: number; lastColdAt: number; day: string; swappedE6: string };
type Alert = (kind: string, e: unknown, level?: "error" | "warning") => void;

const sol = (l: bigint) => `${Number(l) / 1e9} SOL`;
const usd = (e6: bigint) => `${(Number(e6) / 1e6).toFixed(2)} USDC`;
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const jsonOf = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

export class Keeper {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private running = false;
  private state: { lastSwapAt: number; lastColdAt: number; day: string; swapped: bigint };
  private saved: string | null = null;
  private said: { key: string; at: number } | null = null;
  sol: bigint | null = null;
  usdc: bigint | null = null;
  lastError: string | null = null;
  stats = { swaps: 0, transfers: 0 };

  constructor(
    private readonly cfg: KeeperConfig,
    private readonly io: KeeperIo,
    private readonly log: (s: string) => void,
    private readonly statePath: string,
    private readonly alert: Alert = report,
  ) {
    if (cfg.coldWallet === io.relayer.address) throw new Error("KEEPER_COLD_WALLET is the relayer itself");
    const s = readState<State>(statePath);
    this.state = { lastSwapAt: s?.lastSwapAt ?? 0, lastColdAt: s?.lastColdAt ?? 0, day: s?.day ?? "", swapped: BigInt(s?.swappedE6 ?? 0) };
  }

  /** It moves money only when enabled, on mainnet, and not told to dry run. */
  get live() {
    return this.cfg.enabled && !this.cfg.dryRun && this.cfg.cluster === "mainnet-beta";
  }

  start() {
    const next = (ms: number) => {
      if (this.stopped) return;
      this.timer = setTimeout(() => void this.tick().finally(() => next(this.cfg.everyMs)), ms);
      this.timer.unref();
    };
    // A first look once the chain's blockhash and fee are in, then every few minutes.
    next(15_000);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  status() {
    return {
      enabled: this.cfg.enabled,
      dryRun: !this.live,
      sol: this.sol === null ? null : Number(this.sol) / 1e9,
      usdc: this.usdc === null ? null : Number(this.usdc) / 1e6,
      lastSwapAt: this.state.lastSwapAt ? new Date(this.state.lastSwapAt).toISOString() : null,
      swappedToday: this.state.day === dayOf(this.io.now()) ? Number(this.state.swapped) / 1e6 : 0,
      lastColdAt: this.state.lastColdAt ? new Date(this.state.lastColdAt).toISOString() : null,
      coldWallet: this.cfg.coldWallet,
      ...this.stats,
      lastError: this.lastError,
    };
  }

  /** One look and at most one move. What it decided, for the tests. */
  async tick(): Promise<string> {
    if (this.running) return "busy";
    this.running = true;
    try {
      const { lamports, usdc } = await this.io.balances();
      this.sol = lamports;
      this.usdc = usdc ?? 0n;
      const today = dayOf(this.io.now());
      if (this.state.day !== today) {
        this.state.day = today;
        this.state.swapped = 0n;
      }
      if (lamports < this.cfg.solFloor) return await this.topUp(lamports, usdc ?? 0n);
      if (this.cfg.coldWallet && (usdc ?? 0n) > this.cfg.capE6) return await this.toCold(usdc!);
      this.said = null;
      return "idle";
    } catch (e) {
      const why = String((e as Error).message ?? e).split("\n")[0];
      this.lastError = why;
      this.log(`keeper: ${why}`);
      if (this.live) this.alert("keeper-failed", e);
      return "failed";
    } finally {
      this.running = false;
    }
  }

  /** A decision that waits: said once, and again only an hour on if it still holds. */
  private say(key: string, line: string) {
    const now = this.io.now();
    if (this.said?.key === key && now - this.said.at < SAY_AGAIN_MS) return;
    this.said = { key, at: now };
    this.log(line);
  }

  private async topUp(lamports: bigint, usdc: bigint): Promise<string> {
    const c = this.cfg;
    const dry = this.live ? "" : " (dry run)";
    const want = c.solTarget - lamports;
    const now = this.io.now();
    if (this.live && now - this.state.lastSwapAt < c.minIntervalMs) {
      this.say("wait", `keeper: ${sol(lamports)}, under the ${sol(c.solFloor)} floor; last swap ${Math.round((now - this.state.lastSwapAt) / 60_000)} min ago, one every ${Math.round(c.minIntervalMs / 60_000)} min`);
      return "wait";
    }
    const left = c.dailyCapE6 > this.state.swapped ? c.dailyCapE6 - this.state.swapped : 0n;
    const spare = usdc > c.reserveE6 ? usdc - c.reserveE6 : 0n;
    const budget = min(left, spare);
    if (budget < LEAST_SWAP_E6) {
      const capped = left < LEAST_SWAP_E6;
      const line = capped
        ? `keeper${dry}: ${sol(lamports)}, under the ${sol(c.solFloor)} floor, and ${usd(this.state.swapped)} already swapped today (cap ${usd(c.dailyCapE6)})`
        : `keeper${dry}: ${sol(lamports)}, under the ${sol(c.solFloor)} floor, and only ${usd(usdc)} to buy SOL with (reserve ${usd(c.reserveE6)}): send USDC or SOL to ${this.io.relayer.address}`;
      this.say(capped ? "cap" : "short", line);
      if (this.live) this.alert(capped ? "keeper-cap" : "keeper-usdc-short", line, "warning");
      return capped ? "cap" : "short";
    }
    if (c.cluster !== "mainnet-beta") {
      this.say("dry", `keeper (dry run): ${sol(lamports)}, under the ${sol(c.solFloor)} floor; would buy ${sol(want)} with at most ${usd(budget)}, on mainnet`);
      return "dry";
    }
    // A dry run's quote is only said once an hour: not asked for more often either.
    if (!this.live && this.said?.key === "dry" && now - this.said.at < SAY_AGAIN_MS) return "dry";
    let out = want;
    let quote = await this.quote(out);
    if (BigInt(quote.otherAmountThreshold) > budget) {
      // Less than the target, as much as the budget buys: it still lifts the relayer off the floor.
      out = (want * budget * 98n) / (BigInt(quote.otherAmountThreshold) * 100n);
      quote = await this.quote(out);
    }
    const most = this.check(quote, out, budget);
    const route = (quote.routePlan ?? []).map((r) => r.swapInfo?.label ?? "?").join(" + ");
    if (!this.live) {
      this.say("dry", `keeper (dry run): ${sol(lamports)}, under the ${sol(c.solFloor)} floor; would buy ${sol(out)} for ${usd(BigInt(quote.inAmount))}, at most ${usd(most)}, via ${route}`);
      return "dry";
    }
    return this.swap(quote, out, most, route);
  }

  private get jupiter(): Jupiter {
    return { url: this.cfg.jupiterUrl, key: this.cfg.jupiterKey, fetch: this.io.fetch };
  }

  private quote(lamports: bigint) {
    return quoteExactOut(this.jupiter, this.cfg.usdcMint, lamports, this.cfg.slippageBps);
  }

  /** A quote for exactly `out` lamports, USDC in, wSOL out, within `budget` slippage and all: the most it may spend. */
  private check(q: Quote, out: bigint, budget: bigint): bigint {
    if (q.inputMint !== this.cfg.usdcMint || q.outputMint !== WSOL) throw new Error(`quote is ${q.inputMint} for ${q.outputMint}, not USDC for SOL`);
    if (q.swapMode !== "ExactOut" || BigInt(q.outAmount) < out) throw new Error(`quote is ${q.swapMode} for ${q.outAmount} lamports, not ExactOut for ${out}`);
    if (q.slippageBps !== this.cfg.slippageBps) throw new Error(`quote allows ${q.slippageBps} bps of slippage, not ${this.cfg.slippageBps}`);
    const most = BigInt(q.otherAmountThreshold);
    const into = BigInt(q.inAmount);
    // ExactOut's slippage is on what goes in: the most is the amount in and its slippage, no more.
    if (most < into || most > (into * BigInt(10_000 + q.slippageBps)) / 10_000n + 1n) throw new Error(`quote's most in, ${most}, is not ${into} and its slippage`);
    if (most > budget) throw new Error(`quote wants up to ${usd(most)}, over the ${usd(budget)} it may spend`);
    return most;
  }

  /**
   * Before the relayer signs Jupiter's transaction: the relayer pays its fee and is its only signer; it calls nothing
   * but the token, ATA, system and compute budget programs and Jupiter's; its fee is within the relayer's own cap; and
   * run against the chain, it takes no more USDC than the quote's most and gives the SOL.
   */
  private async swap(quote: Quote, out: bigint, most: bigint, route: string): Promise<string> {
    const me = this.io.relayer.address;
    const res = await ask<{ swapTransaction: string; lastValidBlockHeight: number }>(this.jupiter, "/swap", {
      quoteResponse: quote,
      userPublicKey: me,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      computeUnitPriceMicroLamports: this.io.priority(),
    });
    const tx = getTransactionDecoder().decode(b64.encode(res.swapTransaction));
    const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    if (msg.version !== 0 && msg.version !== "legacy") throw new Error(`swap is a version ${msg.version} transaction`);
    if (msg.staticAccounts[0] !== me) throw new Error(`swap's fee payer is ${msg.staticAccounts[0]}, not the relayer`);
    const signers = Object.keys(tx.signatures);
    if (msg.header.numSignerAccounts !== 1 || signers.length !== 1 || signers[0] !== me) throw new Error(`swap wants signatures from ${signers.join(", ")}`);
    let units = 200_000;
    let price = 0n;
    for (const ix of msg.instructions) {
      // A v0 transaction's programs are always in its own accounts, never a lookup table's.
      const program = msg.staticAccounts[ix.programAddressIndex];
      if (!program || !PROGRAMS.has(program)) throw new Error(`swap calls ${program ?? `account ${ix.programAddressIndex}`}`);
      const d = ix.data;
      if (program === COMPUTE_BUDGET && d?.[0] === 2) units = new DataView(d.buffer, d.byteOffset).getUint32(1, true);
      if (program === COMPUTE_BUDGET && d?.[0] === 3) price = new DataView(d.buffer, d.byteOffset).getBigUint64(1, true);
    }
    if (units > MAX_CU || price > BigInt(this.cfg.priorityMax)) throw new Error(`swap's fee is ${units} units at ${price} micro-lamports, over the relayer's cap`);
    // Read again just before: the relayer's SOL moves with every bet it places.
    const before = await this.io.balances();
    const sim = await this.io.simulate(tx);
    if (sim.err) throw new Error(`swap fails in simulation: ${jsonOf(sim.err)}`);
    const spent = (before.usdc ?? 0n) - (sim.usdc ?? 0n);
    if (sim.usdc === null || spent > most) throw new Error(`swap would take ${usd(spent)}, over the quote's ${usd(most)}`);
    const slack = out / 10n > SOL_SLACK ? out / 10n : SOL_SLACK;
    if (sim.lamports === null || sim.lamports - before.lamports < out - slack) throw new Error(`swap would give ${sol((sim.lamports ?? 0n) - before.lamports)}, not ${sol(out)}`);

    // Counted before it goes, at the most it could take: a crash while it is in flight still counts it today.
    this.state.lastSwapAt = this.io.now();
    this.state.swapped += most;
    this.save();
    let sent: Sent;
    try {
      sent = await this.io.signAndSend(`keeper swap ${out} lamports`, tx, BigInt(res.lastValidBlockHeight));
      if (sent.err) throw new Error(`swap failed on chain: ${jsonOf(sent.err)}`);
    } catch (e) {
      // A swap that failed or never landed took nothing.
      this.state.swapped -= most;
      this.save();
      throw e;
    }
    this.stats.swaps++;
    this.lastError = null;
    this.said = null;
    const line = `keeper: bought ${sol(out)} for ${usd(BigInt(quote.inAmount))} (at most ${usd(most)}) via ${route}: ${sent.signature}`;
    this.log(line);
    this.alert("keeper-swap", line, "warning");
    return "swapped";
  }

  /** What is over the keep, to the cold wallet's USDC account (made if it is not there, the relayer paying). */
  private async toCold(usdc: bigint): Promise<string> {
    const c = this.cfg;
    const cold = c.coldWallet!;
    const now = this.io.now();
    let amount = usdc - c.keepE6;
    const bounded = amount > c.coldMaxE6;
    if (bounded) amount = c.coldMaxE6;
    if (!this.live) {
      this.say("dry-cold", `keeper (dry run): ${usd(usdc)} over the ${usd(c.capE6)} cap; would send ${usd(amount)} to ${cold}${bounded ? ` (the most at once, KEEPER_COLD_MAX_USDC)` : ""}`);
      return "dry";
    }
    if (now - this.state.lastColdAt < COLD_EVERY_MS) {
      this.say("wait-cold", `keeper: ${usd(usdc)} over the ${usd(c.capE6)} cap; last sent to the cold wallet ${Math.round((now - this.state.lastColdAt) / 60_000)} min ago, once an hour`);
      return "wait";
    }
    const [ata] = await findAssociatedTokenPda({ mint: c.usdcMint, owner: cold, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const me = this.io.relayer;
    const ixs = [
      getCreateAssociatedTokenIdempotentInstruction({ payer: me, ata, owner: cold, mint: c.usdcMint }),
      getTransferCheckedInstruction({ source: this.io.usdcAccount, mint: c.usdcMint, destination: ata, authority: me, amount, decimals: USDC_DECIMALS }),
    ];
    this.state.lastColdAt = now;
    this.save();
    const s = await this.io.send(`keeper ${amount} to cold`, ixs, 60_000);
    if (s.err) throw new Error(`transfer to the cold wallet failed on chain: ${jsonOf(s.err)}`);
    this.stats.transfers++;
    this.lastError = null;
    this.said = null;
    const line = `keeper: sent ${usd(amount)} to the cold wallet ${cold}, keeping ${usd(usdc - amount)}: ${s.signature}`;
    this.log(line);
    this.alert("keeper-cold", line, "warning");
    return "sent";
  }

  /** Written only when it changed. A write that fails is said, and the keeper stops moving money until it can. */
  private save() {
    const s: State = { lastSwapAt: this.state.lastSwapAt, lastColdAt: this.state.lastColdAt, day: this.state.day, swappedE6: this.state.swapped.toString() };
    const text = JSON.stringify(s);
    if (text === this.saved) return;
    writeAtomic(this.statePath, text);
    this.saved = text;
  }
}
