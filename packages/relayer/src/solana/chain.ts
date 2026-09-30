/**
 * The relayer's hand on Solana: one keypair that pays every fee and rent and signs as the oracle; a blockhash and a
 * priority fee kept fresh in the background, so sending never waits for either; v0 transactions through the lookup
 * table; and every transaction rebroadcast until it lands or its blockhash runs out, since an RPC forwards a
 * transaction once and a busy leader can drop it: all of those in flight looked for together (confirm.ts).
 */
import {
  type Address,
  appendTransactionMessageInstructions,
  assertAccountExists,
  type Base64EncodedWireTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createKeyPairSignerFromBytes,
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  createTransactionMessage,
  type EncodedAccount,
  fetchEncodedAccounts,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  type Instruction,
  type KeyPairSigner,
  partiallySignTransactionMessageWithSigners,
  pipe,
  type Rpc,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Signature,
  signTransaction,
  type SolanaRpcApi,
  type Transaction,
} from "@solana/kit";
import { fetchAddressLookupTable } from "@solana-program/address-lookup-table";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { decodeToken, findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  CLAIMED_EVENT_DISCRIMINATOR,
  decodeGame,
  decodeHolder,
  decodeMarket,
  decodePlayer,
  decodePool,
  decodeRewards,
  fetchGame,
  fetchMarket,
  fetchMaybePlayer,
  fetchPool,
  type Game,
  getBarPostedEventDecoder,
  getClaimedEventDecoder,
  getDepositedEventDecoder,
  getMintedEventDecoder,
  getOwedEventDecoder,
  getPlacedEventDecoder,
  getRedeemedEventDecoder,
  getSettledEventDecoder,
  holderAddress,
  MINTED_EVENT_DISCRIMINATOR,
  type Player,
  type Pool,
  rewardsAddress,
  BAR_POSTED_EVENT_DISCRIMINATOR,
  DEPOSITED_EVENT_DISCRIMINATOR,
  OWED_EVENT_DISCRIMINATOR,
  PLACED_EVENT_DISCRIMINATOR,
  REDEEMED_EVENT_DISCRIMINATOR,
  SETTLED_EVENT_DISCRIMINATOR,
  playerAddress,
} from "@skech/contracts/solana/sdk";
import { remember } from "../limits";
import type { SolanaConfig } from "./config";
import { Accounts, type Snapshot } from "./accounts";
import { Budget, budgeted } from "./budget";
import { Confirmations, type Sent } from "./confirm";

type Blockhash = { blockhash: Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0]["blockhash"]; lastValidBlockHeight: bigint };
export type { Sent };

const EVENTS = [
  ["Placed", PLACED_EVENT_DISCRIMINATOR, getPlacedEventDecoder()],
  ["Settled", SETTLED_EVENT_DISCRIMINATOR, getSettledEventDecoder()],
  ["Owed", OWED_EVENT_DISCRIMINATOR, getOwedEventDecoder()],
  ["Redeemed", REDEEMED_EVENT_DISCRIMINATOR, getRedeemedEventDecoder()],
  ["Deposited", DEPOSITED_EVENT_DISCRIMINATOR, getDepositedEventDecoder()],
  ["BarPosted", BAR_POSTED_EVENT_DISCRIMINATOR, getBarPostedEventDecoder()],
  ["Minted", MINTED_EVENT_DISCRIMINATOR, getMintedEventDecoder()],
  ["Claimed", CLAIMED_EVENT_DISCRIMINATOR, getClaimedEventDecoder()],
] as const;
export type SolanaEvent = { name: (typeof EVENTS)[number][0]; data: Record<string, unknown> };

/** A fresh blockhash this often, and what recent blocks paid in priority this often. */
const HASH_EVERY_MS = 12_000;
const PRIORITY_EVERY_MS = 45_000;
/** A block at least this often, for reckoning the height: slower than a slot, so it runs behind (see `height`). */
const BLOCK_MS = 450;

const b64 = getBase64Encoder();
const same = (a: Uint8Array | { readonly [i: number]: number; length: number }, b: { readonly [i: number]: number; length: number }) => a.length === b.length && Array.from({ length: a.length }).every((_, i) => a[i] === b[i]);

/** The program's custom error code in a transaction error, if it is one. */
export function customCode(err: unknown): number | null {
  const ie = (err as { InstructionError?: [number, unknown] } | null)?.InstructionError;
  const c = (ie?.[1] as { Custom?: number | bigint } | undefined)?.Custom;
  return c === undefined ? null : Number(c);
}

export class SolanaChain {
  readonly rpc: Rpc<SolanaRpcApi>;
  /** The same RPC, for the sweep's reads: they wait behind everything players are waiting on. */
  readonly sweepRpc: Rpc<SolanaRpcApi>;
  signer!: KeyPairSigner;
  private table: Record<Address, Address[]> = {};
  private hash: Blockhash | null = null;
  private hashAt = 0;
  /** Micro-lamports per compute unit, from what recent blocks paid to write the pool. */
  priority = 0;
  /** Built transactions awaiting a wallet's signature: their message, so only what we built is ever co-signed, and whether it approves the game to sweep. */
  private built = new Map<string, { message: Uint8Array; lastValid: bigint; at: number; kind: string; player: Address; approve: boolean }>();
  inflight = 0;
  stats = { sent: 0, landed: 0, failed: 0, expired: 0, rebroadcasts: 0 };
  /** Every transaction in flight, looked for in one request. */
  readonly confirmations: Confirmations;
  /** What every request to the RPC waits on (budget.ts). */
  readonly budget: Budget;
  /** Each player's accounts, read at most once a second however many ask (accounts.ts). */
  readonly accounts = new Accounts((wallet) => this.snapshot(wallet));
  /** SKT's global account, which every placement and settlement writes. */
  rewards!: Address;
  /** Bets one settlement holds: (bet, player, holder) for each, in 1,232 bytes; one fewer if the lookup table lacks `rewards`. */
  betsPerSettle = 9;

  constructor(readonly cfg: SolanaConfig, private readonly log: (s: string) => void) {
    this.budget = new Budget(cfg.rpcPerSec, log);
    const http = createDefaultRpcTransport({ url: cfg.rpcUrl });
    this.rpc = createSolanaRpcFromTransport(budgeted(http, this.budget, cfg.rpcUrl));
    this.sweepRpc = createSolanaRpcFromTransport(budgeted(http, this.budget, cfg.rpcUrl, "sweep"));
    this.confirmations = new Confirmations(
      {
        statuses: (signatures, searchTransactionHistory) =>
          this.rpc
            .getSignatureStatuses(signatures, { searchTransactionHistory })
            .send()
            .then(({ value }) => value),
        push: (wire) => this.push(wire),
        height: () => this.height,
      },
      this.stats,
    );
  }

  private push(wire: Base64EncodedWireTransaction) {
    return this.rpc.sendTransaction(wire, { encoding: "base64", skipPreflight: true, maxRetries: 0n }).send().catch(() => undefined);
  }

  async start() {
    this.signer = await createKeyPairSignerFromBytes(this.cfg.keyBytes);
    const t = await fetchAddressLookupTable(this.rpc, this.cfg.deployment.lookupTable);
    this.table = { [this.cfg.deployment.lookupTable]: [...t.data.addresses] };
    this.rewards = await rewardsAddress(this.cfg.deployment.program);
    if (!t.data.addresses.includes(this.rewards)) {
      this.betsPerSettle = this.cfg.betsPerSettle - 1;
      this.log(`lookup table ${this.cfg.deployment.lookupTable} lacks SKT's rewards account: ${this.betsPerSettle} bets a settlement (bun run deploy:solana --skip-program extends it)`);
    } else this.betsPerSettle = this.cfg.betsPerSettle;
    await Promise.all([this.refreshHash(), this.refreshPriority()]);
    // A blockhash is good for 150 blocks, about a minute: one a few seconds old costs a transaction nothing. Asked
    // again sooner while the RPC is not answering, so it never runs out under us.
    const hashes = (ms: number) =>
      setTimeout(
        () =>
          void this.refreshHash().then(
            () => hashes(HASH_EVERY_MS),
            (e) => {
              if (Date.now() - this.hashAt > 30_000) this.log(`blockhash ${Math.round((Date.now() - this.hashAt) / 1000)} s old: ${String(e).split("\n")[0]}`);
              hashes(2_000);
            },
          ),
        ms,
      );
    hashes(HASH_EVERY_MS);
    // A fixed fee is never asked for.
    if (this.cfg.priorityFixed === null) setInterval(() => void this.refreshPriority().catch(() => {}), PRIORITY_EVERY_MS);
  }

  /**
   * The block height, reckoned rather than asked for: the blockhash's last valid block less its 150, plus a block for
   * every 450 ms since. Slots are 400 ms and some are skipped, so this runs behind the chain: a transaction is given
   * up a little late, never while it could still land.
   */
  get height(): bigint {
    if (!this.hash) return 0n;
    return this.hash.lastValidBlockHeight - 150n + BigInt(Math.floor((Date.now() - this.hashAt) / BLOCK_MS));
  }

  private async refreshHash() {
    const { value } = await this.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    this.hash = value;
    this.hashAt = Date.now();
  }

  private async refreshPriority() {
    if (this.cfg.priorityFixed !== null) {
      this.priority = this.cfg.priorityFixed;
      return;
    }
    const fees = await this.rpc.getRecentPrioritizationFees([this.cfg.deployment.pool]).send();
    const paid = fees.map((f) => Number(f.prioritizationFee)).sort((a, b) => a - b);
    // What three quarters of recent blocks paid to write the pool, and a floor so a quiet chain still lands quickly.
    const p75 = paid.length ? paid[Math.floor(paid.length * 0.75)] : 0;
    this.priority = Math.min(this.cfg.priorityMax, Math.max(1_000, p75));
  }

  private message(instructions: Instruction[], computeUnits: number) {
    if (!this.hash) throw new Error("no blockhash yet");
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(this.signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(this.hash!, m),
      (m) => appendTransactionMessageInstructions([getSetComputeUnitLimitInstruction({ units: computeUnits }), getSetComputeUnitPriceInstruction({ microLamports: BigInt(this.priority) }), ...instructions], m),
    );
    return compressTransactionMessageUsingAddressLookupTables(msg, this.table);
  }

  /** Send and wait for it to land (confirmed), rebroadcasting meanwhile. The error, if it failed on chain. */
  async send(label: string, instructions: Instruction[], computeUnits: number): Promise<Sent> {
    const tx = await partiallySignTransactionMessageWithSigners(this.message(instructions, computeUnits));
    return this.broadcast(label, getBase64EncodedWireTransaction(tx), getSignatureFromTransaction(tx), this.hash!.lastValidBlockHeight);
  }

  /**
   * A transaction built elsewhere (the keeper's swap), signed as its fee payer and sent like the relayer's own, until
   * it lands or `lastValid` passes. It signs whatever it is given: the caller checks it first.
   */
  async signAndSend(label: string, tx: Transaction, lastValid: bigint): Promise<Sent> {
    const signed = await signTransaction([this.signer.keyPair], tx);
    return this.broadcast(label, getBase64EncodedWireTransaction(signed), getSignatureFromTransaction(signed), lastValid);
  }

  private async broadcast(label: string, wire: Base64EncodedWireTransaction, signature: Signature, lastValid: bigint): Promise<Sent> {
    this.inflight++;
    this.stats.sent++;
    try {
      await this.push(wire);
      return await this.confirmations.watch(label, wire, signature, lastValid);
    } finally {
      this.inflight--;
    }
  }

  /** The program's events in a landed transaction, from its logs. */
  async events(signature: Signature): Promise<SolanaEvent[]> {
    for (let i = 0; i < 5; i++) {
      const tx = await this.rpc.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" }).send();
      if (tx) {
        const out: SolanaEvent[] = [];
        for (const line of tx.meta?.logMessages ?? []) {
          if (!line.startsWith("Program data: ")) continue;
          const bytes = b64.encode(line.slice(14));
          for (const [name, disc, dec] of EVENTS) {
            if (same(bytes.subarray(0, 8), disc)) out.push({ name, data: dec.decode(bytes) as unknown as Record<string, unknown> });
          }
        }
        return out;
      }
      if (i < 4) await Bun.sleep(300);
    }
    return [];
  }

  /* ---- transactions a wallet signs, which the relayer pays for ---- */

  /**
   * A transaction for a player's wallet to sign (the relayer's own signature already on it, as fee payer): what it
   * is kept, so `submit` co-signs nothing but this.
   */
  async build(kind: string, player: Address, instructions: Instruction[], computeUnits: number, approve = false): Promise<{ id: string; tx: string }> {
    const tx = await partiallySignTransactionMessageWithSigners(this.message(instructions, computeUnits));
    const id = crypto.randomUUID();
    for (const [k, v] of this.built) if (Date.now() - v.at > 120_000) this.built.delete(k);
    remember(this.built, id, { message: new Uint8Array(tx.messageBytes), lastValid: this.hash!.lastValidBlockHeight, at: Date.now(), kind, player, approve }, 10_000);
    return { id, tx: getBase64EncodedWireTransaction(tx) };
  }

  /** The same transaction back, signed by the wallet: sent if it is exactly what was built. */
  async submit(id: string, signed: string): Promise<{ kind: string; player: Address; approve: boolean; sent: Sent }> {
    const b = this.built.get(id);
    if (!b) throw new Error("Unknown or expired transaction: build it again");
    const tx = getTransactionDecoder().decode(b64.encode(signed));
    if (!same(new Uint8Array(tx.messageBytes), b.message)) throw new Error("Not the transaction that was built");
    if (Object.values(tx.signatures).some((s) => !s)) throw new Error("Not signed by every signer");
    this.built.delete(id);
    const wire = getBase64Decoder().decode(getTransactionEncoder().encode(tx)) as Base64EncodedWireTransaction;
    const signature = getSignatureFromTransaction(tx);
    // Its own blockhash's last block, from when it was built: not one from now, a wallet's signing later.
    const sent = await this.broadcast(b.kind, wire, signature, b.lastValid);
    return { kind: b.kind, player: b.player, approve: b.approve, sent };
  }

  /* ---- reading ---- */

  game(): Promise<Game> {
    return fetchGame(this.rpc, this.cfg.deployment.game).then((a) => a.data);
  }
  pool(): Promise<Pool> {
    return fetchPool(this.rpc, this.cfg.deployment.pool).then((a) => a.data);
  }
  difficulty(): Promise<number> {
    return fetchMarket(this.rpc, this.cfg.deployment.market).then((a) => a.data.difficulty);
  }
  async player(wallet: Address): Promise<Player | null> {
    const a = await fetchMaybePlayer(this.rpc, await playerAddress(wallet, this.cfg.deployment.program));
    return a.exists ? a.data : null;
  }
  /** The game's account and the market's difficulty, in one request. */
  async terms(): Promise<[Game, number]> {
    const [game, market] = await fetchEncodedAccounts(this.rpc, [this.cfg.deployment.game, this.cfg.deployment.market]);
    assertAccountExists(game);
    assertAccountExists(market);
    return [decodeGame(game).data, decodeMarket(market).data.difficulty];
  }
  /** Accounts in as few requests as `getMultipleAccounts` allows, 100 to one: null for one that is not there. */
  async many<T>(addresses: Address[], decode: (a: EncodedAccount) => T, rpc: Rpc<SolanaRpcApi> = this.rpc): Promise<(T | null)[]> {
    const out: (T | null)[] = [];
    for (let i = 0; i < addresses.length; i += 100) {
      for (const a of await fetchEncodedAccounts(rpc, addresses.slice(i, i + 100))) out.push(a.exists ? decode(a) : null);
    }
    return out;
  }
  /** A player's game account, the pool, the USDC account in their wallet, their SKT and SKT's own, in one request: see `accounts`. */
  async snapshot(wallet: Address): Promise<Omit<Snapshot, "at">> {
    const d = this.cfg.deployment;
    const [pda, [ata], hpda] = await Promise.all([playerAddress(wallet, d.program), findAssociatedTokenPda({ mint: d.usdcMint, owner: wallet, tokenProgram: TOKEN_PROGRAM_ADDRESS }), holderAddress(wallet, d.program)]);
    const [player, pool, token, holder, rewards] = await fetchEncodedAccounts(this.rpc, [pda, d.pool, ata, hpda, this.rewards]);
    assertAccountExists(pool);
    return {
      player: player.exists ? decodePlayer(player).data : null,
      pool: decodePool(pool).data,
      token: token.exists ? decodeToken(token).data : null,
      holder: holder.exists ? decodeHolder(holder).data : null,
      rewards: rewards.exists ? decodeRewards(rewards).data : null,
    };
  }
  async lamports(): Promise<bigint> {
    return (await this.rpc.getBalance(this.signer.address).send()).value;
  }
}
