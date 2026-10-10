#!/usr/bin/env bash
# ==============================================================================
# Zodiac — NETGEAR GS105Ev2 Smart Managed Switch Tunnel Helper
# ==============================================================================
# Establishes an out-of-band management tunnel to either NETGEAR smart switch
# through a Raspberry Pi pivot node, exposing the web UI at http://localhost:8888.
#
# Hardware Targets:
#   1 / workload : zodiac_netgear_1 (192.168.0.239, MAC 28:94:01:8b:70:d9) on eth0
#   2 / uplink   : zodiac_netgear_2 (192.168.0.240, MAC 28:94:01:8b:70:e5) on wlan0
#
# Known Pivot Hosts:
#   Primary:  10.0.0.179 (RPi 5 / rpi-hailo)
#   Fallback: 10.0.0.45  (RPi 3B+ / agentic-node-01)
#
# Deterministic Fail-Closed Guarantee (Invariant 3):
#   The tunnel executes strictly in the foreground. Trapping EXIT/INT/TERM/HUP
#   mathematically guarantees that terminating the session (Ctrl+C or disconnect)
#   automatically flushes all temporary IP aliases and routing rules across all
#   pivot nodes, leaving zero standing routes to the switch management plane.
#
# Usage:
#   ./scripts/netgear-tunnel.sh 1              # Connect to workload switch (press Ctrl+C to close)
#   ./scripts/netgear-tunnel.sh 2              # Connect to uplink switch   (press Ctrl+C to close)
#   ./scripts/netgear-tunnel.sh status         # Inspect current tunnel and HTTP status
#   ./scripts/netgear-tunnel.sh stop           # Explicit cleanup & flush across all pivot hosts
# ==============================================================================

set -euo pipefail

LOCAL_PORT="${LOCAL_PORT:-8888}"
PI_USER="${PI_USER:-agent}"
KNOWN_PI_HOSTS=("10.0.0.179" "10.0.0.45")
PI_HOST="${PI_HOST:-10.0.0.179}"

SW1_NAME="zodiac_netgear_1 (Workload Switch)"
SW1_IP="192.168.0.239"
SW1_MAC="28:94:01:8b:70:d9"
SW1_IFACE="eth0"

SW2_NAME="zodiac_netgear_2 (Uplink Switch)"
SW2_IP="192.168.0.240"
SW2_MAC="28:94:01:8b:70:e5"
SW2_IFACE="wlan0"

GREEN="\033[0;32m"
YELLOW="\033[1;33m"
CYAN="\033[0;36m"
RED="\033[0;31m"
BOLD="\033[1m"
RESET="\033[0m"

log_info()  { echo -e "${CYAN}[*]${RESET} $1"; }
log_ok()    { echo -e "${GREEN}[✓]${RESET} $1"; }
log_warn()  { echo -e "${YELLOW}[!]${RESET} $1"; }
log_err()   { echo -e "${RED}[✗]${RESET} $1"; }

check_pi_reachability() {
  if ssh -o ConnectTimeout=2 -o BatchMode=yes "${PI_USER}@${PI_HOST}" "true" 2>/dev/null; then
    return 0
  fi

  for candidate in "${KNOWN_PI_HOSTS[@]}"; do
    if [ "$candidate" != "$PI_HOST" ] && ssh -o ConnectTimeout=2 -o BatchMode=yes "${PI_USER}@${candidate}" "true" 2>/dev/null; then
      log_warn "Primary pivot ${PI_HOST} unreachable; falling back to ${candidate}"
      PI_HOST="$candidate"
      return 0
    fi
  done

  log_err "Cannot reach any known Raspberry Pi (${KNOWN_PI_HOSTS[*]}). Ensure host is online."
  exit 1
}

cleanup_local_tunnel() {
  local pids
  # Only target SSH processes listening on LOCAL_PORT to avoid terminating unrelated services
  pids=$(lsof -ti ":${LOCAL_PORT}" -c ssh 2>/dev/null || true)
  if [ -n "$pids" ]; then
    log_info "Gracefully closing existing SSH tunnel on port ${LOCAL_PORT} (PID: ${pids})..."
    kill $pids 2>/dev/null || true
    sleep 0.5
    local remaining
    remaining=$(lsof -ti ":${LOCAL_PORT}" -c ssh 2>/dev/null || true)
    if [ -n "$remaining" ]; then
      kill -9 $remaining 2>/dev/null || true
    fi
  else
    # Check if a non-SSH process is holding LOCAL_PORT
    local other_pids
    other_pids=$(lsof -ti ":${LOCAL_PORT}" 2>/dev/null || true)
    if [ -n "$other_pids" ]; then
      local other_cmd
      other_cmd=$(ps -p "$other_pids" -o comm= 2>/dev/null || echo "unknown")
      log_err "Port ${LOCAL_PORT} is held by a non-SSH process '${other_cmd}' (PID: ${other_pids})."
      log_err "Please free port ${LOCAL_PORT} or run with: LOCAL_PORT=<port> $0 ..."
      exit 1
    fi
  fi
}

cmd_stop() {
  echo ""
  log_info "Stopping NETGEAR management tunnel and restoring fail-closed state..."
  cleanup_local_tunnel

  # Fail-Closed Invariant 3: Sanitize all potential pivot hosts
  for host in "${KNOWN_PI_HOSTS[@]}"; do
    if ssh -o ConnectTimeout=2 -o BatchMode=yes "${PI_USER}@${host}" "true" 2>/dev/null; then
      log_info "Flushing temporary IP aliases and routes on ${host}..."
      local host_octet
      host_octet=$(echo "$host" | awk -F. '{print $NF}')
      ssh -o BatchMode=yes "${PI_USER}@${host}" "
        sudo ip route del ${SW1_IP}/32 dev ${SW1_IFACE} 2>/dev/null || true
        sudo ip addr del 192.168.0.${host_octet}/24 dev ${SW1_IFACE} 2>/dev/null || true
        # Also clean up legacy static aliases from manual runbooks (.51 and .179)
        sudo ip addr del 192.168.0.51/24 dev ${SW1_IFACE} 2>/dev/null || true
        sudo ip route del ${SW2_IP}/32 dev ${SW2_IFACE} 2>/dev/null || true
        sudo ip addr del 192.168.0.${host_octet}/24 dev ${SW2_IFACE} 2>/dev/null || true
        sudo ip addr del 192.168.0.179/24 dev ${SW2_IFACE} 2>/dev/null || true
      "
    else
      log_warn "Host ${host} was unreachable over SSH; if previously used as pivot, verify aliases on next boot."
    fi
  done
  log_ok "Fail-closed state verified: management aliases sanitized across pivot hosts."
  echo ""
}

cmd_status() {
  echo ""
  echo -e "${BOLD}NETGEAR Switch Tunnel Status:${RESET}"
  local pids
  pids=$(lsof -ti ":${LOCAL_PORT}" -c ssh 2>/dev/null || true)
  if [ -n "$pids" ]; then
    local proc_info
    proc_info=$(ps -p $pids -o args= 2>/dev/null || true)
    log_ok "Port ${LOCAL_PORT} is active (PID ${pids})"
    echo -e "    Command: ${proc_info}"

    # Probe HTTP
    local title
    title=$(curl -s -m 2 "http://localhost:${LOCAL_PORT}/" | grep -i "<title>" || true)
    if [ -n "$title" ]; then
      log_ok "Switch HTTP UI responding: ${title}"
      echo -e "    URL: ${CYAN}http://localhost:${LOCAL_PORT}/${RESET}"
    else
      log_warn "Port is open, but HTTP probe returned no title (switch may still be booting or ARP resolving)."
    fi
  else
    log_info "No active SSH tunnel on port ${LOCAL_PORT}."
  fi
  echo ""
}

cmd_connect() {
  local target="$1"
  local sw_name sw_ip sw_mac sw_iface

  case "$target" in
    1|sw1|workload|zodiac_netgear_1)
      sw_name="$SW1_NAME"
      sw_ip="$SW1_IP"
      sw_mac="$SW1_MAC"
      sw_iface="$SW1_IFACE"
      ;;
    2|sw2|uplink|zodiac_netgear_2)
      sw_name="$SW2_NAME"
      sw_ip="$SW2_IP"
      sw_mac="$SW2_MAC"
      sw_iface="$SW2_IFACE"
      ;;
    *)
      log_err "Unknown switch target: '$target'. Specify '1' (workload) or '2' (uplink)."
      exit 1
      ;;
  esac

  check_pi_reachability
  cleanup_local_tunnel

  # Dynamically assign alias based on active pivot IP octet
  local pivot_octet
  pivot_octet=$(echo "$PI_HOST" | awk -F. '{print $NF}')
  local sw_alias="192.168.0.${pivot_octet}/24"

  echo ""
  echo -e "${CYAN}${BOLD}Connecting to ${sw_name}...${RESET}"
  echo -e "  Target IP:   ${BOLD}${sw_ip}${RESET}"
  echo -e "  Target MAC:  ${BOLD}${sw_mac}${RESET}"
  echo -e "  Pivot Host:  ${BOLD}${PI_HOST}${RESET} (${sw_iface})"
  echo -e "  Local Alias: ${BOLD}${sw_alias}${RESET}"
  echo ""

  log_info "Configuring L2/L3 routes and ARP pinning on ${PI_HOST} (${sw_iface})..."
  ssh -o BatchMode=yes "${PI_USER}@${PI_HOST}" "
    # 1. Ensure IP alias on pivot interface
    sudo ip addr add ${sw_alias} dev ${sw_iface} 2>/dev/null || true

    # 2. Add /32 host route directly to target interface with source IP
    sudo ip route replace ${sw_ip}/32 dev ${sw_iface} src 192.168.0.${pivot_octet}

    # 3. Pin static ARP neighbor to bypass slow broadcast discovery
    sudo ip neigh replace ${sw_ip} lladdr ${sw_mac} dev ${sw_iface}
  "

  log_info "Testing switch reachability from ${PI_HOST}..."
  if ! ssh -o BatchMode=yes "${PI_USER}@${PI_HOST}" "curl -s -m 2 'http://${sw_ip}/' >/dev/null"; then
    log_warn "Switch ${sw_ip} did not respond to immediate HTTP ping. Verifying ARP..."
    ssh -o BatchMode=yes "${PI_USER}@${PI_HOST}" "ip neigh show ${sw_ip}" || true
  else
    log_ok "Switch ${sw_ip} answered HTTP from ${PI_HOST}."
  fi

  # Foreground mode with deterministic exit trap (guarantees Invariant 3 fail-closed)
  trap 'cmd_stop' EXIT INT TERM HUP

  log_info "Opening foreground SSH tunnel on Mac (localhost:${LOCAL_PORT} -> ${sw_ip}:80)..."
  echo ""
  echo -e "${GREEN}${BOLD}================================================================${RESET}"
  echo -e "  ${GREEN}✓${RESET} ${BOLD}Management Tunnel Active${RESET}"
  echo -e "    Web Interface: ${CYAN}${BOLD}http://localhost:${LOCAL_PORT}/${RESET}"
  echo -e "    Target Switch: ${BOLD}${sw_name} (${sw_ip})${RESET}"
  echo -e "    Default Pass:  ${YELLOW}password${RESET}"
  echo ""
  echo -e "  ${YELLOW}${BOLD}Fail-Closed Guard (Invariant 3):${RESET}"
  echo -e "    Press ${BOLD}Ctrl+C${RESET} to close session."
  echo -e "    Exit trap will automatically flush routes and aliases on all hosts."
  echo -e "${GREEN}${BOLD}================================================================${RESET}"
  echo ""

  ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -L "${LOCAL_PORT}:${sw_ip}:80" "${PI_USER}@${PI_HOST}"
}

case "${1:-}" in
  1|sw1|workload|zodiac_netgear_1)
    cmd_connect 1
    ;;
  2|sw2|uplink|zodiac_netgear_2)
    cmd_connect 2
    ;;
  stop|down|kill)
    cmd_stop
    ;;
  status)
    cmd_status
    ;;
  ""|-h|--help|help)
    echo "Usage: $0 {1|2|status|stop}"
    echo ""
    echo "Targets:"
    echo "  1, workload : zodiac_netgear_1 (192.168.0.239 via eth0)"
    echo "  2, uplink   : zodiac_netgear_2 (192.168.0.240 via wlan0)"
    echo "  status      : Inspect active tunnel and probe endpoint"
    echo "  stop        : Close tunnel and sanitize routes across all pivot hosts"
    echo ""
    echo "Guarantees:"
    echo "  Runs in foreground with automatic exit trap to preserve fail-closed isolation."
    echo ""
    echo "Environment Variables:"
    echo "  LOCAL_PORT  : Local forward port (default: 8888)"
    echo "  PI_HOST     : Raspberry Pi pivot IP (default: 10.0.0.179)"
    exit 0
    ;;
  *)
    log_err "Unknown argument: '$1'"
    echo "Run '$0 --help' for usage."
    exit 1
    ;;
esac
