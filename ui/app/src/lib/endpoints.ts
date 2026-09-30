import { socialUrl } from "@skech/core/social";

/**
 * The servers the app talks to, from the build's settings (next.config.ts): the engine's price feed and the
 * Solana relayer, which builds and pays for every transaction and reads the chain for the app, so the page
 * needs no RPC of its own. The code that connects reads them here, and so does the page's
 * Content-Security-Policy (src/proxy.ts), so the policy never leaves out a server the app uses.
 */
export const ENGINE_URL = process.env.NEXT_PUBLIC_ENGINE_URL || "ws://localhost:3102/ws";
export const RELAYER_URL = process.env.NEXT_PUBLIC_RELAYER_URL || "wss://api.skech.trade/solana/ws";

/**
 * The community (profiles, follows, the leaderboard, the live feed): NEXT_PUBLIC_SOCIAL_URL, or beside the relayer,
 * at /social on its host, or on port 3105 of a relayer on this machine.
 */
export const SOCIAL_URL = socialUrl(RELAYER_URL, process.env.NEXT_PUBLIC_SOCIAL_URL);

/**
 * Reopening a dropped socket: half the wait and a random share of the other half, so a relayer that restarts
 * does not get every player back in the same instant; and the wait starts short again only once a connection
 * has stayed up, so one that opens and drops at once backs off instead of hammering.
 */
export const jitter = (ms: number) => ms / 2 + (Math.random() * ms) / 2;
export const STEADY_MS = 10_000;
