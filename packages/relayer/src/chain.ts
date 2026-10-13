/**
 * The relayer's hands on chain: reads, and transactions sent the Monad way:
 * a local nonce, a gas limit worked out from the call's shape rather than
 * estimated (gas.ts), the base fee followed in the background, and a
 * synchronous send that returns the receipt. Nothing is asked of the node
 * between deciding to send and sending.
 */
import gameAbiJson from "@skech/contracts/evm/abi/SkechGame.json";
import iouAbiJson from "@skech/contracts/evm/abi/SkechIOU.json";
import {
  type Abi,
  type Address,
  type BaseError,
  type Chain,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  type Hex,
  keccak256,
  type Log,
  parseGwei,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monad, monadTestnet } from "viem/chains";
import { sendRawTransactionSync } from "viem/actions";
import { Nonces } from "./nonce";
import { monadHttp, redact } from "./rpc";
import type { Config } from "./config";
import { describe, gasLimit, type Shape } from "./gas";

export const GAME_ABI = gameAbiJson as Abi;
export const IOU_ABI = iouAbiJson as Abi;
const MONAD_PRIORITY = parseGwei("2");
/** One shaped send in this many is also estimated, alongside, to check the model against the chain. RELAYER_SHADOW_EVERY=1 checks every one. */
const SHADOW_EVERY = Math.max(1, Number(process.env.RELAYER_SHADOW_EVERY) || 5);
/** How long a transaction the send lost track of is waited on before it is given up. */
const WAIT_MS = 20_000;

/** A send that failed without saying whether the node has the transaction: it may be on chain, or land yet. */
const unsure = (e: unknown) =>
  ["TimeoutError", "HttpRequestError"].includes((e as Error)?.name) || /timed? ?out|timeout|took too long|fetch failed|socket|connection|network|already known/i.test(String((e as Error)?.message ?? e));

type Dispatched = { nonce: number; serialized: Hex; sending: Promise<TransactionReceipt> };

/** A call the chain reverted, and why (the contract's error, when it has one): sending it again as it is will not help. */
export class Reverted extends Error {
  constructor(
    message: string,
    readonly why: string | null,
  ) {
    super(message);
  }
}

/**
 * What the relayer knows of the pool and the fees without asking: followed from
 * its own receipts, and read afresh every few seconds for what others did.
 * Both decide a little of the gas: a zero slot costs more to write, and a pool
 * that may fall short means IOUs may be minted.
 */
export class Ledger {
  pool: bigint | null = null;
  feesNonZero: boolean | null = null;
  /** Bumped on every change we make from our own receipts: a read of the chain that straddles one is stale. */
  epoch = 0;

  set(pool: bigint, fees: bigint) {
    this.pool = pool;
    this.feesNonZero = fees > 0n;
  }

  note(events: { name: string; args: Record<string, unknown> }[]) {
    if (events.length) this.epoch++;
    for (const ev of events) {
      const a = ev.args;
      if (ev.name === "Placed") {
        if (this.pool !== null) this.pool += (a.staked as bigint) - (a.fee as bigint);
        if ((a.fee as bigint) > 0n) this.feesNonZero = true;
      } else if (ev.name === "Settled") {
        // The player's payout, then the house's cut of its profit, both out of the pool.
        if (this.pool !== null) this.pool -= (a.paid as bigint) + (a.fee as bigint);
        if (this.pool !== null && this.pool < 0n) this.pool = 0n;
      } else if (ev.name === "Owed") {
        this.pool = 0n;
      } else if (ev.name === "Redeemed") {
        if (this.pool !== null) this.pool -= a.value as bigint;
        if (this.pool !== null && this.pool < 0n) this.pool = 0n;
      } else if (ev.name === "FeesCollected") {
        this.feesNonZero = false;
      }
    }
  }

  /** How many of the pool and the fees a placement may find at zero. Unknown counts as zero. */
  get coldSlots(): number {
    return (this.pool === null || this.pool === 0n ? 1 : 0) + (this.feesNonZero === true ? 0 : 1);
  }

  get coldFees(): boolean {
    return this.feesNonZero !== true;
  }
}

export type GasStats = {
  sent: number;
  estimated: number;
  shadows: number;
  short: number;
  worst: number;
  slack: Record<string, number>;
  throttled: number;
  /** The last shadow estimates: what was sent against what the chain thought it needed. */
  recent: { label: string; limit: string; estimate: string; ratio: number }[];
};

export type Session = { key: Address; validUntil: bigint; allowance: bigint; x: Hex; y: Hex };
export type GameConfig = { feeBps: number; profitFeeBps: number; sweepBps: number; lateMs: number; placeGraceMs: number; maxPriceAgeMs: number; minPerDot: bigint; maxPerDot: bigint; maxPieceStake: bigint; minRedeem: bigint };

export class ChainClient {
  readonly account;
  readonly chain: Chain;
  readonly pub;
  readonly wallet;
  private readonly nonces;
  /** The one writer: nonces are taken, and transactions signed and started, one at a time. */
  private writing: Promise<unknown> = Promise.resolve();
  private inflight = 0;
  readonly ledger = new Ledger();
  /** The base fee as last seen, and when. */
  private baseFee: bigint | null = null;
  /** The latest block's number, from following the base fee, and when it was seen. */
  private head: { number: bigint; at: number } | null = null;
  /** Basis points over the model per kind of call, widened when a limit proved short. */
  private slack = new Map<Shape["kind"], bigint>();
  private sends = 0;
  readonly gasStats: GasStats = { sent: 0, estimated: 0, shadows: 0, short: 0, worst: 0, slack: {}, throttled: 0, recent: [] };

  constructor(readonly cfg: Config, private readonly log: (s: string) => void) {
    this.account = privateKeyToAccount(cfg.key);
    const known = cfg.chainId === 143 ? monad : cfg.chainId === 10143 ? monadTestnet : null;
    this.chain = known ?? { id: cfg.chainId, name: `chain ${cfg.chainId}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } };
    let throttled = 0;
    const transport = monadHttp(cfg.rpcUrl, { batch: true, timeout: 20_000 }, (method) => {
      this.gasStats.throttled++;
      if (throttled++ % 20 === 0) log(`rpc: ${redact(cfg.rpcUrl)} is rate limiting (${method}); waiting it out. A private RPC in MONAD_RPC_URL, or a higher plan, avoids this`);
    });
    // Reads made together (an account's balance, session, IOUs and nonce; the pool and the fees) are one eth_call
    // through Multicall3, not one request each: a batch of JSON-RPC calls still counts each against the limit. A chain
    // without Multicall3 (anvil) reads them one by one.
    this.pub = createPublicClient({ chain: this.chain, transport, batch: { multicall: true } });
    this.wallet = createWalletClient({ chain: this.chain, transport, account: this.account });
    this.nonces = new Nonces(this.pub, this.account.address);
  }

  /** Follow the base fee and, for the gas model, the pool and the fees, in the background. */
  async start() {
    await Promise.all([this.refreshFee(), this.refreshLedger()]);
    setInterval(() => void this.refreshFee(), 2_000);
    setInterval(() => void this.refreshLedger(), 5_000);
  }

  private async refreshFee() {
    try {
      const block = await this.pub.getBlock({ blockTag: "latest" });
      if (block.baseFeePerGas !== null && block.baseFeePerGas !== undefined) this.baseFee = block.baseFeePerGas;
      this.head = { number: block.number, at: Date.now() };
    } catch (e) {
      this.log(`base fee: ${String((e as Error).message ?? e).split("\n")[0]}`);
    }
  }

  private async refreshLedger() {
    try {
      const epoch = this.ledger.epoch;
      const [pool, fees] = await Promise.all([this.pool(), this.fees()]);
      // One of our own transactions landed while reading: the read may be from before it. Keep what we worked out.
      if (this.ledger.epoch === epoch) this.ledger.set(pool, fees);
    } catch (e) {
      this.log(`ledger: ${String((e as Error).message ?? e).split("\n")[0]}`);
    }
  }

  /* ---- reads ---- */

  /** The latest block's number: the one the base fee came with if it is under `maxAgeMs` old, else asked for. */
  async blockNumber(maxAgeMs = 2_500): Promise<bigint> {
    if (this.head && Date.now() - this.head.at <= maxAgeMs) return this.head.number;
    return this.pub.getBlockNumber();
  }

  read<T>(fn: string, args: unknown[] = [], address: Address = this.cfg.game, abi: Abi = GAME_ABI) {
    return this.pub.readContract({ address, abi, functionName: fn, args }) as Promise<T>;
  }
  balanceOf = (player: Address) => this.read<bigint>("balanceOf", [player]);
  sessionOf = (player: Address) => this.read<Session>("sessionOf", [player]);
  nonceOf = (player: Address) => this.read<bigint>("nonces", [player]);
  difficultyOf = (market: number) => this.read<number>("difficultyOf", [market]);
  gameConfig = () => this.read<GameConfig>("config");
  oracle = () => this.read<Address>("oracle");
  pool = () => this.read<bigint>("pool");
  fees = () => this.read<bigint>("fees");
  barAt = (market: number, second: bigint) => this.read<[bigint, bigint, bigint, bigint]>("barAt", [market, second]);
  iouBalance = (holder: Address) => this.read<bigint>("balanceOf", [holder], this.cfg.iou!, IOU_ABI);
  iouAssets = (holder: Address) => this.read<bigint>("assetsOf", [holder], this.cfg.iou!, IOU_ABI);

  /**
   * Whether a call would go through, and its gas if so, in one round trip:
   * the estimate reverts where the call would, and says why. For calls whose
   * gas is not worked out from their shape, the estimate is then sent with,
   * rather than asked for again.
   */
  async check(fn: string, args: unknown[]): Promise<{ why: string } | { gas: bigint }> {
    try {
      return { gas: await this.pub.estimateContractGas({ address: this.cfg.game, abi: GAME_ABI, functionName: fn, args, account: this.account }) };
    } catch (e) {
      const err = e as BaseError;
      const revert = typeof err.walk === "function" ? err.walk((x) => x instanceof ContractFunctionRevertedError) : null;
      if (revert instanceof ContractFunctionRevertedError) {
        const name: string | undefined = revert.data?.errorName ?? revert.reason;
        if (name) return { why: name };
      }
      return { why: (err.shortMessage ?? err.message ?? String(e)).split("\n")[0] };
    }
  }

  /* ---- writes ---- */

  /**
   * Send one call and wait for its receipt. With a `shape` the gas limit is
   * the model's (gas.ts); without one it is estimated, for the calls that
   * reach Circle's USDC, whose cost is not ours to pin. Monad charges the
   * limit, and its receipts report the limit as used, so a reverted call is
   * told apart by one estimate afterwards: over the limit, the gas ran out,
   * and the call goes again wider. The sync send returns the receipt from the
   * proposed block, a few hundred ms on.
   */
  async send(fn: string, args: unknown[], label: string, shape?: Shape, estimated?: bigint): Promise<TransactionReceipt> {
    const data = encodeFunctionData({ abi: GAME_ABI, functionName: fn, args });
    let limit: bigint;
    let how: string;
    if (shape) {
      limit = gasLimit(shape, data, this.slack.get(shape.kind) ?? 0n);
      how = describe(shape);
    } else {
      const estimate = estimated ?? (await this.pub.estimateGas({ account: this.account, to: this.cfg.game, data }));
      limit = (estimate * 115n) / 100n;
      how = `estimated ${estimate}`;
      this.gasStats.estimated++;
    }
    // Now and then the model is checked against the chain's own estimate, alongside: the send never waits for it.
    // An estimate already made (the check before a session) is compared every time, rather than asked for again.
    const shadow =
      shape && estimated !== undefined
        ? Promise.resolve(estimated)
        : shape && this.sends++ % SHADOW_EVERY === 0
          ? this.pub.estimateGas({ account: this.account, to: this.cfg.game, data }).then(
              (g) => g,
              () => null,
            )
          : null;
    if (this.baseFee === null) await this.refreshFee();
    let attempt = 0;
    for (;;) {
      attempt++;
      const started = performance.now();
      const receipt = await this.deliver(label, await this.dispatch(data, limit), attempt < 3);
      if (receipt === "again") continue;
      const ms = Math.round(performance.now() - started);
      if (receipt.effectiveGasPrice > MONAD_PRIORITY) this.baseFee = receipt.effectiveGasPrice - MONAD_PRIORITY;
      if (receipt.status !== "success") {
        const verdict = await this.diagnose(data, limit);
        if (verdict.kind === "outOfGas" && shape && attempt < 3) {
          const wider = this.widen(shape.kind, verdict.need, limit);
          this.gasStats.short++;
          this.log(
            `GAS MODEL SHORT: ${label} (${how}) reverted in block ${receipt.blockNumber} with ${limit} gas; the chain wants ${verdict.need}. Slack for ${shape.kind} is now ${wider} bps; sending again`,
          );
          limit = gasLimit(shape, data, wider);
          if (limit < (verdict.need * 115n) / 100n) limit = (((verdict.need * 115n) / 100n + 999n) / 1000n) * 1000n;
          continue;
        }
        if (verdict.kind === "passes" && attempt < 3) {
          this.log(`${label}: reverted in block ${receipt.blockNumber} (${receipt.transactionHash}) but would go through now; sending again`);
          continue;
        }
        this.log(`${label}: reverted in block ${receipt.blockNumber} (${receipt.transactionHash}) after ${ms} ms${verdict.kind === "reverted" ? `: ${verdict.why}` : ""}`);
        throw new Reverted(`${label} reverted${verdict.kind === "reverted" ? `: ${verdict.why}` : ""}`, verdict.kind === "reverted" ? verdict.why : null);
      }
      const events = this.events(receipt);
      this.ledger.note(events);
      this.gasStats.sent++;
      // Anvil reports what ran; Monad reports the limit. Say the former only when it says something.
      const used = receipt.gasUsed !== limit ? `, ${receipt.gasUsed} used` : "";
      this.log(`${label}: block ${receipt.blockNumber}, ${limit} gas (${how}${used}), ${ms} ms, ${receipt.transactionHash}`);
      if (shadow) void shadow.then((estimate) => this.compare(label, shape!, how, limit, estimate));
      return receipt;
    }
  }

  /**
   * Take a nonce, sign, and start the send, as the one writer: never two at once, so transactions go out in the
   * order their nonces were taken. A nonce taken and not sent is lost, and the node asked again.
   */
  private dispatch(data: Hex, limit: bigint): Promise<Dispatched> {
    const run = this.writing.then(async () => {
      const nonce = await this.nonces.take();
      try {
        const base = this.baseFee ?? parseGwei("100");
        const request = await this.wallet.prepareTransactionRequest({
          to: this.cfg.game,
          data,
          nonce,
          gas: limit,
          maxPriorityFeePerGas: MONAD_PRIORITY,
          maxFeePerGas: base * 2n + MONAD_PRIORITY,
          type: "eip1559",
          parameters: ["chainId", "type"],
        });
        const serialized = await this.wallet.signTransaction(request);
        const sending = sendRawTransactionSync(this.wallet, { serializedTransaction: serialized, timeout: 8_000 });
        sending.catch(() => undefined); // heard in deliver
        return { nonce, serialized, sending };
      } catch (e) {
        this.nonces.lost(nonce);
        throw e;
      }
    });
    this.writing = run.catch(() => undefined);
    return run;
  }

  /**
   * The receipt of a transaction on its way, its nonce accounted for either way; "again" when the node turned it
   * away over its nonce and it may go again with another.
   */
  private async deliver(label: string, { nonce, serialized, sending }: Dispatched, retry: boolean): Promise<TransactionReceipt | "again"> {
    this.inflight++;
    try {
      const receipt = await sending;
      this.nonces.used(nonce);
      return receipt;
    } catch (e) {
      const text = String((e as Error).message ?? e).split("\n")[0];
      if (!unsure(e)) {
        // Turned away: its nonce was never taken.
        this.nonces.lost(nonce);
        if (retry && /nonce|replacement/i.test(text)) {
          this.log(`${label}: ${text}; syncing the nonce and retrying`);
          return "again";
        }
        throw e;
      }
      // Timed out, or the connection went: it may be on chain already, or land yet, and sent again under a new nonce
      // both could land. So this very transaction is waited on, its bytes sent again, before it is given up.
      const hash = keccak256(serialized);
      this.log(`${label}: ${text}; waiting on ${hash}`);
      const receipt = await this.waitFor(hash, serialized);
      if (receipt) {
        this.nonces.used(nonce);
        return receipt;
      }
      // Its nonce taken all the same means it is on chain (nothing else sends from this key), out of sight.
      const taken = await this.pub.getTransactionCount({ address: this.account.address, blockTag: "latest" }).then((n) => n > nonce, () => false);
      if (taken) this.nonces.used(nonce);
      else this.nonces.lost(nonce);
      throw new Error(`${label}: ${hash} ${taken ? "took its nonce but no receipt came" : `not on chain ${WAIT_MS / 1000} s after it was sent`}`);
    } finally {
      this.inflight--;
    }
  }

  /** A transaction the send lost track of: its receipt, looked for every second for WAIT_MS, its bytes sent again every few. */
  private async waitFor(hash: Hex, serialized: Hex): Promise<TransactionReceipt | null> {
    for (let i = 1; i <= WAIT_MS / 1000; i++) {
      await Bun.sleep(1_000);
      const receipt = await this.pub.getTransactionReceipt({ hash }).catch(() => null);
      if (receipt) return receipt;
      if (i % 3 === 0) await this.wallet.sendRawTransaction({ serializedTransaction: serialized }).catch(() => undefined);
    }
    return null;
  }

  /** Why a call with `limit` gas reverted: the gas ran out, the call fails on its own, or it would pass now. */
  private async diagnose(data: Hex, limit: bigint): Promise<{ kind: "outOfGas"; need: bigint } | { kind: "passes"; need: bigint } | { kind: "reverted"; why: string }> {
    try {
      const need = await this.pub.estimateGas({ account: this.account, to: this.cfg.game, data });
      return need > limit ? { kind: "outOfGas", need } : { kind: "passes", need };
    } catch (e) {
      const err = e as BaseError;
      const revert = typeof err.walk === "function" ? err.walk((x) => x instanceof ContractFunctionRevertedError) : null;
      const why = revert instanceof ContractFunctionRevertedError ? (revert.data?.errorName ?? revert.reason) : undefined;
      return { kind: "reverted", why: why ?? (err.shortMessage ?? err.message ?? String(e)).split("\n")[0] };
    }
  }

  /** Widen the slack for `kind` so that `need` would have fit, and a little more. */
  private widen(kind: Shape["kind"], need: bigint, limit: bigint): bigint {
    const now = this.slack.get(kind) ?? 0n;
    const shortBy = ((need - limit) * 10_000n) / limit;
    const wider = now + (shortBy > 1000n ? shortBy : 1000n) + 500n;
    this.slack.set(kind, wider);
    this.gasStats.slack[kind] = Number(wider);
    return wider;
  }

  /** A shadow estimate against the limit that was sent: over it, the model would have failed; near it, it is tight. */
  private compare(label: string, shape: Shape, how: string, limit: bigint, estimate: bigint | null) {
    if (estimate === null) return;
    this.gasStats.shadows++;
    const ratio = Number((estimate * 1000n) / limit) / 1000;
    this.gasStats.recent.push({ label: `${label} (${how})`, limit: limit.toString(), estimate: estimate.toString(), ratio });
    if (this.gasStats.recent.length > 20) this.gasStats.recent.shift();
    if (ratio > this.gasStats.worst) this.gasStats.worst = ratio;
    if (estimate > limit) {
      const wider = this.widen(shape.kind, estimate, limit);
      this.gasStats.short++;
      this.log(`GAS MODEL SHORT: ${label} (${how}) went with ${limit} gas but the chain estimates ${estimate}; slack for ${shape.kind} is now ${wider} bps`);
    } else if (ratio > 0.97) {
      this.log(`gas model tight: ${label} (${how}) went with ${limit}, the chain estimates ${estimate} (${Math.round(ratio * 100)}%)`);
    }
  }

  /** The game's events in a receipt, decoded. */
  events(receipt: TransactionReceipt): { name: string; args: Record<string, unknown> }[] {
    const out: { name: string; args: Record<string, unknown> }[] = [];
    for (const log of receipt.logs as Log[]) {
      if (log.address.toLowerCase() !== this.cfg.game.toLowerCase()) continue;
      try {
        const d = decodeEventLog({ abi: GAME_ABI, data: log.data, topics: log.topics });
        out.push({ name: d.eventName as unknown as string, args: (d.args ?? {}) as Record<string, unknown> });
      } catch {
        /* someone else's event */
      }
    }
    return out;
  }

  get busy() {
    return this.inflight;
  }
}

