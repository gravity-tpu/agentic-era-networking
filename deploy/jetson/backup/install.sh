#!/usr/bin/env bash
# install.sh -- install the backup scripts and units on the Jetson. Does NOT create secrets, does NOT
# start a backup, and does NOT enable the timer unless asked.
#   sudo ./install.sh [--enable-timer]
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for t in restic rclone; do
  command -v "$t" >/dev/null || { echo "installing $t ..."; apt-get install -y "$t"; }
done
install -d -m 0750 /etc/zodiac /var/backups/zodiac-inventory
install -m 0755 "$HERE/zodiac-backup.sh" "$HERE/zodiac-backup-inventory.sh" "$HERE/zodiac-backup-restore-drill.sh" /usr/local/sbin/
install -m 0644 "$HERE/zodiac-backup.service" "$HERE/zodiac-backup.timer" "$HERE/zodiac-backup-failed.service" /etc/systemd/system/
[ -e /etc/zodiac/backup.env ] || install -m 0640 "$HERE/backup.env.template" /etc/zodiac/backup.env
systemctl daemon-reload
echo "installed. Next (see README.md): 1) rclone config for Drive  2) create /etc/zodiac/restic-password  3) zodiac-backup.sh init  4) a first manual run  5) the restore drill"
if [ "${1:-}" = "--enable-timer" ]; then
  [ -s /etc/zodiac/restic-password ] || { echo "refusing to enable the timer: /etc/zodiac/restic-password is missing" >&2; exit 1; }
  systemctl enable --now zodiac-backup.timer; systemctl list-timers zodiac-backup.timer --no-pager
fi
