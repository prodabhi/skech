/**
 * The social service on its own, reading the game from the chain and placing nothing: for working on the community
 * pages against a live game without running a relayer (which would need, and contend with, the live relayer's key).
 *
 *   SOCIAL_DATABASE_URL=postgres://… bun run --filter @skech/relayer social
 *
 * The game is `packages/contracts/deployments/solana-<SKECH_SOLANA_CLUSTER>.json` (devnet unless it says otherwise);
 * the RPC is SOLANA_<CLUSTER>_RPC_URL, or the cluster's public one. Drawings come from the chain's events, which keep
 * only a stroke's hash: they count, but have no shape to draw.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deploymentFile, type SolanaDeployment, solanaNetwork, solanaRpc } from "@skech/contracts/solana/sdk";
import { root } from "../env";
import { indexerLimits, SocialBridge } from "./bridge";

const log = (s: string) => console.error(`${new Date().toISOString().slice(11, 23)} ${s}`);

const net = solanaNetwork(process.env);
const d = JSON.parse(readFileSync(join(root, deploymentFile(net.cluster)), "utf8")) as SolanaDeployment;
const rpcUrl = solanaRpc(process.env, net);
const wsUrl = process.env[`SOLANA_${net.cluster.toUpperCase().replace("-", "_")}_WS_URL`]?.trim() || (rpcUrl === net.rpc ? net.ws : rpcUrl.replace(/^http/, "ws"));
if (!process.env.SOCIAL_DATABASE_URL) throw new Error("SOCIAL_DATABASE_URL is not set: there is nothing to keep the community in");

const limits = indexerLimits();
log(`${net.label}: game ${d.game}, pool ${d.pool}, ${rpcUrl === net.rpc ? "the public RPC" : "a private RPC"} at ${limits.rps}/s, history back ${limits.backfillDays} days`);
// SOCIAL_TEST_PLAYS=1: plays made up in memory over POST /test/placed, for testing the live feed with no wallet.
const testPlays = process.env.SOCIAL_TEST_PLAYS === "1";
if (testPlays) log("SOCIAL_TEST_PLAYS: POST /test/placed is on (from this machine only); nothing it makes reaches the database");
const bridge = new SocialBridge({ cluster: net.cluster, program: d.program, game: d.game, pool: d.pool, rpcUrl, wsUrl, ...limits, testPlays }, log);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    bridge.stop();
    process.exit(0);
  });
}
// The worker holds the process open; this keeps it open should the worker stop, so the log says why.
setInterval(() => undefined, 1 << 30);
