# Physical SDN & Autonomous Master Appliance Architecture

> **Hardware Specification & Integration Blueprint for the Agentic Era**  
> **Physical Substrates:** Northbound Networks Zodiac FX OpenFlow Switch + NVIDIA Jetson Orin Nano Super (Master Appliance) + Google Coral Edge TPU + Raspberry Pi 3B+ (Client Workload) + Anker Solix F1500 (Autonomous Power Substrate)  
> **Autonomous Master Appliance:** NVIDIA Jetson Orin Nano Super (24/7 dedicated controller host, 67 TOPS Ampere GPU, TensorRT INT8 engine, Tri-Interface Stack)  
> **Inference Accelerator:** Google Coral Edge TPU (4 TOPS INT8 accelerator, USB 3.0 line-rate packet classifier)  
> **Untrusted Client Workload:** Raspberry Pi 3 Model B+ (`10.0.2.50/24` static on `eth0`, out-of-band management via `wlan0`)  
> **Dedicated Tap Interface:** ASIX AX88179 USB 3.0 GbE Adapter (`enx9c69d39dd0a6` in promiscuous capture mode)  
> **Autonomous Power Substrate:** Anker Solix F1500 (1536 Wh LiFePO4 battery power station, 60–80+ hrs continuous off-grid runtime)  
> **Untethered Workstation:** MacBook Pro (remote operator console via wireless WiFi 6/6E)  
> **Governing Paradigms:** Jeff Dean (Latency Budgets), Sanjay Ghemawat (Fail-Closed Simplicity), Quoc Le (Self-Tuning Control), Oriol Vinyals (Graph Routing), Demis Hassabis (Symbolic Proof Asymmetry).

---

## 1. Executive Summary & The Architectural Role Inversion

In autonomous agent networks, software emulation (e.g., Mininet, OVS) abstracts away critical physical artifacts: hardware buffer overruns, physical link state bounces, serialization jitter, and thermal throttle events. 

This architecture grounds the `gravity-tpu/agentic-era-networking` control plane in **physical hardware**, elevating the compute node from a secondary peripheral into a **24/7 Autonomous Master Appliance**:
- **Zodiac FX Switch**: Physical 4-port 10/100 Mbit/s OpenFlow switch (Microchip KSZ8795 switch IC + Atmel SAM4E8E 120 MHz ARM Cortex-M4 MCU) with a deterministic 128-entry flow table.
- **Autonomous Master Appliance (NVIDIA Jetson Orin Nano Super)**: Dedicated, 24/7 low-power (7W–15W) master controller running the OpenFlow 1.3 controller daemon (`:6633`), the RFC 1035 transparent DNS resolver (`:53`), symbolic DAG route verification, line-rate TensorRT neural anomaly detection (67 TOPS INT8), and physical SSD1306 OLED telemetry daemon.
- **Google Coral Edge TPU**: Dedicated 4 TOPS INT8 USB 3.0 coprocessor executing sub-millisecond shallow packet classification on mirrored data streams without taxing the Jetson GPU pipeline.
- **Dedicated Mirror Tap Interface (ASIX AX88179 USB GbE)**: Dedicated secondary physical NIC (`enx9c69d39dd0a6`) on the Jetson Orin operating in promiscuous mode, directly cabled to Zodiac Port 3 for zero-loss packet inspection.
- **Untrusted Client Workload (Raspberry Pi 3 Model B+)**: Physical client agent running on isolated subnet `10.0.2.50/24` via `eth0` attached to Zodiac Port 1, protected by an out-of-band management backdoor via `wlan0` (`10.0.0.45/24`).
- **Autonomous Power Substrate (Anker Solix F1500)**: 1536 Wh LiFePO4 battery station providing conditioned power to the entire physical rack (~20W continuous draw), guaranteeing 60–80+ hours of off-grid survivability.
- **Untethered Operator Workstation (MacBook Pro)**: Completely decoupled from physical data plane dependencies. The laptop can sleep, reboot, or travel without causing network flapping or interrupting traffic flow.

---

## 2. Desktop Interconnect & Physical Wiring Topology

```
+─────────────────────────────────────────────────────────────────────────────────────────────────────────+
|                                    ANKER SOLIX F1500 (1536 Wh LiFePO4)                                  |
|                         Off-Grid Power Substrate: ~20W Continuous Load (60-80+ Hours)                   |
+───┬───────────────────────────────────────┬───────────────────────────────────┬─────────────────────────+
    │ AC/DC Power                           │ 19V DC Power                      │ 5V USB-C Power
    ▼                                       ▼                                   ▼
+──────────────────────────+     +───────────────────────────────────+     +──────────────────────────────+
| Zodiac FX 4-Port Switch  |     | NVIDIA Jetson Orin Nano Super     |     | Raspberry Pi 3 Model B+      |
| Microchip KSZ8795 +      |     | 67 TOPS Ampere, 24/7 Controller   |     | Untrusted Agent Workload     |
| SAM4E8E ARM Cortex-M4    |     | NVMe 500GB SSD @ 1.8 GB/s         |     | Broadcom BCM2837B0           |
+──────────────────────────+     +───────────────────────────────────+     +──────────────────────────────+

                                            +───────────────────────────────────+
                                            |    Public Internet / Home LAN     |
                                            +-----------------+-----------------+
                                                              │ (Mesh WiFi)
                                                              ▼
                                            +───────────────────────────────────+
                                            |     ISP Gateway / Mesh Node       |
                                            +-----------------+-----------------+
                                                              │ 100BASE-TX Ethernet
                                                              ▼
+─────────────────────────────────────────────────────────────────────────────────────────────────────────+
|                                  Zodiac FX OpenFlow Switch (Data Plane)                                 |
|                                                                                                         |
|   [Port 1]                      [Port 2]                  [Port 3]                    [Port 4]          |
|   Untrusted Agent Workload      Gateway Uplink            Hardware Mirror Tap         OpenFlow 1.3 Ctrl |
|   VLAN 100 (OpenFlow)           VLAN 100 (OpenFlow)       VLAN 100 (OpenFlow)         VLAN 200 (Native) |
|   100BASE-TX                    100BASE-TX                100BASE-TX                  100BASE-TX        |
+───────┬─────────────────────────────▲─────────────────────────┬───────────────────────────▲─────────────+
        │                             │                         │                           │
        │ RJ-45 Patch                 │ RJ-45 Patch             │ RJ-45 Patch               │ RJ-45 Patch
        │                             │                         ▼                           │
        │                             │             +───────────────────────+               │
        │                             │             | ASIX AX88179 USB GbE  |               │
        │                             │             | (enx9c69d39dd0a6)     |               │
        │                             │             +───────────┬───────────+               │
        │                             │                         │ USB 3.0                   │
        │                             │                         ▼                           │
        │                        +----+-----------------------------------------------------+   Micro-USB
        │                        |         NVIDIA Jetson Orin Nano Super Master Appliance   |<──Serial CDC
        │                        |                                                          |   /dev/ttyACM0
        │                        |  * Controller Plane: enP8p1s0 (10.0.1.8/24) <────────────+───(115200 8N1)
        │                        |  * Mirror Tap Ingress: enx9c69d39dd0a6 (Promiscuous)     |
        │                        |  * Management Plane: wlP1p1s0 (10.0.0.15/24)             |
        │                        |  * OpenFlow 1.3 Controller Plane (:6633)                 |
        │                        |  * RFC 1035 Transparent DNS Resolver (:53)              |
        │                        |  * Local Telemetry Bridge & Web UI (:3003)               |
        │                        |  * I2C SSD1306 0.96" OLED Telemetry (Bus 7, 0x3c)        |
        │                        +──────────────────────────────┬───────────────────────────+
        │                                                       │ USB 3.0 SuperSpeed
        │                                                       ▼
        │                                           +───────────────────────+
        │                                           | Google Coral Edge TPU |
        │                                           | 4 TOPS INT8 (18d1:9302|
        │                                           | Line-rate Anomaly DPI |
        │                                           +───────────────────────+
        │                                                       │
        ▼                                                       │ Management Plane
+───────────────────────────────────+                           │ Wireless WiFi (10.0.0.15)
| Raspberry Pi 3 Model B+ (Workload)|                           ▼
|                                   |       +───────────────────────────────────────────────────+
| * eth0: 10.0.2.50/24 (Static) ────+       | Untethered Operator Workstation (MacBook Pro)     |
|   Untrusted SDN Agent Data Plane  |       | * Web UI: http://10.0.0.15:3003 & Cloud Edge      |
|                                   |       | * SSH Operator: ssh zodiac@10.0.0.15              |
| * wlan0: 10.0.0.45/24 (Wi-Fi) <───+───────| * Out-of-Band Safety: ssh agent@10.0.0.45         |
|   Out-of-Band Management Backdoor |       +───────────────────────────────────────────────────+
+───────────────────────────────────+
```

### 2.1 Physical Interconnect & Interface Mapping Matrix

| Node | Interface / Medium | Physical ID / MAC | IP / Subnet | Target / Destination | Role & Invariant |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Zodiac FX Switch** | Port 1 (100BASE-TX) | `70:B3:D5:87:40:C9` | `10.0.2.0/24` (VLAN 100) | RPi 3B+ `eth0` | **Untrusted Workload Port**: Monitored agent data plane transit. |
| **Zodiac FX Switch** | Port 2 (100BASE-TX) | `70:B3:D5:87:40:C9` | Bridged (VLAN 100) | ISP Gateway / Mesh Node | **WAN / Gateway Uplink**: Egress to public internet. |
| **Zodiac FX Switch** | Port 3 (100BASE-TX) | `70:B3:D5:87:40:C9` | Unassigned (VLAN 100) | Jetson `enx9c69d39dd0a6` | **Hardware Mirror Tap**: Port mirror egress for Coral/Jetson DPI. |
| **Zodiac FX Switch** | Port 4 (100BASE-TX) | `70:B3:D5:87:40:C9` | `10.0.1.99/24` (VLAN 200) | Jetson `enP8p1s0` | **OpenFlow 1.3 Control Channel**: Isolated switch management. |
| **Zodiac FX Switch** | Micro-USB (CDC-ACM) | VID `03eb` PID `2404` | `/dev/ttyACM0` (115200) | Jetson USB-A | **Out-of-Band Telemetry**: Real-time hardware register stream. |
| **Jetson Orin Nano** | `enP8p1s0` (Onboard GbE) | `ac:3a:e2:98:99:dd` | `10.0.1.8/24` (Static) | Zodiac Port 4 | **OpenFlow Controller**: Listens on `:6633` (0.7ms latency). |
| **Jetson Orin Nano** | `enx9c69d39dd0a6` (USB GbE)| `9c:69:d3:9d:d0:a6` | Promiscuous (No IP) | Zodiac Port 3 | **Mirror Tap Ingress**: Line-rate packet capture for Coral TPU. |
| **Jetson Orin Nano** | `wlP1p1s0` (Wi-Fi) | `f0:68:e3:33:02:a3` | `10.0.0.15/24` (DHCP) | Home Wireless LAN | **Management Plane**: Web UI (`:3003`), SSH, Cloud Relay. |
| **Google Coral TPU** | USB 3.0 SuperSpeed | Bus 002 `18d1:9302` | USB Endpoints | Jetson USB-A | **Neural Accelerator**: 4 TOPS INT8 shallow packet anomaly DPI. |
| **SSD1306 OLED** | 4-Pin I2C (Bus 7) | Address `0x3c` | Jetson 40-Pin Header | Jetson Bezel | **Front Panel Telemetry**: 5-screen rotational physical display. |
| **Raspberry Pi 3B+** | `eth0` (Onboard GbE) | `b8:27:eb:a2:ec:b0` | `10.0.2.50/24` (Static) | Zodiac Port 1 | **Untrusted Agent Workload**: Target for SDN policy enforcement. |
| **Raspberry Pi 3B+** | `wlan0` (Wi-Fi) | `b8:27:eb:f7:b9:e5` | `10.0.0.45/24` (DHCP) | Home Wireless LAN | **Out-of-Band Safety**: Dedicated SSH backdoor to prevent lockouts. |
| **Anker Solix F1500** | 1536 Wh LiFePO4 Substrate| Station ID `A1780` | AC / 19V / 5V Rails | Entire Physical Rack | **Autonomous Power Substrate**: 60–80+ hrs continuous off-grid runtime. |
| **MacBook Pro** | Wi-Fi 6/6E | — | `10.0.0.x` | Home Wireless LAN | **Untethered Console**: Zero-risk development and monitoring console. |

### 2.2 Dual-Homed Workload Architecture & Asymmetric Routing Invariant

> [!IMPORTANT]
> **Subnet Isolation Law (Ghemawat Invariant)**:  
> The Raspberry Pi 3B+ data plane interface (`eth0`) is assigned an isolated subnet (`10.0.2.50/24`) distinct from the management wireless LAN (`10.0.0.0/24`).  
>
> If `eth0` were assigned an address on `10.0.0.0/24` (e.g. `10.0.0.50/24`), Linux kernel route selection and Reverse Path Forwarding (rp_filter) would route SSH return packets destined for the operator workstation (`10.0.0.x`) out through `eth0` into Zodiac Port 1 instead of returning over `wlan0`. Because OpenFlow has no active forwarding rule for unclassified host traffic, this immediately blackholes the SSH session.
>
> By strictly partitioning the data plane to `10.0.2.0/24`, operator SSH access over `wlan0` (`10.0.0.45`) remains 100% immune to OpenFlow table flushes, flow timeouts, quarantine rules, and switch reboots.

> [!TIP]
> **Physical Chassis & Display Subsystem**: For full mechanical assembly, 4-pin I2C OLED pinouts, button jumper wiring, and the 5-screen physical telemetry daemon, see the dedicated [Jetson Orin & Panini Case Architecture](file:///Users/andymorven/git/agentic-era-networking/docs/design/jetson-orin/README.md).

---

## 3. The Nanosecond-to-WAN Latency Budget (The Dean Invariant)

Cloud LLMs (e.g., GPT-4, Claude, Gemini) are architecturally incapable of direct packet-level or flow-level admission control due to Time-To-First-Token (TTFT) latency:

```
Operation                                 Latency (ns)             Human Time       Viability for Flow Control
---------------------------------------------------------------------------------------------------------------
L1 cache reference                             0.5 ns                               Data plane lookup
KSZ8795 Hardware Fast-Path                   1,000 ns               1 µs            Hardware line-rate forwarding
Zodiac FX Cortex-M4 Pipeline               500,000 ns             0.5 ms            Software OpenFlow classification
Datacenter LAN Roundtrip                   500,000 ns             0.5 ms            Local cluster transit
Jetson Orin TensorRT INT8 Inference        800,000 ns             0.8 ms            Autonomous ML Flow Decision (PASS)
WAN Roundtrip (Cross-continent)        150,000,000 ns             150 ms            Cloud round-trip (FAIL)
Cloud LLM TTFT (API Call)            1,000,000,000 ns           1,000 ms (1 s)      Cloud Agent Reasoning (FAIL)
```

The Jetson Orin Nano Super executes quantized TensorRT neural inference in **< 1.0 ms**, allowing real-time intervention before switch input buffers overflow.

---

## 4. The 4 Autonomous Appliance Roles in Agentic Networking

### Role 1: Real-Time Flow Anomaly Detection & Fail-Closed Quarantine (Coral + Jetson Split Inference)
* **Challenge**: Autonomous AI agents executing tool-use loops can trigger rogue network behaviors (DDoS against local services, aggressive subnet scanning, abnormal packet burst frequencies, exfiltration bursts).
* **Split-Inference Hardware Mechanism**: 
  * Port 3 of the Zodiac FX hardware-mirrors all data plane packet traffic (VLAN 100) directly to the Jetson Orin's dedicated ASIX AX88179 USB GbE adapter (`enx9c69d39dd0a6`) in promiscuous mode.
  * **Stage 1 — Google Coral Edge TPU (4 TOPS INT8)**: The Coral USB accelerator runs sub-millisecond shallow packet classification on raw frame headers, assessing inter-arrival time deltas ($\Delta t$), entropy, and packet size distributions without consuming GPU/CPU cycles.
  * **Stage 2 — Jetson Orin TensorRT (67 TOPS Ampere)**: Deep anomaly detection models (1D-CNN autoencoder) evaluate suspicious sequences flagged by Stage 1 within a `< 1.0 ms` budget.
  * If the anomaly reconstruction error exceeds the policy boundary, the controller pushes an immediate OpenFlow `FLOW_MOD` with highest priority (`65535`) to drop or quarantine the offending agent's MAC/IP traffic on Port 1.
* **Fail-Closed Invariant**: Conforms to Sanjay Ghemawat & Demis Hassabis rules: if the ML detector fails or is ambiguous, the system defaults to DROP/QUARANTINE.

### Role 2: Verification Asymmetry & Symbolic Proof (AlphaProof Paradigm)
* **Challenge**: Neural networks are probabilistic and non-deterministic; they can suggest degenerate or cyclical routing rules.
* **Jetson Orin TensorRT Mechanism**:
  * The Jetson Orin runs a Graph Neural Network (or Pointer Network) predicting optimal path transitions under varying link costs.
  * **The Verification Invariant**: The neural model merely *proposes* a candidate topology update.
  * Before the candidate FlowMod touches the Zodiac FX's 128-entry table, the deterministic `SymbolicRouteVerifier.verifyLoopFree()` formally proves the route is a Directed Acyclic Graph (DAG). Any cycle immediately throws `RoutingLoopDetectedError` and halts installation.

### Role 3: Physical Hardware Reinforcement Learning (Quoc Le Adaptive Control)
* **Challenge**: Hardcoded rate limits and buffer sizes cause queue oscillation and bufferbloat under bursty agent workloads.
* **Jetson Orin TensorRT Mechanism**:
  * The Zodiac FX exposes 64-bit hardware counters: `fx_port_counts` (RX/TX packets, drops, CRC errors) and `fx_flow_counts` (matched packets and bytes).
  * An INT8 contextual bandit model running on the Jetson Orin observes real-time packet loss and latency feedback.
  * Dynamically reconfigures the Zodiac FX's 8 hardware rate meters and the software `AdaptiveFlowController` window using exact integer basis points (`BigInt`), completely eliminating magic constants.

### Role 4: DNS Sentinel & Agent Intent Classification
* **Challenge**: Malicious or drifting agents can employ DNS exfiltration or algorithmic domain generation (DGA) to communicate outside approved environments.
* **Jetson Orin TensorRT Mechanism**:
  * All agent DNS requests are serviced by the internal [src/dns/server.ts](file:///Users/andymorven/git/agentic-era-networking/src/dns/server.ts) resolver.
  * The Jetson Orin runs a character-level quantized sequence model classifying the semantic intent and entropy of requested FQDNs in <1 ms.
  * Queries identified as suspicious are rejected with `NXDOMAIN`, and an OpenFlow rule is dynamically synthesized to isolate the querying agent's MAC address.

---

## 5. Zodiac FX Hardware Constraints & Design Patterns

1. **Table Capacity Bound**: The switch supports a maximum of **128 flow entries** (`MAX_FLOWS = 128`).
   * *Invariant Solution*: The controller must implement deterministic LRU eviction with explicit `idle_timeout` and `hard_timeout` allocations.
2. **Software Pipeline Throughput**: Packets forwarded via OpenFlow are processed by the 120 MHz SAM4E8E MCU in tail-tag mode, yielding ~3–10 Mbps throughput.
   * *Invariant Solution*: Native traffic is delegated to KSZ8795 hardware VLAN switching; only agent-monitored, security-critical, and test traffic is routed through the OpenFlow pipeline.
3. **Fail-Closed State Enforcement**:
   * CLI configuration `set failstate secure` ensures that if the OpenFlow controller or USB serial connection terminates, all transit traffic is immediately dropped rather than leaked.

---

## 6. Telemetry Ingestion, Multi-Tier Storage & Query Routing Architecture

The system employs a deterministic two-tier storage and query routing architecture governed by the **Jeff Dean Latency Invariant** (<10ms local RAM, <20ms cloud edge RAM, <150ms WAN DB query) and **Sanjay Ghemawat's Zero-Bloat Invariant** (preventing connection exhaustion and unbounded database growth).

### Architectural Overview & Data Paths

```
                                  [ ARCHITECTURE OVERVIEW ]

   +-----------------------------------------------------------------------------------------+
   | 1. PHYSICAL APPLIANCE (LOCAL LAN)                                                       |
   |    Browser @ http://10.0.0.15:3003                                                      |
   |                                                                                         |
   |    Browser ────(every 2s GET /api/zodiac)────> Jetson Orin RAM Buffer (Zero DB)         |
   +-----------------------------------------------------------------------------------------+

   +-----------------------------------------------------------------------------------------+
   | 2. CLOUD PRODUCTION (VERCEL)                                                            |
   |    Browser @ https://agentic-era-networking.vercel.app                                  |
   |                                                                                         |
   |    Jetson Orin ──(every 10s POST)──> Vercel API ──(persist)──> Neon Postgres Table     |
   |                                            │                                            |
   |    Browser ──(Live Poll: GET /api/zodiac)──┘ [Served from Vercel RAM Cache: <20ms]      |
   |                                                                                         |
   |    Browser ──(Range: 1h/6h/24h/7d/30d)─────> Neon Postgres SQL Query [Sub-150ms]       |
   +-----------------------------------------------------------------------------------------+
```

### Ingestion vs. Query Lifecycle Matrix

| User Action / UI State | Deployment Target | Data Source | Ingestion / Query Cadence | Latency Budget | Mechanism & Invariant |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Live Appliance Dashboard** | Local LAN (`http://10.0.0.15:3003`) | **Jetson Orin Process RAM** | Every 2s poll (`GET /api/zodiac`) | `< 10ms` (LAN) | Direct memory read from `ZodiacBridgeServer.cachedSnapshot` and 120-point circular ring buffer. Zero database dependency. |
| **Hardware Cloud Relay** | Jetson → Cloud (`https://agentic-era-networking.vercel.app`) | **Neon Postgres (`ZodiacTelemetryPoint`)** | Every 10s push (`POST /api/zodiac`) | `< 3000ms` (WAN timeout) | Jetson background daemon pushes authenticated snapshot (`X-Zodiac-Bridge-Secret`). Vercel writes batched records to Neon via `persistTelemetrySnapshot()`. |
| **Live Cloud Dashboard** | Vercel Edge (`https://agentic-era-networking.vercel.app`) | **Vercel Serverless Memory** | Every 2s poll (`GET /api/zodiac`) | `< 20ms` (Edge) | Served directly from serverless in-memory `latestSnapshot` object. Never hits Neon, preserving database connections and compute credits. |
| **Historical Range Selector** | Vercel Edge (`https://agentic-era-networking.vercel.app`) | **Neon Postgres (`ZodiacTelemetryPoint`)** | On-demand on range click (`1h`, `6h`, `24h`, `7d`, `30d`) | `< 150ms` (Postgres query) | Executes database-level integer time-bucketing (`FLOOR("timestampMs" / bucketMs) * bucketMs`) returning $\le 360$ points without pulling 250k+ raw records over WAN. |
| **Automated Pruning Cron** | Vercel Cron | **Neon Postgres (`ZodiacTelemetryPoint`)** | Daily at 03:00 UTC (`0 3 * * *`) | `< 500ms` (Indexed delete) | Calls `/api/cron/prune-telemetry` with `Bearer ${CRON_SECRET}`, pruning points older than 30 days via indexed `timestampMs: { lt: cutoffMs }`. |

### Design Rationales

1. **Why Live Polling Bypasses Neon Postgres (Dean Latency & Cost Invariant)**:
   Polling a relational database every 2 seconds from concurrent web clients causes connection pool exhaustion, latency spikes (>100ms vs <20ms from RAM), and unnecessary compute billing. Serving live metrics from memory guarantees deterministic sub-20ms TTFB.
2. **Why Cloud Relay Cadence is 10 Seconds (Ghemawat Backpressure Invariant)**:
   The physical switch MCU serial telemetry stream arrives at 1–2 Hz. Relaying over WAN every 10 seconds generates exactly 8,640 records/day (~259,200 points/30 days, ~103.7 MB total storage footprint), perfectly matching Neon's serverless scaling envelope.
3. **Database-Level Downsampling vs. Application-Level Slicing**:
   Rather than fetching 250,000 raw points over the WAN and downsampling in Node.js memory (which causes severe memory bloat and function timeouts), PostgreSQL performs the grouping directly in the query planner using integer division, streaming back a lightweight payload under 50 KB.

