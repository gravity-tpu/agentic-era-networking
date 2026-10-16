# Workstation agent on the Mac

The Jetson's bridge shows the Mac ("workstation") as online by probing a small agent on the Mac, `scripts/workstation-agent.ts`,
at `/api/hardware`. The agent reports the Mac's CPU, memory, Apple GPU and Ollama state. If the agent is not running, the
Jetson gets connection refused and the Mac reads **offline**, even though Ollama itself is fine.

Started by hand (`npm run workstation:agent`) it stops when the terminal closes and nothing restarts it. Install it as a
LaunchAgent instead.

## Install

```bash
npm run build:server                                  # the agent imports dist/
deploy/macos/install-workstation-agent.sh             # binds this Mac's Tailscale address
```

- **Starts at login** and **restarts if it exits** (`RunAtLoad`, `KeepAlive`, 10 s throttle).
- **Online whenever the Mac is awake.** When the Mac sleeps the process is suspended and the Jetson's probes fail, so the
  dashboard shows the Mac offline, which is true. On wake the agent resumes and the next probe finds it.
- **Bind address.** Defaults to the Tailscale IPv4 address (like the Ollama LaunchAgent), so the metrics are not served,
  unauthenticated, to whatever network a laptop joins. `--host 0.0.0.0` listens everywhere; `--host`, `--port` and `--repo`
  are options. If the address is not up yet at login the agent exits and launchd retries every 10 s.
- The LaunchAgent runs the agent from the repo checkout (`--repo`, default the checkout the script is in), so keep that
  checkout built, and re-run the installer (or `launchctl kickstart -k gui/$(id -u)/com.zodiac.workstation-agent`) after
  pulling a change to the agent.
- Re-running the installer replaces the previous install. Remove it with `--uninstall`.

## Check

```bash
curl -s http://$(tailscale ip -4 | head -1):11435/health
launchctl print gui/$(id -u)/com.zodiac.workstation-agent | grep -E 'state|pid'
tail -f ~/Library/Logs/zodiac-workstation-agent.log
```

From the Jetson: `curl -s http://<mac-tailscale-ip>:11435/api/hardware` should return JSON with `"source":"live_hardware"`.

## Jetson side

The bridge tries, at the same time, `WORKSTATION_AGENT_URL`, the USB-C tether (`http://192.168.55.100:11435`) and
`WORKSTATION_AGENT_LAN_URL`, and uses the first that answers. Put the Mac's Tailscale URL in `WORKSTATION_AGENT_URL` in
`/etc/zodiac/zodiac-bridge.env` (read when the bridge starts). A LAN URL stops working once the agent binds only the
Tailscale address, which is why the Tailscale URL is the one to rely on.

## Log

`ioreg` lives in `/usr/sbin`, which launchd's default `PATH` omits; the installer sets `PATH` so the Apple GPU metrics work.
`spawn ioreg ENOENT` in the log means the agent was started some other way without it.
