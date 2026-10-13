#!/usr/bin/env bash
# test-backup-local.sh -- round-trip test of the backup scripts on ANY machine with restic installed.
# Builds a fake root with secrets and state, backs it up to a local restic repository, runs the restore
# drill, and checks the guarantees that matter: the snapshot exists, secrets are excluded, the inventory
# is present, retention runs, and a second run adds a second snapshot. Touches nothing outside a temp dir.
#   ./test-backup-local.sh
set -euo pipefail
command -v restic >/dev/null || { echo "restic is not installed (brew install restic)"; exit 2; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
R="$W/root"; mkdir -p "$R"/etc/zodiac "$R"/etc/openvswitch "$R"/etc/modprobe.d "$R"/etc/default "$R"/etc/ssh/sshd_config.d "$R"/var/lib/zodiac/history "$R"/var/lib/zodiac/o3-captures
echo "SECRET_KEY=abc"            > "$R/etc/zodiac/zodiac-bridge.env"
echo "do-not-back-me-up"         > "$R/etc/zodiac/restic-password"
echo "token=do-not-back-me-up"   > "$R/etc/zodiac/rclone.conf"
echo '{"t":1}'                   > "$R/var/lib/zodiac/history/2026-10-12.jsonl"
echo "pcap-bytes"                > "$R/var/lib/zodiac/o3-captures/o3-t1.pcap"
echo "ovsdb"                     > "$R/etc/openvswitch/conf.db"
echo "install openvswitch /bin/true" > "$R/etc/modprobe.d/openvswitch.conf"
echo "O3_MAC=aa:bb:cc:dd:ee:ff"  > "$R/etc/default/zodiac-o3-nic"
echo "PasswordAuthentication no" > "$R/etc/ssh/sshd_config.d/00-zodiac-hardening.conf"
echo "testpass" > "$W/pw"
cat > "$W/backup.env" <<EOT
RESTIC_REPOSITORY=$W/repo
RESTIC_PASSWORD_FILE=$W/pw
KEEP_DAILY=7
KEEP_WEEKLY=4
KEEP_MONTHLY=6
EOT
export ZODIAC_BACKUP_ENV="$W/backup.env" ZODIAC_BACKUP_ROOT="$R" ZODIAC_BACKUP_STAGE="$R/var/backups/zodiac-inventory" ZODIAC_BACKUP_STATUS="$R/var/lib/zodiac/backup-status.json"
export RESTIC_REPOSITORY="$W/repo" RESTIC_PASSWORD_FILE="$W/pw"   # for the direct restic calls below; the scripts read backup.env themselves
ok() { echo "  ok: $*"; }; fail() { echo "  FAIL: $*"; exit 1; }
echo "1. paths dry run"; paths_out="$("$HERE/zodiac-backup.sh" paths 2>&1)" || fail "paths exited non-zero: $paths_out"
echo "$paths_out" | grep -q "/etc/zodiac" && ok "lists /etc/zodiac" || fail "paths did not list /etc/zodiac"
echo "2. init"; "$HERE/zodiac-backup.sh" init >/dev/null && ok "repository created"
"$HERE/zodiac-backup.sh" init >/dev/null 2>&1 && fail "second init should refuse" || ok "second init refused"
echo "3. run"; "$HERE/zodiac-backup.sh" run >/dev/null && ok "backup completed"
[ -s "$ZODIAC_BACKUP_STATUS" ] && grep -q '"origin": "backup_run"' "$ZODIAC_BACKUP_STATUS" && ok "status file written" || fail "no status file"
n="$(restic snapshots --json | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"; [ "$n" = 1 ] && ok "1 snapshot" || fail "expected 1 snapshot, got $n"
echo "4. contents"
listing="$(restic ls latest)"
echo "$listing" | grep -q "zodiac-bridge.env" && ok "config backed up" || fail "zodiac-bridge.env missing"
echo "$listing" | grep -q "o3-t1.pcap" && ok "capture backed up" || fail "pcap missing"
echo "$listing" | grep -q "conf.db" && ok "OVS database backed up" || fail "conf.db missing"
echo "$listing" | grep -q "restic-password" && fail "restic-password was backed up" || ok "restic-password excluded"
echo "$listing" | grep -q "rclone.conf" && fail "rclone.conf was backed up" || ok "rclone.conf excluded"
echo "$listing" | grep -q "uname.txt" && ok "inventory dump present" || fail "inventory missing"
echo "5. second run adds a second snapshot"; "$HERE/zodiac-backup.sh" run >/dev/null
n="$(restic snapshots --json | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"; [ "$n" = 2 ] && ok "2 snapshots" || fail "expected 2 snapshots, got $n"
echo "6. restore drill"; "$HERE/zodiac-backup-restore-drill.sh" | tail -3
echo "7. a changed file is reported by the drill"
echo "SECRET_KEY=changed" > "$R/etc/zodiac/zodiac-bridge.env"
"$HERE/zodiac-backup-restore-drill.sh" >/dev/null 2>&1 && fail "drill should report the difference" || ok "drill flagged the changed file"
echo "ALL CHECKS PASSED"
