/**
 * What the gas keeper would be quoted to buy SOL with mainnet USDC: one ExactOut quote from Jupiter, read only.
 * Nothing is signed or sent, and no RPC is asked.
 *
 *   bun packages/relayer/scripts/keeper-quote.ts [SOL, default 0.2]
 *
 * KEEPER_JUPITER_URL, KEEPER_JUPITER_API_KEY and KEEPER_SLIPPAGE_BPS as the relayer reads them.
 */
import { SOLANA_NETWORKS } from "@skech/contracts/solana/sdk";
import { quoteExactOut } from "../src/solana/keeper";

const sol = process.argv[2] ?? "0.2";
if (!/^\d+(\.\d{1,9})?$/.test(sol)) throw new Error(`not an amount of SOL: ${sol}`);
const lamports = BigInt(Math.round(Number(sol) * 1e9));
const url = (process.env.KEEPER_JUPITER_URL?.trim() || "https://api.jup.ag/swap/v1").replace(/\/+$/, "");
const slippageBps = Number(process.env.KEEPER_SLIPPAGE_BPS?.trim() || 50);

const t0 = performance.now();
const q = await quoteExactOut({ url, key: process.env.KEEPER_JUPITER_API_KEY?.trim() || null, fetch: (u, init) => fetch(u, init) }, SOLANA_NETWORKS["mainnet-beta"].usdc, lamports, slippageBps);
const ms = Math.round(performance.now() - t0);

console.log(`${url}/quote, ${ms} ms${process.env.KEEPER_JUPITER_API_KEY ? ", with a key" : ", no key"}`);
console.log(`  buy      ${Number(q.outAmount) / 1e9} SOL (${q.swapMode})`);
console.log(`  for      ${(Number(q.inAmount) / 1e6).toFixed(6)} USDC`);
console.log(`  at most  ${(Number(q.otherAmountThreshold) / 1e6).toFixed(6)} USDC (${q.slippageBps} bps)`);
console.log(`  price    ${(Number(q.inAmount) / 1e6 / (Number(q.outAmount) / 1e9)).toFixed(4)} USDC a SOL, impact ${q.priceImpactPct ?? "?"}`);
console.log(`  route    ${(q.routePlan ?? []).map((r) => r.swapInfo?.label ?? "?").join(" + ")}`);
