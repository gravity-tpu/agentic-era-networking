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

export PATH="/usr/local/sbin:/usr/sbin:/sbin:${PATH}"

fail() { echo "sdn-capture-nic[${IFACE}]: $*" >&2; exit 1; }

# Identity gate: never touch an interface that is not the declared capture NIC
# (e.g. if the kernel renames eth1, or the onboard eth0 is passed by mistake).
[[ -r "${SYS}/address" ]] || fail "interface not present"
have_mac="$(<"${SYS}/address")"
[[ "${have_mac,,}" == "${want_mac}" ]] || fail "MAC ${have_mac} != expected ${want_mac}"

apply() {
  # Absolute Wire Fidelity (Jacobson Packet Conservation):
  # Disable hardware offloads and scatter-gather so captured frames strictly match physical wire
  ethtool -K "${IFACE}" gro off lro off rx off tx off sg off
  ip link set dev "${IFACE}" promisc on

  # Mirror Port Ingress Injection Prevention (NET-006):
  # Enforce fail-closed kernel egress drop via clsact qdisc. Any raw AF_PACKET transmission
  # attempt on the capture NIC from a compromised untrusted agent is dropped before touching wire.
  tc qdisc replace dev "${IFACE}" clsact
  tc filter replace dev "${IFACE}" egress protocol all pref 1 matchall action drop
}

verify() {
  local feats flags addrs tc_filters
  feats="$(ethtool -k "${IFACE}")"
  grep -Eq '^generic-receive-offload: off' <<<"${feats}" || fail "GRO is not off"
  grep -Eq '^large-receive-offload: off'   <<<"${feats}" || fail "LRO is not off"
  grep -Eq '^rx-checksumming: off'         <<<"${feats}" || fail "RX checksumming is not off"
  grep -Eq '^tx-checksumming: off'         <<<"${feats}" || fail "TX checksumming is not off"
  grep -Eq '^scatter-gather: off'          <<<"${feats}" || fail "Scatter-gather is not off"

  flags="$(<"${SYS}/flags")"
  (( (flags & 0x100) != 0 )) || fail "promiscuous mode is not set"

  # A capture-only NIC must be address-less: any address means a DHCP/IPv6
  # profile took over and the NIC is now an active host on the workload L2.
  addrs="$(ip -o addr show dev "${IFACE}")"
  [[ -z "${addrs}" ]] || fail "unexpected address on capture NIC: ${addrs}"

  # Verify fail-closed kernel egress drop filter is active (NET-006)
  tc_filters="$(tc filter show dev "${IFACE}" egress 2>/dev/null || true)"
  grep -Eq 'action.*drop' <<<"${tc_filters}" || fail "egress drop filter missing on capture NIC"
}

case "${MODE}" in
  apply)  apply ;;
  verify) verify ;;
  *)      fail "unknown mode '${MODE}' (use apply|verify)" ;;
esac

echo "sdn-capture-nic[${IFACE}]: ${MODE} ok"
