/**
 * What the relayer needs to know, from the monorepo's one `.env.local` (a
 * value already in the environment wins) and the contracts' deployment file.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chainIdFor, rpcFor } from "@skech/core/network";
import type { Address, Hex } from "viem";
import { root } from "./env";

const env = (name: string) => {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
};

// SKECH_NETWORK picks the chain; ENGINE_CHAIN_ID only for a local anvil run.
const chainId = chainIdFor(process.env);
const deploymentPath = join(root, "packages", "contracts", "deployments", `${chainId}.json`);
const deployment = existsSync(deploymentPath) ? (JSON.parse(readFileSync(deploymentPath, "utf8")) as { game: Address; iou: Address; revenue: Address; usdc: Address; oracle: Address; block?: number }) : null;

const key = env("RELAYER_PRIVATE_KEY") ?? env("ENGINE_PRIVATE_KEY");
if (!key) throw new Error("RELAYER_PRIVATE_KEY or ENGINE_PRIVATE_KEY must be set: the relayer signs quotes and bars and pays for gas");
const game = (env("SKECH_GAME") ?? deployment?.game) as Address | undefined;
if (!game) throw new Error(`SKECH_GAME is not set and ${deploymentPath} does not exist: deploy the contracts first`);
const engineSigner = env("RELAYER_ENGINE_SIGNER");
if (engineSigner && !/^0x[0-9a-fA-F]{40}$/.test(engineSigner)) throw new Error(`RELAYER_ENGINE_SIGNER is not an address: ${engineSigner}`);

export const cfg = {
  port: Number(env("RELAYER_PORT") ?? 3103),
  /** Where to listen: this machine only, behind Caddy. 0.0.0.0 to be reached from elsewhere (a phone on the same network). */
  host: env("RELAYER_HOST") ?? "127.0.0.1",
  engineUrl: env("NEXT_PUBLIC_ENGINE_URL") ?? "ws://localhost:3102/ws",
  /** The engine's signing address, if known: an engine that signs as anyone else is not listened to. */
  engineSigner: engineSigner as Address | undefined,
  rpcUrl: rpcFor(process.env, chainId),
  chainId,
  key: key as Hex,
  game,
  iou: (env("SKECH_IOU") ?? deployment?.iou) as Address | undefined,
  usdc: (env("SKECH_USDC") ?? deployment?.usdc) as Address | undefined,
  revenue: (env("SKECH_REVENUE") ?? deployment?.revenue) as Address | undefined,
  /** The block the game was deployed in: each player's transactions are counted from there. Unknown, from now. */
  deployBlock: env("SKECH_DEPLOY_BLOCK") ? BigInt(env("SKECH_DEPLOY_BLOCK")!) : deployment?.block !== undefined ? BigInt(deployment.block) : null,
  libPath: env("SKECH_LIB") ?? join(root, "packages", "core", "src", "dots-lib.bin"),
  /** Where the state and activity files go: packages/relayer, or the box's /var/lib/skech-relayer. */
  stateDir: env("RELAYER_STATE_DIR") ?? join(root, "packages", "relayer"),
  market: 0,
  marketName: "BTC-USD",
  /** A piece opens on a second; it is priced this long after that second starts, once late trades are in. */
  openAfterMs: 350,
  /** How late after its opening second a piece may still arrive: the chain's `lateMs`, read at start. */
  lateMs: 200,
  /** How far ahead of now a piece's opening second may be, at most. */
  aheadMs: 1500,
  /** Sweep IOUs and collect fees this often. */
  sweepEveryMs: 15_000,
  /** Fees are collected once this much has built up, USDC e6. */
  collectAboveE6: 1_000_000n,
  /** The least a deposit or withdrawal the relayer pays gas for may move, USDC e6 (a withdrawal of the whole balance always goes): the apps' least deposit. */
  minMoveE6: 1_000_000n,
};
export type Config = typeof cfg;

