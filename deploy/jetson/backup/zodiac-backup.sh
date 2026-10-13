#!/usr/bin/env bash
# zodiac-backup.sh -- encrypted, deduplicated backup of the Jetson's irreplaceable state to a restic
# repository (Google Drive via rclone by default). Run as root, normally from zodiac-backup.timer.
#
#   zodiac-backup.sh init         create the restic repository (once; refuses if it already exists)
#   zodiac-backup.sh [run]        back up, apply retention, record status
#   zodiac-backup.sh snapshots    list snapshots
#   zodiac-backup.sh paths        print what would be backed up (dry run; nothing is read or sent)
#
# What is backed up: secrets and config (/etc/zodiac, ssh and sudo config, udev/NetworkManager/sysctl
# overrides), local state (/var/lib/zodiac: telemetry history, quarantine audit, O3 captures), the Open
# vSwitch testbed (conf.db, kernel-module bypass), the O3 capture-NIC setup, and a text inventory of the
# machine taken at backup time (installed packages, services, network, OVS bridges and flows).
# What is NOT: Ollama models, TensorRT engines, Python virtualenvs, the git checkout, Tailscale state
# (all rebuildable or re-authenticated), and the restic password and rclone config themselves.
set -euo pipefail
export PATH="/usr/local/sbin:/usr/sbin:/sbin:${PATH}"

ENV_FILE="${ZODIAC_BACKUP_ENV:-/etc/zodiac/backup.env}"
ROOT="${ZODIAC_BACKUP_ROOT:-}"          # test hook: prefix for every path ("" on a real machine)
STAGE_BASE="${ZODIAC_BACKUP_STAGE:-${ROOT}/var/backups/zodiac-inventory}"
STATUS_FILE="${ZODIAC_BACKUP_STATUS:-${ROOT}/var/lib/zodiac/backup-status.json}"
TAG="zodiac-jetson"

die() { echo "zodiac-backup: $*" >&2; exit 1; }
log() { echo "zodiac-backup: $*"; }

[ -r "$ENV_FILE" ] || die "missing $ENV_FILE (copy backup.env.template and edit it)"
set -a; . "$ENV_FILE"; set +a
: "${RESTIC_REPOSITORY:?not set in $ENV_FILE}"
: "${RESTIC_PASSWORD_FILE:?not set in $ENV_FILE}"
case "${EXTRA_PATHS:-}" in *\\*) die "EXTRA_PATHS must be space-separated absolute paths without backslashes or spaces inside a path";; esac
KEEP_DAILY="${KEEP_DAILY:-7}"; KEEP_WEEKLY="${KEEP_WEEKLY:-4}"; KEEP_MONTHLY="${KEEP_MONTHLY:-6}"

# --- candidate paths (globs allowed; anything absent is skipped and logged) -----------------------
CANDIDATES=(
  /etc/zodiac
  /var/lib/zodiac
  /etc/openvswitch
  /etc/modprobe.d/openvswitch.conf
  '/etc/systemd/system/zodiac-*'
  '/etc/systemd/system/hailo-*'
  '/etc/udev/rules.d/99-zodiac-*'
  '/etc/udev/rules.d/99-coral-*'
  '/etc/NetworkManager/conf.d/99-zodiac-*'
  /etc/netplan
  /etc/ssh/sshd_config.d
  /etc/default/zodiac-o3-nic
  '/usr/local/sbin/zodiac-*'
  '/etc/sysctl.d/99-*'
  /etc/sudoers.d
  /etc/pam.d/sudo
  /etc/Yubico
  /home/zodiac/.ssh/authorized_keys
  /home/zodiac/.ssh/config
  "$STAGE_BASE"
)
EXCLUDES=(
  --exclude "${ROOT}/etc/zodiac/restic-password"
  --exclude "${ROOT}/etc/zodiac/rclone.conf"
  --exclude '*.pyc' --exclude '__pycache__'
)

resolve_paths() {
  PATHS=()
  local c p matched
  for c in "${CANDIDATES[@]}" ${EXTRA_PATHS:-}; do
    # candidates are absolute; the test hook re-roots them (the stage dir is already rooted)
    case "$c" in "$STAGE_BASE") p="$c" ;; *) p="${ROOT}${c}" ;; esac
    matched=0
    for f in $p; do   # intentional glob expansion
      if [ -e "$f" ]; then PATHS+=("$f"); matched=1; fi
    done
    [ "$matched" = 1 ] || SKIPPED+=("$c")
  done
}

# --- text inventory taken at backup time (best effort; each command may be absent) -----------------
dump() {  # dump <name> <command...>
  local name="$1"; shift
  command -v "$1" >/dev/null 2>&1 || { echo "(not installed: $1)" >"$OUT/$name.txt"; return 0; }
  { "$@"; } >"$OUT/$name.txt" 2>&1 || echo "(exit status $?)" >>"$OUT/$name.txt"
}
take_inventory() {
  TS="$(date -u +%Y%m%dT%H%M%SZ)"; OUT="$STAGE_BASE/$TS"; mkdir -p "$OUT"
  dump uname uname -a
  [ -r /etc/nv_tegra_release ] && cp /etc/nv_tegra_release "$OUT/nv_tegra_release.txt" || true
  dump packages-selected dpkg --get-selections
  dump packages-manual apt-mark showmanual
  dump unit-files systemctl list-unit-files --no-pager
  dump failed-units systemctl --failed --no-pager
  dump ip-addr ip -d addr
  dump ip-route ip route show table all
  dump nmcli-connections nmcli con show
  dump usb-tree lsusb -t
  dump block-devices lsblk -f
  dump disk-usage df -h
  dump ovs-show ovs-vsctl show
  dump ovs-flows-br-sim ovs-ofctl -O OpenFlow13 dump-flows br-sim
  dump ovs-ports-br-sim ovs-ofctl -O OpenFlow13 dump-ports-desc br-sim
  command -v ovsdb-client >/dev/null 2>&1 && \
    ovsdb-client backup unix:/var/run/openvswitch/db.sock Open_vSwitch >"$OUT/ovs-conf.db.backup" 2>/dev/null || true
  dump ollama-models ollama list
  for nic in /sys/class/net/enx*; do
    [ -e "$nic" ] || continue; n="${nic##*/}"
    dump "nic-$n-features" ethtool -k "$n"; dump "nic-$n-qdisc" tc qdisc show dev "$n"
  done
  for v in /home/zodiac/*-venv; do
    [ -x "$v/bin/pip" ] && "$v/bin/pip" freeze >"$OUT/pip-$(basename "$v").txt" 2>&1 || true
  done
  # keep two weeks of staged inventories
  find "$STAGE_BASE" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} + 2>/dev/null || true
}

write_status() {  # write_status <snapshot-id> <warnings>
  mkdir -p "$(dirname "$STATUS_FILE")"
  python3 - "$STATUS_FILE" "$1" "$2" "${#PATHS[@]}" <<'PY'
import json, sys, time
f, snap, warn, npaths = sys.argv[1:5]
with open(f, "w") as fh:
    json.dump({"origin": "backup_run", "last_success_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "snapshot_id": snap, "paths_backed_up": int(npaths), "warnings": warn}, fh, indent=2)
PY
}

cmd="${1:-run}"
SKIPPED=()
command -v restic >/dev/null 2>&1 || [ "$cmd" = paths ] || die "restic is not installed (sudo apt install restic)"

case "$cmd" in
  paths)
    resolve_paths
    printf 'would back up (%d):\n' "${#PATHS[@]}"; printf '  %s\n' "${PATHS[@]:-}"
    printf 'skipped (not present): %d\n' "${#SKIPPED[@]}"; printf '  %s\n' "${SKIPPED[@]:-}" ;;
  init)
    if restic cat config >/dev/null 2>&1; then die "repository already exists at $RESTIC_REPOSITORY (refusing to re-initialize)"; fi
    restic init ;;
  snapshots) restic snapshots --tag "$TAG" ;;
  run)
    [ -n "$ROOT" ] || [ "$(id -u)" -eq 0 ] || die "run as root (it reads /etc and /var/lib)"   # the root check is skipped only in test mode (ZODIAC_BACKUP_ROOT set)
    restic cat config >/dev/null 2>&1 || die "cannot open the repository at $RESTIC_REPOSITORY (run 'init' once, or check the password and rclone config)"
    if command -v flock >/dev/null 2>&1; then   # a manual run must not overlap the timer
      LOCK="${ZODIAC_BACKUP_LOCK:-${ROOT}/var/lock/zodiac-backup.lock}"; mkdir -p "$(dirname "$LOCK")"
      exec 9>"$LOCK"; flock -n 9 || die "another backup run holds $LOCK"
    fi
    take_inventory
    resolve_paths
    [ "${#PATHS[@]}" -gt 0 ] || die "nothing to back up: no candidate path exists"
    [ "${#SKIPPED[@]}" -eq 0 ] || log "skipped (not present): ${SKIPPED[*]}"
    set +e
    restic backup --tag "$TAG" --host "$(hostname -s)" "${EXCLUDES[@]}" "${PATHS[@]}"
    rc=$?
    set -e
    warn=""
    if [ "$rc" -eq 3 ]; then warn="some files could not be read (restic exit 3); a snapshot was still created"; log "$warn"
    elif [ "$rc" -ne 0 ]; then die "restic backup failed (exit $rc)"; fi
    snap="$(restic snapshots --tag "$TAG" --latest 1 --json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d[-1]["short_id"] if d else "")')"
    [ -n "$snap" ] || die "backup reported success but no snapshot is listed"
    # Retention never trims against a degraded run: a partial snapshot must not push complete ones out.
    if [ -n "$warn" ]; then
      log "skipping retention (forget/prune) because this run had warnings"
    elif [ "$(date +%u)" = 7 ]; then
      restic forget --tag "$TAG" --group-by host,tags --keep-daily "$KEEP_DAILY" --keep-weekly "$KEEP_WEEKLY" --keep-monthly "$KEEP_MONTHLY" --prune
    else
      restic forget --tag "$TAG" --group-by host,tags --keep-daily "$KEEP_DAILY" --keep-weekly "$KEEP_WEEKLY" --keep-monthly "$KEEP_MONTHLY"
    fi
    write_status "$snap" "$warn"
    log "ok: snapshot $snap" ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac
