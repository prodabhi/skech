#!/usr/bin/env bash
# Copy the relayer's state files (bets placed and not yet settled, per cluster and game) into a timestamped
# directory, and keep the newest $SKECH_BACKUP_KEEP of them. skech-backup.timer runs it every 15 minutes;
# setup.sh installs it as /usr/local/sbin/skech-backup-relayer, so by hand: sudo skech-backup-relayer.
#
#   SKECH_BACKUP_DIR    where to     /var/backups/skech-relayer
#   SKECH_BACKUP_KEEP   how many     672 (a week, every 15 minutes)
#   SKECH_BACKUP_S3     optional: s3://bucket/prefix, also copied there with the aws CLI and the instance's role
#
# Set them in /etc/skech/backup.env. A copy on the same disk survives a bad deploy or a deleted file, not the
# box: for that, set SKECH_BACKUP_S3.
set -euo pipefail
SRC="${RELAYER_STATE_DIR:-/var/lib/skech-relayer}"
DEST="${SKECH_BACKUP_DIR:-/var/backups/skech-relayer}"
KEEP="${SKECH_BACKUP_KEEP:-672}"
S3="${SKECH_BACKUP_S3:-}"

shopt -s nullglob
files=("$SRC"/.relayer-state.*.json)
if [ ${#files[@]} -eq 0 ]; then
  echo "nothing to back up in $SRC"
  exit 0
fi

umask 077
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$DEST/$stamp"
for f in "${files[@]}"; do
  # The relayer rewrites its file every few seconds, in place: a copy caught mid-write does not parse. Try again.
  for _ in 1 2 3 4 5; do
    cp --preserve=timestamps "$f" "$DEST/$stamp/"
    python3 -c 'import json, sys; json.load(open(sys.argv[1]))' "$DEST/$stamp/$(basename "$f")" 2>/dev/null && continue 2
    sleep 1
  done
  echo "$f did not parse in five tries; kept the last copy anyway" >&2
done

# Newest first; everything past the newest $KEEP goes. The names sort by time.
find "$DEST" -mindepth 1 -maxdepth 1 -type d -name '20*Z' | sort -r | tail -n +"$((KEEP + 1))" | xargs -r rm -rf --

if [ -n "$S3" ]; then
  aws s3 cp --recursive --only-show-errors "$DEST/$stamp" "${S3%/}/$stamp/"
fi
echo "backed up ${#files[@]} file(s) to $DEST/$stamp${S3:+ and ${S3%/}/$stamp}"
