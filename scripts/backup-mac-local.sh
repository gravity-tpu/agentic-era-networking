#!/usr/bin/env bash
# backup-mac-local.sh -- back up the operator Mac's gitignored, single-copy files to a SEPARATE restic
# repository on Google Drive (via rclone). These files exist nowhere else: they are not in git.
#
#   scripts/backup-mac-local.sh init        create the repository (once)
#   scripts/backup-mac-local.sh [run]       back up and apply retention
#   scripts/backup-mac-local.sh snapshots   list snapshots
#   scripts/backup-mac-local.sh paths       show what exists and would be backed up (nothing is sent)
#
# Needs: brew install restic rclone; an rclone remote named "gdrive" (see deploy/jetson/backup/README.md);
# the restic password in the macOS Keychain:  security add-generic-password -a "$USER" -s zodiac-restic-mac -w
# (keep a second copy of that password in your password manager: without it the backup is unreadable).
# The rclone config (it holds the Drive token) and the Drive token itself are deliberately NOT backed up.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-rclone:gdrive:zodiac-mac-local-backup}"
export RESTIC_PASSWORD_COMMAND="${RESTIC_PASSWORD_COMMAND:-security find-generic-password -s zodiac-restic-mac -w}"
TAG="zodiac-mac-local"
CANDIDATES=(
  "$REPO_ROOT/.env.local" "$REPO_ROOT/.env"
  "$REPO_ROOT/.agents/devices.local.md" "$REPO_ROOT/.agents/local"
  "$HOME/.ssh/config" "$HOME/.ssh/known_hosts"
  "$HOME/o3-captures"
)
die() { echo "backup-mac-local: $*" >&2; exit 1; }
PATHS=(); for c in "${CANDIDATES[@]}"; do [ -e "$c" ] && PATHS+=("$c"); done
cmd="${1:-run}"
case "$cmd" in
  paths)
    echo "would back up (${#PATHS[@]}):"; for p in "${PATHS[@]}"; do printf '  %-70s %s\n' "$p" "$(du -sh "$p" 2>/dev/null | cut -f1)"; done
    echo "absent (skipped):"; for c in "${CANDIDATES[@]}"; do [ -e "$c" ] || echo "  $c"; done ;;
  init) command -v restic >/dev/null || die "brew install restic rclone"
        restic cat config >/dev/null 2>&1 && die "repository already exists (refusing to re-initialize)"; restic init ;;
  snapshots) restic snapshots --tag "$TAG" ;;
  run)
    command -v restic >/dev/null || die "brew install restic rclone"
    [ "${#PATHS[@]}" -gt 0 ] || die "nothing to back up"
    restic cat config >/dev/null 2>&1 || die "cannot open the repository (run init once, or check the Keychain password and the rclone remote)"
    restic backup --tag "$TAG" --host "$(hostname -s)" "${PATHS[@]}"
    if [ "$(date +%u)" = 7 ]; then P="--prune"; else P=""; fi
    # shellcheck disable=SC2086
    restic forget --tag "$TAG" --group-by host,tags --keep-daily 7 --keep-weekly 4 --keep-monthly 12 $P
    echo "backup-mac-local: ok" ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
