#!/usr/bin/env bash
# deploy-capture-nic.sh
# Installs the persistent capture-NIC configuration on the Raspberry Pi 5:
# udev rule (by MAC) -> sdn-capture-nic@<iface>.service -> sdn-capture-nic.sh.
#
# Usage: deploy-capture-nic.sh [host] [user] [capture-mac]

set -euo pipefail

TARGET_HOST="${1:-10.0.0.179}"
TARGET_USER="${2:-agent}"
CAPTURE_MAC="${3:-a0:ce:c8:0e:73:f7}"
REMOTE="${TARGET_USER}@${TARGET_HOST}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="${REPO_ROOT}/deploy/rpi5"

CAPTURE_MAC="$(tr '[:upper:]' '[:lower:]' <<<"${CAPTURE_MAC}")"
if ! [[ "${CAPTURE_MAC}" =~ ^([0-9a-f]{2}:){5}[0-9a-f]{2}$ ]]; then
  echo "ERROR: '${CAPTURE_MAC}' is not a valid MAC address" >&2
  exit 2
fi

echo "==> Installing capture-NIC persistence on ${REMOTE} (MAC ${CAPTURE_MAC})..."

# 1. Stage files
scp "${SRC}/sdn-capture-nic.sh" "${SRC}/sdn-capture-nic@.service" "${SRC}/99-sdn-capture-nic.rules.in" "${REMOTE}:/tmp/"

# 2. Install (MAC is validated above, so safe to interpolate)
ssh -o BatchMode=yes "${REMOTE}" "set -euo pipefail
sudo install -o root -g root -m 0755 /tmp/sdn-capture-nic.sh /usr/local/sbin/sdn-capture-nic.sh
sudo install -o root -g root -m 0644 /tmp/sdn-capture-nic@.service /etc/systemd/system/sdn-capture-nic@.service
echo 'CAPTURE_MAC=${CAPTURE_MAC}' | sudo tee /etc/default/sdn-capture-nic >/dev/null
sudo chmod 0644 /etc/default/sdn-capture-nic
sed 's/@CAPTURE_MAC@/${CAPTURE_MAC}/' /tmp/99-sdn-capture-nic.rules.in | sudo tee /etc/udev/rules.d/99-sdn-capture-nic.rules >/dev/null
rm -f /tmp/sdn-capture-nic.sh /tmp/sdn-capture-nic@.service /tmp/99-sdn-capture-nic.rules.in
sudo systemctl daemon-reload
sudo udevadm control --reload"

# 3. Apply now by re-triggering the add event for the capture NIC
echo "==> Triggering udev for ${CAPTURE_MAC}..."
ssh -o BatchMode=yes "${REMOTE}" "sudo udevadm trigger --action=add --subsystem-match=net --attr-match=address=${CAPTURE_MAC}"

# 4. Verify: the unit must be active for the interface that owns this MAC
echo "==> Verifying..."
ssh -o BatchMode=yes "${REMOTE}" "set -euo pipefail
IFACE=\$(grep -il '${CAPTURE_MAC}' /sys/class/net/*/address | head -n1 | cut -d/ -f5)
[ -n \"\$IFACE\" ] || { echo 'ERROR: no interface with MAC ${CAPTURE_MAC}' >&2; exit 1; }
for i in 1 2 3 4 5 6 7 8 9 10; do
  systemctl is-active --quiet sdn-capture-nic@\$IFACE.service && break
  sleep 1
done
systemctl is-active --quiet sdn-capture-nic@\$IFACE.service || {
  echo \"ERROR: sdn-capture-nic@\$IFACE.service is not active\" >&2
  journalctl -u sdn-capture-nic@\$IFACE.service -n 20 --no-pager >&2
  exit 1
}
echo \"==> SUCCESS: \$IFACE configured (promisc, GRO/LRO off, address-less)\"
ip -d link show dev \$IFACE | head -n 3"
