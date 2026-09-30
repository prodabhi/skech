/**
 * The Solana game end to end on a local validator: the relayer against the live engine, and a scripted player who
 * never holds SOL. It signs a session (with a standing approval), deposits, draws a piece at the price, sees it
 * placed and settled, counts its transactions and withdraws.
 *
 *   solana-test-validator --reset --gossip-port 8110 --dynamic-port-range 8111-8140   (elsewhere)
 *   SKECH_SOLANA_CLUSTER=localnet bun run deploy:solana
 *   bun packages/relayer/scripts/e2e-solana.ts
 */
import { ed25519 } from "@noble/curves/ed25519";
import {
  type Address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  getAddressDecoder,
  getBase16Decoder,
  getBase64Decoder,
  getBase64Encoder,
  getTransactionDecoder,
  getTransactionEncoder,
  generateKeyPairSigner,
  partiallySignTransaction,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  getBase64EncodedWireTransaction,
} from "@solana/kit";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getMintToInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pieceBytes, type SolanaDeployment } from "@skech/contracts/solana/sdk";

const root = join(import.meta.dir, "..", "..", "..");
const deployment = JSON.parse(readFileSync(join(root, "packages/contracts/deployments/solana-localnet.json"), "utf8")) as SolanaDeployment;
const rpc = createSolanaRpc(process.env.SOLANA_LOCALNET_RPC_URL ?? "http://127.0.0.1:8899");
const engineUrl = process.env.E2E_ENGINE_URL ?? "wss://api.skech.trade/engine/ws";
const port = 3199;
const ok = (cond: unknown, what: string) => {
  if (!cond) {
    console.error(`FAIL: ${what}`);
    process.exit(1);
  }
  console.log(`ok: ${what}`);
};
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

/* ---- a player with local USDC and no SOL ---- */

const deployer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), ".config/solana/id.json"), "utf8")) as number[]));
const wallet = await generateKeyPairSigner();
const [ata] = await findAssociatedTokenPda({ mint: deployment.usdcMint, owner: wallet.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
{
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(deployer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([getCreateAssociatedTokenIdempotentInstruction({ payer: deployer, ata, owner: wallet.address, mint: deployment.usdcMint }), getMintToInstruction({ mint: deployment.usdcMint, token: ata, mintAuthority: deployer, amount: 50_000_000n })], m),
  );
  const tx = await signTransactionMessageWithSigners(msg);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: "base64" }).send();
  await Bun.sleep(1500);
}
ok((await rpc.getBalance(wallet.address).send()).value === 0n, `player ${wallet.address} holds no SOL, and $50 of local USDC`);

/* ---- the relayer ---- */

const relayer = spawn("bun", ["packages/relayer/src/index.ts"], {
  cwd: root,
  env: { ...process.env, SKECH_SOLANA_CLUSTER: "localnet", RELAYER_SOLANA_PORT: String(port), NEXT_PUBLIC_ENGINE_URL: engineUrl, SOLANA_PRIORITY_MICROLAMPORTS: "1000" },
  stdio: ["ignore", "inherit", "inherit"],
});
process.on("exit", () => relayer.kill());
for (let i = 0; i < 60; i++) {
  const r = await fetch(`http://localhost:${port}/health`).catch(() => null);
  if (r?.ok) break;
  await Bun.sleep(500);
}

/* ---- the engine: the price the player sees, signed ---- */

let seen: { p: number; message: { price: string; time: number }; signature: `0x${string}` } | null = null;
const engine = new WebSocket(engineUrl);
engine.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.type === "price" && m.message && m.signature) seen = m;
};

/* ---- the player's app ---- */

const ws = new WebSocket(`ws://localhost:${port}/ws`);
const inbox: Record<string, unknown>[] = [];
ws.onmessage = (e) => inbox.push(JSON.parse(String(e.data)));
await new Promise((r) => (ws.onopen = r));
const next = async (pred: (m: Record<string, unknown>) => boolean, what: string, ms = 20_000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const i = inbox.findIndex(pred);
    if (i >= 0) return inbox.splice(i, 1)[0];
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const hello = await next((m) => m.type === "hello", "hello");
ok(hello.chain === "solana" && hello.cluster === "localnet", `hello from the Solana relayer, difficulty ${hello.difficulty}`);
ws.send(json({ type: "watch", player: wallet.address }));
await next((m) => m.type === "account", "account");

/** What the app does with a built transaction: the wallet signs it, and it goes back. */
async function walletSigns(kind: string, extra: Record<string, unknown>) {
  ws.send(json({ type: "build", kind, player: wallet.address, ...extra }));
  const built = await next((m) => m.type === "built" && m.kind === kind, `built ${kind}`);
  ok(built.tx, `relayer built a ${kind} for the wallet to sign`);
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(built.tx as string));
  const signed = await partiallySignTransaction([wallet.keyPair], tx);
  ws.send(json({ type: "submit", id: built.id, tx: getBase64Decoder().decode(getTransactionEncoder().encode(signed)), ...(extra.approve ? { approve: true } : {}) }));
  const r = await next((m) => m.type === "submitted" && m.id === built.id, `submitted ${kind}`, 60_000);
  ok(r.ok, `${kind} landed: ${r.tx ?? r.why}`);
}

const sessionKey = ed25519.utils.randomSecretKey();
const sessionAddress = getAddressDecoder().decode(ed25519.getPublicKey(sessionKey)) as Address;
await walletSigns("session", { key: sessionAddress, validUntil: String(Math.floor(Date.now() / 1000) + 86_400), allowance: "20000000", approve: "5000000" });
await walletSigns("deposit", { amount: "10000000" });
const acct = await next((m) => m.type === "account" && BigInt(m.balance as string) >= 10_000_000n, "the balance");
// $15 when the approval's sweep landed first.
ok([10_000_000n, 15_000_000n].includes(BigInt(acct.balance as string)), "$10 deposited; the wallet never paid a fee");

// The standing approval sweeps in whatever else lands in the wallet ($5 approved), on the relayer's next sweep.
const swept = await next((m) => m.type === "account" && BigInt(m.balance as string) >= 15_000_000n, "the sweep", 40_000).catch(() => null);
ok(swept, "USDC in the wallet swept in on its approval: $15 now");

/* ---- a piece, drawn at the price ---- */

for (let i = 0; i < 100 && !seen; i++) await Bun.sleep(100);
ok(seen, "a signed price from the engine");
ws.send(json({ type: "hello" }));
const fresh = await next((m) => m.type === "hello" && Array.isArray(m.units), "a hello with the grid");
const units = fresh.units as string[];
ok(units?.length, `grid units ${units?.join(", ")}`);
const unit = BigInt(units[Math.floor(units.length / 2)]);
const priceE8 = BigInt(seen!.message.price);
const lo = Number(priceE8 / unit) - 2;
const stroke = new Uint8Array([1, ...new Array(32).fill(0)]);
const strokeHash = new Uint8Array(await crypto.subtle.digest("SHA-256", stroke));
const openAt = Math.ceil((Date.now() + 250) / 1000) * 1000;
const piece = {
  domain: Uint8Array.from(Buffer.from(hello.domain as string, "hex")),
  player: wallet.address,
  drawing: BigInt(Date.now()),
  index: 0,
  market: 0,
  difficulty: hello.difficulty as number,
  openAt: BigInt(openAt),
  perDot: 100_000,
  unit,
  priceSeen: priceE8,
  priceTime: BigInt(seen!.message.time),
  strokeHash,
  sections: [1, 2, 3].map((second) => ({ second, lo, width: 4, stake: 50_000 })),
};
const sig = ed25519.sign(pieceBytes(piece), sessionKey);
const hex = (b: Uint8Array) => `0x${getBase16Decoder().decode(b)}`;
ws.send(
  json({
    type: "piece",
    piece: { ...piece, domain: undefined, player: wallet.address, drawing: String(piece.drawing), openAt: String(openAt), unit: String(unit), priceSeen: String(priceE8), priceTime: String(piece.priceTime), strokeHash: hex(strokeHash) },
    sessionSig: hex(sig),
    priceSig: seen!.signature,
    stroke: hex(stroke),
  }),
);
const ack = await next((m) => m.type === "ack", "ack");
ok(ack.ok, `piece accepted: ${ack.betId ?? ack.why}`);
const placed = await next((m) => m.type === "placed" || m.type === "refused", "placed");
ok(placed.type === "placed", `piece placed on chain, ${(placed.sections as unknown[] | undefined)?.length} bands, staked ${placed.staked}: ${placed.tx ?? placed.why}`);
const settled: Record<string, unknown>[] = [];
// A bet decided inside its placing window is closed by a settle once the window is over: one message more.
for (let i = 0; i < 4; i++) {
  const s = await next((m) => m.type === "settled", "settled", 30_000);
  settled.push(s);
  if (s.closed) break;
}
ok(settled.at(-1)?.closed, `settled over ${settled.length} seconds: hit ${settled.map((s) => (s.hitMask as number).toString(2)).join(",")}, paid ${settled.reduce((n, s) => n + BigInt(s.paid as string), 0n)}; bet closed, rent back`);

/* ---- how many transactions, and money out ---- */

ws.send(json({ type: "activity" }));
const activity = await next((m) => m.type === "activity", "activity");
ok((activity.txs as number) >= 4, `${activity.txs} transactions on the player's account`);
const before = (await rpc.getTokenAccountBalance(ata).send()).value.amount;
await walletSigns("withdraw", { amount: "1000000" });
const after = (await rpc.getTokenAccountBalance(ata).send()).value.amount;
ok(BigInt(after) - BigInt(before) === 1_000_000n, "$1 withdrawn to the wallet");
const status = await (await fetch(`http://localhost:${port}/status`)).json();
console.log(`relayer: ${JSON.stringify(status.chain.sends)}; pieces ${JSON.stringify(status.pieces)}`);
engine.close();
ws.close();
relayer.kill();
process.exit(0);
