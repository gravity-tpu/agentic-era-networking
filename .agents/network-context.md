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
│ P1-P3: free; O3 mirror of P4 pending│                         │                                    │
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
| **NETGEAR GS105Ev2** | 5-Port Gigabit Smart Managed Switch | Model GS105E v2 | Port 4 (RPi 5 GbE)<br>Port 3 (RPi 3B+ GbE)<br>Port 2 (RPi 5 USB-GbE capture NIC; mirror destination for P5, both directions verified 2026-10-07)<br>Port 1 (RPi 3B+ `agentic-node-02` GbE)<br>Port 5 (Zodiac Port 1 Uplink 100M) | Intermediate Gigabit aggregation layer for Workload subnet. 128 KB shared packet buffer; IEEE 802.3x Flow Control ENABLED to propagate backpressure across 1Gbps -> 100Mbps speed transition; store-and-forward latency (~12 µs GbE ingress + ~120 µs 100M egress per 1518B MTU); loop detection enabled, IGMP snooping disabled; 802.1Q tagging readiness (fail-closed drop on untagged frames for trunking). |
| **Jetson Appliance** | NVIDIA Jetson Orin Nano Super | Serial `1791626120820` | `wlP1p1s0` (`10.0.0.15`)<br>`enP8p1s0` (`10.0.1.8`)<br>`enx9c69d39dd0a6` (Tap)<br>`br-sim` (Internal OVS) | Master SDN controller, Sentinel ML daemon, dual Coral Edge TPU INT8 coprocessor host; hosts Open vSwitch 2.17.12 in userspace `netdev` mode (`br-sim`) for software reference evaluation and large-scale rule verification. |
| **Raspberry Pi 5** | Broadcom BCM2712 + Hailo-8 (26 TOPS) | Hostname `rpi-hailo` (renamed from `agentic-node-02`, 2026-10-09)<br>MAC `98:fe:54:52:9d:85` | `wlan0` (`10.0.0.179`)<br>`eth0` (`10.0.2.51`)<br>Realtek RTL8153 USB 3.0 GbE (`0bda:8153`) capture NIC `eth1` (MAC `a0:ce:c8:0e:73:f7`, NETGEAR Port 2) | Adversarial edge workload, Red Team workload generator, 26 TOPS INT8 PCIe Gen 3.0 coprocessor host, line-rate GbE traffic engine. |
| **Raspberry Pi 3B+** | Broadcom BCM2837B0 | Hostname `agentic-node-01`<br>User `agent` | `wlan0` (`10.0.0.45`)<br>`eth0` (`10.0.2.50`; also carries `10.0.1.50/24`, see caveat 8) | Untrusted agent workload node, iperf3 client traffic generator. |
| **Raspberry Pi 3B+** | Broadcom BCM2837B0 (Rev 1.4) | Hostname `agentic-node-02` (added 2026-10-09)<br>User `agent`, key-only SSH<br>`eth0` MAC `b8:27:eb:79:ff:0a`, `wlan0` MAC `b8:27:eb:2c:aa:5f` | `wlan0` (`10.0.0.177`)<br>`eth0` (`10.0.2.52/24`, profile `eth0-sdn`, never-default)<br>`tailscale0` (`100.105.255.18`) | Second untrusted workload node; planned legitimate client. Raspberry Pi OS Lite 64-bit (Debian 13), `arp_ignore=1`, `arp_announce=2`. Cabled to NETGEAR Port 1. |
| **Mac Workstation** | Apple Silicon Workstation | MAC `f2:5b:dc:7d:21:d4` | `en0` (`10.0.0.119`, Wi-Fi)<br>`tailscale0` (`100.112.223.16`) | Operator terminal. Connected strictly via Wi-Fi and Tailscale mesh (no direct physical Ethernet link to Zodiac). |
| **ISP Wi-Fi Extender** | Lab LAN / WAN Bridge | Gateway `10.0.0.1` | RJ45 Ethernet Port | Connected to uplink switch #2 port 5 (was Zodiac Port 2 until 2026-10-09); provides L2 attachment to lab LAN / WAN gateway. |
| **NETGEAR GS105Ev2 (uplink switch #2)** | 5-Port Gigabit Smart Managed Switch | Model GS105E v2 | Port 5 (ISP mesh / extender)<br>Port 4 (Zodiac Port 2)<br>Ports 1 to 3 free | Lab-side L2 aggregation for the uplink; installed 2026-10-09 and carrying only those two links. Port mirroring of its port 4 is planned as observation point O3 and is not yet configured; no capture interface is attached (plan: move the Jetson's USB NIC here for conformance sessions). Management plane uses dynamic DHCP on lab LAN (`10.0.0.0/24`) from ISP gateway; IEEE 802.3x Flow Control enabled to propagate backpressure across GbE -> 100M speed boundary. Verified after install: the Mac still reaches the workload nodes through the Zodiac and the workload cannot reach `10.0.0.1`. |

### L3 Subnet & Addressing Schema

| Subnet CIDR | Interface / Segment | Scope | Purpose |
| :--- | :--- | :--- | :--- |
| `10.0.0.0/24` | `wlP1p1s0` (Jetson), `wlan0` (Pi 3 & Pi 5), `en0` (Mac), Zodiac Port 2 | Out-of-Band Mgmt & Gateway Uplink | SSH management, Internet gateway egress (`10.0.0.1`), physical uplink from Zodiac Port 2 to the ISP extender via uplink switch #2 (since 2026-10-09). |
| `10.0.1.0/24` | `enP8p1s0` (Jetson `10.0.1.8`) -> Port 4 (`10.0.1.99`) | Switch Control Plane | OpenFlow 1.3 control channel (`10.0.1.8:6633` <-> `10.0.1.99:6633`). |
| `10.0.2.0/24` | `eth0` (`agentic-node-01`: `10.0.2.50`, `rpi-hailo`: `10.0.2.51`, `agentic-node-02`: `10.0.2.52`) -> Netgear P3/P4/P1 -> P5 -> Zodiac P1 | Untrusted Data Plane Subnet | Workload packet plane governed by SDN flow tables. Isolated from `10.0.0.0/24` lab LAN and WAN by the verified Port 1 Isolation Policy ([port1-isolation.ts](file:///Users/andymorven/git/agentic-era-networking/src/sdn/port1-isolation.ts)): only IPv4 with src AND dst in `10.0.2.0/24`, plus ARP, may cross P1⟷P2; everything else from P1 is mirrored to the P3 tap only. Residual: ARP crosses P1⟷P2 (address disclosure only) until FW 0.86 `ARP_TPA` matching is verified. |
| `192.168.0.0/24` | Workload-side NETGEAR GS105Ev2 management (`192.168.0.239`, factory-default static IP, MAC `28:94:01:8b:70:d9`) | Switch Management (Out-of-Band, Operator-Only) | Smart-switch web UI (HTTP :80). Not routed anywhere; reached only by a temporary `192.168.0.50/24` alias on an `eth0` of a host on the NETGEAR. See *NETGEAR Management Access*. |
| `100.64.0.0/10` | `tailscale0` (Jetson `100.118.64.16`, Mac `100.112.223.16`) | WireGuard Mesh | Remote operator access, secure WAN exit node (`174.181.87.229`). |

### NETGEAR Management Access

This section describes the **workload-side** switch. **Uplink switch #2** (installed 2026-10-09) sits on the lab LAN side, cabled directly to the ISP Wi-Fi extender via Port 5.

- *Management Plane Isolation:* Uplink switch #2 receives an IP address via DHCP from the ISP gateway on the lab LAN (`10.0.0.0/24`), remaining completely separate from the workload-side fallback address (`192.168.0.239`). Furthermore, under the Port 1 Isolation Policy ([port1-isolation.ts](file:///Users/andymorven/git/agentic-era-networking/src/sdn/port1-isolation.ts)), IPv4 traffic to `192.168.0.0/24` is fail-closed quarantined from Port 2 (`in_port=1, dst 192.168.0.x → [P3]` tap only), ensuring management traffic to the workload switch never transits Port 2 and cannot collide with the lab LAN.
- *Rate Transition & Flow Control (NET-010):* Uplink switch #2 mediates the speed transition between the Gigabit ISP mesh and the 100BASE-TX Zodiac Port 2 link. IEEE 802.3x Flow Control is enabled on the GS105Ev2 ports to push backpressure via standard PAUSE frames toward the gigabit source during bursts, preventing silent buffer exhaustion or tail-drops in the switch's 128 KB buffer. Observation point O3 (port mirror on uplink switch #2 Port 4) is planned to record wire frames entering Zodiac Port 2, guaranteeing full packet provenance without unobserved upstream loss.

The workload-side GS105Ev2 web UI is at `http://192.168.0.239/`. It sits outside the OpenFlow control plane and is not reachable from the lab LAN. Operator access is an SSH port-forward through a workload node (RPi 3B+ shown; `10.0.0.45` is its `wlan0`):

```bash
# 1. On the RPi 3B+: temporary alias on the NETGEAR-facing NIC (non-persistent; lost on reboot)
sudo ip addr add 192.168.0.50/24 dev eth0
# 2. On the Mac: forward localhost:8888 to the switch UI
ssh -f -N -o ExitOnForwardFailure=yes -L 8888:192.168.0.239:80 agent@10.0.0.45   # then http://localhost:8888
# 3. When done: stop the tunnel (Mac) and remove the alias (RPi 3B+)
pkill -f "8888:192.168.0.239"
sudo ip addr del 192.168.0.50/24 dev eth0
```

The alias is deliberately not persisted: the RPi 3B+ is the untrusted workload node, so a standing route to the switch management plane would violate fail-closed isolation (Invariant 3). Verified 2026-10-07: `192.168.0.239` answers ping and HTTP 200 once the alias exists.

**Port mirroring (operator-confirmed in the UI 2026-10-07):** source Port 5, destination Port 2. The RPi 5 was rebooted but the NETGEAR was not power-cycled, so persistence of this config across a switch power cycle remains unverified.

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
| **Edge TPU DPI Queue** | Google Coral USB (4 TOPS) | Sub-4ms batch inference | **80% Duty Cycle** | Shed non-SYN packet evaluation; prioritize handshake triage. |
| **Edge NPU Coprocessor** | Hailo-8 M.2 (RPi 5 PCIe Gen 3) | **26 TOPS INT8** | **80% Duty Cycle** | CNN inference only (HEF via Hailo Dataflow Compiler); advisory on the untrusted tier, never an enforcement input. Not an LLM runtime; traffic generation is host CPU/NIC-bound. |
| **Aggregation Buffer** | NETGEAR GS105Ev2 | **128 KB SRAM** (~85 MTU frames) | **102.4 KB (80%)** | Enforce IEEE 802.3x PAUSE backpressure + host-side egress pacing on RPi (`tc qdisc replace dev eth0 root fq maxrate 95mbit`) to prevent 10:1 rate mismatch tail-drops. |

---

## 3. Roadmap State

Current scope is a real-hardware testbed and verifier for agent-proposed SDN policy ([ROADMAP.md](../docs/ROADMAP.md)). The earlier phase list (including "Phase 4: SymbolicRouteVerifier loop-free DAGs") was superseded on 2026-10-09: that check could not reject its input and was removed.

### Track A: Policy verifier

- [x] **A1 Isolation, A2 hairpin**: `verifyPort1Isolation` (`src/sdn/port1-isolation.ts`); plan-level table budget, hairpin and DROP semantics in `verifyPlanAdmissible` (`src/sdn/dataplane-benchmark.ts`).
- [x] **Readback on match fields**: `verifyIsolationReadback`.
- [ ] **A3 to A10**: default-drop check, quarantine precedence, shadowing, conflicts, rule budget, capacity budget, layout, ARP confinement. A4 and A9 conflict (forwarding-first is cheaper but outranks quarantine); see the roadmap.
- [ ] **Output-action readback; agent-proposal evaluation.**

### Track B: Hardware model and conformance

- [x] **Cost model fitted and documented**: 38.5 µs + 34.8 ns per payload byte above 64 + 4.24 µs per rule (1.3 µs forwarding-first); see the benchmark whitepaper.
- [ ] **Cost model as a verifier input; model-versus-wire conformance probe; open measurement items.**

### Track C: Adversarial testing

- [ ] **ARP spoofing across P1 to P2, intra-segment spoofing, scans, flood to session loss, evasion.** Detector accuracy (Coral and Jetson GPU) is unmeasured.

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
| **NET-004** | Loop-Free Forwarding & Flap Prevention | No hairpin or isolation leaks in installed rule sets (checked by `verifyPort1Isolation`, `verifyPlanAdmissible`); exponential backoff hysteresis damping on ACLs. | **PARTLY CHECKED** (shadowing and conflict checks planned) |
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
     2. **Switch Silicon Mirror Ingress Drop**: On NETGEAR GS105Ev2, ports configured as mirror destinations operate in dedicated monitoring mode with hardware MAC learning disabled. Ingress frames on mirror destination ports are dropped by switch silicon and never forwarded.
     3. **Wire Fidelity**: Offloads (`gro off lro off rx off tx off sg off`) are permanently disabled, ensuring captured frames strictly match physical wire encoding for Milestone 2C CNN packet classifier training.
8. **`agentic-node-01` `eth0` also carries `10.0.1.50/24`**:
   - *Observation (2026-10-09, read-only)*: `eth0-sdn` on `agentic-node-01` is `10.0.2.50/24, 10.0.1.50/24`. `10.0.1.0/24` is the control subnet (Jetson `10.0.1.8`, switch `10.0.1.99`). The reason is not documented; whether it creates a reachable path from the untrusted segment to the controller has not been tested. `agentic-node-02` was deliberately configured without it.
9. **Jetson Tegra Kernel OVS Kernel Module Absence & Controller Connection Hardening**:
   - *Absence of `openvswitch.ko` in Tegra Kernel*: JetPack 6.1 kernel (`5.15.148-tegra`) omits `CONFIG_OPENVSWITCH`. Stock `apt install openvswitch-switch` triggers an init script failure on `modprobe openvswitch` due to existing active bridge interfaces (`docker0`, `l4tbr0`).
   - *Resolution*: Configured `/etc/modprobe.d/openvswitch.conf` with `install openvswitch /bin/true` to treat module loading as a no-op. OVS bridges are instantiated explicitly with `datapath_type: netdev` (userspace datapath), running fully functional OpenFlow 1.3 pipelines in memory.
   - *Controller Connection Hardening (DoS Mitigation)*: `src/sdn/openflow-server.ts` enforces single-tenant session exclusivity (Invariant 3 & NET-001). When an authenticated switch session is in `ESTABLISHED` or `HANDSHAKE` state, any secondary or rogue connection attempt is immediately rejected (`socket.destroy()`) and accounted for in `rejectedConnections` without dropping the live switch. Additionally, virtual testbed bridges like `br-sim` are bound to a separate test port (`tcp:127.0.0.1:6634`) and pinned to `protocols=OpenFlow13` to preserve complete control-plane isolation.
