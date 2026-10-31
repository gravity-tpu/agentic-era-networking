#!/usr/bin/env bash
# ==============================================================================
# Zodiac — Persistent Local Telemetry Bridge Tunnel Supervisor (macOS launchd)
# ==============================================================================
# Supervised by macOS launchd (com.zodiac.bridge-tunnel).
# Forwards local port 3003 to the Jetson Orin Nano's Zodiac Bridge server (:3003),
# maintaining persistent operator dashboard access across Mac reboots, sleep/wake,
# and network changes.
#
# Endpoints:
#   http://localhost:3003/          -> Full Zodiac Appliance Dashboard
#   http://localhost:3003/api/zodiac -> Live physical hardware telemetry
#   http://localhost:3003/api/auth/me -> Authenticated local operator session
# ==============================================================================

set -euo pipefail

TARGET_HOST="${TARGET_HOST:-jetson}"
LOCAL_PORT="${LOCAL_PORT:-3003}"
REMOTE_PORT="${REMOTE_PORT:-3003}"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [bridge-tunnel-supervisor] $*"
}

# 1. Wait for Jetson target reachability (accurate timing via $SECONDS)
MAX_WAIT_SECS=30
START_TIME=$SECONDS

while ! ssh -o BatchMode=yes -o ConnectTimeout=2 "${TARGET_HOST}" "true" >/dev/null 2>&1; do
  ELAPSED=$(( SECONDS - START_TIME ))
  if [ "$ELAPSED" -ge "$MAX_WAIT_SECS" ]; then
    log "Target host ${TARGET_HOST} unreachable after ${ELAPSED}s. Sleeping 5s before exit for launchd throttle."
    sleep 5
    exit 1
  fi
  sleep 2
done

log "Target host ${TARGET_HOST} is reachable."

# 2. Clean up any stale local SSH processes holding the target local port
pids=$(lsof -a -ti ":${LOCAL_PORT}" -c ssh 2>/dev/null || true)
if [ -n "$pids" ]; then
  log "Clearing existing SSH process on port ${LOCAL_PORT} (PID: ${pids})..."
  kill -9 $pids 2>/dev/null || true
fi

# 3. Launch persistent SSH port forward
log "Starting persistent SSH tunnel (:${LOCAL_PORT} -> 127.0.0.1:${REMOTE_PORT} on ${TARGET_HOST})..."

set +e
ssh -o BatchMode=yes \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    -o TCPKeepAlive=yes \
    -N \
    -L "${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}" \
    "${TARGET_HOST}"
SSH_EXIT=$?
set -e

log "SSH session terminated with exit code ${SSH_EXIT}. Sleeping 3s before restart."
sleep 3
exit "${SSH_EXIT}"

