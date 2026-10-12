#!/usr/bin/env bash
# ==============================================================================
# Zodiac — Persistent NETGEAR Management Tunnel Supervisor (macOS launchd)
# ==============================================================================
# Supervised by macOS launchd (com.zodiac.netgear-tunnels).
# Multiplexes ports 8888 and 8889 over a resilient SSH session to the RPi 5 pivot,
# maintaining persistent operator access across Mac reboots, sleep/wake, and
# Wi-Fi reconnections WITHOUT violating fail-closed isolation (Invariant 3).
#
# Invariant 3 (Fail-Closed Architecture):
#   The Raspberry Pi is an untrusted/adversarial workload node. To prevent standing
#   attack paths to the switch management plane, NO permanent systemd service or
#   standing routes exist on the Pi. Instead, the remote SSH session traps EXIT/INT/TERM/HUP;
#   the moment the Mac disconnects or sleeps, the remote trap on the Pi immediately
#   flushes all temporary routes and IP aliases.
#
# Endpoints:
#   http://localhost:8888/ -> Switch #1 (zodiac_netgear_1 @ 192.168.0.239:80)
#   http://localhost:8889/ -> Switch #2 (zodiac_netgear_2 @ 192.168.0.240:80)
# ==============================================================================

set -euo pipefail

PI_HOST="${PI_HOST:-10.0.0.179}"
PI_USER="${PI_USER:-agent}"

SW1_IP="192.168.0.239"
SW1_MAC="28:94:01:8b:70:d9"
SW1_IFACE="eth0"
SW1_SRC="192.168.0.51"

SW2_IP="192.168.0.240"
SW2_MAC="28:94:01:8b:70:e5"
SW2_IFACE="wlan0"
SW2_SRC="192.168.0.179"

PORT_SW1="8888"
PORT_SW2="8889"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [tunnel-supervisor] $*"
}

# 1. Wait for local network & pivot host reachability (accurate timing via $SECONDS)
MAX_WAIT_SECS=30
START_TIME=$SECONDS

while ! ping -c 1 -W 1000 "${PI_HOST}" >/dev/null 2>&1; do
  ELAPSED=$(( SECONDS - START_TIME ))
  if [ "$ELAPSED" -ge "$MAX_WAIT_SECS" ]; then
    log "Pivot host ${PI_HOST} unreachable after ${ELAPSED}s. Sleeping 5s before exit for launchd throttle."
    sleep 5
    exit 1
  fi
  sleep 2
done

log "Pivot host ${PI_HOST} is reachable."

# 2. Clean up any stale local SSH processes on ports 8888 or 8889
for port in "$PORT_SW1" "$PORT_SW2"; do
  pids=$(lsof -a -ti ":${port}" -c ssh 2>/dev/null || true)
  if [ -n "$pids" ]; then
    log "Clearing existing SSH process on port ${port} (PID: ${pids})..."
    kill -9 $pids 2>/dev/null || true
  fi
done

# 3. Construct remote payload with deterministic EXIT trap (guarantees Invariant 3)
# Remote script:
#   - Injects temporary aliases, routes, and permanent ARP neighbors
#   - Traps EXIT/INT/TERM/HUP to flush routes the moment SSH connection drops
#   - Reads stdin heartbeat with a 25s timeout. If the Mac sleeps or drops Wi-Fi,
#     heartbeats cease, read times out within 25s, and the cleanup trap executes immediately.
REMOTE_PAYLOAD="bash -c '
  cleanup() {
    sudo ip route del ${SW1_IP}/32 dev ${SW1_IFACE} 2>/dev/null || true
    sudo ip neigh del ${SW1_IP} dev ${SW1_IFACE} 2>/dev/null || true
    sudo ip addr del ${SW1_SRC}/24 dev ${SW1_IFACE} 2>/dev/null || true
    sudo ip route del ${SW2_IP}/32 dev ${SW2_IFACE} 2>/dev/null || true
    sudo ip neigh del ${SW2_IP} dev ${SW2_IFACE} 2>/dev/null || true
    sudo ip addr del ${SW2_SRC}/24 dev ${SW2_IFACE} 2>/dev/null || true
  }
  trap cleanup EXIT INT TERM HUP

  sudo ip addr add ${SW1_SRC}/24 dev ${SW1_IFACE} 2>/dev/null || true
  sudo ip route replace ${SW1_IP}/32 dev ${SW1_IFACE} src ${SW1_SRC}
  sudo ip neigh replace ${SW1_IP} lladdr ${SW1_MAC} dev ${SW1_IFACE} nud permanent

  sudo ip addr add ${SW2_SRC}/24 dev ${SW2_IFACE} 2>/dev/null || true
  sudo ip route replace ${SW2_IP}/32 dev ${SW2_IFACE} src ${SW2_SRC}
  sudo ip neigh replace ${SW2_IP} lladdr ${SW2_MAC} dev ${SW2_IFACE} nud permanent

  while read -t 25 -r _line; do
    :
  done
'"

log "Starting trapped multiplexed SSH tunnel (:8888 -> ${SW1_IP}:80, :8889 -> ${SW2_IP}:80)..."

# 4. Launch persistent multiplexed SSH session with local heartbeat stream
# Feeds a heartbeat every 10s down stdin. If Mac sleeps or disconnects, remote read times out.
heartbeat_loop() {
  while true; do
    printf '\n' || break
    sleep 10 || break
  done
}

set +e
heartbeat_loop | ssh -o BatchMode=yes \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    -o TCPKeepAlive=yes \
    -L "${PORT_SW1}:${SW1_IP}:80" \
    -L "${PORT_SW2}:${SW2_IP}:80" \
    "${PI_USER}@${PI_HOST}" \
    "$REMOTE_PAYLOAD"
SSH_EXIT="${PIPESTATUS[1]}"
set -e

log "SSH session terminated with exit code ${SSH_EXIT}. Sleeping 5s before restart."
sleep 5
exit "${SSH_EXIT}"
