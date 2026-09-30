# Setup

What has to be set up by hand to run what is on `main`: keys, consoles, the box, the Solana program. Code ships
itself (Vercel on merge, `infra/deploy.sh` for the box); this is everything that doesn't.

Do it in order: each part assumes the ones above it. [`DEPLOYING.md`](DEPLOYING.md) is how to ship once it
is set up; [`infra/README.md`](../infra/README.md) is the box.

## 1. Keys on your machine

`.env.local` at the repo root holds every server key. `infra/deploy.sh --env` sends the box only the ones
the servers read. [`.env.example`](../.env.example) documents each.

| Variable | What | Status |
|---|---|---|
| `ENGINE_PRIVATE_KEY` | signs prices | set |
| `RELAYER_ENGINE_SIGNER` | the engine key's address. The relayer ignores prices signed by anyone else | **new: add** |
| `ENGINE_SENTRY_DSN`, `RELAYER_SENTRY_DSN` | errors from the box | set |
| `ENGINE_BAND_BPS` | how far Coinbase may be from Binance or Kraken, in bp. Blank: 15 | leave blank |
| `SKECH_SOLANA_CLUSTER` | `devnet` | **new: add** (part 4) |
| `SOLANA_RELAYER_SECRET_KEY` | the relayer's keypair, the 64 bytes as JSON: `~/.config/solana/skech-devnet-relayer.json` on the owner's machine (`3hNNKV…Ge9s`). It is also the devnet game's oracle | **new: add** (part 4) |
| `SOLANA_DEVNET_RPC_URL` | a devnet RPC (the public one rate-limits) | **new: add** (part 4) |
| `SOLANA_RPC_RPS` | requests a second the relayer asks of that RPC, all told. Blank: 15. Set it under the plan's limit | optional (part 4) |

`RELAYER_ENGINE_SIGNER` for today's key is `0xc6377415Ee98A7b71161Ee963603eE52fF7750FC`
(`cast wallet address --private-key $ENGINE_PRIVATE_KEY` prints it).

Unused, safe to delete: `DATABASE_URL`, `LIGHTER_*`, `BOOST_*`, `FEED_URL`, `API_URL`, `TRADER_URL`, the
web app's old Coinbase keys, and what only the Monad relayer read: `SKECH_NETWORK`, `MONAD_*_RPC_URL`,
`MONAD_RPC_URL`, `QUICK_NODE_API_KEY`, `RELAYER_PRIVATE_KEY`, `RELAYER_SHADOW_EVERY`, `ENGINE_CHAIN_ID`,
`ENGINE_VERIFYING_CONTRACT`, `SKECH_GAME`, `SKECH_IOU`, `SKECH_REVENUE`, `SKECH_USDC`. Rotate the Lighter and
Boost keys first if those accounts hold anything.

## 2. Consoles

**Privy (dashboard.privy.io), the app `cmuzqwmig01200dl8gf8j8tf2`** ([`PRIVY-SETUP.md`](PRIVY-SETUP.md)):
- [ ] Login methods: email, SMS, Google, Apple
- [ ] Embedded wallets: Solana on
- [ ] Allowed origins: `https://app.skech.trade` and `http://localhost:3101`

**Vercel, the app's project, Production and Preview.** These are read when the app is built: redeploy after
changing any.

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_ENGINE_URL` | `wss://api.skech.trade/engine/ws` |
| `NEXT_PUBLIC_RELAYER_URL` | `wss://api.skech.trade/solana/ws` (the default, so it may be left unset) |
| `NEXT_PUBLIC_SOLANA_CLUSTER` | `devnet` (the default; `mainnet-beta` once the game is there) |
| `NEXT_PUBLIC_PRIVY_APP_ID` | `cmuzqwmig01200dl8gf8j8tf2`. Not the app secret, which the web app never needs |
| `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_REGION` | PostHog → Settings → Project; `us` or `eu` |
| `NEXT_PUBLIC_SENTRY_DSN` | the Sentry project `next-app` |
| `SENTRY_AUTH_TOKEN` | Sentry → Settings → Auth Tokens. Secret. Without it errors show minified code |

Check it took: the live page's JavaScript must not contain `localhost:3102`.

**AWS (Mumbai):**
- [ ] The box has an Elastic IP, and `api.skech.trade` points at it
- [ ] Security group: inbound 80 and 443 from anywhere; 22 from your own IP only
- [ ] The instance's CPU credits are not "Unlimited"
- [ ] A monthly budget alert (about $15)

**Sentry:** alert rules for new issues, and for the relayer's `low-sol`, `not-oracle` and `engine-signer`
reports (players can't play while any of them fires). On mainnet, also the gas keeper's `keeper-failed`,
`keeper-usdc-short` and `keeper-cap` (it could not buy SOL back), and `keeper-swap` and `keeper-cold` (it moved
money) to see each one.

**PostHog:** filter internal and test users, with your own wallet in the filter.

## 3. The box

After merging, from a clean checkout of `main` (both scripts refuse uncommitted changes):

```bash
infra/setup.sh            # the service users, bun, Caddy 2.11.4 (checksum checked), units, the backup timer
infra/deploy.sh --env     # right after: until it runs, the new units point at files that don't exist yet
```

Setup changes how the box runs: each service as its own user, code owned by root, `/etc/skech/env` split
per service, the relayer's state in `/var/lib/skech-relayer`, backed up every 15 minutes. On a box that still
runs the Monad relayer (`skech-relayer`), the next deploy stops, disables and removes it
([`infra/README.md`](../infra/README.md#from-the-monad-relayer)). A deploy needs the Solana keys of part 4 on
the box: do part 4's keys first.

Then check:
- [ ] `curl https://api.skech.trade/engine/health` and `/solana/health` answer `ok`
- [ ] `ssh skech curl -s localhost:3104/status` shows the difficulty and no errors (`/status` is box-only)
- [ ] `ssh skech chronyc tracking`: the clock is synced. Trades more than 2 s off local time are not signed
- [ ] `ssh skech systemctl status skech-engine skech-relayer-solana`: memory under the units' `MemoryMax`
  (300M and 400M, estimates); `skech-relayer` is gone
- [ ] The relayer wallet holds 1 SOL or more

## 4. Solana devnet

The game is on devnet (2026-10-01). Every address is in `packages/contracts/deployments/solana-devnet.json`:

| | |
|---|---|
| Program | `2k9WY5YR357AGVVoBW6ouFHijEypTj8953fzSdD7HfRV` (upgrade authority: the deployer, `7Qfww9…Njng`) |
| Game | `EQmnM7EP6ewPvjq81cCKmcKKzXFi5WGuciHfDtTCpyxF`, BTC-USD at difficulty 51: 4% of stakes, 10% of profit (3 and 8 points to SKT holders, 1 and 2 to the treasury; 75% of the pool's surplus to holders, 25% to the treasury) |
| SKT | live since 2026-10-10: `Rewards` `EkpMFY…Vvd71`, carried in the lookup table `HvMYfL…RzXX` |
| USDC | Circle's devnet mint, `4zMMC9…DncDU` |
| Oracle and relayer | `3hNNKVAfS95A1Rqqss7xoRS8PZceQbKCS4HCfhDsGe9s`, 0.3 SOL |

Its relayer runs on the box:

1. **Keys**: `SKECH_SOLANA_CLUSTER=devnet`, `SOLANA_RELAYER_SECRET_KEY` (the relayer keypair file's contents) and
   `SOLANA_DEVNET_RPC_URL` in the env file `infra/deploy.sh` reads (`.env.local`, or `SKECH_ENV_FILE`). If the
   RPC's plan allows fewer than 15 requests a second, set `SOLANA_RPC_RPS` below it: the relayer holds itself to
   that and backs off on a 429 (`/status` → `rpc` counts both).
2. **Ship**: `infra/deploy.sh --env`. The relayer serves `wss://api.skech.trade/solana/ws`.
3. **Check**: `curl https://api.skech.trade/solana/health` answers `ok`; `ssh skech curl -s localhost:3104/status`
   shows devnet, difficulty 51 and the engine connected.
4. **SOL**: the relayer pays every fee and every bet's rent (the rent comes back when the bet settles). Keep it
   over 1 SOL from faucet.solana.com; `solana airdrop` is rate-limited.

Upgrading the program: `deploy:solana` uploads through the RPC (`--use-rpc`), and the public devnet RPC rate-limits
it to a crawl (4% in 30 minutes). Upload straight to the validators instead, then set up or reconfigure the game:
`solana program deploy target/deploy/skech.so --program-id target/deploy/skech-keypair.json --url devnet` from
`packages/contracts/solana`, then `bun run deploy:solana --skip-program`.

### Social database

Profiles, follows, the leaderboard and the live feed are kept in Postgres by the relayer's social service
([`infra/README.md`](../infra/README.md#the-social-service-and-its-database)). Supabase, free plan or above:

1. A project in a region near the box (Mumbai: `ap-south-1`). In it, **Connect → Session pooler** (port 5432:
   the box has no IPv6, which the direct connection needs). Copy that URI, with the database password in it.
2. In the env file `infra/deploy.sh` reads: `SOCIAL_DATABASE_URL=<that URI>?sslmode=require`, and
   `SOCIAL_ALLOWED_ORIGINS=https://app.skech.trade` (and preview origins, comma-separated). It is a secret:
   never a `NEXT_PUBLIC_` name, and only the relayer's env file on the box gets it.
3. `infra/deploy.sh --env`. The service makes its schema, `skech_social`, on start, so the database role needs to
   be able to create one (Supabase's `postgres` can). One database per deployment of the game: a second one
   (mainnet) gets its own project.
4. On Vercel: `NEXT_PUBLIC_SOCIAL_URL=https://api.skech.trade/social` (or leave it blank: that is what it is
   derived as from the relayer's URL), then redeploy.
5. **Check**: `curl https://api.skech.trade/social/health` answers `"db":true`; `counting` goes false once the
   history is read (a transaction at a time, at `SOCIAL_RPC_RPS`).

On a laptop, the service runs without a relayer, reading the game from the chain and placing nothing:
`SOCIAL_DATABASE_URL=postgres://… bun run --filter @skech/relayer social`.

## 5. The phone app

`packages/solana-mobile`, its own npm project (not in the bun workspace). It signs in by email, SMS or, on
Android, a Solana wallet on the phone (Phantom, Solflare, the Seeker's Seed Vault). The email and SMS sign-in
and the embedded Solana wallet are Privy's, the same Privy app as the web. Google and Apple are off on the phone.

**Privy (dashboard.privy.io), app `cmuzqwmig01200dl8gf8j8tf2`:**
- Login methods: email and SMS on.
- Embedded wallets: Solana on. The app creates one for anyone who signs in without one.
- App settings → Clients → Add app client: allowed app identifiers `trade.skech.app` (the Android package and
  the iOS bundle id), URL scheme `skech`. Its client id is `EXPO_PUBLIC_PRIVY_CLIENT_ID`.
- The app secret stays on servers: nothing in `packages/solana-mobile` may hold it.

1. `packages/solana-mobile/.env` from its `.env.example`: `EXPO_PUBLIC_PRIVY_APP_ID`, `EXPO_PUBLIC_PRIVY_CLIENT_ID`
   (without both the app signs in only with a wallet on the phone) and the two URLs, which default to the box.
   Until the relayer runs there (part 4), point `EXPO_PUBLIC_RELAYER_URL` at a relayer on your machine by
   its network address, e.g. `ws://192.168.x.x:3104/ws` (a phone's `localhost` is the phone), with
   `RELAYER_HOST=0.0.0.0` on the relayer.
2. `npm install` (its `.npmrc` lets Privy's pinned viem peer through), then `npx expo run:ios` or
   `npx expo run:android`. Needs Xcode, or Android Studio and JDK 17. A development build loads its code from
   Metro on your machine: the phone has to be on the same network.
3. To play: sign in, copy the Solana address from Deposit, get devnet USDC at faucet.circle.com (Solana Devnet)
   and send it there. It is swept into the balance by itself.

Done on a Galaxy A07: Privy sign-in, a deposit, pieces placed and settled, a Solana wallet (Phantom, Solflare)
through the Mobile Wallet Adapter.

### Releasing: store builds and over-the-air updates

`android/` and `ios/` are generated (`npx expo prebuild`) and not in git. Everything native lives in `app.json`
and `plugins/`: the release signing (`with-release-signing`, reading `~/.config/skech/android-signing.properties`,
which is the Play upload key: back up `~/.config/skech/`), Gradle's memory (`with-gradle-memory`), and the
permissions (only camera, vibrate, internet, notifications; microphone, overlay, storage and background audio
are blocked).

Two kinds of release:
- **Over the air (most releases).** Changes to the app's own code and images: `npx eas-cli update --channel
  production --environment production --platform android --message "…"` from `packages/solana-mobile`. Installed
  apps download it in the background and run it on their next launch. The `EXPO_PUBLIC_*` settings baked into an
  update come from **EAS's own environment variables** (`npx eas-cli env:list production`), not the local `.env`:
  an update without them ships with sign-in switched off. Switching the relayer or the Solana cluster (e.g. to
  mainnet) is `eas env:update`, then an update. The app logs `[updates] …` at startup: the build's own code, or
  which update it runs.
- **Through the store.** Anything native: a new package with native code, a new permission, the icon, the
  Expo SDK. Raise `android.versionCode` in `app.json`, `npx expo prebuild --platform android`, then
  `./gradlew clean bundleRelease` in `android/` (JDK 17) and upload `app/build/outputs/bundle/release/app-release.aab`
  in Play Console. Build clean: Gradle otherwise reuses the last build's fingerprint, and updates then never reach
  the build (`unzip -p <apk> assets/fingerprint` should equal `npx expo-updates fingerprint:generate --platform android`).

`runtimeVersion` is the native fingerprint, so an update only reaches builds whose native code it matches: an
update that needs a new native build simply waits for it, rather than crashing an old one. `eas-cli fingerprint:compare`
tells which kind a change is.

The Expo project is `@swayams-team/skech` (its id and the updates URL are in `app.json`); `npx eas-cli login` once on
a new machine. Don't run `eas update:configure` again: it rewrites `app.json`, duplicating every list in it. Play's own app-signing SHA-256 (Play Console → App
integrity) goes into skech.trade's `assetlinks.json` next to the upload key's, or wallets stop trusting the
store's copy.

## 6. Before mainnet

- **iOS builds.** Android ships through Play (part 5); iOS still needs an Apple distribution certificate and
  TestFlight.
- **Real-money gambling on Play.** Closed, open and production tracks need Google's real-money gambling
  approval (licences per country, age and region gating). Internal testing does not.

- **Hand the program to a multisig.** The deployer is the program's upgrade authority and the game's admin.
  On mainnet, transfer both to a Squads multisig straight after the deploy; only the relayer's key, the
  oracle, sits on the box.
- **Fees to the relayer, and its gas from them.** Deploy with `SOLANA_TREASURY` set to the relayer's address
  (`solana address -k <relayer keypair>`): the treasury is then the relayer's own USDC account, and the fees it
  collects land there. Its gas keeper (`packages/relayer/src/solana/keeper.ts`) buys its SOL back with them through
  Jupiter, and sends what piles up over a cap to a cold wallet (the multisig). The treasury of a game already set up
  changes only by its admin's `set_treasury` (then `bun run deploy:solana --skip-program` rewrites the deployment).
  In the env file `infra/deploy.sh --env` ships:

  ```bash
  KEEPER_ENABLED=1
  KEEPER_DRY_RUN=1                  # the first day: it logs what it would do, with the quote; then remove it
  KEEPER_JUPITER_API_KEY=<from developers.jup.ag/portal>
  KEEPER_SOL_FLOOR=0.1
  KEEPER_SOL_TARGET=0.3
  KEEPER_DAILY_CAP_USDC=30          # the default: 0.2 SOL cost 22 USDC on 2026-10-09; raise it if SOL rises
  KEEPER_COLD_WALLET=<the multisig's address>
  KEEPER_USDC_CAP=100
  KEEPER_USDC_KEEP=20
  ```

  `bun packages/relayer/scripts/keeper-quote.ts 0.2` shows what a top-up costs now, read only. Then
  `ssh skech curl -s localhost:3104/status` shows it under `keeper`: `enabled`, `dryRun`, the relayer's `sol` and
  `usdc`, `lastSwapAt`, `swappedToday` and `lastError`; `journalctl -u skech-relayer-solana | grep keeper` what it
  decided. Fund the relayer with SOL to start: the keeper buys only once fees have come in.
- **Shorten the web session.** A browser-held session key is allowed $100,000 for 7 days; about a day, and
  an allowance near the balance, is enough.
- **Enforce the CSP.** It runs report-only; switch it to enforced once Sentry shows no reports.
- **Privy's HttpOnly cookies** on our own domain (dashboard → Configuration → App settings → Domains, then the
  DNS records it shows), so the session is a first-party cookie rather than browser storage. Add the
  `privy.skech.trade` host it gives to the CSP's `connect-src` and `frame-src` (`ui/app/src/proxy.ts`).
