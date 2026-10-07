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

echo "==> Uninstalling Zodiac Data Plane persistence daemon..."

# 1. Unload service from launchd
if launchctl list | grep -q "com.zodiac.dataplane"; then
  echo "    Unloading launchd service..."
  launchctl bootout system/"com.zodiac.dataplane" 2>/dev/null || launchctl unload "${TARGET_PLIST}" 2>/dev/null || true
fi

# 2. Remove files
rm -f "${TARGET_PLIST}" "${TARGET_SCRIPT}"
echo "    Removed ${TARGET_PLIST} and ${TARGET_SCRIPT}"

# 3. Clean up alias from active Wi-Fi interface if present
WIFI_IFACE="$(networksetup -listallhardwareports 2>/dev/null | awk '/Hardware Port: Wi-Fi/{getline; print $2}')"
IFACE="${WIFI_IFACE:-en0}"

if ifconfig "${IFACE}" | grep -q "inet 10.0.2.119 "; then
  ifconfig "${IFACE}" -alias 10.0.2.119 >/dev/null 2>&1 || true
  echo "    Removed 10.0.2.119 alias from ${IFACE}"
fi

echo "==> Daemon successfully uninstalled."
