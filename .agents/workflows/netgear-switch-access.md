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

## Quick Access (Automated Helper)

Use the dedicated helper script [scripts/netgear-tunnel.sh](file:///Users/andymorven/git/agentic-era-networking/scripts/netgear-tunnel.sh) or npm shortcuts. The script runs strictly in the foreground with an automatic `trap` to ensure deterministic, fail-closed route cleanup the moment the session ends:

```bash
# Connect to Switch 1 (Workload switch @ 192.168.0.239)
npm run switch:workload
# or: ./scripts/netgear-tunnel.sh 1
# (Press Ctrl+C when finished — the exit trap automatically flushes all routes across all pivot nodes)

# Connect to Switch 2 (Uplink switch @ 192.168.0.240)
npm run switch:uplink
# or: ./scripts/netgear-tunnel.sh 2

# Check tunnel status & probe HTTP (from another shell if needed)
npm run switch:status
# or: ./scripts/netgear-tunnel.sh status

# Explicitly stop tunnel & sanitize routes across all pivot hosts
npm run switch:stop
# or: ./scripts/netgear-tunnel.sh stop
```

Once connected, open **`http://localhost:8888/`** in your browser.

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

Before opening the tunnel, ensure no dangling SSH process is bound to port 8888:

```bash
lsof -ti :8888 | xargs kill 2>/dev/null || true
sleep 0.5
lsof -ti :8888 | xargs kill -9 2>/dev/null || true
```

### Step 3: Open Local Port Forwarding Tunnel

```bash
# For zodiac_netgear_1:
ssh -f -N -o BatchMode=yes -o ExitOnForwardFailure=yes -L 8888:192.168.0.239:80 agent@10.0.0.179

# For zodiac_netgear_2:
ssh -f -N -o BatchMode=yes -o ExitOnForwardFailure=yes -L 8888:192.168.0.240:80 agent@10.0.0.179
```

### Step 4: Verify Local Endpoint

```bash
curl -s -m 2 http://localhost:8888/ | grep -i "<title>"
# Expected output: <title>Redirect to Login</title>
```

### Step 5: Session Teardown (Restoring Fail-Closed Isolation)

When the maintenance session is complete:

```bash
# 1. Gracefully terminate local tunnel on Mac
lsof -ti :8888 | xargs kill 2>/dev/null || true
sleep 0.5
lsof -ti :8888 | xargs kill -9 2>/dev/null || true

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
