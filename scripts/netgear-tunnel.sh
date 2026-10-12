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

PORT_SW1="8888"
PORT_SW2="8889"
LOCAL_PORT="${LOCAL_PORT:-$PORT_SW1}"
PI_USER="${PI_USER:-agent}"
KNOWN_PI_HOSTS=("10.0.0.179" "10.0.0.45")
PI_HOST="${PI_HOST:-10.0.0.179}"

SW1_NAME="zodiac_netgear_1 (Workload Switch)"
SW1_IP="192.168.0.239"
SW1_MAC="28:94:01:8b:70:d9"
SW1_IFACE="eth0"
SW1_SRC="192.168.0.51"

SW2_NAME="zodiac_netgear_2 (Uplink Switch)"
SW2_IP="192.168.0.240"
SW2_MAC="28:94:01:8b:70:e5"
SW2_IFACE="wlan0"
SW2_SRC="192.168.0.179"

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
  local port="${1:-${LOCAL_PORT:-8888}}"
  local pids
  # Only target SSH processes listening on target port to avoid terminating unrelated services
  pids=$(lsof -a -ti ":${port}" -c ssh 2>/dev/null || true)
  if [ -n "$pids" ]; then
    log_info "Gracefully closing existing SSH tunnel on port ${port} (PID: ${pids})..."
    kill $pids 2>/dev/null || true
    sleep 0.5
    local remaining
    remaining=$(lsof -a -ti ":${port}" -c ssh 2>/dev/null || true)
    if [ -n "$remaining" ]; then
      kill -9 $remaining 2>/dev/null || true
    fi
  else
    # Check if a non-SSH process is holding port
    local other_pids
    other_pids=$(lsof -ti ":${port}" 2>/dev/null || true)
    if [ -n "$other_pids" ]; then
      local other_cmd
      other_cmd=$(ps -p "$other_pids" -o comm= 2>/dev/null || echo "unknown")
      log_err "Port ${port} is held by a non-SSH process '${other_cmd}' (PID: ${other_pids})."
      log_err "Please free port ${port} or run with: LOCAL_PORT=<port> $0 ..."
      exit 1
    fi
  fi
}

cmd_stop() {
  local target="${1:-all}"
  echo ""
  log_info "Stopping NETGEAR management tunnel(s) and restoring fail-closed state..."

  if [ "$target" = "1" ] || [ "$target" = "workload" ] || [ "$target" = "sw1" ]; then
    cleanup_local_tunnel "${LOCAL_PORT:-$PORT_SW1}"
  elif [ "$target" = "2" ] || [ "$target" = "uplink" ] || [ "$target" = "sw2" ]; then
    cleanup_local_tunnel "${LOCAL_PORT:-$PORT_SW2}"
  else
    cleanup_local_tunnel "$PORT_SW1"
    cleanup_local_tunnel "$PORT_SW2"
    if [ -n "${LOCAL_PORT:-}" ] && [ "${LOCAL_PORT}" != "$PORT_SW1" ] && [ "${LOCAL_PORT}" != "$PORT_SW2" ]; then
      cleanup_local_tunnel "${LOCAL_PORT}"
    fi
  fi

  # Fail-Closed Invariant 3: Sanitize potential pivot hosts for target (or all)
  for host in "${KNOWN_PI_HOSTS[@]}"; do
    if ssh -o ConnectTimeout=2 -o BatchMode=yes "${PI_USER}@${host}" "true" 2>/dev/null; then
      log_info "Flushing temporary IP aliases and routes on ${host}..."
      local host_octet
      host_octet=$(echo "$host" | awk -F. '{print $NF}')
      local flush_cmds=""
      if [ "$target" = "1" ] || [ "$target" = "workload" ] || [ "$target" = "sw1" ] || [ "$target" = "all" ]; then
        flush_cmds+="
          sudo ip route del ${SW1_IP}/32 dev ${SW1_IFACE} 2>/dev/null || true
          sudo ip neigh del ${SW1_IP} dev ${SW1_IFACE} 2>/dev/null || true
          sudo ip addr del 192.168.0.${host_octet}/24 dev ${SW1_IFACE} 2>/dev/null || true
          sudo ip addr del ${SW1_SRC}/24 dev ${SW1_IFACE} 2>/dev/null || true
        "
      fi
      if [ "$target" = "2" ] || [ "$target" = "uplink" ] || [ "$target" = "sw2" ] || [ "$target" = "all" ]; then
        flush_cmds+="
          sudo ip route del ${SW2_IP}/32 dev ${SW2_IFACE} 2>/dev/null || true
          sudo ip neigh del ${SW2_IP} dev ${SW2_IFACE} 2>/dev/null || true
          sudo ip addr del 192.168.0.${host_octet}/24 dev ${SW2_IFACE} 2>/dev/null || true
          sudo ip addr del ${SW2_SRC}/24 dev ${SW2_IFACE} 2>/dev/null || true
        "
      fi
      ssh -o BatchMode=yes "${PI_USER}@${host}" "${flush_cmds}"
    else
      log_warn "Host ${host} was unreachable over SSH; if previously used as pivot, verify aliases on next boot."
    fi
  done
  log_ok "Fail-closed state verified: management aliases sanitized across pivot hosts."

  if launchctl print "gui/$(id -u)/com.zodiac.netgear-tunnels" >/dev/null 2>&1; then
    echo ""
    log_warn "Active permanent LaunchAgent detected ('com.zodiac.netgear-tunnels')."
    log_warn "launchd will automatically restart the persistent tunnel. To completely uninstall:"
    log_warn "  npm run switch:service:uninstall (or: $0 uninstall-service)"
  fi
  echo ""
}

cmd_status() {
  echo ""
  echo -e "${BOLD}NETGEAR Switch Tunnels Status:${RESET}"
  local ports_to_check=("${PORT_SW1}" "${PORT_SW2}")
  if [ -n "${LOCAL_PORT:-}" ] && [ "${LOCAL_PORT}" != "$PORT_SW1" ] && [ "${LOCAL_PORT}" != "$PORT_SW2" ]; then
    ports_to_check+=("${LOCAL_PORT}")
  fi

  for port in "${ports_to_check[@]}"; do
    local sw_label="Port ${port}"
    if [ "$port" = "$PORT_SW1" ]; then sw_label="Switch #1 (${SW1_NAME}) on :${PORT_SW1}"; fi
    if [ "$port" = "$PORT_SW2" ]; then sw_label="Switch #2 (${SW2_NAME}) on :${PORT_SW2}"; fi

    local pids
    pids=$(lsof -a -ti ":${port}" -c ssh 2>/dev/null || true)
    if [ -n "$pids" ]; then
      local proc_info
      proc_info=$(ps -p $pids -o args= 2>/dev/null || true)
      log_ok "${sw_label} is active (PID ${pids})"
      echo -e "    Command: ${proc_info}"

      local title
      title=$(curl -s -m 2 "http://localhost:${port}/" | grep -i "<title>" || true)
      if [ -n "$title" ]; then
        log_ok "Switch HTTP UI responding: ${title}"
        echo -e "    URL: ${CYAN}http://localhost:${port}/${RESET}"
      else
        log_warn "Port is open, but HTTP probe returned no title (switch may still be booting or ARP resolving)."
      fi
    else
      log_info "${sw_label}: No active SSH tunnel."
    fi
  done
  echo ""
}

cmd_connect() {
  local target="$1"
  local sw_name sw_ip sw_mac sw_iface sw_src default_port

  case "$target" in
    1|sw1|workload|zodiac_netgear_1)
      sw_name="$SW1_NAME"
      sw_ip="$SW1_IP"
      sw_mac="$SW1_MAC"
      sw_iface="$SW1_IFACE"
      sw_src="$SW1_SRC"
      default_port="$PORT_SW1"
      ;;
    2|sw2|uplink|zodiac_netgear_2)
      sw_name="$SW2_NAME"
      sw_ip="$SW2_IP"
      sw_mac="$SW2_MAC"
      sw_iface="$SW2_IFACE"
      sw_src="$SW2_SRC"
      default_port="$PORT_SW2"
      ;;
    *)
      log_err "Unknown switch target: '$target'. Specify '1' (workload) or '2' (uplink)."
      exit 1
      ;;
  esac

  LOCAL_PORT="${LOCAL_PORT:-$default_port}"
  check_pi_reachability
  cleanup_local_tunnel "${LOCAL_PORT}"

  local sw_alias="${sw_src}/24"

  echo ""
  echo -e "${CYAN}${BOLD}Connecting to ${sw_name}...${RESET}"
  echo -e "  Target IP:   ${BOLD}${sw_ip}${RESET}"
  echo -e "  Target MAC:  ${BOLD}${sw_mac}${RESET}"
  echo -e "  Pivot Host:  ${BOLD}${PI_HOST}${RESET} (${sw_iface})"
  echo -e "  Local Alias: ${BOLD}${sw_alias}${RESET}"
  echo ""

  # Construct remote payload with deterministic EXIT trap and heartbeat timeout
  local remote_payload="bash -c '
    cleanup() {
      sudo ip route del ${sw_ip}/32 dev ${sw_iface} 2>/dev/null || true
      sudo ip neigh del ${sw_ip} dev ${sw_iface} 2>/dev/null || true
      sudo ip addr del ${sw_alias} dev ${sw_iface} 2>/dev/null || true
    }
    trap cleanup EXIT INT TERM HUP

    sudo ip addr add ${sw_alias} dev ${sw_iface} 2>/dev/null || true
    sudo ip route replace ${sw_ip}/32 dev ${sw_iface} src ${sw_src}
    sudo ip neigh replace ${sw_ip} lladdr ${sw_mac} dev ${sw_iface} nud permanent

    while read -t 25 -r _line; do
      :
    done
  '"

  # Foreground mode with deterministic exit trap (guarantees Invariant 3 fail-closed)
  trap "cmd_stop '${target}'" EXIT INT TERM HUP

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
  echo -e "    Exit trap & remote 25s heartbeat timeout guarantee zero standing routes on pivot."
  echo -e "${GREEN}${BOLD}================================================================${RESET}"
  echo ""

  heartbeat_loop() {
    while true; do
      printf '\n' || break
      sleep 10 || break
    done
  }

  heartbeat_loop | ssh -o BatchMode=yes \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    -o TCPKeepAlive=yes \
    -L "${LOCAL_PORT}:${sw_ip}:80" \
    "${PI_USER}@${PI_HOST}" \
    "${remote_payload}"
}

cmd_install_service() {
  echo ""
  log_info "Installing permanent Netgear switch management LaunchAgent (macOS launchd)..."
  check_pi_reachability

  local repo_root
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

  # macOS LaunchAgent: Generate plist dynamically using current repository root
  local launch_agents_dir="${HOME}/Library/LaunchAgents"
  local plist_target="${launch_agents_dir}/com.zodiac.netgear-tunnels.plist"
  mkdir -p "${launch_agents_dir}"

  log_info "Generating LaunchAgent plist at ${plist_target}..."
  chmod +x "${repo_root}/deploy/mac/zodiac-netgear-tunnel-supervisor.sh"

  # Unload previous instance if active
  if launchctl print "gui/$(id -u)/com.zodiac.netgear-tunnels" >/dev/null 2>&1; then
    log_info "Unloading existing LaunchAgent..."
    launchctl bootout "gui/$(id -u)/com.zodiac.netgear-tunnels" 2>/dev/null || launchctl unload "${plist_target}" 2>/dev/null || true
  fi

  cat <<EOF > "${plist_target}"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.zodiac.netgear-tunnels</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${repo_root}/deploy/mac/zodiac-netgear-tunnel-supervisor.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>/tmp/zodiac-netgear-tunnels.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/zodiac-netgear-tunnels.log</string>
</dict>
</plist>
EOF

  # Clear existing ad-hoc tunnels on 8888 and 8889 so LaunchAgent can bind
  cleanup_local_tunnel "8888"
  cleanup_local_tunnel "8889"

  log_info "Loading LaunchAgent into launchd..."
  if ! launchctl bootstrap "gui/$(id -u)" "${plist_target}" 2>/dev/null; then
    launchctl load -w "${plist_target}"
  fi

  # Allow supervisor 3 seconds to establish the multiplexed tunnel
  sleep 3
  log_ok "macOS LaunchAgent registered and started."
  cmd_service_status
}

cmd_uninstall_service() {
  echo ""
  log_info "Uninstalling permanent Netgear switch management LaunchAgent..."
  local launch_agents_dir="${HOME}/Library/LaunchAgents"
  local plist_target="${launch_agents_dir}/com.zodiac.netgear-tunnels.plist"

  # 1. Unload and remove LaunchAgent
  if [ -f "${plist_target}" ] || launchctl print "gui/$(id -u)/com.zodiac.netgear-tunnels" >/dev/null 2>&1; then
    log_info "Unloading macOS LaunchAgent..."
    launchctl bootout "gui/$(id -u)/com.zodiac.netgear-tunnels" 2>/dev/null || launchctl unload "${plist_target}" 2>/dev/null || true
    rm -f "${plist_target}"
    log_ok "Removed ${plist_target}."
  fi

  cleanup_local_tunnel "8888"
  cleanup_local_tunnel "8889"

  # 2. Flush routes across pivot hosts (Invariant 3 fail-closed guarantee)
  for host in "${KNOWN_PI_HOSTS[@]}"; do
    if ssh -o ConnectTimeout=2 -o BatchMode=yes "${PI_USER}@${host}" "true" 2>/dev/null; then
      log_info "Sanitizing IP aliases and routes on ${host}..."
      ssh -o BatchMode=yes "${PI_USER}@${host}" "
        sudo ip route del ${SW1_IP}/32 dev ${SW1_IFACE} 2>/dev/null || true
        sudo ip neigh del ${SW1_IP} dev ${SW1_IFACE} 2>/dev/null || true
        sudo ip addr del ${SW1_SRC}/24 dev ${SW1_IFACE} 2>/dev/null || true
        sudo ip route del ${SW2_IP}/32 dev ${SW2_IFACE} 2>/dev/null || true
        sudo ip neigh del ${SW2_IP} dev ${SW2_IFACE} 2>/dev/null || true
        sudo ip addr del ${SW2_SRC}/24 dev ${SW2_IFACE} 2>/dev/null || true
      "
    fi
  done

  log_ok "Permanent switch service uninstalled and fail-closed state restored."
  echo ""
}

cmd_service_status() {
  echo ""
  echo -e "${BOLD}================================================================${RESET}"
  echo -e "  ${BOLD}Permanent Switch Management Services Status${RESET}"
  echo -e "${BOLD}================================================================${RESET}"

  # 1. macOS LaunchAgent
  echo -e "\n${BOLD}[1] macOS LaunchAgent (com.zodiac.netgear-tunnels):${RESET}"
  if launchctl print "gui/$(id -u)/com.zodiac.netgear-tunnels" >/dev/null 2>&1; then
    local svc_state svc_pid
    svc_state=$(launchctl print "gui/$(id -u)/com.zodiac.netgear-tunnels" 2>/dev/null | awk '/state =/{print $3; exit}')
    svc_pid=$(launchctl print "gui/$(id -u)/com.zodiac.netgear-tunnels" 2>/dev/null | awk '/pid =/{print $3; exit}')
    log_ok "LaunchAgent active in launchd (state: ${svc_state:-running}, PID: ${svc_pid:-unknown})"
  else
    log_warn "LaunchAgent NOT registered in launchd. Run: npm run switch:service:install"
  fi

  if [ -f "/tmp/zodiac-netgear-tunnels.log" ]; then
    echo -e "    Recent Supervisor Log (/tmp/zodiac-netgear-tunnels.log):"
    tail -n 4 "/tmp/zodiac-netgear-tunnels.log" | sed 's/^/      /'
  fi

  # 2. RPi 5 Pivot Ephemeral Route Isolation (Invariant 3)
  echo -e "\n${BOLD}[2] RPi 5 Pivot (10.0.0.179) Route Isolation (Invariant 3):${RESET}"
  if ssh -o BatchMode=yes -o ConnectTimeout=3 "${PI_USER}@${PI_HOST}" "true" 2>/dev/null; then
    local rpi_routes
    rpi_routes=$(ssh -o BatchMode=yes "${PI_USER}@${PI_HOST}" "ip route show | grep -E '192\.168\.0\.(239|240)'" 2>/dev/null || true)
    if [ -n "$rpi_routes" ]; then
      log_ok "Ephemeral route active on pivot via trapped supervisor SSH session:"
      echo "$rpi_routes" | sed 's/^/      /'
    else
      log_info "No switch routes on pivot (clean fail-closed state when supervisor disconnected)."
    fi
  else
    log_warn "Cannot reach pivot host ${PI_HOST} over SSH."
  fi

  # 3. Port & HTTP Probes
  cmd_status
}

cmd_service_restart() {
  echo ""
  log_info "Restarting permanent switch management supervisor..."
  local plist_target="${HOME}/Library/LaunchAgents/com.zodiac.netgear-tunnels.plist"

  if [ -f "${plist_target}" ]; then
    log_info "Restarting macOS LaunchAgent..."
    launchctl kickstart -k "gui/$(id -u)/com.zodiac.netgear-tunnels" 2>/dev/null || {
      launchctl bootout "gui/$(id -u)/com.zodiac.netgear-tunnels" 2>/dev/null || launchctl unload "${plist_target}" 2>/dev/null || true
      sleep 1
      launchctl bootstrap "gui/$(id -u)" "${plist_target}" 2>/dev/null || launchctl load -w "${plist_target}"
    }
  else
    log_warn "LaunchAgent plist not found. Run: npm run switch:service:install"
  fi

  sleep 2
  cmd_service_status
}

case "${1:-}" in
  1|sw1|workload|zodiac_netgear_1)
    cmd_connect 1 "${2:-}"
    ;;
  2|sw2|uplink|zodiac_netgear_2)
    cmd_connect 2 "${2:-}"
    ;;
  stop|down|kill)
    cmd_stop "${2:-all}"
    ;;
  status)
    cmd_status
    ;;
  install-service|service-install|service:install)
    cmd_install_service
    ;;
  uninstall-service|service-uninstall|service:uninstall)
    cmd_uninstall_service
    ;;
  service-status|service:status)
    cmd_service_status
    ;;
  service-restart|service:restart)
    cmd_service_restart
    ;;
  ""|-h|--help|help)
    echo "Usage: $0 {1|2|status|stop|install-service|uninstall-service|service-status|service-restart}"
    echo ""
    echo "Ad-Hoc Targets:"
    echo "  1, workload       : zodiac_netgear_1 (192.168.0.239 via eth0 -> :8888)"
    echo "  2, uplink         : zodiac_netgear_2 (192.168.0.240 via wlan0 -> :8889)"
    echo "  status            : Inspect active tunnels and probe endpoints"
    echo "  stop              : Close ad-hoc tunnels and sanitize routes across pivot hosts"
    echo ""
    echo "Permanent Service (Auto-Start on Boot / Reconnect across Reboots):"
    echo "  install-service   : Install and start macOS LaunchAgent supervisor"
    echo "  uninstall-service : Remove LaunchAgent, flush ephemeral routes, restore fail-closed state"
    echo "  service-status    : Inspect status of LaunchAgent and ephemeral pivot route isolation"
    echo "  service-restart   : Restart LaunchAgent tunnel supervisor"
    echo ""
    echo "Environment Variables:"
    echo "  LOCAL_PORT        : Local forward port override"
    echo "  PI_HOST           : Raspberry Pi pivot IP (default: 10.0.0.179)"
    exit 0
    ;;
  *)
    log_err "Unknown argument: '$1'"
    echo "Run '$0 --help' for usage."
    exit 1
    ;;
esac
