/**
 * `bun run deploy:solana`: the game on Solana, from .env.local.
 *
 *   bun run deploy:solana                  deploy to SKECH_SOLANA_CLUSTER (devnet when unset)
 *   bun run deploy:solana --mainnet        required as well on mainnet-beta: it spends real SOL
 *   bun run deploy:solana --skip-program   the program is already deployed: set the game up only
 *   bun run deploy:solana --set-config     also set the game's terms to the defaults (4% of stakes, 10% of profit), and SOLANA_CONFIG
 *   bun run deploy:solana --set-rewards    also set SKT's terms to the defaults (3 of the 4 points, 8 of the 10, 75% of the pool's surplus), and SOLANA_REWARDS_CONFIG
 *
 * A game without SKT (set up before it) is given it: `init_rewards` starts SKT and moves the game's fees to the
 * defaults in the same instruction, keeping its other terms (SOLANA_CONFIG and SOLANA_REWARDS_CONFIG apply). Until it
 * is sent, an upgraded program places and settles nothing.
 *
 * It deploys the program (`anchor build` first), initializes the game with the deployer as admin (the program's
 * upgrade authority must be the deployer), opens BTC-USD, creates the lookup table every placement uses, and
 * writes packages/contracts/deployments/solana-<cluster>.json, where the relayer and the app find it all.
 *
 *   SOLANA_DEPLOYER_KEYPAIR   the deployer's keypair file (default ~/.config/solana/id.json): upgrade authority and admin
 *   SOLANA_RELAYER_KEYPAIR    the relayer's keypair file: its key is the oracle (or set SOLANA_ORACLE to an address)
 *   SOLANA_TREASURY           who owns the treasury's USDC account (default the deployer; a multisig on mainnet)
 *   DIFFICULTY                the market's difficulty, 50 to 100 (default 51)
 *   SOLANA_CONFIG             with --set-config: JSON of terms to change from the defaults, e.g. {"feeBps":300}
 *   SOLANA_REWARDS_CONFIG     JSON of SKT's terms to change from the defaults, e.g. {"mintScale":"100000000000"}
 *
 * On mainnet: transfer the upgrade authority and the admin to a multisig (Squads) straight after, and build with
 * `anchor build --verifiable` so the deployed program can be verified against this source.
 */
import {
  address,
  appendTransactionMessageInstructions,
  type Address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  type Instruction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { getCreateLookupTableInstructionAsync, getExtendLookupTableInstruction } from "@solana-program/address-lookup-table";
import { getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { getCreateAccountInstruction } from "@solana-program/system";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getInitializeMint2Instruction, getMintToInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  barsAddress,
  type Config,
  DEFAULT_CONFIG,
  DEFAULT_REWARDS_CONFIG,
  deploymentFile,
  fetchMaybeGame,
  fetchMaybeRewards,
  gameAddress,
  getInitializeInstruction,
  getInitMarketInstruction,
  getInitRewardsInstruction,
  getSetConfigInstruction,
  getSetRewardsConfigInstruction,
  INSTRUCTIONS_SYSVAR,
  marketAddress,
  poolAddress,
  rewardsAddress,
  type RewardsConfig,
  SKECH_PROGRAM_ADDRESS,
  type SolanaDeployment,
  solanaNetwork,
  solanaRpc,
} from "../packages/contracts/solana/sdk";

const root = join(import.meta.dir, "..");
const solanaDir = join(root, "packages/contracts/solana");
const fail = (m: string): never => {
  console.error(m);
  process.exit(1);
};
const env = (n: string) => process.env[n]?.trim() || undefined;
const expand = (p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);
const keypair = async (path: string) => createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(expand(path), "utf8")) as number[]));

const net = (() => {
  try {
    return solanaNetwork(process.env);
  } catch (e) {
    return fail((e as Error).message);
  }
})();
if (net.cluster === "mainnet-beta" && !process.argv.includes("--mainnet")) fail("SKECH_SOLANA_CLUSTER is mainnet-beta: this spends real SOL (about 5 for the program's rent). Run again with --mainnet.");
const rpcUrl = solanaRpc(process.env, net);
const rpc = createSolanaRpc(rpcUrl);
const wsUrl = env(`SOLANA_${net.cluster.toUpperCase().replace("-", "_")}_WS_URL`) ?? (rpcUrl === net.rpc ? net.ws : rpcUrl.replace(/^http/, "ws"));
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: createSolanaRpcSubscriptions(wsUrl) });

const deployerPath = env("SOLANA_DEPLOYER_KEYPAIR") ?? "~/.config/solana/id.json";
if (!existsSync(expand(deployerPath))) fail(`no deployer keypair at ${deployerPath}: solana-keygen new, or set SOLANA_DEPLOYER_KEYPAIR`);
const deployer = await keypair(deployerPath);
const oracle: Address = env("SOLANA_ORACLE") ? address(env("SOLANA_ORACLE")!) : env("SOLANA_RELAYER_KEYPAIR") ? (await keypair(env("SOLANA_RELAYER_KEYPAIR")!)).address : net.cluster === "localnet" ? deployer.address : fail("set SOLANA_RELAYER_KEYPAIR (or SOLANA_ORACLE): the relayer's key signs every placement and bar");
const treasuryOwner = env("SOLANA_TREASURY") ? address(env("SOLANA_TREASURY")!) : deployer.address;
const difficulty = Number(env("DIFFICULTY") ?? 51);

const { value: lamports } = await rpc.getBalance(deployer.address).send();
console.log(`${net.label} via ${rpcUrl.replace(/(api[-_]?key=)[^&]+/i, "$1…")}: deployer ${deployer.address} holds ${Number(lamports) / 1e9} SOL; oracle ${oracle}; program ${SKECH_PROGRAM_ADDRESS}`);

async function send(label: string, instructions: Instruction[]) {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(deployer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([getSetComputeUnitPriceInstruction({ microLamports: net.cluster === "mainnet-beta" ? 50_000 : 1_000 }), ...instructions], m),
  );
  const tx = await signTransactionMessageWithSigners(msg);
  await sendAndConfirm(tx as Parameters<typeof sendAndConfirm>[0], { commitment: "confirmed" });
  console.log(`  ${label}: ${getSignatureFromTransaction(tx)}`);
}

/* ---- the program ---- */

if (!process.argv.includes("--skip-program")) {
  const so = join(solanaDir, "target/deploy/skech.so");
  const programKeypair = join(solanaDir, "target/deploy/skech-keypair.json");
  if (!existsSync(so)) fail("no target/deploy/skech.so: cd packages/contracts && bun run solana:build");
  if (!existsSync(programKeypair)) fail(`no ${programKeypair}: the program id in lib.rs is that keypair's; without it the program cannot be deployed at its address`);
  if ((await keypair(programKeypair)).address !== SKECH_PROGRAM_ADDRESS) fail("target/deploy/skech-keypair.json is not the program id in lib.rs: anchor keys sync, then build again");
  console.log(`deploying ${so}`);
  const run = spawnSync(
    "solana",
    ["program", "deploy", so, "--program-id", programKeypair, "--keypair", expand(deployerPath), "--url", rpcUrl, "--with-compute-unit-price", net.cluster === "mainnet-beta" ? "50000" : "1000", "--max-sign-attempts", "60", "--use-rpc"],
    { stdio: "inherit" },
  );
  if (run.status !== 0) fail("solana program deploy failed");
}

/* ---- USDC: Circle's, or a local stand-in ---- */

const [game, pool, market, bars] = await Promise.all([gameAddress(), poolAddress(), marketAddress(0), barsAddress(0)]);
const existing = await fetchMaybeGame(rpc, game);
let usdc = net.usdc;
if (existing.exists) {
  // A game already set up keeps the USDC it was set up with: on a local validator, the stand-in made last time.
  usdc = existing.data.usdcMint;
} else if (net.cluster === "localnet") {
  const mint = await generateKeyPairSigner();
  const space = 82n;
  const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
  await send("local USDC", [
    getCreateAccountInstruction({ payer: deployer, newAccount: mint, lamports: rent, space, programAddress: TOKEN_PROGRAM_ADDRESS }),
    getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: deployer.address }),
  ]);
  usdc = mint.address;
  const [ata] = await findAssociatedTokenPda({ mint: usdc, owner: deployer.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  await send("1,000,000 local USDC to the deployer", [
    getCreateAssociatedTokenIdempotentInstruction({ payer: deployer, ata, owner: deployer.address, mint: usdc }),
    getMintToInstruction({ mint: usdc, token: ata, mintAuthority: deployer, amount: 1_000_000_000_000n }),
  ]);
}

/* ---- the game ---- */

const [vault] = await findAssociatedTokenPda({ mint: usdc, owner: game, tokenProgram: TOKEN_PROGRAM_ADDRESS });
const [treasury] = await findAssociatedTokenPda({ mint: usdc, owner: treasuryOwner, tokenProgram: TOKEN_PROGRAM_ADDRESS });
if (existing.exists) {
  console.log(`the game is already set up at ${game} (admin ${existing.data.admin}): leaving it as it is`);
} else {
  const [programData] = await getProgramDerivedAddress({ programAddress: address("BPFLoaderUpgradeab1e11111111111111111111111"), seeds: [getAddressEncoder().encode(SKECH_PROGRAM_ADDRESS)] });
  await send("treasury account", [getCreateAssociatedTokenIdempotentInstruction({ payer: deployer, ata: treasury, owner: treasuryOwner, mint: usdc })]);
  await send("initialize", [
    getInitializeInstruction({
      authority: deployer,
      game,
      pool,
      usdcMint: usdc,
      vault,
      treasury,
      program: SKECH_PROGRAM_ADDRESS,
      programData,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      cluster: net.cluster,
      oracle,
      // 0.1% a day, x1e18 per second.
      iouRate: 11_574_074_074n,
    }),
  ]);
  await send(`BTC-USD at difficulty ${difficulty}`, [getInitMarketInstruction({ admin: deployer, game, market, bars, id: 0, name: "BTC-USD", difficulty })]);
}

/* ---- the terms: a game keeps what it was initialized with until the admin sets others ---- */

/** `base` with the JSON in `name` over it, each value the type the default has. */
function terms<T extends object>(name: string, base: T): T {
  const overrides = JSON.parse(env(name) ?? "{}") as Record<string, number | string>;
  const unknown = Object.keys(overrides).filter((k) => !(k in base));
  if (unknown.length) fail(`${name} names terms there are none of: ${unknown.join(", ")}`);
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(overrides)) out[k] = typeof (base as Record<string, unknown>)[k] === "bigint" ? BigInt(v) : Number(v);
  return out as T;
}
const same = (a: object, b: object) => Object.keys(b).every((k) => String((a as Record<string, unknown>)[k]) === String((b as Record<string, unknown>)[k]));
const rewards = await rewardsAddress();
const skt = await fetchMaybeRewards(rpc, rewards);
const onGame = await fetchMaybeGame(rpc, game);
const current = onGame.exists ? onGame.data.config : undefined;
if (!skt.exists) {
  // SKT starts with the game's fees at the defaults, its other terms as they are: one instruction, never between.
  const config = terms("SOLANA_CONFIG", { ...(current ?? DEFAULT_CONFIG), feeBps: DEFAULT_CONFIG.feeBps, profitFeeBps: DEFAULT_CONFIG.profitFeeBps });
  const rewardsConfig = terms("SOLANA_REWARDS_CONFIG", DEFAULT_REWARDS_CONFIG);
  await send(`SKT (${config.feeBps / 100}% of stakes, ${config.profitFeeBps / 100}% of profit; ${rewardsConfig.holderFeeBps} and ${rewardsConfig.holderProfitFeeBps} bps of them, and ${rewardsConfig.surplusHolderBps / 100}% of the pool's surplus, to holders)`, [
    getInitRewardsInstruction({ admin: deployer, game, rewards, config, rewardsConfig }),
  ]);
} else {
  if (process.argv.includes("--set-config")) {
    const config = terms("SOLANA_CONFIG", DEFAULT_CONFIG);
    if (current && same(current, config)) console.log("the game's terms are already these: leaving them");
    else await send("terms", [getSetConfigInstruction({ admin: deployer, game, rewards, config: config as Config })]);
  }
  if (process.argv.includes("--set-rewards")) {
    const rewardsConfig = terms("SOLANA_REWARDS_CONFIG", DEFAULT_REWARDS_CONFIG);
    if (same(skt.data.config, rewardsConfig)) console.log("SKT's terms are already these: leaving them");
    else await send("SKT's terms", [getSetRewardsConfigInstruction({ admin: deployer, game, rewards, rewardsConfig: rewardsConfig as RewardsConfig })]);
  }
}

/* ---- the lookup table every placement uses ---- */

const slot = await rpc.getSlot({ commitment: "finalized" }).send();
const [createTable, table] = await (async () => {
  const ix = await getCreateLookupTableInstructionAsync({ authority: deployer, payer: deployer, recentSlot: slot });
  return [ix, ix.accounts[0].address] as const;
})();
await send("lookup table", [
  createTable,
  getExtendLookupTableInstruction({
    address: table,
    authority: deployer,
    payer: deployer,
    addresses: [game, market, bars, pool, rewards, INSTRUCTIONS_SYSVAR, address("11111111111111111111111111111111"), vault, usdc, TOKEN_PROGRAM_ADDRESS],
  }),
]);

// What the game holds, where it is already set up: its admin may have changed the oracle or the treasury since.
const onChain = existing.exists ? existing.data : null;
const deployment: SolanaDeployment = {
  cluster: net.cluster,
  program: SKECH_PROGRAM_ADDRESS,
  game,
  pool,
  market,
  bars,
  rewards,
  vault: onChain?.vault ?? vault,
  usdcMint: usdc,
  tokenProgram: onChain?.tokenProgram ?? TOKEN_PROGRAM_ADDRESS,
  treasury: onChain?.treasury ?? treasury,
  oracle: onChain?.oracle ?? oracle,
  admin: onChain?.admin ?? deployer.address,
  lookupTable: table,
  slot: Number(slot),
};
const file = join(root, deploymentFile(net.cluster));
writeFileSync(file, JSON.stringify(deployment, null, 2) + "\n");
console.log(`wrote ${deploymentFile(net.cluster)}`);
