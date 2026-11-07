#!/usr/bin/env bash
# pi5-ingress-test.sh  --  LOCAL helper (gitignored). Run ON the Pi 5 (rpi-hailo) with sudo.
#
# Does NETGEAR switch #1's mirror destination port (P2, where the Pi 5's capture NIC eth1 is cabled)
# accept ingress frames? The Pi 5 is the untrusted adversary node, so this matters.
# It briefly lifts the NIC's egress drop, sends harmless tagged test frames (experimental ethertype 0x88b6),
# and looks for a copy coming back inbound through the P5 mirror. It then restores the egress drop by
# restarting the existing sdn-capture-nic@<iface> unit and verifies it.
#
# Usage: sudo ./pi5-ingress-test.sh [iface=eth1] [--tagged]
set -euo pipefail
export PATH="/usr/local/sbin:/usr/sbin:/sbin:${PATH}"
IFACE="${1:-eth1}"; MODE="${2:-}"; WANT_MAC="a0:ce:c8:0e:73:f7"
die() { echo "pi5-ingress-test: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run with sudo"
for t in tc tcpdump python3 systemctl; do command -v "$t" >/dev/null || die "missing $t"; done
have="$(cat "/sys/class/net/$IFACE/address" 2>/dev/null || true)"
[ "${have,,}" = "$WANT_MAC" ] || die "$IFACE has MAC '$have', expected the capture NIC $WANT_MAC"
/usr/local/sbin/sdn-capture-nic.sh "$IFACE" verify || die "capture NIC is not in its verified state before the test"

send() {  # send <hex-ethertype> <vid-or-none> <tag>
  python3 - "$IFACE" "$@" <<'PY'
import socket, sys
iface, et, vid, tag = sys.argv[1:5]
s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW); s.bind((iface, 0))
src = bytes([0x02,0,0,0,0,0x99])
if vid == "none":
    f = b"\xff"*6 + src + int(et,16).to_bytes(2,"big") + tag.encode().ljust(46, b"\0")
elif vid.startswith("q"):   # double tag: outer ethertype given after q (8100 or 88a8), outer VID 1, inner VID 2
    f = b"\xff"*6 + src + int(vid[1:],16).to_bytes(2,"big") + (1).to_bytes(2,"big") + b"\x81\x00" + (2).to_bytes(2,"big") + int(et,16).to_bytes(2,"big") + tag.encode().ljust(38, b"\0")
else:
    f = b"\xff"*6 + src + b"\x81\x00" + int(vid).to_bytes(2,"big") + int(et,16).to_bytes(2,"big") + tag.encode().ljust(42, b"\0")
s.send(f)
PY
}

echo "pi5-ingress-test: lifting the egress drop on $IFACE for a few seconds; it is restored afterwards."
restore() { systemctl restart "sdn-capture-nic@${IFACE}.service" >/dev/null 2>&1 || true; }
trap restore EXIT
tc qdisc del dev "$IFACE" clsact 2>/dev/null || true
tmp="$(mktemp)"; timeout 7 tcpdump -i "$IFACE" -nn -e -Q in 'ether proto 0x88b6 or ether proto 0x8100 or ether proto 0x88a8' >"$tmp" 2>&1 & tp=$!
sleep 1
for _ in 1 2 3; do send 88b6 none pi5-ingress-test; sleep 0.3; done
if [ "$MODE" = "--tagged" ]; then
  for v in 1 2; do for _ in 1 2 3; do send 88b6 "$v" pi5-ingress-vlan$v; sleep 0.3; done; done
  for o in 8100 88a8; do for _ in 1 2 3; do send 88b6 "q$o" pi5-ingress-qinq-$o; sleep 0.3; done; done
fi
wait "$tp" 2>/dev/null || true
restore; trap - EXIT
/usr/local/sbin/sdn-capture-nic.sh "$IFACE" verify || die "egress drop was NOT restored: run  systemctl restart sdn-capture-nic@${IFACE}.service  and check it"
if grep -q '88b6' "$tmp"; then
  echo "RESULT: a test frame came back through the mirror: switch #1's mirror port ACCEPTS ingress (injection path exists from the Pi 5 capture NIC)."
else
  echo "RESULT: no test frame came back through the mirror: consistent with the mirror port dropping ingress (or isolating it)."
fi
rm -f "$tmp"
