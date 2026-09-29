#!/usr/bin/env bash
# Ship the engine and relayer to the box: copy the committed source, build there, install, restart, check /health.
#
#   infra/deploy.sh           # code only
#   infra/deploy.sh --env     # also replace the box's keys with the server's keys from .env.local
#
# SKECH_ENV_FILE=<path> reads the keys from somewhere else. The box's keys are not always the ones
# this machine develops against, and copying them over .env.local to send them is how a laptop ends
# up pointed at production.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${SKECH_HOST:-skech}"
ENV_FILE="${SKECH_ENV_FILE:-.env.local}"

# Only what the engine and relayer read. .env.local holds much more (CDP, Lighter, the old DATABASE_URL);
# none of it goes to the box. SOCIAL_DATABASE_URL does, to the relayer's env file only (split_env below): it is a
# secret, and never a NEXT_PUBLIC_ one.
SERVER_KEYS="ENGINE_PRIVATE_KEY ENGINE_BAND_BPS ENGINE_MAX_CLIENTS ENGINE_SENTRY_DSN RELAYER_ENGINE_SIGNER RELAYER_SENTRY_DSN
  SKECH_SOLANA_CLUSTER SOLANA_RELAYER_SECRET_KEY SOLANA_DEVNET_RPC_URL SOLANA_DEVNET_WS_URL SOLANA_MAINNET_BETA_RPC_URL
  SOLANA_MAINNET_BETA_WS_URL SOLANA_PRIORITY_MICROLAMPORTS SOLANA_PRIORITY_MAX_MICROLAMPORTS SOLANA_RPC_RPS SOLANA_MIN_PIECE_STAKE
  KEEPER_ENABLED KEEPER_DRY_RUN KEEPER_EVERY_MS KEEPER_SOL_FLOOR KEEPER_SOL_TARGET KEEPER_JUPITER_URL KEEPER_JUPITER_API_KEY
  KEEPER_SLIPPAGE_BPS KEEPER_MIN_INTERVAL_MS KEEPER_DAILY_CAP_USDC KEEPER_USDC_RESERVE KEEPER_COLD_WALLET KEEPER_USDC_CAP
  KEEPER_USDC_KEEP KEEPER_COLD_MAX_USDC
  SOCIAL_DATABASE_URL SOCIAL_ALLOWED_ORIGINS SOCIAL_PORT SOCIAL_RPC_RPS SOCIAL_BACKFILL_DAYS"

# What ships, below. It ships as committed, from `git archive`: anything changed and not committed there is
# refused rather than left behind unnoticed.
SHIPS=(package.json bun.lock bunfig.toml tsconfig.base.json 'ui/*/package.json' packages/core packages/relayer packages/engine
  packages/contracts/package.json packages/contracts/deployments
  packages/contracts/solana/sdk.ts packages/contracts/solana/client packages/contracts/solana/snapshots
  infra/Caddyfile infra/backup-relayer.sh infra/systemd)
if [ -n "$(git status --porcelain -- "${SHIPS[@]}")" ]; then
  echo "not committed, so not shipped; commit them first (a new deployments/solana-<cluster>.json too):" >&2
  git status --short -- "${SHIPS[@]}" >&2
  exit 1
fi
TREE="$(mktemp -d)"
trap 'rm -rf "$TREE"' EXIT
git archive HEAD | tar -x -C "$TREE"

if [ "${1:-}" = "--env" ]; then
  [ -f "$ENV_FILE" ] || { echo "$ENV_FILE not found" >&2; exit 1; }
  # /etc/skech/env, root's alone (600), is where the box keeps them all; each service is given its own
  # share of it on every deploy, below. umask first, so the file is never readable by anyone else.
  for k in $SERVER_KEYS; do grep -E "^$k=.+" "$ENV_FILE" || true; done \
    | ssh "$HOST" 'umask 077 && sudo install -m 600 -o root -g root /dev/null /etc/skech/env.new && sudo tee /etc/skech/env.new >/dev/null && sudo mv -f /etc/skech/env.new /etc/skech/env'
  echo "env: $(ssh "$HOST" 'sudo cut -d= -f1 /etc/skech/env | tr "\n" " "')"
fi

# The workspace skeleton (ui/*/package.json keeps bun.lock's graph whole), core, relayer, the engine's source,
# and the Solana program's deployments, client and compute snapshot, into skech's build tree.
# Nothing excluded is deleted there, so node_modules and target/ survive between deploys.
rsync -az --delete --rsync-path="sudo -u skech rsync" \
  --exclude='node_modules/' --exclude='.relayer-state*' --exclude='.relayer-activity*' --exclude='*.tsbuildinfo' --exclude='dist/' --exclude='*.test.ts' \
  --include='/package.json' --include='/bun.lock' --include='/bunfig.toml' --include='/tsconfig.base.json' \
  --include='/ui/' --include='/ui/*/' --include='/ui/*/package.json' \
  --include='/packages/' --include='/packages/core/***' --include='/packages/relayer/***' \
  --include='/packages/engine/' --include='/packages/engine/Cargo.*' --include='/packages/engine/package.json' --include='/packages/engine/src/***' \
  --include='/packages/contracts/' --include='/packages/contracts/package.json' --include='/packages/contracts/deployments/***' \
  --include='/packages/contracts/solana/' --include='/packages/contracts/solana/sdk.ts' --include='/packages/contracts/solana/client/***' --include='/packages/contracts/solana/snapshots/***' \
  --exclude='*' \
  "$TREE/" "$HOST:/home/skech/src/"

# The commit being shipped, built into the engine as its Sentry release.
RELEASE="$(git rev-parse --short HEAD)"

# The services, Caddy's routes and the backup, so a new one needs no setup.sh rerun. Into a directory of their own,
# emptied first: a unit left in /tmp by an older deploy is not installed again.
ssh "$HOST" 'rm -rf /tmp/skech-infra && mkdir -m 700 /tmp/skech-infra'
scp -q "$TREE/infra/Caddyfile" "$TREE/infra/backup-relayer.sh" "$TREE"/infra/systemd/*.service "$TREE"/infra/systemd/*.timer "$HOST:/tmp/skech-infra/"

ssh "$HOST" "SKECH_RELEASE=$RELEASE bash -s" <<'REMOTE'
set -euo pipefail
for u in skech-engine skech-relayer; do
  id "$u" &>/dev/null || { echo "no $u user on the box: run infra/setup.sh first" >&2; exit 1; }
done
[ -f /etc/skech/env ] || { echo "no /etc/skech/env on the box: infra/deploy.sh --env" >&2; exit 1; }
sudo grep -q "^SOLANA_RELAYER_SECRET_KEY=" /etc/skech/env && sudo grep -q "^SKECH_SOLANA_CLUSTER=" /etc/skech/env \
  || { echo "no SOLANA_RELAYER_SECRET_KEY or SKECH_SOLANA_CLUSTER in /etc/skech/env: set them and infra/deploy.sh --env" >&2; exit 1; }

# Once, from before the build moved out of /opt/skech: the engine's target/ comes along, so it is not
# compiled from nothing.
if [ ! -d /home/skech/src/packages/engine/target ] && [ -d /opt/skech/packages/engine/target ]; then
  sudo mv /opt/skech/packages/engine/target /home/skech/src/packages/engine/target
  sudo chown -R skech:skech /home/skech/src/packages/engine/target
fi

sudo -u skech -H SKECH_RELEASE="$SKECH_RELEASE" bash -euc '
  export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
  cd /home/skech/src
  bun install --production --frozen-lockfile --filter @skech/relayer
  cd packages/engine && cargo build --release --locked -q
'

# Each service's share of /etc/skech/env: the engine's keys to the engine, the rest to the relayer.
split_env() {
  sudo bash -euc '
    umask 027
    # Once: the keys only the Monad relayer read (its own key, its RPCs, the network switch) leave the box with it.
    sed -i -E "/^(SKECH_NETWORK|RELAYER_PRIVATE_KEY|RELAYER_SHADOW_EVERY|MONAD_[A-Z_]+)=/d" /etc/skech/env
    grep -E "^ENGINE_[A-Z0-9_]+=" /etc/skech/env > /etc/skech/engine.env.new || true
    grep -vE "^ENGINE_[A-Z0-9_]+=" /etc/skech/env > /etc/skech/relayer.env.new || true
    chown root:skech-engine /etc/skech/engine.env.new && chown root:skech-relayer /etc/skech/relayer.env.new
    chmod 640 /etc/skech/engine.env.new /etc/skech/relayer.env.new
    mv -f /etc/skech/engine.env.new /etc/skech/engine.env && mv -f /etc/skech/relayer.env.new /etc/skech/relayer.env
    # Once: the env file of before this split was root:skech 640.
    chown root:root /etc/skech/env && chmod 600 /etc/skech/env
  '
}
split_env

# Once, from when Monad had a relayer of its own (skech-relayer, on :3103): stopped, disabled and its unit removed,
# so it is not left running, or started again at boot, beside the Solana relayer.
if [ -e /etc/systemd/system/skech-relayer.service ]; then
  sudo systemctl disable -q --now skech-relayer || true
  sudo rm -f /etc/systemd/system/skech-relayer.service
  sudo systemctl daemon-reload
  sudo systemctl reset-failed skech-relayer 2>/dev/null || true
  echo "the Monad relayer (skech-relayer) is stopped, disabled and removed"
fi

# From here the services are down, for as long as it takes to copy and start them.
sudo systemctl stop skech-relayer-solana
# Once, from before the relayers had a state directory of their own: their state files move into it.
# Then, once: the Monad relayer's state files (what it had still to settle, who it owed, its activity counts) move
# out of the live state directory into the backups, kept whole and no longer copied every 15 minutes.
sudo bash -euc '
  shopt -s nullglob
  for f in /opt/skech/packages/relayer/.relayer-state* /opt/skech/packages/relayer/.relayer-activity*; do
    if [ -e "/var/lib/skech-relayer/$(basename "$f")" ]; then echo "keeping $f: /var/lib/skech-relayer has one by that name"; else mv "$f" /var/lib/skech-relayer/; fi
  done
  chown -R skech-relayer:skech-relayer /var/lib/skech-relayer
  monad=(/var/lib/skech-relayer/.relayer-state.[0-9]* /var/lib/skech-relayer/.relayer-activity.*)
  if [ ${#monad[@]} -gt 0 ]; then
    install -d -m 700 -o root -g root /var/backups/skech-relayer/monad
    mv -f "${monad[@]}" /var/backups/skech-relayer/monad/
    echo "moved the Monad relayer state to /var/backups/skech-relayer/monad: ${monad[*]##*/}"
  fi
  # The switch the Solana relayer used to start on: it always runs now.
  rm -f /etc/skech/solana
'
# What runs is root's: no service can change the code it runs.
sudo rsync -a --delete --chown=root:root --chmod=go-w \
  --exclude='/packages/engine/target/' --exclude='/bin/' --exclude='.relayer-state*' --exclude='.relayer-activity*' \
  /home/skech/src/ /opt/skech/
sudo install -D -m 755 -o root -g root /home/skech/src/packages/engine/target/release/engine /opt/skech/bin/engine
sudo chown root:root /opt/skech && sudo chmod 755 /opt/skech

sudo install -m 755 -o root -g root /tmp/skech-infra/backup-relayer.sh /usr/local/sbin/skech-backup-relayer
sudo install -m 644 /tmp/skech-infra/*.service /tmp/skech-infra/*.timer /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl enable -q --now skech-backup.timer
# Caddy only when its routes changed: every socket through it is the price of a reload (eased by stream_close_delay),
# and most deploys change none. Restart if a reload fails: once, the running Caddy is one whose admin API was on
# localhost:2019. A Caddy that is not running is started either way.
if ! sudo cmp -s /tmp/skech-infra/Caddyfile /etc/caddy/Caddyfile; then
  sudo install -m 644 /tmp/skech-infra/Caddyfile /etc/caddy/Caddyfile && (sudo systemctl reload caddy || sudo systemctl restart caddy)
elif ! systemctl is-active -q caddy; then
  sudo systemctl restart caddy
fi
rm -rf /tmp/skech-infra
sudo systemctl reset-failed skech-engine skech-relayer-solana 2>/dev/null || true
sudo systemctl enable -q skech-engine skech-relayer-solana
sudo systemctl restart skech-engine skech-relayer-solana
for i in $(seq 20); do
  e=$(curl -fs localhost:3102/health || true); r=$(curl -fs localhost:3104/health || true)
  [ "$e" = ok ] && [ "$r" = ok ] && break
  sleep 1
done
echo "engine: ${e:-down}  relayer: ${r:-down}"
[ "$e" = ok ] && [ "$r" = ok ] || { sudo journalctl -u skech-engine -u skech-relayer-solana -n 30 --no-pager; exit 1; }
REMOTE
