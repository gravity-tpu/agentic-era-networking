#!/usr/bin/env bash
# zodiac-backup-restore-drill.sh -- prove the backup restores: restore the latest snapshot into a scratch
# directory, compare critical files against the live copies, and spot-check repository integrity.
# Run monthly (and after any change to the backup). Never writes outside the scratch directory.
#   sudo ./zodiac-backup-restore-drill.sh
set -euo pipefail
export PATH="/usr/local/sbin:/usr/sbin:/sbin:${PATH}"
ENV_FILE="${ZODIAC_BACKUP_ENV:-/etc/zodiac/backup.env}"
ROOT="${ZODIAC_BACKUP_ROOT:-}"
TAG="zodiac-jetson"
die() { echo "restore-drill: FAIL: $*" >&2; exit 1; }
[ -r "$ENV_FILE" ] || die "missing $ENV_FILE"
set -a; . "$ENV_FILE"; set +a
command -v restic >/dev/null || die "restic not installed"
T="$(mktemp -d /var/tmp/zodiac-restore-drill.XXXXXX)"; trap 'rm -rf "$T"' EXIT
restic cat config >/dev/null 2>&1 || die "cannot open the repository"
snap="$(restic snapshots --tag "$TAG" --latest 1 --json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d[-1]["short_id"] if d else "")')"
[ -n "$snap" ] || die "no snapshot with tag $TAG"
echo "restoring snapshot $snap into $T ..."
restic restore "$snap" --target "$T" >/dev/null
files="$(find "$T" -type f | wc -l)"; [ "$files" -gt 0 ] || die "restore produced no files"
echo "  restored $files files"
# compare critical, slow-changing files byte for byte against the live copies
bad=0; checked=0
for f in /etc/zodiac/zodiac-bridge.env /etc/modprobe.d/openvswitch.conf /etc/default/zodiac-o3-nic /etc/ssh/sshd_config.d/00-zodiac-hardening.conf; do
  live="${ROOT}${f}"; rest="${T}${live}"
  [ -e "$live" ] || continue
  checked=$((checked+1))
  if [ ! -e "$rest" ]; then echo "  MISSING in restore: $f"; bad=$((bad+1)); continue; fi
  cmp -s "$live" "$rest" && echo "  identical: $f" || { echo "  DIFFERS: $f (changed since the snapshot, or a bad restore)"; bad=$((bad+1)); }
done
# the inventory dump must be present, and the secrets must NOT be
ls "$T"/"${ROOT}"/var/backups/zodiac-inventory/*/uname.txt >/dev/null 2>&1 || die "no inventory dump in the snapshot"
[ ! -e "${T}${ROOT}/etc/zodiac/restic-password" ] || die "restic-password was backed up (it must be excluded)"
[ ! -e "${T}${ROOT}/etc/zodiac/rclone.conf" ] || die "rclone.conf was backed up (it must be excluded)"
echo "  inventory present; secrets correctly excluded"
echo "integrity spot-check (5% of data) ..."
restic check --read-data-subset=5% >/dev/null 2>&1 || die "restic check failed"
[ "$bad" -eq 0 ] && echo "restore-drill: PASS ($checked critical files compared)" || { echo "restore-drill: DONE WITH DIFFERENCES ($bad of $checked): review above; differences can be legitimate edits since the snapshot"; exit 1; }
