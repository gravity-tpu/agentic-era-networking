#!/usr/bin/env bash
# zodiac-dataplane.sh
# macOS Network Persistence Helper for Zodiac / Hailo-8 Data Plane (10.0.2.0/24).
# Automatically manages the on-link 10.0.2.119/24 IP alias on the primary egress
# interface whenever attached to the Lab LAN (10.0.0.0/24).

set -euo pipefail

CONF_FILE="/etc/zodiac/dataplane.conf"
if [[ -r "${CONF_FILE}" ]]; then
  # shellcheck source=/dev/null
  source "${CONF_FILE}"
fi

ALIAS_IP="${ALIAS_IP:-10.0.2.119}"
NETMASK="${NETMASK:-255.255.255.0}"
LAB_GW="10.0.0.1"

log() {
  local msg="zodiac-dataplane: $*"
  logger -t zodiac-dataplane -p daemon.info "${msg}"
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] ${msg}"
}

err() {
  local msg="zodiac-dataplane ERROR: $*"
  logger -t zodiac-dataplane -p daemon.err "${msg}"
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] ${msg}" >&2
}

# 1. Egress Interface Resolution: dynamically resolve interface reaching lab gateway
EGRESS_IFACE="$(route -n get "${LAB_GW}" 2>/dev/null | awk '/interface:/{print $2}' || true)"
WIFI_IFACE="$(networksetup -listallhardwareports 2>/dev/null | awk '/Hardware Port: Wi-Fi/{getline; print $2}' || true)"
IFACE="${EGRESS_IFACE:-${WIFI_IFACE:-en0}}"

# 2. Check if interface exists
if ! ifconfig "${IFACE}" >/dev/null 2>&1; then
  exit 0
fi

# 3. Cache interface configuration and routing table (subshell elimination)
IFACE_CONFIG="$(ifconfig "${IFACE}")"
ROUTES_CONFIG="$(netstat -rn -f inet)"

# 4. Strict Subnet Environment Fence (Council Invariant 3 & Quoc Le heuristic audit):
# Only activate when connected to the trusted Lab LAN (10.0.0.0/24).
# Matches exact boundary 'inet 10.0.0.<1-3 digits> netmask 0xffffff00'
if ! grep -E -q 'inet 10\.0\.0\.[0-9]+ netmask 0xffffff00' <<<"${IFACE_CONFIG}"; then
  # If an alias remains while disconnected from Lab LAN, strip it to prevent leakage
  if grep -E -q "inet ${ALIAS_IP} " <<<"${IFACE_CONFIG}"; then
    ifconfig "${IFACE}" -alias "${ALIAS_IP}"
    log "Removed ${ALIAS_IP} from ${IFACE} (disconnected from Lab LAN)"
  fi
  exit 0
fi

# 5. Routing Table Cleansing: Remove stale/bogus gateway route pointing to 10.0.0.1
# (Gateway routing sends packets to router MAC instead of broadcasting ARP on-link)
if grep -E -q '10\.0\.2/24[[:space:]]+10\.0\.0\.1' <<<"${ROUTES_CONFIG}"; then
  route -n delete -net 10.0.2.0/24 10.0.0.1
  log "Cleared invalid 10.0.0.1 gateway route for 10.0.2.0/24"
  ROUTES_CONFIG="$(netstat -rn -f inet)"
fi

# 6. Apply alias if missing
if ! grep -E -q "inet ${ALIAS_IP} " <<<"${IFACE_CONFIG}"; then
  ifconfig "${IFACE}" alias "${ALIAS_IP}" "${NETMASK}"
  log "Configured alias ${ALIAS_IP} on ${IFACE}"
  ROUTES_CONFIG="$(netstat -rn -f inet)"
fi

# 7. Ensure direct on-link route exists for 10.0.2.0/24 via interface (Council Invariant 1: Zero Suppression)
if ! grep -E -q '^10\.0\.2/24[[:space:]]+link#' <<<"${ROUTES_CONFIG}"; then
  route add -net 10.0.2.0/24 -interface "${IFACE}"
  log "Installed direct on-link route for 10.0.2.0/24 on ${IFACE}"
fi
