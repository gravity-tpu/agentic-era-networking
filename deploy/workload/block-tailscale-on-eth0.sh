#!/usr/bin/env bash
# Keep Tailscale off the workload interface of a Zodiac workload node (agentic-node-01 / agentic-node-02).
#
# Why: Tailscale advertises every local interface address as a candidate path. A workload node's eth0 (10.0.2.x) and
# the Mac's 10.0.2.119 alias are on the same /24, so the node picks that direct path to the Mac, and its management
# traffic (WireGuard and disco on UDP 41641, packets up to ~1.4 KB) crosses the Zodiac, the device under test, and its
# P3 tap. Measured 2026-10-16: 63 such frames in a 125-frame capture at the tap, the cause of the detector's
# "26 pps" proposals for a source that was only pinging at 5 pps. Dropping UDP 41641 on eth0 makes Tailscale fall back
# to wlan0 or a relay. Test traffic (ping, attacks) is not Tailscale and is not affected.
#
# What this does NOT do: it does not close the other ways a node can reach the lab LAN (wlan0 itself, or the extra
# 10.0.1.50 address on agentic-node-01's eth0). Those are separate roadmap items.
#
# Usage (as root):
#   sudo bash block-tailscale-on-eth0.sh                 install and enable (persists across reboots)
#   bash block-tailscale-on-eth0.sh --dry-run            print the rules and unit it would install; changes nothing
#   sudo bash block-tailscale-on-eth0.sh --uninstall     remove it
# Options: --iface NAME (default eth0)   --port N (Tailscale UDP port, default 41641)
set -euo pipefail

IFACE="eth0"
PORT="41641"
DRY_RUN=0
UNINSTALL=0
TABLE="zodiac_tailscale_block"
RULES_FILE="/etc/zodiac/tailscale-eth0-block.nft"
UNIT_NAME="zodiac-tailscale-eth0-block.service"
UNIT_FILE="/etc/systemd/system/${UNIT_NAME}"

die() { echo "error: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --iface) [ $# -ge 2 ] || die "--iface needs a value"; IFACE="$2"; shift 2 ;;
    --port) [ $# -ge 2 ] || die "--port needs a value"; PORT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

# Both values go into a ruleset and a unit file: accept only what is safe there.
case "$IFACE" in
  ''|*[!A-Za-z0-9_.-]*) die "--iface must be 1 to 15 characters of letters, digits, '.', '_' or '-' (got '${IFACE}')" ;;
esac
[ "${#IFACE}" -le 15 ] || die "--iface is longer than the 15 characters Linux allows"
case "$PORT" in
  ''|*[!0-9]*) die "--port must be a number from 1 to 65535 (got '${PORT}')" ;;
esac
{ [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ]; } || die "--port must be a number from 1 to 65535 (got '${PORT}')"

NFT_BIN="$(command -v nft 2>/dev/null || true)"
[ -n "$NFT_BIN" ] || NFT_BIN="/usr/sbin/nft"

rules() {
  cat <<RULES
# Managed by deploy/workload/block-tailscale-on-eth0.sh. Drops Tailscale's UDP port on the workload interface only.
add table inet ${TABLE}
delete table inet ${TABLE}
table inet ${TABLE} {
  chain input {
    type filter hook input priority -10; policy accept;
    iifname "${IFACE}" udp dport ${PORT} counter drop
  }
  chain output {
    type filter hook output priority -10; policy accept;
    oifname "${IFACE}" udp sport ${PORT} counter drop
  }
}
RULES
}

unit() {
  cat <<UNIT
[Unit]
Description=Keep Tailscale (UDP ${PORT}) off ${IFACE}, the Zodiac workload interface
# Before tailscaled, so the rules exist before it starts probing paths.
Before=tailscaled.service network-pre.target
Wants=network-pre.target
DefaultDependencies=no
After=local-fs.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${NFT_BIN} -f ${RULES_FILE}
ExecStop=${NFT_BIN} delete table inet ${TABLE}

[Install]
WantedBy=multi-user.target
UNIT
}

if [ "$DRY_RUN" -eq 1 ]; then
  echo "# would write ${RULES_FILE}:"
  rules
  echo
  echo "# would write ${UNIT_FILE}:"
  unit
  exit 0
fi

[ "$(id -u)" -eq 0 ] || die "run as root (sudo); use --dry-run to see what would change"
command -v systemctl >/dev/null 2>&1 || die "systemctl not found"
[ -x "$NFT_BIN" ] || die "nft not found (install the nftables package)"

if [ "$UNINSTALL" -eq 1 ]; then
  systemctl disable --now "$UNIT_NAME" 2>/dev/null || true
  "$NFT_BIN" delete table inet "$TABLE" 2>/dev/null || true
  rm -f "$UNIT_FILE" "$RULES_FILE"
  systemctl daemon-reload
  echo "removed ${UNIT_NAME}; Tailscale may use ${IFACE} again"
  exit 0
fi

# Refuse to cut the path this node is managed over: the interface carrying the default route is the one Tailscale
# reaches the internet through.
DEFAULT_IF="$(ip route show default 2>/dev/null | awk '/^default/ {for (i=1;i<=NF;i++) if ($i=="dev") {print $(i+1); exit}}')"
[ "$DEFAULT_IF" != "$IFACE" ] || die "${IFACE} carries this node's default route; blocking Tailscale there would cut management"

mkdir -p "$(dirname "$RULES_FILE")"
rules > "$RULES_FILE"
unit > "$UNIT_FILE"
chmod 644 "$RULES_FILE" "$UNIT_FILE"
systemctl daemon-reload
systemctl enable --now "$UNIT_NAME"

# Prove it is in force, not just written.
LISTED="$("$NFT_BIN" list table inet "$TABLE" 2>&1)" || die "the rules did not load: ${LISTED}"
printf '%s' "$LISTED" | grep -q "udp dport ${PORT}" || die "input rule is missing from the loaded table"
printf '%s' "$LISTED" | grep -q "udp sport ${PORT}" || die "output rule is missing from the loaded table"
echo "installed: UDP ${PORT} is dropped on ${IFACE} (input and output); it persists across reboots."
echo "Tailscale re-probes paths on its own; give it a minute, then check:  tailscale status --json | grep -i curaddr"
echo "Packets dropped so far:  ${NFT_BIN} list table inet ${TABLE}"
