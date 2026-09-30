/**
 * The Solana game from TypeScript: the networks, the accounts' addresses, and the one thing Codama cannot
 * generate, the bytes a session key signs. The relayer, the deploy script and the mobile app use this with the
 * generated client in `./client`.
 */
import { type Address, address, getAddressEncoder, getProgramDerivedAddress, getU32Encoder, getU64Encoder, type Instruction, type ReadonlyUint8Array } from "@solana/kit";
import { type Config, getPlaceInstructionDataEncoder, type Holder, type Pool, type Rewards, type RewardsConfig, SKECH_PROGRAM_ADDRESS, type SectionArgArgs } from "./client";

export * from "./client";

export type SolanaClusterName = "devnet" | "mainnet-beta" | "localnet";

export type SolanaNetwork = {
  cluster: SolanaClusterName;
  /** What a player is told the network is called. */
  label: string;
  /** The public RPC. A private one (Helius, Triton) goes in SOLANA_<NAME>_RPC_URL, server side. */
  rpc: string;
  ws: string;
  explorer: (kind: "tx" | "address", id: string) => string;
  /** Circle's USDC. */
  usdc: Address;
  /** Where free test USDC comes from; mainnet has none. */
  faucet: string | null;
};

const solscan = (cluster: string) => (kind: "tx" | "address", id: string) => `https://solscan.io/${kind === "tx" ? "tx" : "account"}/${id}${cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`}`;

export const SOLANA_NETWORKS: Record<SolanaClusterName, SolanaNetwork> = {
  devnet: {
    cluster: "devnet",
    label: "Solana devnet",
    rpc: "https://api.devnet.solana.com",
    ws: "wss://api.devnet.solana.com",
    explorer: solscan("devnet"),
    usdc: address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
    faucet: "https://faucet.circle.com/",
  },
  "mainnet-beta": {
    cluster: "mainnet-beta",
    label: "Solana",
    rpc: "https://api.mainnet-beta.solana.com",
    ws: "wss://api.mainnet-beta.solana.com",
    explorer: solscan("mainnet-beta"),
    usdc: address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    faucet: null,
  },
  localnet: {
    cluster: "localnet",
    label: "Solana localnet",
    rpc: "http://127.0.0.1:8899",
    ws: "ws://127.0.0.1:8900",
    explorer: (kind, id) => `https://explorer.solana.com/${kind}/${id}?cluster=custom`,
    // Created by the deploy script on a local validator.
    usdc: address("11111111111111111111111111111111"),
    faucet: null,
  },
};

/** SKECH_SOLANA_CLUSTER picks the row: devnet unless it says otherwise. */
export function solanaNetwork(env: Record<string, string | undefined>): SolanaNetwork {
  const name = (env.SKECH_SOLANA_CLUSTER?.trim() || "devnet") as SolanaClusterName;
  const n = SOLANA_NETWORKS[name];
  if (!n) throw new Error(`SKECH_SOLANA_CLUSTER is "${name}": use devnet, mainnet-beta or localnet`);
  return n;
}

/** A private RPC when one is set (SOLANA_DEVNET_RPC_URL, SOLANA_MAINNET_BETA_RPC_URL), else the public one. */
export function solanaRpc(env: Record<string, string | undefined>, n: SolanaNetwork): string {
  return env[`SOLANA_${n.cluster.toUpperCase().replace("-", "_")}_RPC_URL`]?.trim() || n.rpc;
}

/** What `bun run deploy:solana` writes to `packages/contracts/deployments/solana-<cluster>.json`. */
export type SolanaDeployment = {
  cluster: SolanaClusterName;
  program: Address;
  game: Address;
  pool: Address;
  market: Address;
  bars: Address;
  /** SKT's account; absent from a deployment written before SKT (`rewardsAddress` gives it). */
  rewards?: Address;
  vault: Address;
  usdcMint: Address;
  tokenProgram: Address;
  treasury: Address;
  oracle: Address;
  admin: Address;
  /** Every placement's shared accounts, so a 32-band piece fits in one transaction. */
  lookupTable: Address;
  slot: number;
};

/** Where it is, from the repo root. */
export const deploymentFile = (cluster: SolanaClusterName) => `packages/contracts/deployments/solana-${cluster}.json`;

/* ---- the program's rules, as the program has them (state.rs, piece.rs) ---- */

export const HORIZON = 30;
export const MAX_SECTIONS = 32;
export const PIECE_FIXED = 32 + 32 + 8 + 4 + 1 + 1 + 8 + 4 + 8 + 8 + 8 + 32 + 4;
export const SECTION_BYTES = 11;
export const ED25519_PROGRAM = address("Ed25519SigVerify111111111111111111111111111");
export const INSTRUCTIONS_SYSVAR = address("Sysvar1nstructions1111111111111111111111111");

/** `Config::DEFAULT`, what `initialize` sets: the EVM game's terms (`SkechGame.initialize`), and a session of 30 days at most. */
export const DEFAULT_CONFIG: Config = {
  feeBps: 400,
  profitFeeBps: 1000,
  sweepBps: 1000,
  lateMs: 200,
  placeGraceMs: 3000,
  maxPriceAgeMs: 15_000,
  minPerDot: 10_000n,
  maxPerDot: 100_000_000n,
  maxPieceStake: 10_000_000_000n,
  minRedeem: 10_000n,
  maxSessionSecs: 30n * 86_400n,
};

/* ---- SKT (state.rs, skt.rs) ---- */

/**
 * `RewardsConfig::DEFAULT`: 3 of the 4 stake points and 8 of the 10 profit points to SKT holders; the curve's scale
 * $1,000,000; a half-life of 26 weeks; no wallet past 10% of all SKT, or 100,000 SKT while there is under a million;
 * $2,457,600 kept in the pool over what live bets could pay before any surplus is shared, and of the surplus 75% to
 * holders, 25% to the treasury.
 */
export const DEFAULT_REWARDS_CONFIG: RewardsConfig = {
  holderFeeBps: 300,
  holderProfitFeeBps: 800,
  mintScale: 1_000_000_000_000n,
  halfLifeSecs: 26 * 7 * 86_400,
  walletCapBps: 1_000,
  capFloor: 1_000_000_000_000n,
  surplusReserve: 2_457_600_000_000n,
  surplusHolderBps: 7_500,
};
/** SKT is counted in millionths, as USDC is. */
export const SKT_DECIMALS = 6;
/** The holders' accumulator's scale. */
export const ACC_SCALE = 10n ** 24n;
/** Half-lives in an era, and eras whose closing accumulator is kept (state.rs). */
export const ERA_HALVINGS = 16n;
export const ERAS_KEPT = 8n;
const ERA_LOG2 = ERA_HALVINGS << 32n;

/** 2^(2^-i) for i = 1 to 32, times 2^62, rounded down: skt.rs `EXP2_TABLE`. */
const EXP2_TABLE = [
  6521908912666391106n, 5484249825272419511n, 5029079263719320435n, 4815862801830788490n, 4712668792719003883n, 4661903986662671289n, 4636727017470743990n, 4624189567668517720n,
  4617933561212708776n, 4614808732577250068n, 4613247111281068008n, 4612466498810092974n, 4612076242109103707n, 4611881126141011236n, 4611783571252412753n, 4611734794581956353n,
  4611710406440186475n, 4611698212417665819n, 4611692115418496524n, 4611689066921934630n, 4611687542674409371n, 4611686780550835663n, 4611686399489096040n, 4611686208958238036n,
  4611686113692811986n, 4611686066060099699n, 4611686042243743740n, 4611686030335565806n, 4611686024381476851n, 4611686021404432376n, 4611686019915910140n, 4611686019171649022n,
];
/** `2^(l / 2^32)` times 2^32, rounded down, as skt.rs `exp2_q32` works it. */
export function exp2Q32(l: bigint): bigint {
  const whole = l >> 32n > 90n ? 90n : l >> 32n;
  const frac = l & 0xffffffffn;
  let x = 1n << 62n;
  EXP2_TABLE.forEach((root, i) => {
    if (frac & (1n << BigInt(31 - i))) x = (x * root) >> 62n;
  });
  return (x >> 30n) << whole;
}
const shr = (x: bigint, bits: bigint) => (bits >= 128n ? 0n : x >> bits);
type Clock = Pick<Rewards, "anchorLog2" | "anchorTime" | "era" | "config">;
/** A share's weight at `now` (unix seconds), as its log2 times 2^32: `Rewards::log2_weight`. */
const log2Weight = (r: Clock, now: bigint) => r.anchorLog2 + ((now > r.anchorTime ? now - r.anchorTime : 0n) << 32n) / BigInt(Math.max(1, r.config.halfLifeSecs));

/**
 * What a holder's SKT is worth at `now` (unix seconds), e6: its shares over today's weight, eras and all, exactly as
 * `Rewards::balance_of` works it. SKT decays: it halves every half-life.
 */
export function sktNowE6(holder: Pick<Holder, "shares" | "era">, rewards: Clock, now: bigint): bigint {
  const l = log2Weight(rewards, now);
  const eras = BigInt(Math.max(0, rewards.era - holder.era)) + l / ERA_LOG2;
  return (shr(holder.shares, ERA_HALVINGS * eras) << 32n) / exp2Q32(l % ERA_LOG2);
}

/**
 * What a holder's SKT has earned and not been claimed, USDC e6: exactly what `claim` would pay now (`Holder::
 * settle_rewards`): this era's accumulator on its shares, and for a holder behind by eras, each kept era's on its shares
 * as they stood then.
 */
export function claimableE6(holder: Pick<Holder, "shares" | "era" | "accAt" | "unclaimed">, rewards: Pick<Rewards, "acc" | "era" | "eraEnds">): bigint {
  const endOf = (era: number) => (era < rewards.era && rewards.era - era <= Number(ERAS_KEPT) ? rewards.eraEnds[era % Number(ERAS_KEPT)] : null);
  if (holder.era === rewards.era) return holder.unclaimed + (rewards.acc > holder.accAt ? (holder.shares * (rewards.acc - holder.accAt)) / ACC_SCALE : 0n);
  let earned = 0n;
  const last = endOf(holder.era);
  if (last !== null && last > holder.accAt) earned += (holder.shares * (last - holder.accAt)) / ACC_SCALE;
  for (let era = holder.era + 1; era < rewards.era; era++) {
    const s = shr(holder.shares, ERA_HALVINGS * BigInt(era - holder.era));
    if (s === 0n) break;
    const end = endOf(era);
    if (end !== null) earned += (s * end) / ACC_SCALE;
  }
  earned += (shr(holder.shares, ERA_HALVINGS * BigInt(rewards.era - holder.era)) * rewards.acc) / ACC_SCALE;
  return holder.unclaimed + earned;
}

/** The most one piece can pay at `c`, gross: state.rs `max_piece_payout`. */
export const maxPiecePayoutE6 = (c: Pick<Config, "maxPerDot" | "maxPieceStake">) => {
  const bands = 32n * 256n * c.maxPerDot;
  const stake = (c.maxPieceStake * 12_800n) / 100n;
  return bands < stake ? bands : stake;
};

/** What `share_surplus` would move out of the pool now, USDC e6 (surplus.rs `surplus`): 0 while anything is owed, too
 * soon after SKT started, with no shares to share it among, or with the pool at or under its reserve and every live
 * bet's most. `surplusHolderBps` of it goes to holders, the rest to the treasury. */
export function surplusE6(pool: Pick<Pool, "pool" | "iouShares" | "houseShares">, rewards: Pick<Rewards, "liability" | "config" | "startedAt" | "totalShares">, now: bigint): bigint {
  if (pool.iouShares > 0n || pool.houseShares > 0n || now < rewards.startedAt + 240n || rewards.totalShares < 1_000_000n) return 0n;
  const keep = rewards.liability + rewards.config.surplusReserve;
  return pool.pool > keep ? pool.pool - keep : 0n;
}

/* ---- addresses ---- */

const enc = getAddressEncoder();
const text = (s: string) => new TextEncoder().encode(s);

export async function pda(seeds: (string | ReadonlyUint8Array)[], program: Address = SKECH_PROGRAM_ADDRESS): Promise<[Address, number]> {
  const [a, bump] = await getProgramDerivedAddress({ programAddress: program, seeds: seeds.map((s) => (typeof s === "string" ? text(s) : s)) });
  return [a, bump];
}
export const gameAddress = (program?: Address) => pda(["game"], program).then((r) => r[0]);
export const poolAddress = (program?: Address) => pda(["pool"], program).then((r) => r[0]);
export const marketAddress = (id: number, program?: Address) => pda(["market", Uint8Array.of(id)], program).then((r) => r[0]);
export const barsAddress = (id: number, program?: Address) => pda(["bars", Uint8Array.of(id)], program).then((r) => r[0]);
export const playerAddress = (wallet: Address, program?: Address) => pda(["player", enc.encode(wallet)], program).then((r) => r[0]);
/** SKT's global account: supply, the holders' accumulator, their funds, the tracked gain. */
export const rewardsAddress = (program?: Address) => pda(["rewards"], program).then((r) => r[0]);
/** A player's SKT: balance, earnings, net result and its low. Opened by the first settlement that mints for them. */
export const holderAddress = (wallet: Address, program?: Address) => pda(["holder", enc.encode(wallet)], program).then((r) => r[0]);
/** A piece's bet, at its canonical bump (the only address `place` takes), and that bump: `place` searches down from
 * 255 for it, and each bump below 255 costs it `place_per_bump` compute units more. */
export const betAddress = (wallet: Address, drawing: bigint, index: number, program?: Address) =>
  pda(["bet", enc.encode(wallet), getU64Encoder().encode(drawing), getU32Encoder().encode(index)], program);

/** sha256("skech/v1" || program id || cluster): what every signed piece starts with, as `initialize` sets it. */
export async function domainFor(program: Address, cluster: string): Promise<Uint8Array> {
  const bytes = new Uint8Array([...text("skech/v1"), ...enc.encode(program), ...text(cluster)]);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/* ---- a piece, as its session key signs it ---- */

export type SolanaPiece = {
  domain: ReadonlyUint8Array;
  player: Address;
  drawing: bigint;
  index: number;
  market: number;
  difficulty: number;
  openAt: bigint;
  perDot: number;
  unit: bigint;
  priceSeen: bigint;
  priceTime: bigint;
  strokeHash: ReadonlyUint8Array;
  sections: SectionArgArgs[];
};

/**
 * The bytes a session key signs: the piece exactly as it sits in the `place` instruction's data, from byte 8 (the
 * program checks the Ed25519 instruction points at that range of its own data).
 */
export function pieceBytes(p: SolanaPiece): Uint8Array {
  const data = getPlaceInstructionDataEncoder().encode({ ...p, price: 0n, momentum: 0n, receivedAt: 0n, chances: [] });
  return new Uint8Array(data.slice(8, 8 + PIECE_FIXED + p.sections.length * SECTION_BYTES));
}

/**
 * The Ed25519 precompile instruction that goes just before `place`, at index `placeIndex - 1`: one signature by
 * `key`, inline, over `len` bytes of the `place` instruction's data from byte 8.
 */
export function ed25519Instruction(key: ReadonlyUint8Array, signature: ReadonlyUint8Array, placeIndex: number, len: number): Instruction {
  const data = new Uint8Array(16 + 32 + 64);
  const v = new DataView(data.buffer);
  data[0] = 1;
  // signature offset, its instruction (inline), key offset, its instruction (inline), message offset, size, its instruction.
  [48, 0xffff, 16, 0xffff, 8, len, placeIndex].forEach((x, i) => v.setUint16(2 + 2 * i, x, true));
  data.set(key, 16);
  data.set(signature, 48);
  return { programAddress: ED25519_PROGRAM, accounts: [], data };
}
