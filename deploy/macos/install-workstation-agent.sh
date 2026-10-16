#!/usr/bin/env bash
# install-workstation-agent.sh -- keep the workstation agent running on this Mac, as a user LaunchAgent.
#
#   deploy/macos/install-workstation-agent.sh [--repo DIR] [--host ADDR] [--port N] [--dry-run]
#   deploy/macos/install-workstation-agent.sh --uninstall
#
# What it does: writes ~/Library/LaunchAgents/com.zodiac.workstation-agent.plist (RunAtLoad + KeepAlive, so it starts at
# login, restarts if it exits, and is suspended and resumed with the Mac's sleep: online whenever the Mac is awake) and
# loads it. Needs the repo built (dist/sdn/hardware-probe.js). Touches nothing outside ~/Library/LaunchAgents and
# ~/Library/Logs. Re-running it replaces the previous install.
#
# --host defaults to this Mac's Tailscale IPv4 address (like the Ollama LaunchAgent), falling back to 0.0.0.0 with a
# warning if Tailscale is not up. If the address is not up yet at login, the agent exits and launchd retries every 10 s.
set -euo pipefail

LABEL="com.zodiac.workstation-agent"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG="${HOME}/Library/Logs/zodiac-workstation-agent.log"
REPO=""; HOST=""; PORT="11435"; DRY=0; UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:?--repo needs a directory}"; shift 2 ;;
    --host) HOST="${2:?--host needs an address}"; shift 2 ;;
    --port) PORT="${2:?--port needs a number}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[ "$(uname -s)" = "Darwin" ] || { echo "this installs a macOS LaunchAgent; run it on the Mac" >&2; exit 1; }
UID_NUM="$(id -u)"

if [ "$UNINSTALL" = 1 ]; then
  launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed ${LABEL} (log kept at ${LOG})"
  exit 0
fi

if [ -z "$REPO" ]; then REPO="$(cd "$(dirname "$0")/../.." && pwd)"; fi
[ -f "${REPO}/scripts/workstation-agent.ts" ] || { echo "no scripts/workstation-agent.ts in ${REPO}" >&2; exit 1; }
[ -f "${REPO}/dist/sdn/hardware-probe.js" ] || { echo "${REPO} is not built (dist/sdn/hardware-probe.js missing): run 'npm run build:server' there first" >&2; exit 1; }
case "$PORT" in ''|*[!0-9]*) echo "--port must be a number" >&2; exit 2 ;; esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || { echo "--port must be 1..65535" >&2; exit 2; }

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node not found in PATH" >&2; exit 1; }

if [ -z "$HOST" ]; then
  HOST="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  if [ -z "$HOST" ]; then
    HOST="0.0.0.0"
    echo "warning: Tailscale address not found; the agent will listen on every interface (0.0.0.0)" >&2
  fi
fi
case "$HOST" in *[!A-Za-z0-9.-]*|'') echo "--host must be an IPv4 address or hostname" >&2; exit 2 ;; esac

PLIST_BODY="$(cat <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${NODE}</string><string>--experimental-strip-types</string><string>scripts/workstation-agent.ts</string>
  </array>
  <key>WorkingDirectory</key><string>${REPO}</string>
  <key>EnvironmentVariables</key><dict>
    <key>WORKSTATION_AGENT_HOST</key><string>${HOST}</string>
    <key>WORKSTATION_AGENT_PORT</key><string>${PORT}</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict></plist>
XML
)"

if [ "$DRY" = 1 ]; then
  echo "would write ${PLIST}:"; echo "$PLIST_BODY"; exit 0
fi

mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
printf '%s\n' "$PLIST_BODY" > "$PLIST"
plutil -lint "$PLIST" >/dev/null
# bootout returns before the old job is gone, and bootstrapping while it is still unloading fails with
# "Input/output error": wait for it to disappear, then bootstrap with a few retries.
launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
for _ in $(seq 1 20); do
  launchctl print "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1 || break
  sleep 0.5
done
loaded=0
for _ in 1 2 3 4 5; do
  if launchctl bootstrap "gui/${UID_NUM}" "$PLIST" 2>/dev/null; then loaded=1; break; fi
  sleep 1
done
[ "$loaded" = 1 ] || { echo "launchctl could not load ${LABEL} (try again in a few seconds, or: launchctl bootstrap gui/${UID_NUM} ${PLIST})" >&2; exit 1; }
launchctl kickstart -k "gui/${UID_NUM}/${LABEL}"
echo "installed ${LABEL}: agent on ${HOST}:${PORT}, repo ${REPO}, log ${LOG}"
echo "check:     curl -s http://${HOST}:${PORT}/health"
echo "uninstall: $0 --uninstall"
