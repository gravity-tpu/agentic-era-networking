#!/usr/bin/env bash
# deploy-hailo-service.sh
# Deploys the FastAPI Hailo-8 Neural Inference Microservice to Raspberry Pi 5.

set -euo pipefail

TARGET_HOST="${1:-10.0.0.179}"
TARGET_USER="${2:-agent}"
REMOTE="${TARGET_USER}@${TARGET_HOST}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "==> Deploying Hailo-8 Inference Microservice to ${REMOTE}..."

# 1. Ensure target directory exists on RPi 5
ssh -o BatchMode=yes "${REMOTE}" "sudo mkdir -p /opt/hailo-service && sudo chown -R ${TARGET_USER}:${TARGET_USER} /opt/hailo-service"

# 2. Sync application files
echo "==> Syncing service files to /opt/hailo-service/..."
rsync -avz --delete \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  "${REPO_ROOT}/services/hailo-inference/" \
  "${REMOTE}:/opt/hailo-service/"

# 3. Copy systemd unit file
echo "==> Installing systemd service unit..."
scp "${REPO_ROOT}/deploy/rpi5/hailo-inference.service" "${REMOTE}:/tmp/hailo-inference.service"
ssh -o BatchMode=yes "${REMOTE}" "sudo mv /tmp/hailo-inference.service /etc/systemd/system/hailo-inference.service && sudo chown root:root /etc/systemd/system/hailo-inference.service && sudo chmod 644 /etc/systemd/system/hailo-inference.service"

# 4. Reload systemd and start service
echo "==> Reloading systemd and restarting hailo-inference.service..."
ssh -o BatchMode=yes "${REMOTE}" "sudo systemctl daemon-reload && sudo systemctl enable hailo-inference.service && sudo systemctl restart hailo-inference.service"

# 5. Wait for service to become ready
echo "==> Verifying service readiness on http://${TARGET_HOST}:8000/health..."
MAX_TRIES=15
READY=0
for i in $(seq 1 ${MAX_TRIES}); do
  if curl -sf "http://${TARGET_HOST}:8000/health" > /dev/null 2>&1; then
    READY=1
    break
  fi
  echo "    Waiting for service... (attempt ${i}/${MAX_TRIES})"
  sleep 1
done

if [ "${READY}" -eq 1 ]; then
  echo "==> SUCCESS! Service is healthy on http://${TARGET_HOST}:8000"
  curl -s "http://${TARGET_HOST}:8000/health" | python3 -m json.tool || true
else
  echo "==> ERROR: Service failed to respond within ${MAX_TRIES} seconds."
  echo "==> Fetching recent journal logs from remote:"
  ssh -o BatchMode=yes "${REMOTE}" "journalctl -u hailo-inference.service -n 30 --no-pager"
  exit 1
fi
