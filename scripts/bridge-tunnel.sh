#!/usr/bin/env bash
# ==============================================================================
# Zodiac — Local Telemetry Bridge Tunnel Helper
# ==============================================================================
# Establishes and manages a persistent SSH port-forward tunnel from the Mac operator
# terminal (:3003) to the Zodiac Bridge Server (:3003) on the NVIDIA Jetson Orin Nano.
#
# Provides seamless access to the live hardware metrics and local web dashboard:
#   http://localhost:3003/
#
# Usage:
#   ./scripts/bridge-tunnel.sh start             # Run tunnel in foreground
#   ./scripts/bridge-tunnel.sh stop              # Stop local tunnel process on :3003
#   ./scripts/bridge-tunnel.sh status            # Check port :3003 and HTTP health
#   ./scripts/bridge-tunnel.sh install-service   # Install and enable macOS LaunchAgent
#   ./scripts/bridge-tunnel.sh uninstall-service # Remove macOS LaunchAgent
#   ./scripts/bridge-tunnel.sh service-status    # Inspect LaunchAgent and log output
#   ./scripts/bridge-tunnel.sh service-restart   # Restart LaunchAgent
# ==============================================================================

set -euo pipefail

LABEL="com.zodiac.bridge-tunnel"
LOCAL_PORT="${LOCAL_PORT:-3003}"
TARGET_HOST="${TARGET_HOST:-jetson}"

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

cleanup_local_tunnel() {
  local port="${1:-${LOCAL_PORT}}"
  local pids
  pids=$(lsof -a -ti ":${port}" -c ssh 2>/dev/null || true)
  if [ -n "$pids" ]; then
    log_info "Closing SSH tunnel on port ${port} (PID: ${pids})..."
    kill $pids 2>/dev/null || true
    sleep 0.5
    local remaining
    remaining=$(lsof -a -ti ":${port}" -c ssh 2>/dev/null || true)
    if [ -n "$remaining" ]; then
      kill -9 $remaining 2>/dev/null || true
    fi
    log_ok "Port ${port} released."
  fi
}

cmd_start() {
  echo ""
  log_info "Starting Zodiac Bridge tunnel in foreground on http://localhost:${LOCAL_PORT}..."
  cleanup_local_tunnel "${LOCAL_PORT}"

  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  exec bash "${script_dir}/deploy/mac/zodiac-bridge-tunnel-supervisor.sh"
}

cmd_stop() {
  echo ""
  log_info "Stopping Zodiac Bridge tunnel..."
  cleanup_local_tunnel "${LOCAL_PORT}"
  echo ""
}

cmd_status() {
  echo ""
  echo -e "${BOLD}================================================================${RESET}"
  echo -e "  ${BOLD}Zodiac Localhost Bridge Tunnel Status (:3003)${RESET}"
  echo -e "${BOLD}================================================================${RESET}"

  # 1. Check local port listening
  local pids
  pids=$(lsof -ti ":${LOCAL_PORT}" 2>/dev/null | tr '\n' ' ' | xargs || true)
  if [ -n "$pids" ]; then
    local first_pid proc_cmd
    first_pid=$(awk '{print $1}' <<< "$pids")
    proc_cmd=$(ps -p "$first_pid" -o comm= 2>/dev/null || echo "unknown")
    log_ok "Port ${LOCAL_PORT} is ACTIVE (PID: ${pids}, Process: ${proc_cmd})"
  else
    log_err "Port ${LOCAL_PORT} is NOT listening."
    echo -e "    Run 'npm run bridge:service:install' or 'npm run bridge:tunnel'"
    echo ""
    return 1
  fi

  # 2. Check HTTP endpoints
  echo -e "\n${BOLD}[HTTP Probe] Probing http://localhost:${LOCAL_PORT}/api/auth/me:${RESET}"
  local auth_resp
  auth_resp=$(curl -s -m 3 "http://localhost:${LOCAL_PORT}/api/auth/me" 2>/dev/null || echo "TIMEOUT_OR_FAILED")
  if [[ "$auth_resp" == *"authenticated"* ]]; then
    log_ok "Authenticated Operator Session active"
    echo -e "    Response: ${auth_resp}"
  else
    log_err "Auth probe failed: ${auth_resp}"
  fi

  echo -e "\n${BOLD}[HTTP Probe] Probing http://localhost:${LOCAL_PORT}/api/zodiac?summary=1:${RESET}"
  local telem_resp
  telem_resp=$(curl -s -m 3 "http://localhost:${LOCAL_PORT}/api/zodiac?summary=1" 2>/dev/null || echo "TIMEOUT_OR_FAILED")
  if [[ "$telem_resp" == *"source"* ]]; then
    local source dev_name
    source=$(python3 -c "import json; d=json.loads('''${telem_resp}'''); print(d.get('source', 'unknown'))" 2>/dev/null || echo "live")
    dev_name=$(python3 -c "import json; d=json.loads('''${telem_resp}'''); print(d.get('system', {}).get('deviceName', 'unknown'))" 2>/dev/null || echo "Zodiac")
    log_ok "Hardware Telemetry received from ${dev_name} (source: ${source})"
  else
    log_err "Telemetry probe failed: ${telem_resp}"
  fi

  echo -e "\n  ${GREEN}✨ Web Dashboard is live at: http://localhost:${LOCAL_PORT}/${RESET}\n"
}

cmd_install_service() {
  echo ""
  log_info "Installing persistent Zodiac Bridge tunnel LaunchAgent..."

  local repo_dir
  repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  local plist_source="${repo_dir}/deploy/mac/com.zodiac.bridge-tunnel.plist"
  local launch_agents_dir="${HOME}/Library/LaunchAgents"
  local plist_target="${launch_agents_dir}/${LABEL}.plist"

  mkdir -p "${launch_agents_dir}"

  # Unload previous service if registered
  if launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
    log_info "Unloading existing LaunchAgent..."
    launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  fi

  # Generate customized plist with real paths
  log_info "Writing ${plist_target}..."
  sed "s|/path/to/agentic-era-networking|${repo_dir}|g" "${plist_source}" > "${plist_target}"
  chmod 644 "${plist_target}"

  # Boot up via launchctl
  log_info "Registering service with macOS launchctl..."
  launchctl bootstrap "gui/$(id -u)" "${plist_target}" 2>/dev/null || launchctl load -w "${plist_target}"

  log_info "Waiting 3 seconds for tunnel initialization..."
  sleep 3

  log_ok "macOS LaunchAgent registered and started."
  cmd_service_status
}

cmd_uninstall_service() {
  echo ""
  log_info "Uninstalling persistent Zodiac Bridge tunnel LaunchAgent..."
  local launch_agents_dir="${HOME}/Library/LaunchAgents"
  local plist_target="${launch_agents_dir}/${LABEL}.plist"

  if [ -f "${plist_target}" ] || launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
    log_info "Unloading macOS LaunchAgent..."
    launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || launchctl unload "${plist_target}" 2>/dev/null || true
    rm -f "${plist_target}"
    log_ok "Removed ${plist_target}."
  fi

  cleanup_local_tunnel "${LOCAL_PORT}"
  log_ok "Service uninstalled and local port released."
  echo ""
}

cmd_service_status() {
  echo ""
  echo -e "${BOLD}================================================================${RESET}"
  echo -e "  ${BOLD}macOS LaunchAgent Status (${LABEL})${RESET}"
  echo -e "${BOLD}================================================================${RESET}"

  if launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
    local svc_state svc_pid
    svc_state=$(launchctl print "gui/$(id -u)/${LABEL}" 2>/dev/null | awk '/state =/{print $3; exit}')
    svc_pid=$(launchctl print "gui/$(id -u)/${LABEL}" 2>/dev/null | awk '/pid =/{print $3; exit}')
    log_ok "LaunchAgent active in launchd (state: ${svc_state:-running}, PID: ${svc_pid:-unknown})"
  else
    log_warn "LaunchAgent NOT registered in launchd. Run: npm run bridge:service:install"
  fi

  if [ -f "/tmp/zodiac-bridge-tunnel.log" ]; then
    echo -e "    Recent Supervisor Log (/tmp/zodiac-bridge-tunnel.log):"
    tail -n 6 "/tmp/zodiac-bridge-tunnel.log" | sed 's/^/      /'
  fi

  cmd_status
}

cmd_service_restart() {
  echo ""
  log_info "Restarting persistent bridge tunnel supervisor..."
  local plist_target="${HOME}/Library/LaunchAgents/${LABEL}.plist"

  if [ -f "${plist_target}" ]; then
    log_info "Restarting macOS LaunchAgent..."
    launchctl kickstart -k "gui/$(id -u)/${LABEL}" 2>/dev/null || {
      launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || launchctl unload "${plist_target}" 2>/dev/null || true
      sleep 1
      launchctl bootstrap "gui/$(id -u)" "${plist_target}" 2>/dev/null || launchctl load -w "${plist_target}"
    }
  else
    log_warn "LaunchAgent plist not found. Run: npm run bridge:service:install"
  fi

  sleep 2
  cmd_service_status
}

case "${1:-status}" in
  start)
    cmd_start
    ;;
  stop)
    cmd_stop
    ;;
  status)
    cmd_status
    ;;
  install-service|install)
    cmd_install_service
    ;;
  uninstall-service|uninstall)
    cmd_uninstall_service
    ;;
  service-status)
    cmd_service_status
    ;;
  service-restart|restart)
    cmd_service_restart
    ;;
  -h|--help|help)
    head -n 22 "$0" | tail -n 14
    ;;
  *)
    log_err "Unknown command: $1"
    echo "Usage: $0 {start|stop|status|install-service|uninstall-service|service-status|service-restart}"
    exit 2
    ;;
esac
