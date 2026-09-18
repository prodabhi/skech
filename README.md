# skech

Bun-workspaces monorepo.

## Layout

```
.
├── package.json          # workspace root (workspaces: ui/*, packages/*, except packages/solana-mobile)
├── bunfig.toml           # hoisted install linker
├── tsconfig.base.json    # shared TS compiler options
├── ui/
│   ├── landing/          # @skech/landing   — marketing site
│   └── app/              # @skech/app       — product app
└── packages/
    ├── core/             # @skech/core      — the game's pricing and settlement (TypeScript)
    ├── engine/           # @skech/engine    — price server: Coinbase in, signed prices out (Rust)
    ├── relayer/          # @skech/relayer   — prices pieces, signs quotes and bars, sends every transaction (Bun)
    ├── contracts/        # @skech/contracts — the game on chain
    │   ├── solana/       #   the game, on Solana (Anchor)
    │   ├── evm/          #   the EVM contracts it was first written as (Foundry): kept, not deployed or used
    │   └── deployments/  #   the deployed addresses, written by the deploy, read by everything
    └── solana-mobile/    # the phone app (Expo, Privy): the web game, screen for screen; its own npm project
infra/                    # the EC2 box: setup, deploy, Caddy, systemd
deck/                     # the pitch deck (Vite, React): its own npm project; see deck/README.md
```

Both apps are Next.js 16 (App Router, TypeScript, Tailwind v4, ESLint, Turbopack)
with the `@/*` import alias pointing at each app's `src/`.

## Getting started

```bash
bun install          # install every workspace from the root
bun run dev          # engine + relayer + app + landing in one terminal, one labelled log
bun run dev app engine   # just those
bun run dev --kill   # first stop whatever holds their ports
bun run dev:landing  # landing on its own
bun run dev:app      # app on its own (needs the engine for prices)
bun run dev:engine   # engine on its own
bun run dev:relayer  # relayer on its own (needs the engine, a game on the cluster and a relayer key)
```

The engine needs Rust (`cargo`); the Solana program needs Anchor and the Solana CLI (`docs/SETUP.md`).
`SKECH_SOLANA_CLUSTER` (devnet when blank) picks the game, from `packages/contracts/deployments/solana-<cluster>.json`.
Without a relayer key (`SOLANA_RELAYER_KEYPAIR`) the relayer sits out. Without sign-in (`NEXT_PUBLIC_PRIVY_APP_ID`)
the app plays practice money; with it, someone signed out gets a thirty-second free trial on paper money, and a
signed-in player plays for USDC on Solana devnet through the relayer.

## Ports

Both apps use fixed default ports for `dev` and `start`:

- Landing: http://localhost:3100
- App: http://localhost:3101
- Engine: ws://localhost:3102/ws (`ENGINE_PORT`; the app reads `NEXT_PUBLIC_ENGINE_URL`)
- Relayer: ws://localhost:3104/ws (`RELAYER_SOLANA_PORT`; the app reads `NEXT_PUBLIC_RELAYER_URL`)

Stop an existing server before restarting it. Keep `http://localhost:3101`
in your Privy development app's allowed origins (`docs/PRIVY-SETUP.md`).

To override a port for an individual app, set `PORT`:

```bash
PORT=3000 bun run dev:landing
```

Leave `PORT` unset when running `bun run dev` or `bun run start` for the whole
monorepo so the two apps use different ports.

## Scripts

| Script | What it does |
| --- | --- |
| `bun run dev` | the whole stack, one labelled log (`scripts/dev.ts`); stops it all if one dies |
| `bun run build` | production build for every workspace |
| `bun run start` | serve the production builds |
| `bun run lint` | ESLint across every workspace |
| `bun run typecheck` | `tsc --noEmit` across every workspace |
| `bun run test` | bun tests, `cargo test` and `forge test` |
| `bun run deploy:solana` | the game on Solana devnet (`packages/contracts/solana/README.md`) |
| `bun packages/relayer/scripts/e2e-solana.ts` | the game on a local validator: the program, the relayer, a scripted player who holds no SOL |
| `bun run clean` | remove `node_modules`, `.next`, `target`, and Foundry's `out` and `cache` |

`typecheck` relies on the route types Next generates, so run `bun run build`
(or `bun run dev`) at least once in a fresh checkout before it will pass.

## Docs

| Doc | What it covers |
| --- | --- |
| [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) | the game end to end: the price feed, what a drawing costs and pays, the replay that checks it, and the game on chain |
| [docs/PRIVY-SETUP.md](docs/PRIVY-SETUP.md) | sign-in and the embedded wallet: what to turn on in Privy's dashboard |
| [infra/README.md](infra/README.md) | the EC2 box the engine and relayer run on: access, deploy, logs |
| [docs/SETUP.md](docs/SETUP.md) | what is set up by hand: keys, consoles, the box, Solana devnet, the phone app |
| [docs/DEPLOYING.md](docs/DEPLOYING.md) | shipping a change, changing a key, a new deployment of the program, going back |

## Adding a workspace

Anything dropped in `ui/` or `packages/` is picked up automatically. Depend
on one as `"@skech/<name>": "workspace:*"`. `packages/core` is the example:
the game's pricing and settlement, imported by the app and checked by the
replay scripts so they cannot disagree about what a drawing pays.
