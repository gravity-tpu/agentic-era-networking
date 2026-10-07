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
