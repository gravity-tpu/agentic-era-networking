#!/usr/bin/env bash
# zodiac-dataplane.sh
# macOS Network Persistence Helper for Zodiac / Hailo-8 Data Plane (10.0.2.0/24).
# Automatically manages the on-link 10.0.2.119/24 IP alias on the primary Wi-Fi
# interface whenever attached to the Lab LAN (10.0.0.0/24).

set -euo pipefail

ALIAS_IP="10.0.2.119"
NETMASK="255.255.255.0"
LAB_SUBNET_PREFIX="10.0.0."

# 1. Dynamically locate primary Wi-Fi interface (fallback to en0)
WIFI_IFACE="$(networksetup -listallhardwareports 2>/dev/null | awk '/Hardware Port: Wi-Fi/{getline; print $2}')"
IFACE="${WIFI_IFACE:-en0}"

# 2. Check if interface exists and is up
if ! ifconfig "${IFACE}" >/dev/null 2>&1; then
  exit 0
fi

# 3. Environment fence: Only activate when connected to the Lab LAN (10.0.0.0/24)
# Prevents subnet contamination when connected to external Wi-Fi or hotspots.
if ! ifconfig "${IFACE}" | grep -q "inet ${LAB_SUBNET_PREFIX}"; then
  # If we have an alias active while not on lab Wi-Fi, remove it
  if ifconfig "${IFACE}" | grep -q "inet ${ALIAS_IP} "; then
    ifconfig "${IFACE}" -alias "${ALIAS_IP}" >/dev/null 2>&1 || true
    echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Removed ${ALIAS_IP} from ${IFACE} (disconnected from Lab LAN)"
  fi
  exit 0
fi

# 4. Remove any stale/bogus gateway route pointing to 10.0.0.1 for 10.0.2.0/24
# (Gateway routing sends packets to router MAC instead of broadcasting ARP on-link)
if netstat -rn -f inet | grep -q '10.0.2/24.*10.0.0.1'; then
  route delete -net 10.0.2.0/24 10.0.0.1 >/dev/null 2>&1 || true
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Cleared invalid 10.0.0.1 gateway route for 10.0.2.0/24"
fi

# 5. Apply alias if missing
if ! ifconfig "${IFACE}" | grep -q "inet ${ALIAS_IP} "; then
  ifconfig "${IFACE}" alias "${ALIAS_IP}" "${NETMASK}"
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Configured alias ${ALIAS_IP} on ${IFACE}"
fi

# 6. Ensure direct on-link route exists for 10.0.2.0/24 via interface
if ! netstat -rn -f inet | grep -E '^10.0.2/24.*link#' >/dev/null 2>&1; then
  route add -net 10.0.2.0/24 -interface "${IFACE}" >/dev/null 2>&1 || true
fi
