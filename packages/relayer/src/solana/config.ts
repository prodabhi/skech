/**
 * What the Solana relayer needs to know: the cluster (SKECH_SOLANA_CLUSTER), its keypair, and the game's addresses
 * from `packages/contracts/deployments/solana-<cluster>.json`, written by `bun run deploy:solana`.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { address } from "@solana/kit";
import { deploymentFile, type SolanaDeployment, solanaNetwork, solanaRpc } from "@skech/contracts/solana/sdk";
import { MIN_PIECE_STAKE_E6 } from "@skech/core/chain";
import { root } from "../env";

const env = (name: string) => {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
};
const expand = (p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

const net = solanaNetwork(process.env);
const deploymentPath = join(root, deploymentFile(net.cluster));
if (!existsSync(deploymentPath)) throw new Error(`${deploymentPath} does not exist: bun run deploy:solana first (SKECH_SOLANA_CLUSTER=${net.cluster})`);
const deployment = JSON.parse(readFileSync(deploymentPath, "utf8")) as SolanaDeployment;

/** The relayer's keypair: a file (SOLANA_RELAYER_KEYPAIR), or its 64 bytes as JSON (SOLANA_RELAYER_SECRET_KEY, for a server's env file). */
function keyBytes(): Uint8Array {
  const inline = env("SOLANA_RELAYER_SECRET_KEY");
  if (inline) return Uint8Array.from(JSON.parse(inline) as number[]);
  const path = expand(env("SOLANA_RELAYER_KEYPAIR") ?? (net.cluster === "localnet" ? "~/.config/solana/id.json" : ""));
  if (!path || !existsSync(path)) throw new Error("SOLANA_RELAYER_KEYPAIR (a keypair file) or SOLANA_RELAYER_SECRET_KEY must be set: the relayer pays every fee and signs as the oracle");
  return Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]);
}

const rpcUrl = solanaRpc(process.env, net);
const engineSigner = env("RELAYER_ENGINE_SIGNER");
if (engineSigner && !/^0x[0-9a-fA-F]{40}$/.test(engineSigner)) throw new Error(`RELAYER_ENGINE_SIGNER is not an address: ${engineSigner}`);
/** An amount in SOL or USDC ("0.3"), in its smallest unit: exact, never through a float. */
function amount(name: string, fallback: string, decimals: number): bigint {
  const v = env(name) ?? fallback;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(v);
  if (!m || (m[2] ?? "").length > decimals) throw new Error(`${name} is not an amount with at most ${decimals} decimals: ${v}`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").padEnd(decimals, "0"));
}
function whole(name: string, fallback: number, least: number, most = Number.MAX_SAFE_INTEGER): number {
  const v = Number(env(name) ?? fallback);
  if (!Number.isInteger(v) || v < least || v > most) throw new Error(`${name} is ${env(name)}: a whole number from ${least} to ${most}`);
  return v;
}
function flag(name: string): boolean {
  const v = env(name) ?? "0";
  if (v !== "0" && v !== "1") throw new Error(`${name} is ${v}: 1 or 0`);
  return v === "1";
}

/**
 * The gas keeper (keeper.ts): the relayer's SOL topped up from the USDC fees that land in its wallet, and USDC over a
 * cap sent to a cold wallet. Off unless KEEPER_ENABLED=1; off mainnet, or with KEEPER_DRY_RUN=1, it only says what it
 * would do.
 */
function keeper() {
  const cold = env("KEEPER_COLD_WALLET");
  const k = {
    enabled: flag("KEEPER_ENABLED"),
    dryRun: flag("KEEPER_DRY_RUN"),
    everyMs: whole("KEEPER_EVERY_MS", 300_000, 10_000),
    solFloor: amount("KEEPER_SOL_FLOOR", "0.1", 9),
    solTarget: amount("KEEPER_SOL_TARGET", "0.3", 9),
    /** Jupiter's Metis swap API, the one that quotes ExactOut (keeper.ts). */
    jupiterUrl: (env("KEEPER_JUPITER_URL") ?? "https://api.jup.ag/swap/v1").replace(/\/+$/, ""),
    jupiterKey: env("KEEPER_JUPITER_API_KEY") ?? null,
    slippageBps: whole("KEEPER_SLIPPAGE_BPS", 50, 1, 500),
    minIntervalMs: whole("KEEPER_MIN_INTERVAL_MS", 3_600_000, 60_000),
    dailyCapE6: amount("KEEPER_DAILY_CAP_USDC", "30", 6),
    reserveE6: amount("KEEPER_USDC_RESERVE", "0", 6),
    coldWallet: cold ? address(cold) : null,
    capE6: amount("KEEPER_USDC_CAP", "100", 6),
    keepE6: amount("KEEPER_USDC_KEEP", "20", 6),
    /** The most one transfer to the cold wallet moves: a balance read wrong never sends it all. */
    coldMaxE6: amount("KEEPER_COLD_MAX_USDC", "1000", 6),
  };
  if (k.solTarget <= k.solFloor) throw new Error("KEEPER_SOL_TARGET must be above KEEPER_SOL_FLOOR");
  if (k.keepE6 >= k.capE6) throw new Error("KEEPER_USDC_KEEP must be below KEEPER_USDC_CAP");
  if (k.dailyCapE6 === 0n || k.coldMaxE6 === 0n) throw new Error("KEEPER_DAILY_CAP_USDC and KEEPER_COLD_MAX_USDC must be above 0");
  if (!/^https?:\/\/[^/]+/.test(k.jupiterUrl)) throw new Error(`KEEPER_JUPITER_URL is not a URL: ${k.jupiterUrl}`);
  return k;
}

const compute = JSON.parse(readFileSync(join(root, "packages/contracts/solana/snapshots/compute.json"), "utf8")) as Record<string, number>;

export const scfg = {
  port: Number(env("RELAYER_SOLANA_PORT") ?? 3104),
  /** Where to listen: this machine only, behind Caddy. 0.0.0.0 to be reached from elsewhere (a phone on the same network). */
  host: env("RELAYER_HOST") ?? "127.0.0.1",
  engineUrl: env("NEXT_PUBLIC_ENGINE_URL") ?? "ws://localhost:3102/ws",
  /** The engine's signing address, if known: an engine that signs as anyone else is not listened to. */
  engineSigner: engineSigner as `0x${string}` | undefined,
  net,
  rpcUrl,
  wsUrl: env(`SOLANA_${net.cluster.toUpperCase().replace("-", "_")}_WS_URL`) ?? (rpcUrl === net.rpc ? net.ws : rpcUrl.replace(/^http/, "ws")),
  keyBytes: keyBytes(),
  deployment,
  libPath: env("SKECH_LIB") ?? join(root, "packages", "core", "src", "dots-lib.bin"),
  /** Where the state file goes: packages/relayer, or the box's /var/lib/skech-relayer. */
  stateDir: env("RELAYER_STATE_DIR") ?? join(root, "packages", "relayer"),
  market: 0,
  marketName: "BTC-USD",
  /** A piece opens on a second; it is priced this long after that second starts, once late trades are in. */
  openAfterMs: 350,
  /** How late after its opening second a piece may still arrive: the game's `late_ms`, read at start. */
  lateMs: 200,
  /** How far ahead of now a piece's opening second may be. */
  aheadMs: 1500,
  /**
   * Sweep IOUs, deposits and fees this often, in full. A wallet is swept at once when its app says USDC landed in it,
   * or when it approves the game; IOUs and fees can wait a few minutes.
   */
  sweepEveryMs: 300_000,
  collectAboveE6: 1_000_000n,
  /** The pool's surplus is shared with SKT holders once it is at least this, USDC e6: $10, so a share is worth its fee. */
  surplusAboveE6: BigInt(env("SOLANA_SURPLUS_ABOVE_E6") ?? 10_000_000),
  /** The least a deposit or withdrawal the relayer pays for may move, USDC e6 (a withdrawal of the whole balance always goes): the app's least deposit. */
  minMoveE6: 1_000_000n,
  /**
   * The least one piece may stake, USDC e6, as it arrives and as the program would place it: 1¢ (`MIN_PIECE_STAKE_E6`),
   * so a single dot goes in. Pieces under 10¢ are limited for each player instead (`SmallPieces`). Told to the apps in `hello`.
   */
  minPieceStake: BigInt(whole("SOLANA_MIN_PIECE_STAKE", Number(MIN_PIECE_STAKE_E6), 0, 1_000_000_000)),
  /** Compute units each instruction takes, measured in LiteSVM (`bun run solana:snapshot`). */
  compute,
  /** Priority fee, micro-lamports per compute unit: a fixed one, or what recent blocks paid to write the pool, capped. */
  priorityFixed: env("SOLANA_PRIORITY_MICROLAMPORTS") ? Number(env("SOLANA_PRIORITY_MICROLAMPORTS")) : null,
  priorityMax: Number(env("SOLANA_PRIORITY_MAX_MICROLAMPORTS") ?? (net.cluster === "mainnet-beta" ? 2_000_000 : 50_000)),
  /** Requests a second the relayer asks of its RPC, all told (budget.ts): under the plan's limit, which bills per request on mainnet. */
  rpcPerSec: Math.max(1, Number(env("SOLANA_RPC_RPS") ?? 15) || 15),
  /** Bets settled in one transaction: three accounts each (the bet, the player, their SKT), 32 bytes a key, in 1232 bytes. */
  betsPerSettle: 9,
  keeper: keeper(),
};
export type SolanaConfig = typeof scfg;
