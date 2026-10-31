# macOS Data-Plane Persistence Daemon (`com.zodiac.dataplane`)

This directory provides a native macOS `launchd` system daemon to maintain access to the isolated Zodiac / Hailo-8 workload data-plane subnet (`10.0.2.0/24`) from the Mac operator terminal.

---

## The Problem

On macOS (Darwin), network interface IP aliases (e.g., `sudo ifconfig en0 alias 10.0.2.119 255.255.255.0`) and custom routes are ephemeral:

- They are purged whenever Wi-Fi disconnects or reconnects.
- They are purged when the MacBook goes to sleep or wakes up.
- They are purged on reboot.

Without persistence, accessing edge data-plane services (e.g. `http://10.0.2.51:8000/`) fails with timeouts as soon as the interface resets.

---

## The Solution

The `com.zodiac.dataplane` daemon:

1. **Listens to System Configuration Changes**: Using `WatchPaths` on `/Library/Preferences/SystemConfiguration`, `launchd` immediately invokes the daemon whenever network state changes (Wi-Fi re-association, DHCP renewal, sleep/wake).
2. **Environment Fencing**: Checks that the Mac is attached to the Lab LAN (`10.0.0.0/24`). If connected to a coffee shop Wi-Fi or mobile hotspot, it cleanly detaches the alias to prevent network leakage.
3. **Route Cleansing**: Automatically deletes invalid gateway routes (e.g. `10.0.2/24 -> 10.0.0.1`) that improperly direct packets to the router MAC instead of on-link ARP.
4. **Safety Heartbeat**: Runs every 300 seconds (`StartInterval: 300`) to guarantee self-healing if macOS flushes the routing table.

---

## Installation

Run the installation script with `sudo`:

```bash
sudo bash deploy/mac/install-dataplane-daemon.sh
```

---

## Verification

Check that the service is registered with `launchd`:

```bash
launchctl list | grep com.zodiac.dataplane
```

Check that the alias is active:

```bash
ifconfig en0 | grep 10.0.2.119
```

View daemon log stream via macOS Unified Logging:

```bash
log stream --predicate 'eventMessage CONTAINS "zodiac-dataplane"' --info
```

---

## Uninstallation

To remove the daemon and restore default macOS network behavior:

```bash
sudo bash deploy/mac/uninstall-dataplane-daemon.sh
```

---

## NETGEAR Switch Management Tunnels (`com.zodiac.netgear-tunnels`)

This LaunchAgent maintains persistent, self-healing SSH port forwards from the Mac operator terminal to the two NETGEAR GS105Ev2 smart switches (`192.168.0.239` on `:8888` and `192.168.0.240` on `:8889`) across reboots, sleep/wake, and Wi-Fi reconnections.

### Endpoints

- **Switch #1 (Workload):** `http://localhost:8888/` (default password: `password`)
- **Switch #2 (Uplink):** `http://localhost:8889/` (default password: `password`)

### Installation & Management

Installed as a user-level LaunchAgent (`~/Library/LaunchAgents/com.zodiac.netgear-tunnels.plist`):

```bash
# Install and activate (macOS launchd supervisor with trapped ephemeral routes on RPi 5):
npm run switch:service:install

# Check status of LaunchAgent and switch HTTP endpoints:
npm run switch:service:status

# Restart supervisor:
npm run switch:service:restart

# Uninstall and restore fail-closed isolation:
npm run switch:service:uninstall
```

### Invariant 3 Architecture (Zero Standing Routes on Pivot)

Per Invariant 3 (Fail Closed), untrusted or adversarial pivot nodes (such as the Raspberry Pi 5 workload host) must never maintain permanent standing routes or systemd units pointing to management hardware.

The supervisor script (`zodiac-netgear-tunnel-supervisor.sh`) connects over SSH and executes a trapped session (`trap cleanup EXIT INT TERM HUP`). Ephemeral routes exist on the pivot **only while the operator's SSH session is actively connected**. When the Mac disconnects, sleeps, or reboots, the remote trap automatically sanitizes all routes and IP aliases immediately.

---

## Local Telemetry Bridge Tunnel (`com.zodiac.bridge-tunnel`)

This LaunchAgent maintains a persistent, self-healing SSH port forward from the Mac operator terminal to the Jetson Orin Nano's Zodiac Bridge server (`http://localhost:3003/`) across reboots, sleep/wake, and Wi-Fi reconnections.

### Endpoints

- **Live Dashboard:** `http://localhost:3003/`
- **Hardware Telemetry:** `http://localhost:3003/api/zodiac?summary=1`
- **Authenticated Local Operator:** `http://localhost:3003/api/auth/me`

### Installation & Management

Installed as a user-level LaunchAgent (`~/Library/LaunchAgents/com.zodiac.bridge-tunnel.plist`):

```bash
# Install and activate (macOS launchd supervisor):
npm run bridge:service:install

# Check status of LaunchAgent, local port, and HTTP probes:
npm run bridge:service:status

# Restart supervisor:
npm run bridge:service:restart

# Uninstall LaunchAgent:
npm run bridge:service:uninstall
```
