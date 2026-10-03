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
               ┌────────────────────────────────────────────────────────┐
               │              WAN / Internet / Cloud Services           │
               └───────────────────────────┬────────────────────────────┘
                                           │ (Home LAN 10.0.0.1/24)
                                           ▼
               ┌────────────────────────────────────────────────────────┐
               │              Tailscale Mesh Overlay (WireGuard)        │
               │   100.118.64.16 (Jetson) · 100.112.223.16 (MacBook)    │
               │   Subnet Router (10.0.0.0/24, 10.0.1.0/24) & Exit Node │
               └───────────────────────────┬────────────────────────────┘
                                           │
         ┌─────────────────────────────────┴─────────────────────────────────┐
         │                                                                   │
         ▼ (Wi-Fi 10.0.0.15)                                                 ▼ (Port 2 Uplink)
┌─────────────────────────────────┐                       ┌───────────────────────────────────┐
│     Jetson Orin Nano Super      │                       │         Zodiac FX Switch          │
│   (Master Appliance & Bridge)   │                       │       (SAM4E8E / KSZ8795CLX)      │
├─────────────────────────────────┤                       ├───────────────────────────────────┤
│ • Management: 10.0.0.15 (WLAN)  │                       │ Port 2: Gateway Uplink (VLAN 100) │
│ • Control Plane: 10.0.1.8 (ETH) ├─(VLAN 200 Native Port 4)┤ Port 4: Controller (VLAN 200)    │
│ • Mirror Tap: Promiscuous (USB3)│◄─(Port 3 Mirror Tap)──┤ Port 3: Mirror Tap (VLAN 100)     │
│ • Coral TPU #1 & #2 (USB 3.0)   │                       │ Port 1: Workload Subnet (VLAN 100)│
│ • Ollama qwen2.5:3b (Port 11434)│                       └─────────────────┬─────────────────┘
│ • Zodiac Bridge (:3003, :6633)  │                                         │
└─────────────────────────────────┘                                         ▼ (Port 1 RJ45)
                                                          ┌───────────────────────────────────┐
                                                          │        Raspberry Pi 3B+           │
                                                          │   (Untrusted Agent Workload)      │
                                                          ├───────────────────────────────────┤
                                                          │ • Data Plane: 10.0.2.50 (eth0)    │
                                                          │ • Mgmt Tether: 10.0.0.45 (wlan0)  │
                                                          └───────────────────────────────────┘
```

### 802.1Q VLAN Matrix

| VLAN ID | Name | Type | Member Ports | Purpose & Forwarding Domain |
| :--- | :--- | :--- | :--- | :--- |
| **VLAN 100** | `OpenFlow` | OpenFlow Data Plane | Port 1, Port 2, Port 3 | Forwarding data plane. Subject to OpenFlow 1.3 `FLOW_MOD` match-action pipelines. Isolated from switch MCU management. |
| **VLAN 200** | `Controller` | Native Switch Mgmt | Port 4 | Dedicated controller communication channel between Zodiac switch firmware and Jetson Orin Nano (`10.0.1.8:6633`). |

### L3 Subnet & Addressing Schema

| Subnet CIDR | Interface / Segment | Scope | Purpose |
| :--- | :--- | :--- | :--- |
| `10.0.0.0/24` | `wlP1p1s0` (Jetson), `wlan0` (Pi) | Out-of-Band Mgmt | SSH management, Internet gateway egress, cloud telemetry sync. |
| `10.0.1.0/24` | `enP8p1s0` (Jetson) -> Port 4 | Switch Control Plane | OpenFlow 1.3 control channel (`10.0.1.8:6633` <-> `10.0.1.99`). |
| `10.0.2.0/24` | `eth0` (RPi) -> Port 1 | Untrusted Data Plane | Workload packet plane governed by SDN flow tables. |
| `100.64.0.0/10` | `tailscale0` (Jetson/MacBook) | WireGuard Mesh | Remote operator access, secure WAN exit node (`174.181.87.229`). |

### L4 Transport & Protocol Bindings

| Port / Protocol | Service | Direction | Security & Performance Invariant |
| :--- | :--- | :--- | :--- |
| `TCP 6633` | OpenFlow 1.3 Controller | Jetson Ingress (from Port 4) | Isolated to VLAN 200; BigInt wire serialization; fail-secure. |
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
