# Network Engineering Context & Development State Matrix

**Custodian:** CCIE Network Engineer Agent  
**Repository:** `gravity-tpu/agentic-era-networking`  
**Governing Invariants:** `NET-001` through `NET-006` ([network-engineering-principles.md](file:///Users/andymorven/git/agentic-era-networking/.agents/rules/network-engineering-principles.md))  
**Companion Documents:** [audit-log.md](file:///Users/andymorven/git/agentic-era-networking/.agents/audit-log.md), [ROADMAP.md](file:///Users/andymorven/git/agentic-era-networking/docs/ROADMAP.md), [SENTINEL-ROADMAP.md](file:///Users/andymorven/git/agentic-era-networking/docs/SENTINEL-ROADMAP.md)

---

## 1. High-Level Network Topology & Architecture State

This ledger tracks the physical, data link, network, and transport architecture of the Zodiac autonomous networking fabric.

### Physical & Logical Topology Map

```text
                                         ┌─────────────────────────────────────────────┐
                                         │           WAN / Internet (ISP NAT)          │
                                         └──────────────────────┬──────────────────────┘
                                                                │
                                         ┌──────────────────────┴──────────────────────┐
                                         │  ISP Wi-Fi Router & Extender (gw 10.0.0.1)  │
                                         │ Home LAN 10.0.0.0/24 — trusted household L2 │
                                         └───┬──────────────────┬──────────────────────┘
                                             │                  │ Home Wi-Fi (802.11)
                   ┌─────────────────────────┘                  ├────────────────────────────────────┐
                   │ Extender RJ45 (wired)                      │ 10.0.0.15                          │ 10.0.0.119
                   ▼                                            ▼                                    ▼
┌─────────────────────────────────────┐     ┌───────────────────────────────────────┐   ┌────────────────────────┐
│           Zodiac FX Switch          │     │         Jetson Orin Nano Super        │   │    Mac Workstation     │
│   (SAM4E8E / KSZ8795CLX, FW 0.86)   │     │    (SDN Controller & Sentinel Host)   │   │  (Operator Terminal)   │
├─────────────────────────────────────┤     ├───────────────────────────────────────┤   ├────────────────────────┤
│ P2: ISP Extender Uplink  (VLAN 100) │     │ • Mgmt:    10.0.0.15  (wlP1p1s0)      │   │ Wi-Fi en0: 10.0.0.119  │
│ P4: Controller 10.0.1.99 (VLAN 200) │◄───►│ • Control: 10.0.1.8   (enP8p1s0)      │   │ Tailscale:             │
│ P3: Mirror Tap → Jetson  (VLAN 100) │────►│ • Tap NIC: enx9c69d39dd0a6 (USB)      │   │   100.112.223.16       │
│ P1: Workload Ingress     (VLAN 100) │     │ • Coral Edge TPU ×2   (USB 3.0)       │   │ No Ethernet to Zodiac  │
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
│ P4: RPi 3B+ (GbE)                   │
│ P1–3: Reserved (RPi 5 + Hailo-8)    │
└──────────────────┬──────────────────┘
                   │ P4 RJ45 GbE
                   ▼
┌─────────────────────────────────────┐
│           Raspberry Pi 3B+          │
│      (Untrusted Agent Workload)     │
├─────────────────────────────────────┤
│ Data Plane: 10.0.2.50 (eth0)        │
│ Mgmt: 10.0.0.45 (wlan0, Wi-Fi)      │
│ never-default on eth0               │
└─────────────────────────────────────┘

Port 1 Isolation Policy (installed by zodiac-bridge-server on OpenFlow ready):
  prio 65535  quarantine DROP (sentinel)                       — always wins
  prio 200    P1 IPv4 10.0.2.0/24 → 10.0.2.0/24    → [P2, P3]  — intra-segment only
  prio 200    P1 ARP                               → [P2, P3]
  prio 150    P1 anything else                     → [P3]      — tap only, never P2
  prio 200    P2 IPv4 → 10.0.2.0/24, P2 ARP        → [P1]
  prio 100    P3 (Jetson tap) → [P1]
  prio 0      table-miss DROP                                  — fail-closed

Tailscale overlay (100.64.0.0/10): Jetson 100.118.64.16 ⟷ Mac 100.112.223.16;
Jetson advertises 10.0.0.0/24 + 10.0.1.0/24 as subnet router and acts as exit node.
The 10.0.2.0/24 workload subnet is NOT advertised.
```

### 802.1Q VLAN Matrix

| VLAN ID | Name | Type | Member Ports | Purpose & Forwarding Domain |
| :--- | :--- | :--- | :--- | :--- |
| **VLAN 100** | `OpenFlow` | OpenFlow Data Plane | Zodiac Ports 1, 2, 3<br>Netgear Ports 4, 5 (Untagged PVID 1/100) | Forwarding data plane. Subject to OpenFlow 1.3 `FLOW_MOD` match-action pipelines. Isolated from switch MCU management. |
| **VLAN 200** | `Controller` | Native Switch Mgmt | Zodiac Port 4 | Dedicated controller communication channel between Zodiac switch firmware and Jetson Orin Nano (`10.0.1.8:6633`). |
| *VLAN 101/102* | *Multi-Tenant (Planned)* | *802.1Q Tagged* | *Netgear P4 (VLAN 101: RPi 3), P1 (VLAN 102: RPi 5), P5 (Trunk)* | *Roadmap Milestone 4A multi-tenant workload separation before Zodiac Port 1 ingress.* |

### Physical Hardware Identity & Profile Ledger

| Node / Silicon | Hardware / SoC | MAC / Serial / ID | Network Interfaces | Roles & Capabilities |
| :--- | :--- | :--- | :--- | :--- |
| **Zodiac FX Switch** | Atmel SAM4E8E + KSZ8795CLX | DPID `0x70b3d58740c9`<br>MAC `70:B3:D5:87:40:C9`<br>FW `0.86`<br>UID `1396191488-826951736-858797360-925970489` | Port 1 (Workload)<br>Port 2 (ISP Wi-Fi Extender Uplink)<br>Port 3 (Tap)<br>Port 4 (Mgmt) | 128-rule OpenFlow 1.3 switch fabric; hardware MIB counters via CDC-ACM `/dev/ttyACM0`. |
| **NETGEAR GS105Ev2** | 5-Port Gigabit Smart Managed Switch | Model GS105E v2 | Port 1–3 (Reserved/Exp)<br>Port 4 (RPi 3B+ GbE)<br>Port 5 (Zodiac Port 1 Uplink 100M) | Intermediate Gigabit aggregation layer for Workload subnet. 128 KB shared packet buffer; IEEE 802.3x Flow Control ENABLED to propagate backpressure across 1Gbps -> 100Mbps speed transition; store-and-forward latency (~12 µs GbE ingress + ~120 µs 100M egress per 1518B MTU); loop detection enabled, IGMP snooping disabled; 802.1Q tagging readiness (fail-closed drop on untagged frames for trunking). |
| **Jetson Appliance** | NVIDIA Jetson Orin Nano Super | Serial `1791626120820` | `wlP1p1s0` (`10.0.0.15`)<br>`enP8p1s0` (`10.0.1.8`)<br>`enx9c69d39dd0a6` (Tap) | Master SDN controller, Sentinel ML daemon, dual Coral Edge TPU INT8 coprocessor host. |
| **Raspberry Pi 3B+** | Broadcom BCM2837B0 | Hostname `agentic-node-01`<br>User `agent` | `wlan0` (`10.0.0.45`)<br>`eth0` (`10.0.2.50`) | Untrusted agent workload node, iperf3 client traffic generator. |
| **Mac Workstation** | Apple Silicon Workstation | MAC `f2:5b:dc:7d:21:d4` | `en0` (`10.0.0.119`, Wi-Fi)<br>`tailscale0` (`100.112.223.16`) | Operator terminal. Connected strictly via Wi-Fi and Tailscale mesh (no direct physical Ethernet link to Zodiac). |
| **ISP Wi-Fi Extender** | Home LAN / WAN Bridge | Gateway `10.0.0.1` | RJ45 Ethernet Port | Uplink bridge connected to Zodiac Port 2; provides L2 physical attachment to home LAN / WAN gateway. |

### L3 Subnet & Addressing Schema

| Subnet CIDR | Interface / Segment | Scope | Purpose |
| :--- | :--- | :--- | :--- |
| `10.0.0.0/24` | `wlP1p1s0` (Jetson), `wlan0` (Pi), `en0` (Mac), Zodiac Port 2 | Out-of-Band Mgmt & Gateway Uplink | SSH management, Internet gateway egress (`10.0.0.1`), physical uplink from Zodiac Port 2 to ISP extender. |
| `10.0.1.0/24` | `enP8p1s0` (Jetson `10.0.1.8`) -> Port 4 (`10.0.1.99`) | Switch Control Plane | OpenFlow 1.3 control channel (`10.0.1.8:6633` <-> `10.0.1.99:6633`). |
| `10.0.2.0/24` | `eth0` (RPi `10.0.2.50`) -> Netgear P4 -> P5 -> Zodiac P1 | Untrusted Data Plane Subnet | Workload packet plane governed by SDN flow tables. Isolated from `10.0.0.0/24` home LAN and WAN by the verified Port 1 Isolation Policy ([port1-isolation.ts](file:///Users/andymorven/git/agentic-era-networking/src/sdn/port1-isolation.ts)): only IPv4 with src AND dst in `10.0.2.0/24`, plus ARP, may cross P1⟷P2; everything else from P1 is mirrored to the P3 tap only. Residual: ARP crosses P1⟷P2 (address disclosure only) until FW 0.86 `ARP_TPA` matching is verified. |
| `100.64.0.0/10` | `tailscale0` (Jetson `100.118.64.16`, Mac `100.112.223.16`) | WireGuard Mesh | Remote operator access, secure WAN exit node (`174.181.87.229`). |

### L4 Transport & Protocol Bindings

| Port / Protocol | Service | Direction | Security & Performance Invariant |
| :--- | :--- | :--- | :--- |
| `TCP 6633` | OpenFlow 1.3 Controller | Jetson Ingress (from Port 4) | Isolated to VLAN 200; BigInt wire serialization; fail-secure. |
| `TCP 5201` | iperf3 TCP/UDP Benchmark | Home LAN Ingress (`10.0.0.x` / `10.0.2.x`) from Pi (`10.0.2.50`) | Port 1 ⟷ Port 2 data-plane transit testing across ISP extender uplink; zero-suppression integer throughput metering. |
| `UDP 53` | RFC 1035 DNS Wire Server | Jetson Ingress / Workload | Default-drop on unrecognized domains; fail-closed resolver. |
| `TCP 3003` | Zodiac Bridge HTTP / SSE | Local / Tailscale | Read-only telemetry exposition; real-time hardware status. |
| `TCP 9100/9105` | Prometheus Metrics Exporter | Local / Scraping | 64-bit integer counters; zero floating point precision drift. |
| `TCP 11434` | Ollama LLM Service (`qwen2.5`) | Localhost only | Out-of-band telemetry analysis; non-blocking to packet flow. |

---

## 2. Silicon Budgets & Forwarding Capacity Ledger

Tracks physical hardware limits to prevent table exhaustion, bufferbloat, and out-of-memory crashes.

| Subsystem | Hardware / Engine | Physical Capacity | 80% High-Water Mark | Mitigation on Exhaustion |
| :--- | :--- | :--- | :--- | :--- |
| **Switch Flow Table** | Zodiac FX (SAM4E8E MCU) | **128 flow entries** | **102 rules** | Enforce `/24` or `/16` CIDR supernet aggregation; reject `/32` host bloat. |
| **Kernel Interval Sets** | Linux netfilter (`nftables`) | System RAM bounded | **10,000 subnets** | Subnet LRU eviction (`bounded-lru.ts`) + automatic coarse `/16` aggregation. |
| **Sentinel Daemon State** | systemd cgroup | `MemoryMax=64M` | **51.2 MB** | Count-Min Sketch fixed table; zero unbounded array allocation. |
| **Edge TPU DPI Queue** | Google Coral USB (4 TOPS) | Sub-4ms batch inference | **80% Duty Cycle** | Shed non-SYN packet evaluation; prioritize handshake triage. |
| **Aggregation Buffer** | NETGEAR GS105Ev2 | **128 KB SRAM** (~85 MTU frames) | **102.4 KB (80%)** | Enforce IEEE 802.3x PAUSE backpressure + host-side egress pacing on RPi (`tc qdisc replace dev eth0 root fq maxrate 95mbit`) to prevent 10:1 rate mismatch tail-drops. |

---

## 3. Multi-Track Development Roadmap State

This section tracks the active developmental state across the primary SDN architecture roadmap and the autonomous sentinel security roadmap.

### Track 1: Zodiac SDN & Telemetry Engine ([ROADMAP.md](file:///Users/andymorven/git/agentic-era-networking/docs/ROADMAP.md))

- [x] **Phase 1: Clean-Room Bootstrap & Foundational Invariants**: Repository scaffolding, BigInt arithmetic, fail-closed tests.
- [x] **Phase 2: Zodiac FX Physical Hardware Controller**: Dual-plane serial CDC-ACM driver + OpenFlow 1.3 TCP server.
- [x] **Phase 3: Physical Co-Design & Edge TPU Hardware Integration**: Promiscuous mirror tap on Port 3; INT8 inference pipeline.
- [x] **Phase 4: OpenFlow 1.3 Rule Verification**: `SymbolicRouteVerifier` ensuring loop-free DAGs before rule insertion.
- [ ] **Phase 5: Autonomous Edge Copilot & Dynamic Mitigation**: Real-time traffic anomaly triage and adaptive rate-metering.
- [ ] **Phase 6: Multi-Node Production Fabric**: Scaling from single Zodiac FX switch to multi-switch enterprise topologies.

### Track 2: Autonomous Sentinel Edge Security ([SENTINEL-ROADMAP.md](file:///Users/andymorven/git/agentic-era-networking/docs/SENTINEL-ROADMAP.md))

- [ ] **Phase S1: Zero-Overhead Wire Ingestion**: Out-of-band Apache `access.log` observation via `inotify` + mirror tap.
- [ ] **Phase S2: In-Kernel Pre-Routing Drops**: Sub-microsecond malicious packet drop in `PREROUTING` via atomic netlink sets.
- [ ] **Phase S3: Edge Copilot Triage**: Local on-device SLM (`qwen2.5:3b`) for structured threat justification.
- [ ] **Phase S4: Sister-Site Burst Protection**: HMAC-authenticated token bypass + hardware token-bucket rate metering (no DROP).
- [ ] **Phase S5: Production Hardening & Chaos Testing**: Daemon crash, network partition, and hardware disconnect resilience tests.
- [ ] **Phase S6: Multi-Node Mesh Scaling**: Distributed state replication across sister nodes via signed gossip sync.

---

## 4. Network Invariant Compliance Matrix

| Invariant | Title | Core Rule | Status |
| :--- | :--- | :--- | :--- |
| **NET-001** | Data vs. Control Plane Decoupling | Data plane executes in kernel/ASIC (< 1 µs); control plane daemons run strictly out-of-band. | **ACTIVE / ENFORCED** |
| **NET-002** | TCAM & FIB Silicon Budgeting | Hardware flow tables bounded (128 rules on Zodiac FX); enforce CIDR prefix aggregation. | **ACTIVE / ENFORCED** |
| **NET-003** | End-to-End Principle & Fate-Sharing | Web origin traffic never shares fate with autonomous agents; fail-open for clean traffic. | **ACTIVE / ENFORCED** |
| **NET-004** | Loop-Free Forwarding & Flap Prevention | All routing updates verified loop-free DAGs; exponential backoff hysteresis damping on ACLs. | **ACTIVE / ENFORCED** |
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
   - *Symptom*: RPi 3B+ (or future RPi 5) transmits bursts at GbE rate into Netgear Port 4, overflowing the 128KB buffer on egress to Zodiac Port 1 (100BASE-TX). Because the Netgear switch sits outside the OpenFlow control plane, buffer tail-drops do not increment Zodiac MIB drop counters, creating a telemetry blind spot (violating Invariant 6).
   - *Fix*:
     1. Enable IEEE 802.3x Flow Control on all Netgear ports to push backpressure into the RPi socket queue.
     2. Configure host egress rate pacing on RPi: `sudo tc qdisc replace dev eth0 root fq maxrate 95mbit`.
     3. Telemetry Reconciliation: Benchmark and monitoring scripts must reconcile host sysfs `tx_packets` against Zodiac Port 1 `rx_packets` to detect any intervening packet loss before entering the OpenFlow domain.
5. **Port 2 Home-LAN L2 Leak (Workload Isolation)**:
   - *Symptom*: Zodiac Port 2 is wired to the ISP Wi-Fi extender. The legacy port-only rule (`in_port=1 → [2,3]`) bridged every workload frame (DHCP, mDNS, spoofed `10.0.0.x` sources) onto the household L2 domain; `never-default` on the Pi was the only guard, and the untrusted workload controls it.
   - *Fix*: Verified Port 1 Isolation Policy ([port1-isolation.ts](file:///Users/andymorven/git/agentic-era-networking/src/sdn/port1-isolation.ts), PR #25). Only IPv4 with src AND dst in `10.0.2.0/24`, plus ARP, crosses P1⟷P2; everything else from P1 goes to the P3 tap only.
   - *Hardware verification (2026-10-05, FW 0.86)*: Pi `10.0.2.50` → Mac `10.0.2.119` via eth0: 3/3 replies (masked OXM rules accepted). Pi `10.0.2.50` → Mac `10.0.0.119` forced out eth0 with a static neighbor entry: 100% loss (blocked). The Mac answers ICMP and has an on-link return path, so a leak would have produced replies.
   - *Residual*: ARP still crosses P1⟷P2 (address disclosure only). The bridge does not yet subscribe to `ofError`, so a switch-side FlowMod rejection would be silent; re-run the leak test after firmware or policy changes.
