import { SOLANA_NETWORKS, type SolanaClusterName } from "@skech/contracts/solana/sdk";

/**
 * Where the game is, for the app: a Solana cluster, devnet unless the build says otherwise
 * (NEXT_PUBLIC_SOLANA_CLUSTER, or SKECH_SOLANA_CLUSTER in the repo's `.env.local`, via next.config.ts). The
 * game's own addresses come from the relayer's hello, so the app never holds one the relayer does not; this is
 * only what the page needs before it has spoken: the network's name, its faucet, where to look a transaction up.
 */

const named = process.env.NEXT_PUBLIC_SOLANA_CLUSTER?.trim() as SolanaClusterName | undefined;
export const CLUSTER: SolanaClusterName = named && named in SOLANA_NETWORKS ? named : "devnet";
export const NETWORK = SOLANA_NETWORKS[CLUSTER];

/** Solana's own explorer, on the cluster the game is on: the relayer's word on that when it has given it. */
const on = (cluster: string) => (cluster === "mainnet-beta" ? "" : `?cluster=${cluster === "localnet" ? "custom" : cluster}`);
export const explorerTx = (signature: string, cluster: string = CLUSTER) => `https://explorer.solana.com/tx/${signature}${on(cluster)}`;
export const explorerAddress = (address: string, cluster: string = CLUSTER) => `https://explorer.solana.com/address/${address}${on(cluster)}`;
