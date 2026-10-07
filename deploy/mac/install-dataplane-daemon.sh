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
CONF_DIR="/etc/zodiac"
CONF_FILE="${CONF_DIR}/dataplane.conf"

echo "==> Installing Zodiac Data Plane persistence daemon..."

# 1. Stage configuration directory and default config file (strict root permissions)
install -d -o root -g wheel -m 0755 "${CONF_DIR}"
if [[ ! -f "${CONF_FILE}" ]]; then
  cat <<'EOF' > "${CONF_FILE}"
# Zodiac macOS Data-Plane Configuration
ALIAS_IP="10.0.2.119"
NETMASK="255.255.255.0"
EOF
  chown root:wheel "${CONF_FILE}"
  chmod 0644 "${CONF_FILE}"
  echo "    Created default configuration at ${CONF_FILE}"
fi

# 2. Stage helper script
mkdir -p /usr/local/libexec
install -o root -g wheel -m 0755 "${SCRIPT_DIR}/zodiac-dataplane.sh" "${TARGET_SCRIPT}"
echo "    Installed helper script to ${TARGET_SCRIPT}"

# 3. Stage launchd plist
if launchctl print system/com.zodiac.dataplane >/dev/null 2>&1; then
  echo "    Unloading existing launchd service..."
  launchctl bootout system/"com.zodiac.dataplane" 2>/dev/null || launchctl unload "${TARGET_PLIST}" 2>/dev/null || true
fi

install -o root -g wheel -m 0644 "${SCRIPT_DIR}/${PLIST_NAME}" "${TARGET_PLIST}"
echo "    Installed launchd plist to ${TARGET_PLIST}"

# 4. Load service into launchd
echo "    Loading service into launchd..."
if ! launchctl bootstrap system "${TARGET_PLIST}" 2>/dev/null; then
  # Fallback for older macOS versions
  launchctl load -w "${TARGET_PLIST}"
fi

# 5. Trigger initial execution
echo "    Triggering initial network configuration..."
"${TARGET_SCRIPT}"

# 6. Verification
ALIAS_IP="10.0.2.119"
if [[ -r "${CONF_FILE}" ]]; then
  parsed_ip="$(grep -E '^ALIAS_IP=' "${CONF_FILE}" | head -n1 | cut -d'"' -f2 || true)"
  if [[ -n "${parsed_ip}" ]]; then ALIAS_IP="${parsed_ip}"; fi
fi

EGRESS_IFACE="$(route -n get 10.0.0.1 2>/dev/null | awk '/interface:/{print $2}' || route -n get default 2>/dev/null | awk '/interface:/{print $2}' || true)"
WIFI_IFACE="$(networksetup -listallhardwareports 2>/dev/null | awk '/Hardware Port: Wi-Fi/{getline; print $2}' || true)"
IFACE="${EGRESS_IFACE:-${WIFI_IFACE:-en0}}"

echo "==> Verifying configuration on ${IFACE}..."
if ifconfig "${IFACE}" | grep -F -q "inet ${ALIAS_IP} "; then
  echo "    [+] SUCCESS: Alias ${ALIAS_IP} active on ${IFACE}."
else
  echo "    [!] Note: ${ALIAS_IP} not yet bound (ensure you are connected to Lab Wi-Fi 10.0.0.0/24)."
fi

echo "==> Status of launchd service:"
launchctl list | grep "com.zodiac.dataplane" || echo "    Service queued in launchd."

echo "==> Installation complete! Data-plane alias is persistent across reboots and disconnects."
