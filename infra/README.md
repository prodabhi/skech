# infra

Where the engine and relayer run: one small Linux box (EC2, Amazon Linux 2023), Caddy in front for TLS.
The apps stay on Vercel and the stores, and reach it over `wss://`.

```
app ──wss://<domain>/engine/ws───> Caddy :443 ──> engine  127.0.0.1:3102
    ├─wss://<domain>/solana/ws───>            ├─> relayer 127.0.0.1:3104 ──> Solana
    └─https://<domain>/social/*──>            └─> its social service 127.0.0.1:3105 ──> Postgres (Supabase)
```

| File | |
|---|---|
| `setup.sh` | once per box: swap, the users, rustup, bun, Caddy (pinned, its SHA-256 checked), the systemd units. Safe to run again |
| `deploy.sh` | copy the committed source, build on the box, install it, restart, check `/health`. `--env` also sends the keys |
| `Caddyfile` | TLS and the paths, on `SKECH_DOMAIN`; the relayer's `/status` stays on the box |
| `systemd/` | `skech-engine`, `skech-relayer-solana`, `caddy`, all restarting on exit; `skech-backup.timer` |
| `backup-relayer.sh` | the relayer's state files into `/var/backups/skech-relayer`, every 15 minutes |
| `BOX.local.md` | gitignored: which box, how to get in, what is still to do on it |

## Access

The scripts reach the box as `skech`, a host in `~/.ssh/config` with its key (`*.pem` never goes in
the repo). `SKECH_HOST=<other>` points them at another entry.

```bash
ssh skech
```

## Deploy

```bash
infra/setup.sh            # a new box, or after changing setup.sh; deploy.sh right after
infra/deploy.sh --env     # first time, or after changing a key in .env.local
infra/deploy.sh           # every other time, the Caddyfile and units included
```

Both ship what is committed, not the working tree: `deploy.sh` sends `git archive HEAD`, and each refuses
to run while what it would ship has changes that are not committed (a new `deployments/solana-<cluster>.json`
included).

`setup.sh` serves the box's IP as an sslip.io name (`1.2.3.4` → `1-2-3-4.sslip.io`, which resolves back
to it), so no DNS is needed. `SKECH_DOMAIN=api.example.com infra/setup.sh` serves a real name instead,
once its A record points at the box. Either way ports 80 and 443 have to be open for the certificate;
3102, 3104 and 3105 never are. The engine and the relayer listen on 127.0.0.1 only, and the security group keeps
them off the internet besides.

`--env` writes `/etc/skech/env` (root only, 600) from `.env.local`, keeping only what the servers read:
the `ENGINE_*` settings and key, `RELAYER_ENGINE_SIGNER`, `RELAYER_SENTRY_DSN`, `SKECH_SOLANA_CLUSTER`, the
relayer's Solana key (`SOLANA_RELAYER_SECRET_KEY`), the `SOLANA_*` RPCs and fees, the gas keeper's `KEEPER_*`,
and the social service's `SOCIAL_DATABASE_URL`, `SOCIAL_ALLOWED_ORIGINS`, `SOCIAL_PORT`, `SOCIAL_RPC_RPS` and
`SOCIAL_BACKFILL_DAYS`. Nothing else in
`.env.local` leaves this machine. Every deploy splits it in two: `/etc/skech/engine.env` (the `ENGINE_*`
keys, readable by the engine only) and `/etc/skech/relayer.env` (the rest, readable by the relayer only).
A deploy stops before touching anything when the box has no `SOLANA_RELAYER_SECRET_KEY` or
`SKECH_SOLANA_CLUSTER`.

### From the Monad relayer

The box used to run a second relayer, for Monad (`skech-relayer`, on :3103, behind `/relayer/*`). The next
`deploy.sh` (or `setup.sh`) takes it down for good, once:

- `skech-relayer` is stopped, disabled and its unit file removed, so it neither runs on nor starts at boot;
- its state files (`.relayer-state.10143.*`, `.relayer-activity.*`) move from `/var/lib/skech-relayer` to
  `/var/backups/skech-relayer/monad/`, kept, and no longer copied every 15 minutes;
- the keys only it read (`SKECH_NETWORK`, `RELAYER_PRIVATE_KEY`, `RELAYER_SHADOW_EVERY`, `MONAD_*`) are
  deleted from `/etc/skech/env`, and the `/relayer/*` route goes with the new Caddyfile;
- `/etc/skech/solana`, which the Solana relayer used to wait for, is removed: it always runs now.

## Who runs what

| User | | Can write |
|---|---|---|
| `skech` | builds: owns rustup, bun and `/home/skech/src`, where `deploy.sh` copies the source and compiles it. Cannot sudo | its home |
| root | owns `/opt/skech`, what runs: the build copied out of `/home/skech/src`, the engine as `/opt/skech/bin/engine` | |
| `skech-engine` | the engine | nothing |
| `skech-relayer` | the relayer (`skech-relayer-solana`) | `/var/lib/skech-relayer` (its state), `/var/cache/skech-relayer` (bun's cache) |
| `caddy` | Caddy, on 80 and 443 | `/var/lib/caddy` (its certificates) |

Each service runs with `ProtectSystem=strict` (the whole file system read-only but the paths above),
`ProtectHome=read-only`, a private `/tmp` and `/dev`, no capabilities (Caddy keeps the one to bind 80 and
443), only IP and unix sockets, 65536 files, and a `MemoryMax` so a leak on the 1 GB box ends in its own
service. A service that crashes 50 times in ten minutes is left stopped: `sudo systemctl reset-failed
<unit>` and start it. Caddy's admin API is a unix socket, `/run/caddy/admin.sock`, not `localhost:2019`.

The engine compiles on the box, which is slow the first time (several minutes, in swap) and quick after:
`target/` stays in `/home/skech/src` between deploys. So does `node_modules`.

Which game the relayer serves comes from `packages/contracts/deployments/solana-<cluster>.json`, deployed
with the rest. After a new `bun run deploy:solana`, commit that file and run `infra/deploy.sh`; the whole
order is in [docs/DEPLOYING.md](../docs/DEPLOYING.md).

The web app finds them through `NEXT_PUBLIC_ENGINE_URL=wss://<domain>/engine/ws` and
`NEXT_PUBLIC_RELAYER_URL=wss://<domain>/solana/ws`, set in its Vercel project; the phone app through its
`EXPO_PUBLIC_*` equivalents. The web app's origin also goes in the Privy app's allowed origins
(`docs/PRIVY-SETUP.md`).

## The social service, and its database

Profiles, follows, the leaderboard and the live feed of drawings are the relayer's social service
(`packages/relayer/src/social`): a worker inside the relayer's process, on `127.0.0.1:3105` (`SOCIAL_PORT`),
behind Caddy's `/social/*`. It keeps them in Postgres, at `SOCIAL_DATABASE_URL` (a Supabase session pooler, with
`sslmode=require`: `docs/SETUP.md`), in a schema of its own, `skech_social`, made at start and closed to
Supabase's browser roles. One database is one deployment of the game: it refuses another's.

- Without `SOCIAL_DATABASE_URL` there is no worker; with a database that is down it answers 503 and tries again.
  The game never waits for it either way: the relayer only posts it messages.
- `SOCIAL_ALLOWED_ORIGINS` is the app's origins (production and previews, comma-separated). A page from any
  other is refused; a request with no Origin may read, and changes only what a wallet's signature says.
- It reads the game's history from the chain itself, by the pool's address: a `logsSubscribe` for what happens
  now, a look every minute for what it missed, and the history back `SOCIAL_BACKFILL_DAYS` (30), a transaction
  at a time. That is in a budget of its own, `SOCIAL_RPC_RPS` (2), on the relayer's RPC: keep `SOLANA_RPC_RPS`
  plus it under the RPC plan's limit.
- The chain keeps only a stroke's hash: a drawing's shape is what the relayer tells the service as it places it.
  Restoring a lost database from the chain recovers every number, not the shapes: back it up (Supabase does).

The `DATABASE_URL` some `.env.local` files still carry was for the Lighter services, removed on 2026-09-26; it is
not read.

## State

| State | Where | If it is lost |
|---|---|---|
| balances, bets, IOUs, fees, SKT | on chain: the Solana program's accounts | not possible to lose |
| bets placed but not yet settled | `/var/lib/skech-relayer/.relayer-state.solana-<cluster>.<game>.json` | survives restarts and deploys; backed up every 15 minutes (below) |
| the gas keeper's last swap and the day's USDC swapped | `/var/lib/skech-relayer/.relayer-state.keeper.solana-<cluster>.json` | the day's cap and the hour between swaps start over; backed up with the above |
| sign-in, wallet | Privy: the login and each player's embedded Solana wallet | Privy keeps it |
| session key | the player's browser (IndexedDB), or the phone's secure store | the player signs in again |
| profiles, avatars, follows, drawings and their results | Postgres, `skech_social` (`SOCIAL_DATABASE_URL`) | the numbers are read again from the chain; profiles, follows and drawings' shapes are not: the database's backups |
| settings, practice money, scoreboard | the player's browser, local and session storage | per device on purpose |
| waitlist emails | a Google Sheet, via `WAITLIST_SHEET_URL` in `ui/landing` | kept in the Sheet |

## Backups

`skech-backup.timer` runs `/usr/local/sbin/skech-backup-relayer` (`backup-relayer.sh`) every 15 minutes: the
relayer's state files are copied to `/var/backups/skech-relayer/<UTC time>/` (root only), and the newest 672,
a week, are kept. A copy on the same disk covers a bad deploy or a deleted file, not losing the box. For
that, `SKECH_BACKUP_S3=s3://<bucket>/<prefix>` in `/etc/skech/backup.env` also sends each one to S3, with the
aws CLI (on Amazon Linux already) and an instance role that may `s3:PutObject` there. `SKECH_BACKUP_KEEP` and
`SKECH_BACKUP_DIR` go there too.

```bash
sudo skech-backup-relayer                              # one now
systemctl list-timers skech-backup.timer               # when the next is
sudo ls /var/backups/skech-relayer | tail -3           # the newest
```

To restore one: `sudo systemctl stop skech-relayer-solana`, copy its files into `/var/lib/skech-relayer/`,
`sudo chown skech-relayer: /var/lib/skech-relayer/.relayer-*`, and start it.

## On the box

```bash
systemctl status skech-engine skech-relayer-solana caddy
journalctl -u skech-engine -f                     # what it signs, once a second
journalctl -u skech-relayer-solana -f             # pieces placed, bars settled
curl -s localhost:3104/status                     # the relayer's sends, RPC budget and backlog (not served publicly)
sudo systemctl restart skech-relayer-solana
```

Keep SOL in the relayer's wallet: it pays every fee and rent. It logs a warning, and tells Sentry, under 0.5 SOL.

## Cost

A t3.micro on demand is about **$12.50 a month**: the instance $8.20, the disk $0.70, a public IPv4 $3.60.
An attached Elastic IP adds nothing; one left unattached still bills. Measured on 2026-09-29: CPU about 1%
(a t3.micro can sustain 10% at no extra cost), and 1.5 KB/s out per connected player, so AWS's free
100 GB a month of outbound data covers about 17,000 player-hours. Set the instance's CPU credits to
Standard so a busy CPU slows down instead of billing.
