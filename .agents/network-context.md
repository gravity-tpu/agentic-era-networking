# Network Engineering Context & Development State Matrix

**Custodian:** network engineering review skill (`.agents/skills/ccie-network-engineer`); a review aid, not a certified review  
**Repository:** `gravity-tpu/agentic-era-networking`  
**Governing Invariants:** `NET-001` through `NET-006` ([network-engineering-principles.md](file:///Users/andymorven/git/agentic-era-networking/.agents/rules/network-engineering-principles.md))  
**Companion Documents:** [audit-log.md](file:///Users/andymorven/git/agentic-era-networking/.agents/audit-log.md), [ROADMAP.md](file:///Users/andymorven/git/agentic-era-networking/docs/ROADMAP.md), [SENTINEL-ROADMAP.md](file:///Users/andymorven/git/agentic-era-networking/docs/SENTINEL-ROADMAP.md)

---

## 1. High-Level Network Topology & Architecture State

This ledger tracks the physical, data link, network, and transport architecture of the Zodiac testbed.

### Physical & Logical Topology Map

```text
                                         ┌─────────────────────────────────────────────┐
                                         │           WAN / Internet (ISP NAT)          │
                                         └──────────────────────┬──────────────────────┘
                                                                │
                                         ┌──────────────────────┴──────────────────────┐
                                         │  ISP Wi-Fi Router & Extender (gw 10.0.0.1)  │
                                         │ Lab LAN 10.0.0.0/24 — trusted household L2 │
                                         └───┬──────────────────┬──────────────────────┘
                                             │                  │ Lab Wi-Fi (802.11)
                   ┌─────────────────────────┘                  ├────────────────────────────────────┐
                   │ Extender RJ45 → uplink switch #2 P5        │ 10.0.0.15                          │ 10.0.0.119
                   ▼                                            │                                    │
┌─────────────────────────────────────┐                         │                                    │
│ NETGEAR GS105Ev2 (uplink switch #2) │                         │                                    │
├─────────────────────────────────────┤                         │                                    │
│ P5: ISP mesh / extender (RJ45)      │                         │                                    │
│ P4: → Zodiac P2 (100M)              │                         │                                    │
│ P3: O3 mirror dest; P1-P2 free      │                         │                                    │
└──────────────────┬──────────────────┘                         │                                    │
                   │ P4 RJ45 → Zodiac P2                        │                                    │
                   ▼                                            ▼                                    ▼
┌─────────────────────────────────────┐     ┌───────────────────────────────────────┐   ┌────────────────────────┐
│           Zodiac FX Switch          │     │         Jetson Orin Nano Super        │   │    Mac Workstation     │
│   (SAM4E8E / KSZ8795CLX, FW 0.86)   │     │    (SDN Controller & Sentinel Host)   │   │  (Operator Terminal)   │
├─────────────────────────────────────┤     ├───────────────────────────────────────┤   ├────────────────────────┤
│ P2: Uplink switch #2 P4 (VLAN 100)  │     │ • Mgmt:    10.0.0.15  (wlP1p1s0)      │   │ Wi-Fi en0: 10.0.0.119  │
│ P4: Controller 10.0.1.99 (VLAN 200) │◄───►│ • Control: 10.0.1.8   (enP8p1s0)      │   │ Tailscale:             │
│ P3: Mirror Tap → Jetson  (VLAN 100) │────►│ • Tap NIC: enx9c69d39dd0a6 (USB)      │   │   100.112.223.16       │
│ P1: Workload Ingress     (VLAN 100) │     │ • O3 NIC: enx9c69d39ddcc0 (USB 3)     │   │ No Ethernet to Zodiac  │
└──────────────────┬──────────────────┘     │ • Bridge :3003 HTTP, :6633 OpenFlow   │   └────────────────────────┘
                   │                        │ • Ollama qwen2.5:3b  :11434 (local)   │
                   │                        │ • Tailscale 100.118.64.16             │
                   │                        └───────────────────────────────────────┘
                   │ P1 RJ45 100M — Port 1 Isolation Policy (see below)
                   ▼
┌─────────────────────────────────────┐
│           NETGEAR GS105Ev2          │
│     (5-Port Easy Smart Managed)     │
├─────────────────────────────────────┤
│ P5: Uplink → Zodiac P1 (100M)       │
│ P4: RPi 5 + Hailo-8 (GbE, 10.0.2.51)│
│ P3: RPi 3B+ (GbE, 10.0.2.50)        │
│ P2: RPi 5 USB-GbE (capture NIC)     │
│ P1: agentic-node-02 (GbE, 10.0.2.52)│
└───────────┬─────────────────────┬───┘
            │ P4 RJ45             │ P3 RJ45
            ▼                     ▼
┌──────────────────────────────────────┐ ┌────────────────────────┐
│     Raspberry Pi 5 + Hailo-8 (26T)   │ │    Raspberry Pi 3B+    │
│     (Adversarial Workload)         │ │ (Untrusted Workload 1) │
├──────────────────────────────────────┤ ├────────────────────────┤
│ Data Plane: 10.0.2.51 (eth0)         │ │ Data: 10.0.2.50 (eth0) │
│ Mgmt Tether: 10.0.0.179 (wlan0)      │ │ Mgmt: 10.0.0.45 (wlan0)│
│ never-default on eth0, HailoRT 4.20  │ │ never-default on eth0  │
└──────────────────────────────────────┘ └────────────────────────┘

Port 1 Isolation Policy (installed by zodiac-bridge-server on OpenFlow ready):
  prio 65535  quarantine DROP (sentinel)                       — always wins
  prio 200    P1 IPv4 10.0.2.0/24 → 10.0.2.0/24    → [P2, P3]  — intra-segment only
  prio 200    P1 ARP                               → [P2, P3]
  prio 150    P1 anything else                     → [P3]      — tap only, never P2
  prio 200    P2 IPv4 → 10.0.2.0/24, P2 ARP        → [P1]
  prio 100    P3 (Jetson tap) → [P1]
  prio 0      table-miss DROP                                  — fail-closed

Tailscale overlay (100.64.0.0/10): Jetson 100.118.64.16 ⟷ Mac 100.112.223.16 ⟷ rpi-hailo (RPi 5) 100.114.195.7 ⟷ agentic-node-01 100.79.152.36 ⟷ agentic-node-02 100.105.255.18;
Jetson advertises 10.0.0.0/24 + 10.0.1.0/24 as subnet router and acts as exit node.
RPi 5 MUST configure '--accept-routes=false' (RouteAll: false) to prevent Jetson's advertised
10.0.0.0/24 route from hijacking local wlan0 return traffic in Linux policy table 52.
The 10.0.2.0/24 workload subnet is NOT advertised.
```

### 802.1Q VLAN Matrix

| VLAN ID | Name | Type | Member Ports | Purpose & Forwarding Domain |
| :--- | :--- | :--- | :--- | :--- |
| **VLAN 100** | `OpenFlow` | OpenFlow Data Plane | Zodiac Ports 1, 2, 3<br>Netgear Ports 3, 4, 5 (Untagged PVID 1/100); Port 2 = RPi 5 capture NIC (mirror destination, VLAN membership TBD) | Forwarding data plane. Subject to OpenFlow 1.3 `FLOW_MOD` match-action pipelines. Isolated from switch MCU management. |
| **VLAN 200** | `Controller` | Native Switch Mgmt | Zodiac Port 4 | Dedicated controller communication channel between Zodiac switch firmware and Jetson Orin Nano (`10.0.1.8:6633`). |
| *VLAN 101/102* | *Multi-Tenant (Planned)* | *802.1Q Tagged* | *Netgear P3 (VLAN 101: RPi 3), P4 (VLAN 102: RPi 5), P5 (Trunk)* | *Roadmap Milestone 4A multi-tenant workload separation before Zodiac Port 1 ingress.* |

### Physical Hardware Identity & Profile Ledger

| Node / Silicon | Hardware / SoC | MAC / Serial / ID | Network Interfaces | Roles & Capabilities |
| :--- | :--- | :--- | :--- | :--- |
| **Zodiac FX Switch** | Atmel SAM4E8E + KSZ8795CLX | DPID `0x70b3d58740c9`<br>MAC `70:B3:D5:87:40:C9`<br>FW `0.86`<br>UID `1396191488-826951736-858797360-925970489` | Port 1 (Workload)<br>Port 2 (Uplink switch #2, port 4; was the ISP extender until 2026-10-09)<br>Port 3 (Tap)<br>Port 4 (Mgmt) | 128-rule OpenFlow 1.3 switch fabric; hardware MIB counters via CDC-ACM `/dev/ttyACM0`. |
| **NETGEAR GS105Ev2 (zodiac_netgear_1)** | 5-Port Gigabit Smart Managed Switch | Model GS105E v2<br>MAC `28:94:01:8b:70:d9` | Port 4 (RPi 5 GbE)<br>Port 3 (RPi 3B+ GbE)<br>Port 2 (RPi 5 USB-GbE capture NIC; mirror destination for P5, both directions verified 2026-10-07)<br>Port 1 (RPi 3B+ `agentic-node-02` GbE)<br>Port 5 (Zodiac Port 1 Uplink 100M) | Intermediate Gigabit aggregation layer for Workload subnet. 128 KB shared packet buffer; IEEE 802.3x Flow Control ENABLED to propagate backpressure across 1Gbps -> 100Mbps speed transition; store-and-forward latency (~12 µs GbE ingress + ~120 µs 100M egress per 1518B MTU); loop detection enabled, IGMP snooping disabled; 802.1Q tagging readiness (fail-closed drop on untagged frames for trunking). Management IP `192.168.0.239`. VLANs (since 2026-10-12): VLAN 1 = P1, P3, P4, P5; VLAN 2 = P2 only, which isolates the Pi 5 capture NIC's mirror port after it was found to accept ingress. |
| **Jetson Appliance** | NVIDIA Jetson Orin Nano Super | Serial `1791626120820` | `wlP1p1s0` (`10.0.0.15`)<br>`enP8p1s0` (`10.0.1.8`)<br>`enx9c69d39dd0a6` (O2 tap, Zodiac P3)<br>`enx9c69d39ddcc0` (O3 capture, switch #2 P3, USB 3)<br>`br-sim` (Internal OVS) | Master SDN controller, Sentinel ML daemon, the Coral Edge TPUs were removed on 2026-10-11 (`zodiac-coral.service` disabled); hosts Open vSwitch 2.17.12 in userspace `netdev` mode (`br-sim`) for software reference evaluation and large-scale rule verification. |
| **Raspberry Pi 5** | Broadcom BCM2712 + Hailo-8 (26 TOPS) | Hostname `rpi-hailo` (renamed from `agentic-node-02`, 2026-10-09)<br>MAC `98:fe:54:52:9d:85` | `wlan0` (`10.0.0.179`)<br>`eth0` (`10.0.2.51`)<br>Realtek RTL8153 USB 3.0 GbE (`0bda:8153`) capture NIC `eth1` (MAC `a0:ce:c8:0e:73:f7`, NETGEAR Port 2) | Adversarial edge workload, Red Team workload generator, 26 TOPS INT8 PCIe Gen 3.0 coprocessor host, line-rate GbE traffic engine. Hosts one Coral Edge TPU (USB 3.0 on its own bus; enumerates as `1a6e:089a`; idle, no Edge TPU runtime installed). |
| **Raspberry Pi 3B+** | Broadcom BCM2837B0 | Hostname `agentic-node-01`<br>User `agent` | `wlan0` (`10.0.0.45`)<br>`eth0` (`10.0.2.50`; also carries `10.0.1.50/24`, see caveat 8) | Untrusted agent workload node, iperf3 client traffic generator. |
| **Raspberry Pi 3B+** | Broadcom BCM2837B0 (Rev 1.4) | Hostname `agentic-node-02` (added 2026-10-09)<br>User `agent`, key-only SSH<br>`eth0` MAC `b8:27:eb:79:ff:0a`, `wlan0` MAC `b8:27:eb:2c:aa:5f` | `wlan0` (`10.0.0.177`)<br>`eth0` (`10.0.2.52/24`, profile `eth0-sdn`, never-default)<br>`tailscale0` (`100.105.255.18`) | Second untrusted workload node; planned legitimate client. Raspberry Pi OS Lite 64-bit (Debian 13), `arp_ignore=1`, `arp_announce=2`. Cabled to NETGEAR Port 1. |
| **Mac Workstation** | Apple Silicon Workstation | MAC `f2:5b:dc:7d:21:d4` | `en0` (`10.0.0.119`, Wi-Fi)<br>`tailscale0` (`100.112.223.16`) | Operator terminal. Connected strictly via Wi-Fi and Tailscale mesh (no direct physical Ethernet link to Zodiac). |
| **ISP Wi-Fi Extender** | Lab LAN / WAN Bridge | Gateway `10.0.0.1` | RJ45 Ethernet Port | Connected to uplink switch #2 port 5 (was Zodiac Port 2 until 2026-10-09); provides L2 attachment to lab LAN / WAN gateway. |
| **NETGEAR GS105Ev2 (zodiac_netgear_2)** | 5-Port Gigabit Smart Managed Switch | Model GS105E v2<br>MAC `28:94:01:8b:70:e5` | Port 5 (ISP mesh / extender)<br>Port 4 (Zodiac Port 2)<br>Port 3 (Jetson O3 capture NIC `enx9c69d39ddcc0`, mirror destination)<br>Ports 1 and 2 free | Lab-side L2 aggregation for the uplink (uplink switch #2); installed 2026-10-09 carrying those two links. Port mirroring of port 4 (the Zodiac P2 link) to port 3 is configured as observation point O3, confirmed in the UI and persistent across a switch power cycle (2026-10-12); 802.3x flow control is on for P4 and P5 and off on the mirror destination. VLANs: VLAN 1 = P4, P5; VLAN 2 = P1, P2, P3 (isolates the mirror port after it was found to accept ingress). Static management IP assigned at `192.168.0.240` to avoid address collision with `zodiac_netgear_1` (`192.168.0.239`); IEEE 802.3x Flow Control enabled to propagate backpressure across GbE -> 100M speed boundary. |

### L3 Subnet & Addressing Schema

| Subnet CIDR | Interface / Segment | Scope | Purpose |
| :--- | :--- | :--- | :--- |
| `10.0.0.0/24` | `wlP1p1s0` (Jetson), `wlan0` (Pi 3 & Pi 5), `en0` (Mac), Zodiac Port 2 | Out-of-Band Mgmt & Gateway Uplink | SSH management, Internet gateway egress (`10.0.0.1`), physical uplink from Zodiac Port 2 to the ISP extender via uplink switch #2 (since 2026-10-09). |
| `10.0.1.0/24` | `enP8p1s0` (Jetson `10.0.1.8`) -> Port 4 (`10.0.1.99`) | Switch Control Plane | OpenFlow 1.3 control channel (`10.0.1.8:6633` <-> `10.0.1.99:6633`). |
| `10.0.2.0/24` | `eth0` (`agentic-node-01`: `10.0.2.50`, `rpi-hailo`: `10.0.2.51`, `agentic-node-02`: `10.0.2.52`) -> Netgear P3/P4/P1 -> P5 -> Zodiac P1 | Untrusted Data Plane Subnet | Workload packet plane governed by SDN flow tables. Isolated from `10.0.0.0/24` lab LAN and WAN by the verified Port 1 Isolation Policy ([port1-isolation.ts](file:///Users/andymorven/git/agentic-era-networking/src/sdn/port1-isolation.ts)): only IPv4 with src AND dst in `10.0.2.0/24`, plus ARP, may cross P1⟷P2; everything else from P1 is mirrored to the P3 tap only. Residual: ARP crosses P1⟷P2 (address disclosure only) until FW 0.86 `ARP_TPA` matching is verified. |
| `192.168.0.0/24` | NETGEAR management (`zodiac_netgear_1`: `192.168.0.239`, MAC `28:94:01:8b:70:d9`; `zodiac_netgear_2`: `192.168.0.240`, MAC `28:94:01:8b:70:e5`) | Switch Management (Out-of-Band, Operator-Only) | Smart-switch web UI (HTTP :80). Not routed anywhere; reached only by a temporary `192.168.0.x/24` alias on a connected host NIC. See *NETGEAR Management Access*. |
| `100.64.0.0/10` | `tailscale0` (Jetson `100.118.64.16`, Mac `100.112.223.16`) | WireGuard Mesh | Remote operator access, secure WAN exit node (`174.181.87.229`). |

### NETGEAR Management Access

Two managed switches exist in the testbed topology:

- **`zodiac_netgear_1` (Workload-Side Switch)**: IP `192.168.0.239`, MAC `28:94:01:8b:70:d9`. Attached to Zodiac Port 1. Reached via workload host `eth0` (e.g. `rpi-hailo` or `agentic-node-01`).
- **`zodiac_netgear_2` (Uplink Switch #2)**: IP `192.168.0.240`, MAC `28:94:01:8b:70:e5`. Attached between ISP Wi-Fi Extender (P5) and Zodiac Port 2 (P4). Reached via lab LAN host `wlan0` (e.g. `rpi-hailo`). Distinct IP prevents ARP/IP collisions.

- *Management Plane Isolation:* Under the Port 1 Isolation Policy ([port1-isolation.ts](file:///Users/andymorven/git/agentic-era-networking/src/sdn/port1-isolation.ts)), IPv4 traffic to `192.168.0.0/24` is fail-closed quarantined from Port 2 (`in_port=1, dst 192.168.0.x → [P3]` tap only), ensuring management traffic to the workload switch never transits Port 2.
- *Rate Transition & Flow Control (NET-010):* `zodiac_netgear_2` mediates the speed transition between the Gigabit ISP mesh and the 100BASE-TX Zodiac Port 2 link. IEEE 802.3x Flow Control is enabled on the GS105Ev2 ports to push backpressure via standard PAUSE frames toward the gigabit source during bursts, preventing silent buffer exhaustion or tail-drops in the switch's 128 KB buffer. Observation point O3 (mirror of `zodiac_netgear_2` Port 4 to Port 3, captured by the Jetson) records what actually crosses the Zodiac P2 link and has been live since 2026-10-12.

**Automated Tunneling & Permanent Boot Persistence:**
The operational procedure is codified in [.agents/workflows/netgear-switch-access.md](file:///Users/andymorven/git/agentic-era-networking/.agents/workflows/netgear-switch-access.md) and automated by [scripts/netgear-tunnel.sh](file:///Users/andymorven/git/agentic-era-networking/scripts/netgear-tunnel.sh).

1. **Persistent Operator Access across Reboots (Invariant 3 Compliant):**
   - **macOS LaunchAgent (`com.zodiac.netgear-tunnels`):** Registered in `~/Library/LaunchAgents/` using [deploy/mac/zodiac-netgear-tunnel-supervisor.sh](file:///Users/andymorven/git/agentic-era-networking/deploy/mac/zodiac-netgear-tunnel-supervisor.sh). Starts on boot/login, reconnects across sleep/wake, and multiplexes local ports `:8888` and `:8889` over persistent SSH.
   - **Zero Standing Routes on Pivot Host (Invariant 3):** Routes to `192.168.0.0/24` are deliberately **not** persisted as a systemd unit or static configuration on the Raspberry Pi. Instead, the supervisor executes a trapped SSH session (`trap cleanup EXIT INT TERM HUP`). Routes and aliases on the pivot exist strictly while the operator's authenticated SSH session is active, and are immediately sanitized if the connection drops, Mac sleeps, or operator logs out.

```bash
# Install & activate supervisor LaunchAgent:
npm run switch:service:install

# Status check (verifies LaunchAgent, pivot ephemeral isolation, and probes HTTP endpoints):
npm run switch:service:status

# Restart persistent supervisor:
npm run switch:service:restart

# Uninstall LaunchAgent & restore fail-closed isolation:
npm run switch:service:uninstall
```

2. **Ad-Hoc Interactive Sessions (Foreground with Trap):**

```bash
# Workload switch #1 (192.168.0.239 via eth0 -> http://localhost:8888/):
npm run switch:workload     # foreground session; Ctrl+C cleans up routes

# Uplink switch #2 (192.168.0.240 via wlan0 -> http://localhost:8889/):
npm run switch:uplink       # foreground session; Ctrl+C cleans up routes

# Explicit teardown & flush (preserves fail-closed Invariant 3):
npm run switch:stop         # or ./scripts/netgear-tunnel.sh stop
```

Once connected, browse to:
- **Switch #1 (Workload):** `http://localhost:8888/` (default password: `password`)
- **Switch #2 (Uplink):** `http://localhost:8889/` (default password: `password`)

**Manual Setup (Reference):**

```bash
# To access zodiac_netgear_1 (192.168.0.239) via workload eth0 (Port 8888):
ssh agent@10.0.0.179 "sudo ip addr add 192.168.0.51/24 dev eth0 2>/dev/null; sudo ip route replace 192.168.0.239/32 dev eth0 src 192.168.0.51; sudo ip neigh replace 192.168.0.239 lladdr 28:94:01:8b:70:d9 dev eth0"
ssh -f -N -o ExitOnForwardFailure=yes -L 8888:192.168.0.239:80 agent@10.0.0.179

# To access zodiac_netgear_2 (192.168.0.240) via lab LAN wlan0 (Port 8889):
ssh agent@10.0.0.179 "sudo ip addr add 192.168.0.179/24 dev wlan0 2>/dev/null; sudo ip route replace 192.168.0.240/32 dev wlan0 src 192.168.0.179; sudo ip neigh replace 192.168.0.240 lladdr 28:94:01:8b:70:e5 dev wlan0"
ssh -f -N -o ExitOnForwardFailure=yes -L 8889:192.168.0.240:80 agent@10.0.0.179
```

**Port mirroring (operator-confirmed in the UI 2026-10-07):** source Port 5, destination Port 2. The RPi 5 was rebooted but the NETGEAR was not power-cycled, so persistence of this config across a switch power cycle remains unverified. On 2026-10-12 the destination port was found to accept ingress and was isolated in its own VLAN (VLAN 2 = P2 only); the re-test was negative (see caveat 10).

**O3 port mirroring on `zodiac_netgear_2` (operator-confirmed in the UI, 2026-10-11/12):** source Port 4 (the Zodiac P2 link), destination Port 3, where the Jetson's O3 capture NIC is cabled. The switch was power-cycled and the mirror persisted. The destination port was found to accept ingress (see caveat 10) and was isolated into its own VLAN on 2026-10-12; the ingress claim documented for `zodiac_netgear_1` is untested.

### L4 Transport & Protocol Bindings

| Port / Protocol | Service | Direction | Security & Performance Invariant |
| :--- | :--- | :--- | :--- |
| `TCP 6633` | OpenFlow 1.3 Controller | Jetson Ingress (from Port 4) | Isolated to VLAN 200; BigInt wire serialization; fail-secure. Dedicated to physical Zodiac FX switch. |
| `TCP 6634` | OpenFlow 1.3 Testbed Channel | Jetson Localhost (`br-sim`) | Dedicated virtual testbed port for Open vSwitch `br-sim` (`netdev` bridge). Isolated from live Zodiac controller on `TCP 6633` to prevent single-socket controller collision (`openflow-server.ts:422`). |
| `TCP 5201` | iperf3 TCP/UDP Benchmark | Lab LAN Ingress (`10.0.0.x` / `10.0.2.x`) from Pi (`10.0.2.50`) | Port 1 ⟷ Port 2 data-plane transit testing across ISP extender uplink; zero-suppression integer throughput metering. |
| `UDP 53` | RFC 1035 DNS Wire Server | Jetson Ingress / Workload | Default-drop on unrecognized domains; fail-closed resolver. |
| `TCP 3003` | Zodiac Bridge HTTP / SSE | Local / Tailscale | Read-only telemetry exposition; real-time hardware status. |
| `TCP 9100/9105` | Prometheus Metrics Exporter | Local / Scraping | 64-bit integer counters; zero floating point precision drift. |
| `TCP 11434` | Ollama LLM Service (`qwen2.5`) | Localhost only | Out-of-band telemetry analysis; non-blocking to packet flow. |
| `TCP 8000` | Hailo-8 Neural Inference Service (FastAPI) | RPi 5 Ingress (`10.0.0.179` / `10.0.2.51`) | Exposes 26 TOPS NPU; sub-11ms DMA inference; monotonic nanosecond latency accounting (INV-2); epistemic silicon telemetry (INV-6); daemonized via `hailo-inference.service`. |

---

## 2. Silicon Budgets & Forwarding Capacity Ledger

Tracks physical hardware limits to prevent table exhaustion, bufferbloat, and out-of-memory crashes.

| Subsystem | Hardware / Engine | Physical Capacity | 80% High-Water Mark | Mitigation on Exhaustion |
| :--- | :--- | :--- | :--- | :--- |
| **Switch Flow Table (Physical)** | Zodiac FX (SAM4E8E MCU) | **128 flow entries** | **102 rules** | Enforce `/24` or `/16` CIDR supernet aggregation; reject `/32` host bloat. |
| **Switch Flow Table (Virtual/OVS)** | Open vSwitch 2.17.12 (`br-sim`, `netdev`) | **10,000 flow entries** | **8,000 rules** | Software reference evaluator on Jetson. Memory bounded (~15MB userspace table) to protect Jetson unified RAM. Hard cap enforced by Track A verifier before installation. |
| **Kernel Interval Sets** | Linux netfilter (`nftables`) | System RAM bounded | **10,000 subnets** | Subnet LRU eviction (`bounded-lru.ts`) + automatic coarse `/16` aggregation. |
| **Sentinel Daemon State** | systemd cgroup | `MemoryMax=64M` | **51.2 MB** | Count-Min Sketch fixed table; zero unbounded array allocation. |
| **Edge TPU DPI Queue (parked: no Corals on the Jetson since 2026-10-11)** | Google Coral USB (4 TOPS) | Sub-4ms batch inference | **80% Duty Cycle** | Shed non-SYN packet evaluation; prioritize handshake triage. |
| **Edge NPU Coprocessor** | Hailo-8 M.2 (RPi 5 PCIe Gen 3) | **26 TOPS INT8** | **80% Duty Cycle** | CNN inference only (HEF via Hailo Dataflow Compiler); advisory on the untrusted tier, never an enforcement input. Not an LLM runtime; traffic generation is host CPU/NIC-bound. |
| **Aggregation Buffer** | NETGEAR GS105Ev2 | **128 KB SRAM** (~85 MTU frames) | **102.4 KB (80%)** | Enforce IEEE 802.3x PAUSE backpressure + host-side egress pacing on RPi (`tc qdisc replace dev eth0 root fq maxrate 95mbit`) to prevent 10:1 rate mismatch tail-drops. |

---

## 3. Roadmap State

Current scope is a real-hardware testbed and verifier for agent-proposed SDN policy ([ROADMAP.md](../docs/ROADMAP.md)). The earlier phase list (including "Phase 4: SymbolicRouteVerifier loop-free DAGs") was superseded on 2026-10-09: that check could not reject its input and was removed.

### Track A: Policy verifier

- [x] **A1 Isolation, A2 hairpin**: `verifyPort1Isolation` (`src/sdn/port1-isolation.ts`); plan-level table budget, hairpin and DROP semantics in `verifyPlanAdmissible` (`src/sdn/dataplane-benchmark.ts`).
- [x] **Readback on match fields**: `verifyIsolationReadback`.
- [x] **A5 and A6 implemented** (`src/sdn/rule-hygiene.ts`): shadowing (including coverage by several rules together) and equal-priority conflicts, plus duplicate match and priority keys. Not yet in the bridge install path.
- [x] **Action-level readback implemented** (`src/sdn/flow-actions.ts`, `src/sdn/action-readback.ts`): output ports and the table-miss drop are checked from the flow-stats instruction block. **Measured 2026-10-15** with the read-only probe (`GET /api/zodiac/flows/probe`, `npm run probe:flows`): firmware 0.86 reports the instruction block; six rules byte-identical to the controller's encoding, table-miss drops; evidence in `docs/benchmarks/results/flow-probe/`. **Recorded in the bridge's isolation status** (`src/sdn/isolation-status.ts`; `GET /api/zodiac/flows` -> `port1Isolation.actions` and `provenForwarding`): `state` is `mismatch` if the switch reports different actions or an OFPT_ERROR (including one that arrives after a verified readback), and stays `verified` with `provenForwarding` false if the switch reports no actions. The status is point-in-time: read `port1Isolation.checkedAgeMs` with it. The bridge re-reads and re-verifies the table every 60 s by default (`src/sdn/isolation-recheck.ts`, `ZODIAC_ISOLATION_RECHECK_INTERVAL_MS`, `0` disables), read-only and damped; look for `Isolation re-check:` lines in the journal. Still open: the dashboard does not show it, and a mismatch is recorded, not acted on. Takes effect on the Jetson after the next deploy and restart.
- **Dashboard flicker incident (found 2026-10-16): a second bridge pushing to production.** Symptom: "Hardware Disconnected" / "Degraded Link" on every device several times a minute, the Mac nearly always red, and dips to zero on the graphs, while no device had actually disconnected (the Jetson bridge's own snapshot was unchanged across 77 samples; its series had no gap over 8 s). Cause: a **second bridge on the Mac** (`npm run serve`, started 2026-10-12 23:46, environment pointing at the production relay) had no hardware, reported `source: disconnected` with all ports DOWN and the Jetson offline, and pushed that to the same endpoint **every ~2.5 s** next to the real bridge's push every ~5 s. The cloud kept one in-memory snapshot and the last writer won, so about two thirds of polls were served the disconnected view, and its zero-rate points were merged into the shared series. The UI tolerates 3 consecutive non-live polls, but with a 2/3 chance per poll a run of 3 occurs about every 17 s. Evidence: Vercel runtime logs (`npx vercel logs <domain> --json`: 0.60 POST/s with pairs under a second apart, then 0.20/s with a 4.6-5.2 s interval after the stray was stopped), and the stray's outbound byte counter (~278 KB every ~2.5 s). Stopped 2026-10-16 23:58. Fix in code: the cloud now ignores a non-live push while a live one is fresh (`src/sdn/relay-authority.ts`), unless it comes from the sender that reported live; the bridge sends a stable `bridgeId` and pauses 60 s when told it was ignored. Takes effect on the cloud when merged (deploys with main); the bridge half needs a Jetson deploy. **Database hydration fixed (2026-10-16, option 1):** the old hydration rebuilt a snapshot from one telemetry row and filled devices it had no data for from "connected" defaults under a `live_hardware` label (the Pi 5 was not persisted at all). The cloud now writes the live snapshot the bridge pushed, as received, to a single `ZodiacLatestSnapshot` row (`src/sdn/stored-snapshot.ts`, `persistLatestSnapshot` in `src/db/telemetry-db.ts`; only live snapshots are written, series cut to the newest point, capped at `ZODIAC_STORED_SNAPSHOT_MAX_BYTES`, default 512 KiB) and hydrates from it with nothing synthesized: a block the bridge did not send stays absent and shows as not reported. Any read failure, stale, non-live or malformed row hydrates nothing. The table was created in production Neon on 2026-10-16 with `prisma/migrations/20261016000000_zodiac_latest_snapshot/migration.sql` (`CREATE TABLE IF NOT EXISTS`; the repo had no migration baseline, so `prisma migrate deploy` is not used and the SQL was applied directly). Tests: `test/invariants/latest-snapshot-hydration.test.ts` (database mocked; not yet exercised against the real database under a cold instance). **Still open:** the dashboard has not been checked for how it renders a block that is absent. **Relay default removed (2026-10-16):** the bridge entry point no longer defaults `ZODIAC_CLOUD_RELAY_URL` to production; unset means no relay and a warning (`resolveCloudRelayUrl`). The Jetson sets it explicitly in `/etc/zodiac/zodiac-bridge.env`, so it is unaffected; any other deployment that relied on the default must now set it.
- **Jetson copilot offline, then Qwen removed from the Jetson (2026-10-16).** Ollama could not load `qwen2.5:3b` (`/api/generate` returned HTTP 500, `cudaMalloc failed: out of memory` on a 1.83 GiB buffer: CPU and GPU share 8 GB and about 2 GB was page cache the GPU allocator cannot reclaim), and the copilot endpoint answered 200 from its deterministic fallback, so it looked up. Dropping caches and restarting Ollama loaded it (100% GPU, 5.5 s per summary) but left about 1.9 GB free on the box that runs the bridge and the TensorRT detector, and the summary only restated numbers the bridge already computes. Decision: the model was unloaded and deleted from the Jetson (`ollama list` empty; re-pull with `ollama pull qwen2.5:3b`), so the copilot serves its deterministic fallback until it is pointed at the Mac's Ollama via `OLLAMA_API_URL`. The roadmap's "Jetson Qwen as a cheaper comparison" role is therefore not available. Still to do: a visible `fallback` marker on the copilot response, and the `model` label (it read "qwen2.5:3b (Jetson Orin Nano Super)"; not checked whether it is hard-coded). **GPU utilization is not a target:** the Jetson GPU runs only `zodiac-trt` (MobileNet V2 INT8 on the Port 3 tap) and read 0% on a quiet tap; the Hailo-8 is healthy (`yolov8s_h8.hef` loaded, about 42 °C) and idle by design while parked as a sensor. No utilization-under-load figure has been measured for either. **Copilot `activeRules: 0` while 6 rules are installed is a mislabeled metric, not a controller/switch desync:** `activeRules` and `openflow.activeFlows` are the size of the bridge's in-memory `flowRuleRegistry` (rules installed through its quarantine and install paths; lost on restart; excludes the isolation policy), while the switch's own readback (`port1Isolation`, `checkedAgeMs` 1) confirmed all six policy rules and table-miss drop. The count should come from the switch's flow-stats readback or be labelled as the registry; not yet changed.
- **Jetson GPU detector could not see mirrored traffic (found 2026-10-16).** The `zodiac-trt` daemon reads the Zodiac P3 tap on `enx9c69d39dd0a6` through an `AF_PACKET` socket but never enabled promiscuous mode, and the NIC was at `promiscuity 0`. The P3 mirror copies frames with their original destination MACs, so the NIC discarded nearly all of them in hardware. **Measured:** 150 ICMP echoes from `agentic-node-02` (`10.0.2.52`) to the Mac's `10.0.2.119` alias crossed the switch with 0% loss; Zodiac P3 `tx` rose by 212 frames over the run (119230 to 119442) while the tap NIC's `rx_packets` stayed at 678 (it had received 656 frames in four days, all broadcast or multicast addressed); the O3 capture NIC, which is promiscuous, counted 530 in the first 31 s run. So the GPU's 0% reading reflected a blind input, not a quiet network, and any precision or recall from it before this fix is not meaningful. Fix (`scripts/trt-inference-daemon.py`): the daemon enables `PACKET_MR_PROMISC` on its own socket (released when the socket closes; failure puts it in standby with a warning rather than running blind), and the unit template now pins `TAP_INTERFACE` instead of taking the first `enx*` in directory order. **Not yet verified:** the fix needs the daemon restarted on the Jetson (`sudo systemctl restart zodiac-trt`, after pulling); the same ping test should then move the tap NIC's counter by about the P3 `tx` delta.
- **Auto-quarantine installed a DROP on the physical switch with no approval (found 2026-10-16, right after the tap fix).** With the tap NIC promiscuous the `zodiac-trt` detector saw traffic for the first time and, during the 150-ping test from `agentic-node-02` (`10.0.2.52`, about 5 packets per second against a 10 pps threshold), auto-quarantined it: a priority-65535 DROP on `srcIp 10.0.2.52`, installed 18:57:44, 185 packets dropped, which turned the ping from 0% to 100% loss. The switch showed 8 entries (7 normally); echo requests reached P1 `rx` but not P2 `tx` or P3 `tx`. Why a 5 pps source crossed the threshold is **unexplained**. A forwarding loop duplicating frames is unlikely from what was seen (both 150-ping runs reported 0% loss and no `DUP!` replies, and the tap NIC's `rx_packets` rose by exactly the P3 `tx` delta); the daemon's window arithmetic over bursty USB-NIC delivery is a candidate and was not checked. The path (`_quarantine_worker` -> `POST /api/sdn/quarantine`) has no verifier and no person, which contradicts Invariant 4 and the roadmap's "any quarantine still passes the verifier and a human gate"; it only never fired before because the tap was blind. The local audit log (`/var/lib/zodiac/quarantine-audit.jsonl`) has the event; the Neon copy failed (`Neon table unavailable`, cause not investigated). Released with the operator's approval via `POST /api/sdn/release` (switch back to 7 entries, pings 5/5). **Envelope for `enforce` (merged in #54):** a person approving every quarantine would be minutes against a detector's milliseconds, so a person approves the limits instead (`src/sdn/quarantine-envelope.ts`, enforced in the bridge's `requestQuarantine`): a single source IPv4 inside `10.0.2.0/24` only (a MAC alone is refused: it cannot be scope-checked), never the segment's network or broadcast address or an address in `ZODIAC_QUARANTINE_PROTECTED_IPS` (a malformed entry makes the bridge refuse every quarantine), at most `ZODIAC_QUARANTINE_MAX_ACTIVE` at once (default 8 of the 128 entries, bounded 1..32), and a time limit `ZODIAC_QUARANTINE_TTL_MS` (default 300 s, bounded 10 s..1 h) after which the bridge's own sweep lifts the rule (checked every 5 s; a rule that cannot be lifted is kept and retried) and the rule also carries an OpenFlow hard timeout so the switch can drop it if the bridge dies. Refusals return 400/403/409/429/503 with a code. **What this is not:** it does not make the detection correct, and source IPs are forgeable on the untrusted segment, so an attacker can still choose which in-scope, unprotected host is blocked (for up to the time limit); list essential hosts in the protected list before enabling `enforce`. **Measured live 2026-10-16 (two runs, a quarantine on the unused `10.0.2.250`, default 300 s limit):** the switch's own flow-stats entry reports `hard_timeout 300` (idle 0), so the firmware accepts and stores the timeout; the rule was present at 296 s and gone at 301 s (8 entries to 7), and the bridge logged `released: time limit reached` at the limit, so the end-to-end time limit works on the real switch. **Still unmeasured:** whether the firmware itself removes the rule if the bridge is not there. The flow-table read takes about 4 to 5 s, too coarse to tell the switch's expiry from the bridge's sweep, which fire at the same moment. Until that is separated (for example by stopping the bridge during a run), the bridge sweep is the only expiry relied on, and after a bridge restart a still-installed quarantine is no longer in its registry (orphaned until the switch times it out, if it does). The daemon's own evidence bar (sustained rate, not one window) is not changed, because why a 5 pps source crossed the threshold is not yet understood. **Re-observed with the fixed tap and propose mode, then explained (2026-10-16/17):** 150 pings at about 5 pps from `10.0.2.52` passed 150/150 with nothing installed (switch stayed at 7 entries) and the daemon proposed `10.0.2.52` at 18 to 46 pps against the 10 pps threshold. **The detector was right and the network was behaving: the traffic was real, and it was not the pings.** A 125-frame capture on the tap NIC during a 60-ping run held 60 ICMP echoes, 2 ARP requests and 63 UDP frames `10.0.2.52:41641` to `10.0.2.119:41641` (Tailscale's port, packets up to about 1.4 KB), 30 frames in the first second alone: `node-02` and the Mac's `10.0.2.119` alias talk Tailscale peer to peer over the workload segment, through the Zodiac and its tap, when a management session (my own `ssh`/`scp`) opens. Tailscale advertises every interface address as a candidate path and picks the lowest-latency direct one; `agentic-node-01` was on that path continuously (status: Mac at `10.0.2.119:41641`, active). **Retractions:** earlier today this ledger said `node-02` sends only about 6 frames per second and suspected the daemon's read-time stamping; both were wrong (the counter samples ran after the session was open, so they missed the Tailscale burst; kernel receive stamps showed read lag of 0.1 to 6.7 ms and `socketDrops` 0, so the daemon was not behind). The daemon change that made this visible is `SO_TIMESTAMPNS` with `kernelInterArrivalNs`, `readLagNs` and `socketDrops` in each proposal. **Consequences:** management traffic crosses the device under test and pollutes every measurement at the tap; and the 10 pps per-source threshold is a placeholder that any host opening a Tailscale session crosses (it needs a baseline from measured traffic, a Track C task). **Fix prepared, not yet installed:** `deploy/workload/block-tailscale-on-eth0.sh` drops UDP 41641 on `eth0` (input and output, persistent, ordered before `tailscaled`) on each workload node so Tailscale falls back to `wlan0` or a relay; its ruleset passed `nft -c` and its unit `systemd-analyze verify` on `agentic-node-01` (check only), and it needs root on each node. Its effect on the tap traffic is unmeasured until it is run. It does not close `wlan0` or `agentic-node-01`'s `10.0.1.50` control-subnet address. **Installed and measured 2026-10-17:** the script was run by hand on both nodes. Their Tailscale paths to the Mac moved off the segment (`agentic-node-01` to its IPv6 address, `agentic-node-02` to `10.0.0.119`), and the drop counters stayed small (6 in and 4 out on `node-01`; 20 in and 5 out on `node-02`). **The tap still carries about 6.6 frames per second with no test traffic** (idle 60 s capture: 380 frames in 57 s): 138 from `node-01`, 137 from `node-02` and 93 from `rpi-hailo` (`10.0.2.51:8000`), all TCP to the Mac's `10.0.2.119` alias, plus 6 SSDP multicast frames from the NETGEAR switch (`192.168.0.239`) and a few ARP replies. The Mac end is a local dev server (`node scripts/zodiac-cli.ts serve`, started about 20 minutes before the capture, listening on `:3000` and OpenFlow `:6633`, holding connections to the Pi 5's service on both `10.0.2.51:8000` and `10.0.0.179:8000`); the `10.0.2.x` candidate addresses in its probes send that polling through the Zodiac and its tap. It had no cloud relay configured (no relay environment variable and no connection to the cloud), so it was not pushing to the dashboard. So the tap's baseline is not zero, and any detector number taken while that server (or anything like it) runs includes this polling; the 10 pps threshold cannot be set from the tap until the baseline is clean. **Fix (merged in #54):** `QUARANTINE_MODE` defaults to `propose` (log and a bounded `quarantineProposals` list in the daemon's telemetry; nothing installed); only the exact value `enforce` installs, and anything else is treated as `propose`. Not done: nothing yet presents or approves a proposal (no dashboard or approval endpoint for it), so a proposal is currently visible only in the daemon log and telemetry file; a proposal is raised once per source until the daemon restarts. **Qwen was part of this path:** the daemon's out-of-band triage used the Jetson's Qwen to auto-release quarantines it judged benign; with the model removed that step falls back to keep-quarantined, so in `enforce` mode a quarantine now stays until released by hand.
- **A second detector was auto-quarantining all along, and the bridge is now the single place that decides (2026-10-17).** After the Tailscale block and the dev-server stop the idle tap was clean (6 SSDP frames in 60 s) and 150 pings matched exactly (tap `rx` +153 = Zodiac P3 `tx` +153 = detector +153, 0 socket drops), but the next test run was blocked: two quarantine DROPs (`10.0.2.52`, `10.0.2.50`) were installed while `zodiac-trt` was in `propose` with no proposals. Cause: `gpu-sdn-sentinel.service` (`scripts/gpu-sdn-anomaly-sentinel.py`, a 1D-CNN autoencoder reading the same tap; up 4 h 51 m, 6 anomalies and 6 quarantines before the test, 38 after, most repeats refused) posts straight to the bridge and never saw the trt daemon's `QUARANTINE_MODE`. The bridge envelope did apply (scope, cap, `409 already_active` for repeats), and both rules **expired by themselves at the 300 s limit** (installed 02:39:10 and 02:42:00, released by the bridge at 02:44:10 and 02:47:00, switch back to 7 entries): the first real detector's quarantines to clear without anyone acting. Whether the autoencoder's weights are trained, and on what, was not checked. **Change (this branch):** `ZODIAC_QUARANTINE_MODE` (`propose` by default; only the exact value `enforce` installs) is read by the bridge and applied in `requestQuarantine` after the envelope, so every detector obeys it; a proposal is held per source (bounded, 10 minutes to approve), listed by `GET /api/sdn/quarantine/proposals` and approved with `POST /api/sdn/quarantine/approve {"targetIp"}` (which re-checks the envelope; the HTTP wrappers themselves have no test). The trt daemon's own mode and proposal list are removed: it forwards every request with its evidence (rate inputs, inter-arrival gaps, kernel timestamps, read lag) and the bridge keeps it with the proposal. The bridge API has no authentication, so approval is accepted only from loopback (a person on the Jetson, `curl localhost:3003/api/sdn/quarantine/approve`): a process elsewhere on the LAN cannot approve its own proposal (the check is a tested function; the HTTP route that uses it is not). The quarantine request endpoint itself is still open to the LAN, bounded by the envelope. Evidence kept with a proposal is integers only. **Protected list:** set `ZODIAC_QUARANTINE_PROTECTED_IPS` in `/etc/zodiac/zodiac-bridge.env` to `10.0.2.119` (the Mac alias, the benchmark receiver), `10.0.2.51` (the Pi 5) and, **temporarily while test traffic is generated from it**, `10.0.2.52` (`node-02`); remove `10.0.2.52` afterwards or a legitimate client quarantined by the detector stops counting as a false positive in the experiments. Needs a bridge restart (sudo) and a `zodiac-trt` restart to take effect; deployed behaviour is not yet measured.
- **Mac "offline" after the flicker fix (2026-10-16): the workstation agent was not running.** The Mac had read online only because the stray second bridge probed it locally. With that gone, only the Jetson's view counts, and the Jetson bridge had failed 9,600 consecutive probe cycles (about 13 h) against the Mac's agent (`scripts/workstation-agent.ts`, port 11435): nothing was listening. Ollama had not stopped (running 12 days under the `com.ollama.tailscale` LaunchAgent, bound to the Tailscale address only). The agent had been started by hand, so it died with its terminal and nothing restarted it. Fixed by `deploy/macos/install-workstation-agent.sh`: a user LaunchAgent (`com.zodiac.workstation-agent`, start at login, `KeepAlive`), binding the Tailscale address once the bind-address option is merged (until then the old agent code listens on every interface). The first install lacked `/usr/sbin` in `PATH` (`spawn ioreg ENOENT`, no GPU metrics) and a re-install raced `launchctl bootout`; both fixed in the installer. The Jetson's `/etc/zodiac/zodiac-bridge.env` now also carries `WORKSTATION_AGENT_URL=http://100.112.223.16:11435`, read at the next bridge restart; the existing LAN drop-in (`http://10.0.0.119:11435`) keeps working until the agent narrows to Tailscale only.
- **Jetson bridge state (2026-10-15):** `zodiac-bridge` runs under systemd at commit `36920e0`. Before that, a hand-started `nohup node ... serve 3003` (started 2026-10-13 19:41, five minutes after the systemd unit was stopped) had been the live controller for about 30 hours, with the systemd unit inactive; it was stopped gracefully and replaced. Lesson: check `ss -ltnp | grep 6633` for a stray controller before starting the unit, or the new instance fails to bind (`EADDRINUSE`) and sits in DEGRADED_FAULT. Fixed in the follow-up lifecycle change: (a) the bridge no longer spawns `coral-inference-daemon` unless `ZODIAC_ENABLE_CORAL_DAEMON=1` (the Corals are parked; reporting stays STANDBY); (b) when the OpenFlow port cannot be bound the bridge now exits non-zero before starting anything else, so the unit shows failed (`ZODIAC_ALLOW_DEGRADED_CONTROL_PLANE=1` restores the old degraded mode for development), and it no longer prints "controller listening" when it is not. This takes effect on the Jetson only after the next deploy and restart.
- [ ] **A3, A4, A9, A10**: default-drop check (table-miss drop is now checked at the action level, subject to the above), quarantine precedence, layout, ARP confinement. A4 and A9 conflict (forwarding-first is cheaper but outranks quarantine); see the roadmap.
- [ ] **Output-action readback; agent-proposal evaluation.**

### Track B: Hardware model and conformance

- [x] **Cost model fitted and documented**: 38.5 µs + 34.8 ns per payload byte above 64 + 4.24 µs per rule (1.3 µs forwarding-first); see the benchmark whitepaper.
- [x] **First manual conformance run (2026-10-12) at O3, with O2 for comparison:** allowed traffic appeared, blocked traffic did not, local traffic never reached the Zodiac, ARP crossed toward the uplink (6 of 6 requests at both O2 and O3), and O2 saw only P1-ingress copies. All five checks matched the model; details in [ROADMAP.md](../docs/ROADMAP.md), track B. Small sample (ICMP and ARP only, five pings per run, one firmware).
- [x] **Cost model encoded as a pure integer function** (`src/sdn/zodiac-cost-model.ts`), tested against the stored ladder artifacts (12 saturated points, worst error 1.23%, claimed tolerance 2%).
- [x] **A7 and A8 checks implemented** (`src/sdn/capacity-budget.ts`). A7 passes the deployed policy; A8 is `unverifiable` for it because the cost model was measured only on a two-forwarding-rule plus /32 DROP shape. Not yet in the bridge install path.
- [ ] **Measure the deployed isolation policy on hardware so A8 can cover it; one-command automated conformance probe over a larger packet set; open measurement items.**

### Track C: Adversarial testing

- [ ] **ARP spoofing across P1 to P2, intra-segment spoofing, scans, flood to session loss, evasion.** ARP crossing toward the uplink is now confirmed on hardware (conformance run T2b), so the spoofing precondition holds. Injection through the mirror ports was observed on both switches and is mitigated by VLAN isolation (caveat 10). Detector accuracy (Jetson GPU; the Corals are parked) is unmeasured.

### Track D: Provenance and telemetry

- [x] **Provenance-checked telemetry, 30-day local history, read-only cloud relay.** Maintained as invariants evolve.

### Deferred

- Sentinel (bot and crawler mitigation) is frozen ([SENTINEL-ROADMAP.md](../docs/SENTINEL-ROADMAP.md)). Old phases 1, 4 and 5 (DNS reverse proxy, multi-agent routing stability, intent firewall) are dropped or deferred. The planned multi-tenant VLAN 101/102 separation ("Milestone 4A" in the earlier roadmap) is not on the current roadmap.

---

## 4. Network Invariant Compliance Matrix

| Invariant | Title | Core Rule | Status |
| :--- | :--- | :--- | :--- |
| **NET-001** | Data vs. Control Plane Decoupling | Data plane executes in kernel/ASIC (< 1 µs; the Zodiac FX MCU path measures about 58 µs + 4.24 µs per rule); control plane daemons run strictly out-of-band. | **ACTIVE / ENFORCED** |
| **NET-002** | TCAM & FIB Silicon Budgeting | Hardware flow tables bounded (128 rules on Zodiac FX); enforce CIDR prefix aggregation. | **ACTIVE / ENFORCED** |
| **NET-003** | End-to-End Principle & Fate-Sharing | Web origin traffic never shares fate with sidecar agents; fail-open for clean traffic. | **ACTIVE / ENFORCED** |
| **NET-004** | Loop-Free Forwarding & Intent Compliance | No hairpin or isolation leaks in installed rule sets (checked by `verifyPort1Isolation`, `verifyPlanAdmissible`, `checkIntent` A11); exponential backoff hysteresis damping on ACLs. | **PARTLY CHECKED** (shadowing and conflict checks planned; intent compliance active) |
| **NET-005** | Buffer Dynamics & Anti-Bufferbloat | Drop bad packets in `PREROUTING` before socket memory allocation; shape bursts with meters. | **ACTIVE / ENFORCED** |
| **NET-006** | L2/L3 Boundary & MTU/MSS Integrity | 802.1Q VLAN separation; TCP MSS clamped to 1460B to eliminate PMTUD tunneling black holes. | **ACTIVE / ENFORCED** |
| **NET-010** | Intermediate Aggregation & Rate-Transition Integrity | 802.3x Flow Control active across GbE-to-100M transitions; host-to-switch drop reconciliation to prevent telemetry blind spots. | **ACTIVE / ENFORCED** |

---

## 5. Known Operational Caveats & Hardware Runbook

1. **Zodiac FX Serial CDC ACM Enumeration Lockup**:
   - *Symptom*: Switch serial `/dev/ttyACM0` locks up after Jetson reboot while switch remains powered via USB.
   - *Fix*: Power-cycle switch USB cable from Jetson port to force fresh CDC ACM enumeration, then restart `zodiac-bridge.service`.
2. **Dual-Homed Gateway Metric Priority Collision**:
   - *Symptom*: Raspberry Pi workload node loses internet connectivity when `eth0` acquires default route with metric 100.
   - *Fix*: Set `ipv4.never-default yes` on `eth0-sdn` connection; preserve `wlan0` metric 600 default gateway.
3. **Wi-Fi MAC Randomization Drift**:
   - *Symptom*: Workload node changes IP address across DHCP renewal.
   - *Fix*: Set `wifi.cloned-mac-address permanent` on the NetworkManager connection.
4. **NETGEAR GS105Ev2 GbE-to-100M Buffer Overrun & Telemetry Blind Spot**:
   - *Symptom*: RPi 5 (Port 4) or RPi 3B+ (Port 3) transmits bursts at GbE rate into Netgear switch, overflowing the 128KB buffer on egress to Zodiac Port 1 (100BASE-TX). Because the Netgear switch sits outside the OpenFlow control plane, buffer tail-drops do not increment Zodiac MIB drop counters, creating a telemetry blind spot (violating Invariant 6). Furthermore, concurrent transmission at 95 Mbps from both nodes creates 190 Mbps aggregate demand onto the 100M uplink (2:1 oversubscription).
   - *Fix*:
     1. Enable IEEE 802.3x Flow Control on all Netgear ports to push backpressure into the RPi socket queue.
     2. Configure host egress rate pacing: `sudo tc qdisc replace dev eth0 root fq maxrate 95mbit` for single-generator runs, or `maxrate 45mbit` for concurrent multi-agent tests (physically enforced on `rpi-hailo` and the RPi 3B+ nodes `agentic-node-01` and `agentic-node-02`).
     3. Telemetry Reconciliation: Benchmark and monitoring scripts must reconcile host sysfs `tx_packets` against Zodiac Port 1 `rx_packets` to detect any intervening packet loss before entering the OpenFlow domain.
5. **Port 2 Lab-LAN L2 Leak (Workload Isolation)**:
   - *Symptom*: Zodiac Port 2 is wired to the ISP Wi-Fi extender (since 2026-10-09, through uplink switch #2). The legacy port-only rule (`in_port=1 → [2,3]`) bridged every workload frame (DHCP, mDNS, spoofed `10.0.0.x` sources) onto the household L2 domain; `never-default` on the Pi was the only guard, and the untrusted workload controls it.
   - *Fix*: Verified Port 1 Isolation Policy ([port1-isolation.ts](file:///Users/andymorven/git/agentic-era-networking/src/sdn/port1-isolation.ts), PR #25). Only IPv4 with src AND dst in `10.0.2.0/24`, plus ARP, crosses P1⟷P2; everything else from P1 goes to the P3 tap only.
   - *Hardware verification (2026-10-05, FW 0.86)*: Pi `10.0.2.50` → Mac `10.0.2.119` via eth0: 3/3 replies (masked OXM rules accepted). Pi `10.0.2.50` → Mac `10.0.0.119` forced out eth0 with a static neighbor entry: 100% loss (blocked). The Mac answers ICMP and has an on-link return path, so a leak would have produced replies.
   - *Residual*: ARP still crosses P1⟷P2 (address disclosure only). As of PR #26, the bridge subscribes to `ofError` and executes post-install `OFPMP_FLOW` hardware readback verification against switch silicon, logging any switch-side FlowMod rejection immediately.
   - *Observation (2026-10-09, not a new defect)*: the Mac's `en0` carries `10.0.2.119/24` as an alias (the benchmark receiver) and reaches workload nodes at `10.0.2.50` to `10.0.2.52` in about 10 ms, even though the new node has `arp_ignore=1`. The most likely path is the intended Zodiac P2 to P1 allow rule, not the Pis' Wi-Fi; flow counters were not read to confirm. The implication is that confinement is address-based: any host on the uplink side that takes a `10.0.2.x` address can reach the workload segment, and the source address is trivially forged. Tracked in the roadmap (track C).
6. **Jetson SSH Hardening & FIDO2 Security Key Enforcement**:
   - *Architecture*: Remote SSH password authentication is strictly disabled via `/etc/ssh/sshd_config.d/00-zodiac-hardening.conf` (`PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `AuthenticationMethods publickey`). Access requires a FIDO2 hardware security key (`id_ed25519_sk`) enforcing user presence and physical touch.
   - *Operational Note*: Apple's built-in macOS `/usr/bin/ssh` lacks FIDO2 security key support. Operator sessions must use Homebrew OpenSSH (`/opt/homebrew/bin/ssh`) mapped to `ssh jetson` in `~/.ssh/config`. Legacy software keys (`id_ed25519`) must remain purged from `~/.ssh/authorized_keys` on the appliance to maintain zero-bypass hardware token enforcement.
   - *Sudo PAM U2F Caveat*: When `pam_u2f.so` is configured as `required` in `/etc/pam.d/sudo`, an unseated or disconnected physical YubiKey on the Jetson USB bus causes `sudo` to fail immediately with a generic `[sudo] password for zodiac: Sorry, try again.` before prompting for touch. If `su - zodiac` succeeds with the password but `sudo` fails, inspect `lsusb` for Yubico vendor ID `1050`.
7. **NETGEAR Port 2 Mirror Destination Ingress Drop & Host Egress Clsact Filter (NET-006)**:
   - *Risk*: The capture NIC (`eth1`, RTL8153, MAC `a0:ce:c8:0e:73:f7`) on untrusted RPi 5 is cabled to NETGEAR Port 2 (the mirror destination for Port 5 uplink). If the switch or host allows frame injection on Port 2, a compromised agent could transmit raw spoofed frames bypassing OpenFlow policy boundaries.
   - *Mitigation & Hardware Enforcement*:
     1. **Host Kernel Egress Drop**: `deploy/rpi5/sdn-capture-nic.sh` configures a fail-closed `clsact` qdisc filter on `eth1` (`tc qdisc replace dev eth1 clsact && tc filter replace dev eth1 egress protocol all pref 1 matchall action drop`). Any userland `AF_PACKET` frame injection attempt is dropped inside the kernel before touching the PHY wire.
     2. **Switch Silicon Mirror Ingress Drop (CONTRADICTED on both switches on 2026-10-12; both mirror ports are now isolated in their own VLANs, see caveat 10)**: On NETGEAR GS105Ev2, ports configured as mirror destinations operate in dedicated monitoring mode with hardware MAC learning disabled. Ingress frames on mirror destination ports are dropped by switch silicon and never forwarded.
     3. **Wire Fidelity**: Offloads (`gro off lro off rx off tx off sg off`) are permanently disabled, ensuring captured frames strictly match physical wire encoding for Milestone 2C CNN packet classifier training.
8. **`agentic-node-01` `eth0` also carries `10.0.1.50/24`**:
   - *Observation (2026-10-09, read-only)*: `eth0-sdn` on `agentic-node-01` is `10.0.2.50/24, 10.0.1.50/24`. `10.0.1.0/24` is the control subnet (Jetson `10.0.1.8`, switch `10.0.1.99`). The reason is not documented; whether it creates a reachable path from the untrusted segment to the controller has not been tested. `agentic-node-02` was deliberately configured without it.
9. **Jetson Tegra Kernel OVS Kernel Module Absence & Controller Connection Hardening**:
   - *Absence of `openvswitch.ko` in Tegra Kernel*: JetPack 6.1 kernel (`5.15.148-tegra`) omits `CONFIG_OPENVSWITCH`. Stock `apt install openvswitch-switch` triggers an init script failure on `modprobe openvswitch` due to existing active bridge interfaces (`docker0`, `l4tbr0`).
   - *Resolution*: Configured `/etc/modprobe.d/openvswitch.conf` with `install openvswitch /bin/true` to treat module loading as a no-op. OVS bridges are instantiated explicitly with `datapath_type: netdev` (userspace datapath), running fully functional OpenFlow 1.3 pipelines in memory.
   - *Controller Connection Hardening (DoS Mitigation)*: `src/sdn/openflow-server.ts` enforces single-tenant session exclusivity (Invariant 3 & NET-001). When an authenticated switch session is in `ESTABLISHED` or `HANDSHAKE` state, any secondary or rogue connection attempt is immediately rejected (`socket.destroy()`) and accounted for in `rejectedConnections` without dropping the live switch. Additionally, virtual testbed bridges like `br-sim` are bound to a separate test port (`tcp:127.0.0.1:6634`) and pinned to `protocols=OpenFlow13` to preserve complete control-plane isolation.
10. **Jetson O3 capture NIC: kernel gap, egress drop and boot persistence (2026-10-12)**:
   - *Coral telemetry after removal*: checked 2026-10-12, the bridge reports the Coral as `NOT_DETECTED` with `Disconnected`, zero rates and a null temperature, so no stale detector data is shown.
   - *Mirror port ingress (found and mitigated on both switches, 2026-10-12)*: the documented claim that GS105Ev2 mirror destination ports drop ingress was **false on both units**. With the egress drop lifted, a tagged test frame sent from the capture NIC came back through the mirror: from the Jetson's O3 NIC on `zodiac_netgear_2` P3, and from the untrusted Pi 5's capture NIC `eth1` on `zodiac_netgear_1` P2. Each switch now isolates its mirror port in its own 802.1Q VLAN: `zodiac_netgear_2` VLAN 1 = P4, P5 and VLAN 2 = P1, P2, P3; `zodiac_netgear_1` VLAN 1 = P1, P3, P4, P5 and VLAN 2 = P2 only. Re-tests with the same helpers (`zodiac-o3-nic.sh ingress-test --tagged` on the Jetson, `pi5-ingress-test.sh --tagged` on the Pi 5) saw no frame come back for untagged frames, for 802.1Q VID 1 and VID 2 frames, and for double-tagged (Q-in-Q) frames with outer ethertype 0x8100 and 0x88a8; the mirrors still deliver traffic and the workload network is healthy. PVIDs (isolated port = 2, others = 1) are to be confirmed in each UI; the tests, not the PVID listing, are the evidence. Re-run the tests after any switch configuration change.
   - *Residual risk (tracked)*: a qdisc blackhole (Jetson) or a `clsact` filter (Pi 5) does not stop a raw `AF_PACKET` socket that asks the kernel to bypass the qdisc, so the host-side egress drops are partial. The switch-level VLAN isolation is the layer that closes the injection path, for the untagged, single-tagged and double-tagged variants tested. Injection variants beyond those tested (for example other ethertypes or malformed frames) are untested. Separately, ARP still crosses P1 to P2 (confirmed at O2 and O3), so the ARP-spoofing surface remains open; it is tracked as roadmap A10 and track C scenario 1.
   - *Kernel gap*: this Tegra kernel (`5.15.148-tegra`) is built without `CONFIG_NET_CLS_MATCHALL`, so the Pi 5's `clsact` matchall drop filter fails with "TC classifier not found". The O3 NIC (`enx9c69d39ddcc0`, MAC `9c:69:d3:9d:dc:c0`) drops egress with a root `blackhole` qdisc instead. Proven by the drop counter rising and by `tcpdump -Q out` seeing nothing leave. A raw socket that bypasses the qdisc is not covered, and the switch's destination-port ingress drop is unverified for `zodiac_netgear_2`.
   - *Boot persistence*: the udev rule did not fire at boot (the NIC stayed DOWN with GRO on), so a boot unit, `zodiac-o3-nic-boot.service`, finds the NIC by MAC, brings it up and applies the receive-only config. A real reboot confirmed it applies unattended; hotplug still uses the udev rule.
   - *USB*: the NIC must be on a USB 3 port. An earlier plug negotiated 480M on a hub port; both capture NICs now link at 5000M. The Zodiac's micro-USB cable also powers the switch, so unplugging it reboots the Zodiac and reinstalls the flow table.
   - *Noise*: P4 faces the lab LAN, so O3 carries ambient broadcast, mDNS and Wi-Fi-to-Wi-Fi unicast. Filter by testbed hosts when counting.
   - *Tooling*: the setup helper and runbook are local-only (`.agents/local/`, gitignored); evidence pcaps with provenance sidecars are in `/var/lib/zodiac/o3-captures/` on the Jetson and were copied to the operator's Mac.
