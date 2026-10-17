#!/usr/bin/env bash
# deploy-rpi3-service.sh
# Deploys the lightweight telemetry daemon to Raspberry Pi 3B+ nodes.
# Usage: ./deploy-rpi3-service.sh [TARGET_HOST] [TARGET_USER]

set -euo pipefail

TARGET_HOST="${1:-10.0.0.45}"
TARGET_USER="${2:-agent}"
REMOTE="${TARGET_USER}@${TARGET_HOST}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "==> Deploying RPi 3 Telemetry Daemon to ${REMOTE}..."

# 1. Create target directories on remote node
ssh -o ConnectTimeout=5 -o BatchMode=yes "${REMOTE}" "mkdir -p ~/rpi3-telemetry ~/.config/systemd/user"

# 2. Sync telemetry server script
echo "==> Syncing telemetry_server.py..."
scp -o ConnectTimeout=5 -o BatchMode=yes \
  "${REPO_ROOT}/services/rpi3-telemetry/telemetry_server.py" \
  "${REMOTE}:~/rpi3-telemetry/telemetry_server.py"

# 3. Copy systemd user service unit
echo "==> Installing systemd user unit..."
scp -o ConnectTimeout=5 -o BatchMode=yes \
  "${REPO_ROOT}/deploy/rpi3/rpi3-telemetry.service" \
  "${REMOTE}:~/.config/systemd/user/rpi3-telemetry.service"

# 4. Enable user lingering and reload systemd user daemon
echo "==> Enabling linger and starting service..."
ssh -o ConnectTimeout=5 -o BatchMode=yes "${REMOTE}" bash -s << 'EOF'
set -euo pipefail
loginctl enable-linger 2>/dev/null || true
systemctl --user daemon-reload
systemctl --user enable rpi3-telemetry.service
systemctl --user restart rpi3-telemetry.service
EOF

# 5. Verify local health check on remote host
echo "==> Verifying service responsiveness on ${TARGET_HOST}:8001..."
MAX_TRIES=10
READY=0
for i in $(seq 1 ${MAX_TRIES}); do
  if ssh -o ConnectTimeout=3 -o BatchMode=yes "${REMOTE}" "curl -sf http://127.0.0.1:8001/health > /dev/null 2>&1"; then
    READY=1
    break
  fi
  echo "    Waiting for service... (attempt ${i}/${MAX_TRIES})"
  sleep 1
done

if [ "${READY}" -eq 1 ]; then
  echo "==> SUCCESS! Service is active and responding on ${REMOTE}:8001"
  ssh -o ConnectTimeout=3 -o BatchMode=yes "${REMOTE}" "curl -s http://127.0.0.1:8001/health"
  echo ""
else
  echo "==> ERROR: Service failed to respond within ${MAX_TRIES} seconds."
  ssh -o ConnectTimeout=3 -o BatchMode=yes "${REMOTE}" "systemctl --user status rpi3-telemetry.service --no-pager"
  exit 1
fi
