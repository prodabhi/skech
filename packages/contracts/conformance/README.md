# Conformance

One set of cases, played the same way against the EVM contracts (`evm/`, kept in the repo but not deployed) and the Solana program (`solana/`, the game).
If the two chains ever disagree on a payout, a fee, a refund or a refusal, one of these fails.

| File | What it is |
|---|---|
| `cases.ts` | The cases: deposits, pieces placed, bars posted, step by step. Chain-neutral: bands in grid units, USDC in e6, prices in e8. |
| `reference.ts` | The reference model: what every step must do, on `@skech/core`'s ladder. |
| `generate.ts` | Runs the cases through the model and writes `vectors.json`, and the Solidity that replays it (`evm/test/ConformanceCases.sol`). |
| `vectors.json` | Every expected number. Generated; never edited by hand. |
| `../solana/tests/vectors/ladder.json` | The ladder alone, row for row, from `@skech/core`: `SkechLadder` (`evm/test/LadderVectors.t.sol`) and the program (`solana/tests/src/ladder.rs`) are both checked against it. |

The runners check every number after every step: what each piece staked and the bands it was offered at which rung,
what each settlement paid and owed, and every balance, the pool, the fees and the IOUs. The Solana runner also checks
that every USDC in the vault is accounted for.

- EVM: `evm/test/Conformance.t.sol` (the runner) and `evm/test/ConformanceCases.sol` (one test per case, generated).
- Solana: `solana/tests/src/conformance.rs`, reading `vectors.json` and running the compiled program in LiteSVM.

## Running

```bash
bun run conformance            # from packages/contracts: the files are up to date, then both chains
bun run conformance:generate   # after changing cases.ts or reference.ts
```

The Solana half runs the program as last built, so run `bun run solana:build` first after changing it.

## Adding a case

Add it to `cases.ts`, regenerate, and run both chains. A case both chains fail usually means the model is wrong;
a case one chain fails is the bug this folder is for.
