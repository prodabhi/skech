# @skech/relayer

Bun. The one process besides the engine that holds a signing key: the Solana game's oracle. It prices what
players draw, attests it, and puts it on chain for them; posts the price every second and settles on it; pays
off IOUs, shares the pool's surplus with SKT holders and moves the fees out. Players never send a transaction themselves or hold SOL.

```
app ──ws /ws──> relayer ──sendTransaction──> the skech program on Solana
                  │  ▲
                  │  └── engine ws (trades, signed prices)
                  └───── packages/core: the same pricing the app quotes with
```

- **One piece, one transaction.** Pieces are checked as they arrive (the session's Ed25519 signature over `pieceBytes`, the engine's price, the balance), then at 350 ms into their second each is priced on the map of that second (`field` from `@skech/core`, in a worker) and sent on its own. The Ed25519 precompile instruction points at the piece inside `place`; the relayer signs as fee payer and oracle (`src/solana/sequencer.ts`).
- **Sending.** A blockhash and a priority fee kept fresh in the background, every 12 s and every 45 s (never, with `SOLANA_PRIORITY_MICROLAMPORTS`): the fee is 75% of what recent blocks paid to write the pool, capped. The block height is reckoned from the blockhash, not asked for. v0 transactions go through the deployment's lookup table. Compute limits come from `packages/contracts/solana/snapshots/compute.json`: a settlement is budgeted part by part, for its bar, each bet, each band it has, each band it decides and each SKT account it opens (`src/solana/compute.ts`), and cut into as many transactions as its bytes and compute need. A settlement that fails anyway is split: the bar goes alone, which always fits, and its bets settle on it in halves, down to one bet at the most compute a transaction may have. Each second backs off on its own when it fails, so no second holds back a later one. Each transaction is rebroadcast every 2 s until it is confirmed or its blockhash expires, and every one in flight is looked for in one `getSignatureStatuses` (up to 256 at once, every 400 ms while any is new, then every second): `src/solana/confirm.ts`.
- **Asking the RPC.** Every request waits on one budget, `SOLANA_RPC_RPS` a second (15 by default): sends first, then looking for transactions in flight, the blockhash and fee, players' reads, and the sweep last. A 429 stops them all for its `Retry-After`, or a doubling wait with jitter, and is logged at most every 30 s with a count; identical reads at once are one request (`src/solana/budget.ts`).
- **Settling.** A second's bar goes in with the first nine bets that have ink in it (each is its bet, its player and their SKT `Holder`, which the program opens at the relayer's cost the first time a settlement mints for that player), and the rest settle on it in parallel transactions. Bets are closed as they are decided and the rent comes back. Every five minutes, when nothing is due: IOUs, the house's IOUs, the pool's surplus over its reserve and live bets' worst (`share_surplus`: 75% to SKT holders, 25% to the treasury, never while anything is owed, and only once it is `SOLANA_SURPLUS_ABOVE_E6`, $10), USDC swept in from wallets that approved it, and fees to the treasury, read in a few requests (the pool once, holders and wallets a hundred to a `getMultipleAccounts`). A wallet is swept at once when it approves the game, or when its app says USDC landed (`sweep`). What is still to settle survives a restart in `.relayer-state.solana-<cluster>.<game>.json`, written whole or not at all (`src/state.ts`). A state file that is there but cannot be read stops the relayer at start, rather than being saved over: restore it, or move it aside to start without it.
- **Gas keeper.** Every five minutes, the relayer's SOL and USDC in one read, at the sweep's priority. Under `KEEPER_SOL_FLOOR` it buys SOL back to `KEEPER_SOL_TARGET` with USDC through Jupiter's Metis API (`/swap/v1`, the one that quotes ExactOut): a quote for the lamports wanted, or what the day's cap allows, then Jupiter's transaction, checked before the relayer signs it, and sent like the relayer's own. The checks: the quote is USDC in, wSOL out, ExactOut for the lamports asked, its most-in no more than its in-amount and slippage, and within what it may spend; the transaction is v0 or legacy, paid for and signed by the relayer alone, calls nothing but the compute budget, system, token, ATA and Jupiter programs, at no more than the relayer's priority cap; and simulated, it takes no more USDC than the quote's most and gives the SOL. One swap an hour, `KEEPER_DAILY_CAP_USDC` a UTC day, never into `KEEPER_USDC_RESERVE`; the last swap and the day's total survive a restart in `.relayer-state.keeper.solana-<cluster>.json`. Over `KEEPER_USDC_CAP`, what is above `KEEPER_USDC_KEEP` goes to `KEEPER_COLD_WALLET`'s USDC account (made if missing), at most `KEEPER_COLD_MAX_USDC`, once an hour. Off unless `KEEPER_ENABLED=1`; off mainnet or with `KEEPER_DRY_RUN=1` it only logs what it would do, with the quote it would take on mainnet. Each swap and transfer, each failure, and a floor it cannot buy back to go to Sentry, once an hour each (`src/solana/keeper.ts`). On mainnet the treasury is the relayer's own USDC account, so the fees it collects are what it buys with.
- **Wallet-signed transactions.** Sessions, deposits, withdrawals and SKT claims are `build` → wallet signs → `submit`; the relayer co-signs only a message it built. A claim is built only when the player's SKT has earned something.
- **Reading players.** A player's game account, the pool, their wallet's USDC, their SKT (`Holder`) and SKT's own account (`Rewards`) are one `getMultipleAccounts`, made at most once a second for each player however many ask (the app, a settlement, a piece arriving; `src/solana/accounts.ts`). A piece's price signature is checked before anything is read for it, and an address with no game account is remembered as such for 30 s.
- **Transactions per player** are their `Player` account's signatures, counted incrementally; for an address nobody is watching, one page of them every 30 s at most.

```bash
bun run dev:relayer                          # from the repo root; reads .env.local there
bun packages/relayer/scripts/e2e-solana.ts   # a local validator, the relayer and a scripted player (below)
bun packages/relayer/scripts/keeper-quote.ts 0.2   # what Jupiter would charge the keeper for 0.2 SOL, read only
```

| Env | Default | |
|---|---|---|
| `SKECH_SOLANA_CLUSTER` | `devnet` | The cluster, and with it `packages/contracts/deployments/solana-<cluster>.json`. `devnet`, `mainnet-beta` or `localnet` |
| `SOLANA_RELAYER_KEYPAIR`, `SOLANA_RELAYER_SECRET_KEY` | `~/.config/solana/id.json` on localnet only | A keypair file, or its 64 bytes as JSON (the box). Pays every fee and rent, and must be the game's oracle |
| `SOLANA_DEVNET_RPC_URL`, `SOLANA_MAINNET_BETA_RPC_URL` | the public RPC | A private RPC per cluster; `SOLANA_<CLUSTER>_WS_URL` for its websocket if not the same URL over ws |
| `SOLANA_RPC_RPS` | `15` | Requests a second to the RPC, all told |
| `SOLANA_PRIORITY_MICROLAMPORTS`, `SOLANA_PRIORITY_MAX_MICROLAMPORTS` | followed; capped at 50,000 (2,000,000 on mainnet) | A fixed priority fee, or the cap on the followed one |
| `SOLANA_MIN_PIECE_STAKE` | `10000` (1¢) | The least one piece may stake, USDC millionths, as it arrives and after what the program would hand back: a single dot goes in. In `hello`'s terms as `minPieceStake` |
| `SOLANA_SURPLUS_ABOVE_E6` | `10000000` ($10) | The least pool surplus, USDC millionths, worth sending `share_surplus` for |
| `NEXT_PUBLIC_ENGINE_URL` | `ws://localhost:3102/ws` | Where the engine is |
| `RELAYER_SOLANA_PORT` | `3104` | |
| `RELAYER_HOST` | `127.0.0.1` | Where to listen. Caddy fronts it on the box; `0.0.0.0` for a phone on the LAN |
| `RELAYER_ENGINE_SIGNER` | none | The engine's signing address. Set, an engine that signs as anyone else is not listened to |
| `RELAYER_STATE_DIR` | `packages/relayer` | Where the state file goes; `/var/lib/skech-relayer` on the box |
| `KEEPER_ENABLED` | `0` | `1` to let the gas keeper move money (on mainnet only) |
| `KEEPER_DRY_RUN` | `0` | `1`: only log what it would do. Always so off mainnet |
| `KEEPER_EVERY_MS` | `300000` | How often it looks |
| `KEEPER_SOL_FLOOR`, `KEEPER_SOL_TARGET` | `0.1`, `0.3` | SOL: buy under the floor, up to the target |
| `KEEPER_JUPITER_URL` | `https://api.jup.ag/swap/v1` | Jupiter's Metis API (`/quote`, `/swap`) |
| `KEEPER_JUPITER_API_KEY` | none | Sent as `x-api-key`; from developers.jup.ag/portal |
| `KEEPER_SLIPPAGE_BPS` | `50` | On the USDC going in (1 to 500) |
| `KEEPER_MIN_INTERVAL_MS` | `3600000` | One swap this often at most |
| `KEEPER_DAILY_CAP_USDC` | `30` | USDC swapped a UTC day, at most, counted at each swap's most |
| `KEEPER_USDC_RESERVE` | `0` | USDC never swapped |
| `KEEPER_COLD_WALLET` | none | Where USDC over the cap goes. None: nowhere |
| `KEEPER_USDC_CAP`, `KEEPER_USDC_KEEP` | `100`, `20` | Over the cap, all but the keep goes to the cold wallet |
| `KEEPER_COLD_MAX_USDC` | `1000` | The most one transfer to the cold wallet moves |

`GET /health` returns `ok`; `GET /status` says what it is doing: the engine, the chain's sends and priority
fee, the RPC budget, pieces, settling and the keeper (`keeper`: enabled, dry run, SOL, USDC, the last swap, the
day's total, the last error). Keep SOL in the relayer's wallet: it logs a warning, and tells Sentry, under 0.5 SOL,
or under `KEEPER_SOL_FLOOR` while the keeper is live.

## End to end

`scripts/e2e-solana.ts` plays the game on a local validator: a player with local USDC and no SOL signs a
session with a standing approval, deposits, draws a piece at the engine's price, sees it placed and settled,
counts its transactions and withdraws.

```bash
solana-test-validator --reset --gossip-port 8110 --dynamic-port-range 8111-8140   # elsewhere
SKECH_SOLANA_CLUSTER=localnet bun run deploy:solana
bun packages/relayer/scripts/e2e-solana.ts      # E2E_ENGINE_URL=ws://localhost:3102/ws for a local engine
```

## Protocol

JSON over one WebSocket; the chain's numbers are decimal strings. On connect: `hello` with the cluster, the
program and game, the oracle, the engine's signer, the game's domain, the difficulty, the grid units and the
terms, with the least a piece may stake (`minPieceStake`). Then:

```jsonc
// app -> relayer
{ "type": "watch", "player": "<wallet>" }                  // follow a player: answered with "account", and every event after
{ "type": "piece", "piece": {…}, "sessionSig": "…", "priceSig": "0x…", "stroke": "…" }   // -> "ack" now; "placed" or "refused" once on chain
{ "type": "build", "kind": "session" | "deposit" | "withdraw" | "revoke" | "claim", "player", … }  // -> "built": a transaction for the wallet to sign
{ "type": "submit", "id", "tx" }                           // the built transaction, signed -> "submitted"
{ "type": "sweep" }                                        // USDC just landed in the wallet: move it in now
{ "type": "activity", "player": "<wallet>" }               // -> "activity": the player's transactions
// relayer -> app
{ "type": "placed", "betId", "staked", "fee", "refunded", "sections": [{ "second", "lo", "hi", "stake", "rung" }], "tx" }
{ "type": "refused", "betId", "why" }
{ "type": "settled", "betId", "hitMask", "missMask", "paid", "owed", "closed", "minted", "tx" }   // minted: SKT e6 its misses minted
{ "type": "account", "player", "balance", "session": {…}, "owed", "wallet", "skt": { "balance", "claimable" } }  // SKT e6, USDC e6
{ "type": "beat" }                                          // every 15 s, so a phone's socket is never quiet; ignore it
```

A socket that sends nothing for 30 s, not even a pong to the server's pings, is closed. Apps pass over a
message type they do not know.

Every message is checked before it is read (`src/wire.ts`) and, if it is wrong, answered with why in the reply
its sender waits for. What the relayer pays for is held to players with money in: a session only with a balance
or USDC in the wallet, a deposit or withdrawal of at least 1 USDC (or the whole balance), a few an hour for one
wallet or one address. A piece none of whose bands earns a rung is refused before it is sent. Each connection is
rate limited by type of message (`src/limits.ts`). Pieces staking under 10¢ (`BATCH_PIECE_STAKE_E6`) are also
limited for each player, whichever connection sends them: 10 at once, 2 a second, then "Too many small pieces;
draw a longer line". Each piece is a transaction the relayer pays about $0.0008 for, and a 1¢ piece's 4% fee, of which the house keeps 1 point, does
not cover it; the apps send a line in 10¢ pieces, so only its end, or a tap, is small. Only a piece the relayer
would take counts, so nobody can use up another player's.
