# Deploying

Three things ship separately:

| What | Where it runs | How it ships |
|---|---|---|
| The app (`ui/app`) and the landing (`ui/landing`) | Vercel | on merge to `main`, by itself |
| The engine and the relayer (`packages/engine`, `packages/relayer`, with `packages/core`) | the EC2 box ([infra/README.md](../infra/README.md)) | `infra/deploy.sh`, by hand |
| The program (`packages/contracts/solana`) | Solana devnet | `bun run deploy:solana`, by hand, rarely |

Merging does not reach the box. A change to the engine, the relayer, `packages/core` or a
deployment file is live only after `infra/deploy.sh`.

## 0. Getting in

Two things, and they are separate: the repo, and the box.

**The repo.** Ask an owner of [skech-trade](https://github.com/skech-trade) for write access to
`monorepo`. That is enough to open a pull request, and enough to merge one once it is approved.

**The box.** One SSH key reaches it, held as an EC2 key pair; there is no AWS account login involved
and no IAM user to ask for. To give somebody their own way in, add their public key rather than
sending them the `.pem`: a key per person can be taken away again, a shared `.pem` cannot, and that
one file is root on the whole box.

```bash
# they run this and send you the second line, never the first
ssh-keygen -t ed25519 -C "their-name@skech"      # makes ~/.ssh/id_ed25519 and .pub
cat ~/.ssh/id_ed25519.pub

# you add it, from a machine that can already get in
ssh skech 'cat >> ~/.ssh/authorized_keys' < their-key.pub
```

Then they put the box in `~/.ssh/config`, which is the name every script here uses:

```
Host skech
  HostName 13.206.202.4
  User ec2-user
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
```

`ssh skech` should answer. Taking access away is one line: delete their key from
`~/.ssh/authorized_keys` on the box.

Everyone who gets in is `ec2-user`, who can `sudo` without a password. There is no per-person
account and no audit trail of who did what. If that matters, attach an IAM role with
`AmazonSSMManagedInstanceCore` to the instance and use Session Manager instead: the agent is already
running, it is only missing the role, and after that access is an IAM policy per person with every
session logged. That is a change in the AWS console, not in this repo.

## 1. Push to main

Nobody commits to `main` directly; it takes a pull request.

```bash
git checkout main && git pull
git checkout -b what-you-are-doing
# work, commit
git push -u origin what-you-are-doing
gh pr create --fill          # or open it on github.com
```

Get it reviewed, then merge it. Vercel builds the app and the landing from the merge by itself.
Nothing else does: see below.

## 2. Ship a change to the box

From `main`, after the PR is merged:

```bash
git checkout main && git pull
infra/deploy.sh            # only if the engine, relayer, core or deployments/ changed
```

Then check:

```bash
curl https://api.skech.trade/engine/health      # ok
curl https://api.skech.trade/solana/health      # ok
ssh skech curl -s localhost:3104/status         # up: seconds since the restart; pieces, settling
```

and draw one piece on app.skech.trade.

`deploy.sh` ships the commit checked out, from `git archive`, and refuses to run while what it ships has
changes that are not committed. The engine's Sentry release is that commit.

If the box has not been deployed to in a while, `deploy.sh` may stop with `no skech-engine user on
the box: run infra/setup.sh first`. That is the box predating the split into one user per service.
Run `infra/setup.sh` and then `infra/deploy.sh`; it is safe to run again and it leaves the running
services alone until the deploy restarts them.

`setup.sh` rewrites which name Caddy serves, so pass the one already in `/etc/caddy/env` on the box
or the real domain is dropped for an sslip.io one:

```bash
ssh skech 'sudo cat /etc/caddy/env'      # SKECH_DOMAIN=api.skech.trade, 13-206-202-4.sslip.io
SKECH_DOMAIN="api.skech.trade, 13-206-202-4.sslip.io" infra/setup.sh
```

## 3. Change a key or a setting

| Setting | Where | Then |
|---|---|---|
| A server key or RPC (`ENGINE_*`, `RELAYER_*`, `SKECH_SOLANA_CLUSTER`, `SOLANA_*`, the Sentry DSNs) | `.env.local` | `infra/deploy.sh --env` |
| The same, from a file of the box's own keys | any path | `SKECH_ENV_FILE=.server.env infra/deploy.sh --env` |
| Where the backups go (`SKECH_BACKUP_S3`, `SKECH_BACKUP_KEEP`) | `/etc/skech/backup.env` on the box | the next backup reads it |
| An app setting (`NEXT_PUBLIC_*`, `SENTRY_AUTH_TOKEN`) | the app's Vercel project, Production and Preview | redeploy in Vercel: they are read at build |
| The landing's app link | `NEXT_PUBLIC_APP_URL` in the landing's Vercel project | redeploy |

The full list, with what each is for, is in [.env.example](../.env.example).

`--env` sends only the keys the engine and the relayer read, and replaces the box's set with
whatever it finds: a key missing from the file is a key gone from the box. Check what would go
before sending it.

```bash
ssh skech 'sudo cut -d= -f1 /etc/skech/env'        # what the box has now
```

Keep the box's keys in their own file rather than copying them over `.env.local`, which is what this
machine develops against. `.server.env` is gitignored for that.

## 4. A new deployment of the program

The game is a Solana program (`packages/contracts/solana`), served by the relayer (`packages/relayer`, port 3104,
`wss://…/solana/ws` on the box) to the web and phone apps. Its terms are 4% of stakes and 10% of profit, of which 3 and 8 points go to SKT holders and 1 and 2 to the treasury; of the pool's surplus over its reserve, 75% to SKT holders and 25% to the treasury.

1. **Deploy the program and set the game up**, once per cluster: `bun run deploy:solana` (devnet by default; `--mainnet` for mainnet-beta). It writes `packages/contracts/deployments/solana-<cluster>.json`; commit it and merge it. The deployer needs about 5 SOL for the program's rent; devnet SOL is free from `solana airdrop` or faucet.solana.com.
2. **Give the relayer its key and SOL.** `SOLANA_RELAYER_KEYPAIR` locally, or `SOLANA_RELAYER_SECRET_KEY` (the 64 bytes as JSON) in `.env.local` for the box, plus `SKECH_SOLANA_CLUSTER`. Its key must be the game's oracle: the deploy uses `SOLANA_RELAYER_KEYPAIR`'s. It pays every fee and every rent (a bet's comes back when it settles): keep 1 SOL or more in it.
3. **Ship it**: `infra/deploy.sh --env`. The relayer's state file is per cluster and game (`/var/lib/skech-relayer/.relayer-state.solana-<cluster>.<game>.json`), so a new game starts clean and the old file is left alone.
4. **Check it**: `ssh skech curl -s localhost:3104/status` names the cluster and program, and one piece drawn in the app settles. The pool starts at 0 and only fills from stakes: the first wins are paid in IOUs, which are paid off as it fills.

A new game is a new set of addresses: balances, open bets, IOUs and fees stay in the old one. Before moving,
have players withdraw, and let every open bet settle (`settling.seconds` in `/status` reaches 0). To change the
program's code without new addresses, upgrade it in place instead
([packages/contracts/solana/README.md](../packages/contracts/solana/README.md)): balances and bets stay where they are.

Locally: a validator (`solana-test-validator --reset --gossip-port 8110 --dynamic-port-range 8111-8140`, off port 8000, which Docker holds), `SKECH_SOLANA_CLUSTER=localnet bun run deploy:solana`, then `bun packages/relayer/scripts/e2e-solana.ts` plays the whole game through the relayer.

The EVM contracts in `packages/contracts/evm` are kept in the repo but not deployed or used.

## 5. A new box

[infra/README.md](../infra/README.md): `infra/setup.sh`, then `infra/deploy.sh --env`. Open 80 and
443 for the certificate, point `api.skech.trade` at it, and copy the relayer's state files across from
the old box (`/var/lib/skech-relayer`, or its newest backup) if it had bets still open.

## 6. Going back

- **The app or the landing:** promote the previous deployment in Vercel, then revert the PR.
- **The box:** check out the last good commit and `infra/deploy.sh` from it. The relayer's state
  survives either way.
- **The program:** there is no going back to an old game once players have moved; upgrade the program
  in place with a fix instead.
