#!/usr/bin/env bash
# sdn-capture-nic.sh
# Puts the RPi 5 USB-Ethernet capture NIC (NETGEAR GS105Ev2 mirror destination)
# into a deterministic capture state and fails closed if it cannot be verified.
#
#   apply  : GRO/LRO off (captured frames match the wire), promiscuous on
#   verify : MAC matches CAPTURE_MAC, GRO/LRO off, promiscuous on, no IP address
#
# Usage: sdn-capture-nic.sh <iface> [apply|verify]    (CAPTURE_MAC from env or /etc/default/sdn-capture-nic)

set -euo pipefail

IFACE="${1:?usage: sdn-capture-nic.sh <iface> [apply|verify]}"
MODE="${2:-apply}"
CAPTURE_ENV="/etc/default/sdn-capture-nic"
# systemd injects CAPTURE_MAC via EnvironmentFile=; load the same root-owned file
# when run by hand so manual `verify` checks the identical configuration.
if [[ -z "${CAPTURE_MAC:-}" && -r "${CAPTURE_ENV}" ]]; then
  # shellcheck source=/dev/null
  source "${CAPTURE_ENV}"
fi
: "${CAPTURE_MAC:?CAPTURE_MAC not set (see ${CAPTURE_ENV})}"

SYS="/sys/class/net/${IFACE}"
want_mac="${CAPTURE_MAC,,}"

fail() { echo "sdn-capture-nic[${IFACE}]: $*" >&2; exit 1; }

# Identity gate: never touch an interface that is not the declared capture NIC
# (e.g. if the kernel renames eth1, or the onboard eth0 is passed by mistake).
[[ -r "${SYS}/address" ]] || fail "interface not present"
have_mac="$(<"${SYS}/address")"
[[ "${have_mac,,}" == "${want_mac}" ]] || fail "MAC ${have_mac} != expected ${want_mac}"

apply() {
  ethtool -K "${IFACE}" gro off lro off
  ip link set dev "${IFACE}" promisc on
}

verify() {
  local feats flags addrs
  feats="$(ethtool -k "${IFACE}")"
  grep -Eq '^generic-receive-offload: off' <<<"${feats}" || fail "GRO is not off"
  grep -Eq '^large-receive-offload: off'   <<<"${feats}" || fail "LRO is not off"

  flags="$(<"${SYS}/flags")"
  (( (flags & 0x100) != 0 )) || fail "promiscuous mode is not set"

  # A capture-only NIC must be address-less: any address means a DHCP/IPv6
  # profile took over and the NIC is now an active host on the workload L2.
  addrs="$(ip -o addr show dev "${IFACE}")"
  [[ -z "${addrs}" ]] || fail "unexpected address on capture NIC: ${addrs}"
}

case "${MODE}" in
  apply)  apply ;;
  verify) verify ;;
  *)      fail "unknown mode '${MODE}' (use apply|verify)" ;;
esac

echo "sdn-capture-nic[${IFACE}]: ${MODE} ok"
