# @skech/contracts

Foundry. skech as EVM contracts: three contracts behind ERC-1967 proxies (UUPS), written for Monad.

> **Kept, not deployed or used.** The game runs on Solana (`../solana`); nothing in the repo deploys these,
> and no server or app talks to them. They stay as the reference the Solana program is held to: the
> conformance cases (`../conformance`) and the ladder vectors play both, and the engine's signature vector is
> recovered here. `../deployments/10143.json` records where they were last deployed, on Monad testnet. The
> Monad relayer and `bun run deploy:contracts` were removed; the notes below are as they were.

| Contract | What it is |
| --- | --- |
| `SkechGame` | The game. Deposits, sessions, pieces of ink, the price by the second, settlement, the ladder, fees, IOUs. |
| `SkechIOU` | What the game owes when the pool cannot pay a hit at once: an ERC-20 whose value rises every block. |
| `SkechRevenue` | Where the house's fees go: a share of every stake (4% at deployment, 2% on testnet now), 10% of every profit. A treasurer takes them out. |
| `SkechLadder` | ladder-v1 in integers: from a band's chance, the difficulty and the momentum, the rung it pays. |

How it all fits together is in [docs/HOW-IT-WORKS.md](../../docs/HOW-IT-WORKS.md), section 11.
The ABI the app and the relayer use is in `abi/`, written by `bun run abi` (and by `bun run build`).

- **EIP-712** under `{name "skech", version "1", chainId, verifyingContract: the game}`, the domain the
  engine already signs prices under. Pieces are signed by a player's session key (an Ethereum key, or
  a P-256 key the browser keeps, checked through Monad's P-256 precompile); quotes and bars by the oracle.
- **Monad:** `network = "monad"` in `foundry.toml` (Foundry 1.8+) tests under Monad's gas model and
  its 128 KB code limit, which the game needs: it is 37 KB. On Ethereum it would not deploy. Tests run
  isolated, every call its own transaction starting cold, so gas is measured as the chain charges it.
- Dependencies (OpenZeppelin, forge-std) are installed by bun into the root `node_modules`, not as git
  submodules. Run `bun install` first.

```bash
bun install
forge test          # 49 tests: units, fuzz, an accounting invariant, the engine's signature vector, the gas model
bun run test:check  # the same, failing if any gas number in snapshots/ moved
```

`test/GasModel.t.sol` measures what each of the relayer's transactions costs in the worst state it can
meet (fresh slots, a hit into an empty balance, a hit the pool cannot pay, a first session), derives
the linear model the relayer sets gas limits from, checks it against mixed batches it was not fitted
on, and writes `snapshots/GasModel.json`, which `packages/relayer/src/gas.ts` reads. Monad charges the
gas limit, so those numbers are money: a change that moves them fails `test:check` until the snapshot
is re-recorded with `forge test`.

`test/Vectors.t.sol` prints the hashes `packages/core/src/chain.test.ts` pins, so the TypeScript that
signs and the Solidity that checks cannot drift.

## Deploy

```bash
# by hand; there is no longer a wrapper for it
ORACLE_ADDRESS=<engine signer> forge script script/Deploy.s.sol:Deploy --rpc-url monad_testnet --broadcast --private-key <deployer>
```

The deployer becomes the admin of everything: config, difficulty, upgrades, pausing, the treasury.
`ORACLE_ADDRESS` is the engine's wallet (its `hello.signer`); on testnet the deployer, the oracle and
the relayer are the same key. `SKECH_NETWORK` picks testnet or mainnet, and with it the chain and
Circle's USDC; a mainnet deploy also wants `--mainnet`. Addresses land in `deployments/<chainId>.json`,
where the engine, the relayer and the app all find the game for that network. Nothing is written to
`.env.local`, and a dry run writes nothing at all.
Verify with

```bash
forge verify-contract <address> SkechGame --chain 10143 --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org/
```

Upgrade one proxy: `PROXY=<address> WHICH=game|iou|revenue forge script script/Deploy.s.sol:Upgrade ...`.
The game and the IOU are live behind their proxies, so their storage stays where it is: never reorder, retype or
insert a stored field; add at the end of the namespace's struct. `bun run test:check` fails if the layout moved from
`snapshots/StorageLayout.json`; `bun run layout` records a change that only adds at the end, and refuses one that
would break the proxies.
`script/DeployLocal.s.sol` deploys the same with a mock USDC on anvil, for `packages/relayer/scripts/e2e.ts`.
