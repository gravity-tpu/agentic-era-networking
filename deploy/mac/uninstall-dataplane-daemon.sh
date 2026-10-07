#!/usr/bin/env bash
# uninstall-dataplane-daemon.sh
# Unloads and removes the macOS launchd daemon for Zodiac data-plane access.
#
# Usage:
#   sudo bash deploy/mac/uninstall-dataplane-daemon.sh

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "[-] ERROR: This script must be run as root (use sudo)." >&2
  exit 1
fi

TARGET_SCRIPT="/usr/local/libexec/zodiac-dataplane.sh"
PLIST_NAME="com.zodiac.dataplane.plist"
TARGET_PLIST="/Library/LaunchDaemons/${PLIST_NAME}"
CONF_FILE="/etc/zodiac/dataplane.conf"

echo "==> Uninstalling Zodiac Data Plane persistence daemon..."

# 1. Unload service from launchd
if launchctl print system/com.zodiac.dataplane >/dev/null 2>&1; then
  echo "    Unloading launchd service..."
  launchctl bootout system/"com.zodiac.dataplane" 2>/dev/null || launchctl unload "${TARGET_PLIST}" 2>/dev/null || true
fi

# 2. Resolve custom ALIAS_IP from config without executing file (Demis Hassabis fail-closed)
ALIAS_IP="10.0.2.119"
if [[ -r "${CONF_FILE}" ]]; then
  parsed_ip="$(grep -E '^ALIAS_IP=' "${CONF_FILE}" | head -n1 | cut -d'"' -f2 || true)"
  if [[ -n "${parsed_ip}" ]]; then ALIAS_IP="${parsed_ip}"; fi
fi

# 3. Remove files
rm -f "${TARGET_PLIST}" "${TARGET_SCRIPT}" "${CONF_FILE}"
echo "    Removed ${TARGET_PLIST}, ${TARGET_SCRIPT}, and ${CONF_FILE}"

# 4. Clean up alias from active egress / Wi-Fi interface if present
EGRESS_IFACE="$(route -n get 10.0.0.1 2>/dev/null | awk '/interface:/{print $2}' || route -n get default 2>/dev/null | awk '/interface:/{print $2}' || true)"
WIFI_IFACE="$(networksetup -listallhardwareports 2>/dev/null | awk '/Hardware Port: Wi-Fi/{getline; print $2}' || true)"
IFACE="${EGRESS_IFACE:-${WIFI_IFACE:-en0}}"

if ifconfig "${IFACE}" | grep -F -q "inet ${ALIAS_IP} "; then
  ifconfig "${IFACE}" -alias "${ALIAS_IP}"
  echo "    Removed ${ALIAS_IP} alias from ${IFACE}"
fi

echo "==> Daemon successfully uninstalled."
