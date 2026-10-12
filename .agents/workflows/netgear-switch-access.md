# NETGEAR GS105Ev2 Smart Managed Switch Access Workflow

**Trigger:** `@ccie`, `connect to netgear`, `access switch`, `switch web ui`, `netgear tunnel`

## Objective

Establish secure, deterministic out-of-band operator access from the local workstation (Mac) to the web management interfaces (HTTP :80) of the testbed's two NETGEAR GS105Ev2 smart switches (`zodiac_netgear_1` and `zodiac_netgear_2`), while strictly adhering to testbed isolation invariants (Invariant 1, Invariant 3, and Invariant 6).

---

## Switch Architecture & Topology Reference

| Switch Identifier | Role | Physical Placement | Target IP | Hardware MAC | Pivot Interface | Pivot Host |
| --- | --- | --- | --- | --- | --- | --- |
| **`zodiac_netgear_1`** | Workload Aggregator | Zodiac Port 1 (P5) | `192.168.0.239` | `28:94:01:8b:70:d9` | `eth0` | `10.0.0.179` (RPi 5) / `10.0.0.45` (RPi 3B+) |
| **`zodiac_netgear_2`** | Uplink Aggregator | Zodiac Port 2 (P4) ⟷ ISP Extender (P5) | `192.168.0.240` | `28:94:01:8b:70:e5` | `wlan0` | `10.0.0.179` (RPi 5) / `10.0.0.45` (RPi 3B+) |

---

## Why Connection is Non-Trivial (Network Invariants)

1. **Subnet & Gateway Isolation:**
   - The lab LAN and operator workstations operate on `10.0.0.0/24`. The upstream ISP gateway (`10.0.0.1`) does not route `192.168.0.0/24`.
2. **SDN Policy Fail-Closed Isolation (Invariant 3):**
   - The Zodiac OpenFlow Port 1 Isolation Policy ([port1-isolation.ts](file:///Users/andymorven/git/agentic-era-networking/src/sdn/port1-isolation.ts)) explicitly quarantines traffic destined to `192.168.0.0/24` entering Zodiac Port 1 (`in_port=1, dst 192.168.0.x → [P3]` mirror tap only). Management frames cannot cross to Zodiac Port 2.
3. **Dual-Homed Interface Ambiguity:**
   - Both switches reside in the same `192.168.0.0/24` logical subnet, but connect to two distinct physical interfaces on the pivot host: `eth0` (isolated workload segment) and `wlan0` (bridged home extender segment).
   - Assigning naive `/24` aliases to both interfaces causes routing table conflicts. Explicit `/32` host routes with `src` bindings are required.
4. **Firmware ARP Dropping:**
   - NETGEAR GS105Ev2 firmware frequently drops or ignores dynamic broadcast ARP requests originating outside its immediate broadcast segment. Injecting a static neighbor entry (`ip neigh replace ... lladdr ...`) bypasses broadcast ARP discovery and ensures immediate L2 unicast frame delivery.
5. **No Persistent Standing Routes:**
   - Because the Raspberry Pi is a workload/adversarial node, permanent static routes to the switch management plane are forbidden (Invariant 3). Routes and aliases must be dynamically provisioned for the operator session and torn down when finished.

---

## Permanent Boot Persistence (Always Online across Reboots)

To keep both ports `8888` and `8889` permanently active and self-healing across Mac reboots, sleep/wake, Wi-Fi drops, and Raspberry Pi power cycles:

```bash
# 1. Install & enable permanent supervisor LaunchAgent:
npm run switch:service:install

# 2. Check full status of LaunchAgent, pivot ephemeral isolation, and HTTP endpoints:
npm run switch:service:status

# 3. Restart persistent supervisor if needed:
npm run switch:service:restart

# 4. Uninstall LaunchAgent and restore fail-closed isolation:
npm run switch:service:uninstall
```

### Architecture of Permanent Persistence (Invariant 3 Compliant)
- **macOS (`com.zodiac.netgear-tunnels` LaunchAgent):** Runs in the operator user domain via `~/Library/LaunchAgents/com.zodiac.netgear-tunnels.plist`. Supervised by [deploy/mac/zodiac-netgear-tunnel-supervisor.sh](file:///Users/andymorven/git/agentic-era-networking/deploy/mac/zodiac-netgear-tunnel-supervisor.sh). Multiplexes both ports `:8888` and `:8889` over resilient SSH with TCP keepalives (`ServerAliveInterval 15`). Automatically reconnects on login, sleep/wake, or network reconnects.
- **Pivot Host Zero Standing Routes (Fail-Closed Isolation):** To uphold Invariant 3, the Raspberry Pi 5 workload host boots with zero permanent routes or systemd units to `192.168.0.0/24`. The supervisor script executes an inline trapped remote session (`trap cleanup EXIT INT TERM HUP`). Routes and aliases are only bound for the lifetime of the authenticated SSH connection; if the Mac disconnects, sleeps, or reboots, the remote trap immediately deletes the routes and aliases on the pivot.

---

## Ad-Hoc Sessions (Alternative)

If background persistence is not desired, ad-hoc foreground sessions can still be run:

```bash
# Connect to Switch 1 (Workload switch @ 192.168.0.239 -> http://localhost:8888/)
npm run switch:workload      # Foreground session; Ctrl+C cleans up routes

# Connect to Switch 2 (Uplink switch @ 192.168.0.240 -> http://localhost:8889/)
npm run switch:uplink        # Foreground session; Ctrl+C cleans up routes

# Check tunnel status & probe HTTP for both switches
npm run switch:status
# or: ./scripts/netgear-tunnel.sh status

# Explicitly stop tunnel(s) & sanitize routes across all pivot hosts
npm run switch:stop
# or: ./scripts/netgear-tunnel.sh stop
```

Access via browser:
- **Switch #1 (`zodiac_netgear_1`, Workload):** **`http://localhost:8888/`**
- **Switch #2 (`zodiac_netgear_2`, Uplink):** **`http://localhost:8889/`**
- **Default password:** `password`

---

## Manual Step-by-Step Procedure

If reproducing manually or without the helper script, follow these steps exactly:

### Step 1: Prepare the Pivot Host (Raspberry Pi 5 at `10.0.0.179`)

#### For `zodiac_netgear_1` (Workload Switch)

```bash
ssh -o BatchMode=yes agent@10.0.0.179 "
  sudo ip addr add 192.168.0.51/24 dev eth0 2>/dev/null || true
  sudo ip route replace 192.168.0.239/32 dev eth0 src 192.168.0.51
  sudo ip neigh replace 192.168.0.239 lladdr 28:94:01:8b:70:d9 dev eth0
  curl -s -m 2 http://192.168.0.239/ | grep -i '<title>'
"
```

#### For `zodiac_netgear_2` (Uplink Switch)

```bash
ssh -o BatchMode=yes agent@10.0.0.179 "
  sudo ip addr add 192.168.0.179/24 dev wlan0 2>/dev/null || true
  sudo ip route replace 192.168.0.240/32 dev wlan0 src 192.168.0.179
  sudo ip neigh replace 192.168.0.240 lladdr 28:94:01:8b:70:e5 dev wlan0
  curl -s -m 2 http://192.168.0.240/ | grep -i '<title>'
"
```

### Step 2: Clear Port Collisions on the Mac

Before opening the tunnel, ensure no dangling SSH process is bound to the target port (`8888` for Switch 1, `8889` for Switch 2):

```bash
# Clear Switch 1 (8888) or Switch 2 (8889):
lsof -ti :8888 | xargs kill 2>/dev/null || true
lsof -ti :8889 | xargs kill 2>/dev/null || true
```

### Step 3: Open Local Port Forwarding Tunnel

```bash
# For zodiac_netgear_1 (Port 8888):
ssh -f -N -o BatchMode=yes -o ExitOnForwardFailure=yes -L 8888:192.168.0.239:80 agent@10.0.0.179

# For zodiac_netgear_2 (Port 8889):
ssh -f -N -o BatchMode=yes -o ExitOnForwardFailure=yes -L 8889:192.168.0.240:80 agent@10.0.0.179
```

### Step 4: Verify Local Endpoints

```bash
# Verify Switch 1:
curl -s -m 2 http://localhost:8888/ | grep -i "<title>"
# Expected output: <title>Redirect to Login</title>

# Verify Switch 2:
curl -s -m 2 http://localhost:8889/ | grep -i "<title>"
# Expected output: <title>Redirect to Login</title>
```

### Step 5: Session Teardown (Restoring Fail-Closed Isolation)

When the maintenance session is complete:

```bash
# 1. Gracefully terminate local tunnels on Mac
lsof -ti :8888 :8889 | xargs kill 2>/dev/null || true
sleep 0.5
lsof -ti :8888 :8889 | xargs kill -9 2>/dev/null || true

# 2. Flush aliases and host routes on the Pi
ssh -o BatchMode=yes agent@10.0.0.179 "
  sudo ip route del 192.168.0.239/32 dev eth0 2>/dev/null || true
  sudo ip addr del 192.168.0.51/24 dev eth0 2>/dev/null || true
  sudo ip route del 192.168.0.240/32 dev wlan0 2>/dev/null || true
  sudo ip addr del 192.168.0.179/24 dev wlan0 2>/dev/null || true
"
```

---

## Troubleshooting Guide

| Issue | Root Cause | Resolution |
| --- | --- | --- |
| `bind [127.0.0.1]:8888: Address already in use` | A previous SSH tunnel process is still running. | Run `lsof -ti :8888 \| xargs kill -9` or `./scripts/netgear-tunnel.sh stop`. |
| `curl: (52) Empty reply from server` on `curl -I` | GS105Ev2 embedded web server does not support HTTP `HEAD` method. | Use standard `GET` (`curl -s http://localhost:8888/`) instead of `curl -I`. |
| Timeout reaching `192.168.0.240` via `wlan0` | Missing `/32` host route causes packets to fall through to default gateway `10.0.0.1`. | Run `sudo ip route replace 192.168.0.240/32 dev wlan0 src 192.168.0.179`. |
| Switch does not respond to ping or HTTP | Dynamic ARP broadcast dropped by switch. | Run `sudo ip neigh replace <IP> lladdr <MAC> dev <IFACE>`. |
| Both switches respond on `192.168.0.239` | Switch 2 was reset or did not retain static IP `192.168.0.240`. | Disconnect switch 1 or access switch 2 directly to re-apply static IP `192.168.0.240`. |
