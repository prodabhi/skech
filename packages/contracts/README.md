# @skech/contracts

The game on chain.

| | |
| --- | --- |
| [`solana/`](solana) | **The game**: one Anchor program, deployed on Solana devnet. The relayer and the apps use it, and its TypeScript side (`sdk.ts`, `client/`). |
| [`evm/`](evm) | The EVM contracts the game was first written as (Foundry, for Monad). **Kept, not deployed or used**: nothing deploys them and nothing talks to them. They stay as the reference the Solana program is checked against. |
| [`conformance/`](conformance) | One set of cases played through both, so they agree on every payout, fee, refund and refusal. |
| `deployments/` | `solana-<cluster>.json`, written by `bun run deploy:solana` and read by everything. `10143.json` records the EVM contracts' last deployment, on Monad testnet; nothing on the server side reads it. |

```bash
bun run solana:test     # the program in LiteSVM
bun run conformance     # both, against the same cases
bun run test            # the EVM contracts' Foundry tests
```
