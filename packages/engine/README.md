# @skech/engine

Rust WebSocket server, and skech's price oracle. It streams every BTC-USD
trade on Coinbase to the app, each checked against Binance and Kraken and
signed by the engine's wallet as EIP-712 typed data, which the relayer checks
before it places a piece drawn at that price. The app shows the price that was signed.

```
Coinbase ─wss + REST─┐  the price, and 10 min of history
Binance ───wss───────┤  attesters: sign Coinbase if one of them is within the band of it,
Kraken ────wss───────┘             else their median if they are within the band of each other,
                                   else (no two venues agree, or none heard) sign nothing
                     └──> engine ──ws://…:3102/ws──> app ──piece(price, time, signature)──> relayer
```

Every source is a venue's public WebSocket, one connection each, pushing each
trade as it happens: no API keys, and nowhere near any venue's limits.

Why not an RPC or a DEX for the price: an RPC only has on-chain oracles, and
Chainlink BTC/USD on Ethereum had not moved in 43 minutes when checked, 0.1%
from Coinbase. A DEX pool's price only moves on a swap, drifts by up to its fee
tier, and one large swap can push it. Pyth Pro would sign at the source, but
needs an API key.

Binance's BTC trades are in USDT, which is not quite a dollar (0.044% off when
measured), so they are divided by Binance's own USDC/USDT. In dollars, Binance
was 0.005% from Coinbase at the median. Kraken's WebSocket host could not be
reached from the network this was built on (a TLS failure even for curl), so
its feed is written to Kraken's v2 API but has not run live.

## Run

```bash
bun run dev:engine        # from the repo root; or: cargo run --release -- --dev
cargo test                # includes the vector the EVM contracts' tests recover, and the fixed domain
```

It reads the repo root `.env.local`. Variables already in the environment win.

Without `ENGINE_PRIVATE_KEY` the engine refuses to start: it would sign with a throwaway wallet, and no relayer
set to its signer (`RELAYER_ENGINE_SIGNER`) would take its prices. `--dev` (which `bun run dev:engine` passes)
lets it go on anyway.

It signs under one fixed EIP-712 domain: `name` "skech", `version` "1", `chainId` 10143 and `verifyingContract`
`0xd7cE3AADC704caF2D16319D1D25d01024cC5fdF0`. That is the domain it signed under when the game ran on Monad
testnet, kept byte for byte now that the game is on Solana alone, so every price signs exactly as it did and
checks out wherever it is checked. Nothing is read for it: no chain, no RPC, no deployment file, no env.
`src/quote.rs` has the constants, and a test that the domain separator has not moved.

| Env | Default | |
|---|---|---|
| `ENGINE_PRIVATE_KEY` | required; a throwaway wallet with `--dev` | Hex key the engine signs with |
| `ENGINE_BAND_BPS` | `15` (0.15%) | How close two venues must be to agree on a price |
| `ENGINE_HOST` | `127.0.0.1` | Where it listens. On the box Caddy is the way in; `0.0.0.0` to reach a laptop's engine from a phone |
| `ENGINE_PORT` | `3102` | |
| `ENGINE_MAX_CLIENTS` | `500` | Players connected at once; past it a new one gets a 503. 32 more slots are kept for clients on the box itself (the relayers) |
| `ENGINE_SENTRY_DSN` | off | Sentry: a panic, with its stack, is sent before `panic = "abort"` ends the process. Only where `SENTRY_ENVIRONMENT` is set (the box's unit sets `production`) |
| `ENGINE_SENTRY_DEV` | off | `1` sends from a laptop too, as `development` |

`GET /health` returns `ok`. `hello` also carries `"attest": { "by": ["binance", "kraken"], "band": 0.0015 }`.

## Protocol

One WebSocket at `/ws`, JSON text frames, server to client only. The engine
signs what it saw; a client cannot ask it to sign anything.

```jsonc
// 1. on connect: the signer, and an eth_signTypedData_v4 payload minus the message
{ "type": "hello", "signer": "0x…", "typedData": {
    "domain": { "name": "skech", "version": "1", "chainId": 10143, "verifyingContract": "0xd7cE3AADC704caF2D16319D1D25d01024cC5fdF0" },
    "primaryType": "Price",
    "types": { "EIP712Domain": [ … ], "Price": [
      { "name": "market", "type": "string" }, { "name": "price", "type": "uint256" }, { "name": "time", "type": "uint64" } ] } } }
// 2. then the last ten minutes of trades, oldest first, unsigned: [id, time ms, price, checked]
//    checked is 1 if the trade was checked and signed as it landed, 0 if not (backfilled, or not agreed on)
{ "type": "history", "trades": [[1099703850, 1790629278967, 83591.44, 1], …] }
// 3. then every trade as it lands. p is the price to show, and the one signed;
//    source says whose it is; message is the EIP-712 Price the signature is over
{ "type": "price", "id": 1099703850, "t": 1790629278967, "p": 83591.44, "signed": true,
  "source": "coinbase", "coinbase": 83591.44, "attesters": { "binance": 83588.2 },
  "message": { "market": "BTC-USD", "price": "8359144000000", "time": 1790629278967 },
  "signature": "0x…" }
// not signed: "signed": false, p is Coinbase's price, unchecked, "message": null, "signature": null.
// That is when no two venues agree, no attester has been heard from in 2 s, or Coinbase's time is
// more than 2 s off the engine's clock. Show it if you like; never settle on it.
// Coinbase's heartbeat each second
{ "type": "beat", "t": 1790629279000 }
```

- `price` has 8 decimals and is sent as a string, because it is a `uint256`
  and JavaScript numbers lose precision past 2^53. `time` is Coinbase's, in ms.
- `signature` is 65 bytes, r‖s‖v, with v 27 or 28 and s in the low half.
- The domain is fixed (above), whichever Solana cluster the game is on.

Check a price in the app:

```ts
import { verifyTypedData } from "viem";
await verifyTypedData({ ...hello.typedData, address: hello.signer, message: m.message, signature: m.signature });
```

A piece of ink carries `message.price`, `message.time` and `signature` as the price the player saw, and the
relayer (`packages/relayer`) checks it against this signer before it places the piece. The Solana program takes
the relayer's word for it, as its oracle.

## Notes

- Once a second the log says what is being signed, as a trade would post it:
  `signed $83,422.99 (coinbase, binance 0.004%) 0xcb902e30…b260581b · 7 trades`,
  or `attesters' price; coinbase was …, 0.016% off`, or `NOT signed …: no two venues agree (…)`.

- Each update is serialized once and shared by every client, and so is the
  history, rebuilt once a second. A client on the box itself (no
  `X-Forwarded-For`, so not through Caddy: a relayer) is sent the history as
  of the moment it connects instead, so its bars miss nothing.
- A client that falls 1024 updates behind, or takes more than 10 s to take a
  frame, is dropped; it reconnects and is sent what it missed. What a client
  sends is never read, and anything over 4 KiB closes it.
- `TCP_NODELAY` is on for both upstream and client sockets.
- Signing takes 38 µs a price (release build). Through the engine, a trade
  reaches a client 1–2 ms (p50) later than from Coinbase directly.
- An upstream socket that closes or goes quiet (5 s for Coinbase, 10 s for Binance
  and Kraken) is reopened with backoff, and the trades missed meanwhile are
  backfilled. A few hundred ms between the backfill and the socket opening can
  still be missed; the chart carries the price flat through them.
- A panic ends the process (`panic = "abort"`): a feed that died must not
  leave a server up, serving nothing.
- Keep `ENGINE_PRIVATE_KEY` in a wallet that holds nothing: the relayer trusts
  its prices, so it should have no other job.
- The box's clock must be kept (chrony, on by default on Amazon Linux): a
  Coinbase trade more than 2 s off it is not signed.
