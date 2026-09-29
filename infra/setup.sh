#!/usr/bin/env bash
# One-time setup of a fresh Amazon Linux 2023 box for the engine and relayer.
# Safe to run again: every step checks before it acts. Then infra/deploy.sh.
#
#   infra/setup.sh                                  # the `skech` host in ~/.ssh/config
#   SKECH_HOST=other infra/setup.sh                 # another host entry
#   SKECH_DOMAIN=api.example.com infra/setup.sh     # a real name in place of sslip.io
set -euo pipefail
cd "$(dirname "$0")"
HOST="${SKECH_HOST:-skech}"
BUN_VERSION="$(bun --version)"   # the box runs the bun this machine runs
# The name Caddy serves: by default the host's IP as an sslip.io name, which resolves back to it.
IP="$(ssh -G "$HOST" | awk '$1 == "hostname" { print $2 }')"
DOMAIN="${SKECH_DOMAIN:-${IP//./-}.sslip.io}"
# What goes to the box is what is committed: a Caddyfile or unit edited but not committed is refused.
if [ -n "$(git status --porcelain -- .)" ]; then
  echo "infra/ has changes that are not committed; commit them first:" >&2
  git status --short -- . >&2
  exit 1
fi

# Into a directory of their own, emptied first: a unit left in /tmp by an older run is not installed again.
ssh "$HOST" 'rm -rf /tmp/skech-infra && mkdir -m 700 /tmp/skech-infra'
scp -q Caddyfile backup-relayer.sh systemd/*.service systemd/*.timer "$HOST:/tmp/skech-infra/"
# Quoted for the far side: ssh joins its arguments into one string for the remote shell, so a domain
# that is two names ("a.example.com, 1-2-3-4.sslip.io", which is what Caddy wants to serve both) was
# split on the space and its second half run as a command.
ssh "$HOST" "sudo BUN_VERSION=$(printf %q "$BUN_VERSION") DOMAIN=$(printf %q "$DOMAIN") bash -s" <<'REMOTE'
set -euo pipefail

# Caddy, pinned: a new version is a change to this file, with the SHA-256 of its release tarball
# (checked against the SHA-512 in Caddy's own caddy_<version>_checksums.txt when it was pinned).
CADDY_VERSION=2.11.4
CADDY_SHA256=527fbf917c39189a1e3b31d34fa955601680b2d5c8055d2a87b8b9588dec7bb9

# 1 GB of RAM is not enough to compile the engine. 2 GB of swap is.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile swap swap defaults 0 0' >> /etc/fstab
fi

dnf install -y -q gcc rsync tar unzip python3 >/dev/null

# Who is who. skech builds: it owns the toolchains and /home/skech/src, where deploy.sh copies the source
# and compiles it, and it cannot sudo. What runs is copied from there into /opt/skech, owned by root, and
# runs as a user of its own that can write none of it: skech-engine holds the engine's key, skech-relayer
# the relayer's, and neither can read the other's.
id skech &>/dev/null || useradd --system --create-home --home-dir /home/skech --shell /bin/bash skech
for u in skech-engine skech-relayer; do
  id "$u" &>/dev/null || useradd --system --no-create-home --home-dir /nonexistent --shell /sbin/nologin "$u"
done
install -d -o skech -g skech /home/skech/src
install -d -o root -g root -m 755 /opt/skech
# The env files are 640, each readable by its own service only; deploy.sh writes them.
install -d -m 755 -o root -g root /etc/skech
install -d -m 750 -o skech-relayer -g skech-relayer /var/lib/skech-relayer
install -d -m 700 -o root -g root /var/backups/skech-relayer

sudo -u skech -H BUN_VERSION="$BUN_VERSION" bash -euc '
  cd ~
  [ -x ~/.cargo/bin/cargo ] || curl -sSf https://sh.rustup.rs | sh -s -- -y -q --profile minimal --no-modify-path
  [ "$(~/.bun/bin/bun --version 2>/dev/null)" = "$BUN_VERSION" ] || curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION" >/dev/null
'
# The relayer runs bun as a user with no home: a root-owned copy of skech's, where it can reach it.
[ "$(/usr/local/bin/bun --version 2>/dev/null)" = "$BUN_VERSION" ] || install -m 755 -o root -g root /home/skech/.bun/bin/bun /usr/local/bin/bun

if [ "$(/usr/local/bin/caddy version 2>/dev/null | cut -d' ' -f1)" != "v$CADDY_VERSION" ]; then
  tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_linux_amd64.tar.gz" -o "$tmp/caddy.tar.gz"
  echo "$CADDY_SHA256  $tmp/caddy.tar.gz" | sha256sum -c --quiet || { echo "caddy $CADDY_VERSION does not match its pinned SHA-256: not installed" >&2; exit 1; }
  tar -xzf "$tmp/caddy.tar.gz" -C "$tmp" caddy
  install -m 755 -o root -g root "$tmp/caddy" /usr/local/bin/caddy
  rm -rf "$tmp"
fi
id caddy &>/dev/null || useradd --system --home-dir /var/lib/caddy --create-home --shell /sbin/nologin caddy
install -d -o root -g root /etc/caddy
install -m 644 /tmp/skech-infra/Caddyfile /etc/caddy/Caddyfile
echo "SKECH_DOMAIN=$DOMAIN" > /etc/caddy/env

# Once, from when Monad had a relayer of its own (skech-relayer, on :3103): stopped, disabled and its unit removed.
# deploy.sh moves its state files into the backups.
if [ -e /etc/systemd/system/skech-relayer.service ]; then
  systemctl disable -q --now skech-relayer || true
  rm -f /etc/systemd/system/skech-relayer.service
  systemctl reset-failed skech-relayer 2>/dev/null || true
fi
rm -f /etc/skech/solana

install -m 755 -o root -g root /tmp/skech-infra/backup-relayer.sh /usr/local/sbin/skech-backup-relayer
install -m 644 /tmp/skech-infra/*.service /tmp/skech-infra/*.timer /etc/systemd/system/
rm -rf /tmp/skech-infra
systemctl daemon-reload
systemctl enable caddy
# Restart, not reload: an older Caddy's admin API was on localhost:2019, and the new unit reloads through the socket.
systemctl restart caddy
systemctl enable skech-engine skech-relayer-solana
systemctl enable --now skech-backup.timer
echo "setup done: bun $(/usr/local/bin/bun --version), $(sudo -u skech /home/skech/.cargo/bin/cargo --version), caddy $(/usr/local/bin/caddy version | cut -d' ' -f1), serving $DOMAIN"
REMOTE
