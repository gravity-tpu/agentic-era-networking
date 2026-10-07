#!/usr/bin/env bash
# install-dataplane-daemon.sh
# Installs and activates the persistent macOS launchd daemon for Zodiac data-plane access.
#
# Usage:
#   sudo bash deploy/mac/install-dataplane-daemon.sh

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "[-] ERROR: This script must be run as root (use sudo)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_SCRIPT="/usr/local/libexec/zodiac-dataplane.sh"
PLIST_NAME="com.zodiac.dataplane.plist"
TARGET_PLIST="/Library/LaunchDaemons/${PLIST_NAME}"

echo "==> Installing Zodiac Data Plane persistence daemon..."

# 1. Stage helper script
mkdir -p /usr/local/libexec
install -o root -g wheel -m 0755 "${SCRIPT_DIR}/zodiac-dataplane.sh" "${TARGET_SCRIPT}"
echo "    Installed helper script to ${TARGET_SCRIPT}"

# 2. Stage launchd plist
# Unload previous service if currently running
if launchctl list | grep -q "com.zodiac.dataplane"; then
  echo "    Unloading existing launchd service..."
  launchctl bootout system/"com.zodiac.dataplane" 2>/dev/null || launchctl unload "${TARGET_PLIST}" 2>/dev/null || true
fi

install -o root -g wheel -m 0644 "${SCRIPT_DIR}/${PLIST_NAME}" "${TARGET_PLIST}"
echo "    Installed launchd plist to ${TARGET_PLIST}"

# 3. Load service into launchd
echo "    Loading service into launchd..."
if ! launchctl bootstrap system "${TARGET_PLIST}" 2>/dev/null; then
  # Fallback for older macOS versions
  launchctl load -w "${TARGET_PLIST}"
fi

# 4. Trigger initial execution
echo "    Triggering initial network configuration..."
"${TARGET_SCRIPT}"

# 5. Verification
WIFI_IFACE="$(networksetup -listallhardwareports 2>/dev/null | awk '/Hardware Port: Wi-Fi/{getline; print $2}')"
IFACE="${WIFI_IFACE:-en0}"

echo "==> Verifying configuration on ${IFACE}..."
if ifconfig "${IFACE}" | grep -q "inet 10.0.2.119 "; then
  echo "    [+] SUCCESS: Alias 10.0.2.119 active on ${IFACE}."
else
  echo "    [!] Note: 10.0.2.119 not yet bound (ensure you are connected to Lab Wi-Fi 10.0.0.0/24)."
fi

echo "==> Status of launchd service:"
launchctl list | grep "com.zodiac.dataplane" || echo "    Service queued in launchd."

echo "==> Installation complete! Data-plane alias is persistent across reboots and disconnects."
