# Physical SDN & Autonomous Master Appliance Architecture

> **Zodiac Hardware Specification & Integration Blueprint**  
> **Physical Substrates:** Northbound Networks Zodiac FX OpenFlow Switch + NVIDIA Jetson Orin Nano Super (Master Appliance) + Dual Google Coral Edge TPUs + Raspberry Pi 3B+ (Client Workload) + MacBook M5 Pro (Local AI Workstation & Review Plane)  
> **Autonomous Master Appliance:** NVIDIA Jetson Orin Nano Super (24/7 dedicated controller host, 67 TOPS Ampere GPU, TensorRT INT8 engine, Tri-Interface Stack)  
> **Inference Accelerators:** Dual Google Coral Edge TPUs (8 TOPS INT8 total compute, USB 3.0 line-rate packet classifier & DNS intent sentinel)  
> **Local AI Workstation & Review Plane:** MacBook M5 Pro (20-core Apple Silicon Metal GPU, 26B Gemma 4 local inference, zero-dependency Property List XML parser, 64-bit BigInt token accounting ledger)  
> **Untrusted Client Workload:** Raspberry Pi 3 Model B+ (isolated workload data plane on `eth0`, out-of-band management via `wlan0`)  
> **Dedicated Tap Interface:** ASIX AX88179 USB 3.0 GbE Adapter (`enx*` in promiscuous capture mode)  
> **Governing Paradigms:** Jeff Dean (Latency Budgets), Sanjay Ghemawat (Fail-Closed Simplicity), Quoc Le (Self-Tuning Control), Oriol Vinyals (Graph Routing), Demis Hassabis (Symbolic Proof Asymmetry).

---

## 1. Executive Summary & The Architectural Role Inversion

In autonomous agent networks, software emulation (e.g., Mininet, OVS) abstracts away critical physical artifacts: hardware buffer overruns, physical link state bounces, serialization jitter, and thermal throttle events. 

This architecture grounds the Zodiac control plane in **physical hardware**, elevating the appliances into a multi-tier, hardware-co-designed ecosystem:
- **Zodiac FX Switch**: Physical 4-port 10/100 Mbit/s OpenFlow switch (Microchip KSZ8795 switch IC + Atmel SAM4E8E 120 MHz ARM Cortex-M4 MCU) with a deterministic 128-entry flow table.
- **Autonomous Master Appliance (NVIDIA Jetson Orin Nano Super)**: Dedicated, 24/7 low-power (7W–15W) master controller running the OpenFlow 1.3 controller daemon (`:6633`), the RFC 1035 transparent DNS resolver (`:53`), symbolic DAG route verification, line-rate TensorRT neural anomaly detection (67 TOPS INT8), and physical SSD1306 OLED telemetry daemon.
- **Dual Google Coral Edge TPUs**: Dedicated 8 TOPS INT8 USB 3.0 coprocessors executing sub-millisecond shallow packet classification on mirrored data streams (TPU 0) and RFC 1035 DNS intent analysis (TPU 1) without taxing the Jetson GPU pipeline.
- **Dedicated Mirror Tap Interface (ASIX AX88179 USB GbE)**: Dedicated secondary physical NIC (`enx*`) on the Jetson Orin operating in promiscuous mode, directly cabled to Zodiac Port 3 for zero-loss packet inspection.
- **Untrusted Client Workload (Raspberry Pi 3 Model B+)**: Physical client agent running on an isolated test subnet via `eth0` attached to Zodiac Port 1, protected by an out-of-band management backdoor via `wlan0`.
- **Local AI Workstation (MacBook M5 · Gemma 4)**: High-performance Apple Silicon Metal GPU workstation executing autonomous code synthesis, the 5-Council pre-push code verification gate, real-time physical IOKit hardware profiling, and high-precision BigInt token accounting ledger. Decoupled from physical data plane dependencies while providing 100% local, air-gapped code reasoning.

---

## 2. Desktop Interconnect & Physical Wiring Topology

```
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
        │                             │             | (enx* Promiscuous)    |               │
        │                             │             +───────────┬───────────+               │
        │                             │                         │ USB 3.0                   │
        │                             │                         ▼                           │
        │                        +----+-----------------------------------------------------+   Micro-USB
        │                        |         NVIDIA Jetson Orin Nano Super Master Appliance   |<──Serial CDC
        │                        |                                                          |   /dev/ttyACM0
        │                        |  * Controller Plane: enP8p1s0 (<ctrl-subnet>) <──────────+───(115200 8N1)
        │                        |  * Mirror Tap Ingress: enx* (Promiscuous)                |
        │                        |  * Management Plane: wlP1p1s0 (<mgmt-subnet>)            |
        │                        |  * OpenFlow 1.3 Controller Plane (:6633)                 |
        │                        |  * RFC 1035 Transparent DNS Resolver (:53)              |
        │                        |  * Local Telemetry Bridge & Web UI (:3003)               |
        │                        |  * I2C SSD1306 0.96" OLED Telemetry (Bus 7, 0x3c)        |
        │                        +──────────────────────────────┬───────────────────────────+
        │                                                       │ Dual USB 3.0 SuperSpeed
        │                                                       ▼
        │                                           +───────────────────────────────────────+
        │                                           | Dual Google Coral Edge TPUs (8 TOPS)  |
        │                                           | * TPU 0: Port 3 Mirror Tap DPI        |
        │                                           | * TPU 1: RFC 1035 DNS Intent Sentinel |
        │                                           +───────────────────────────────────────+
        │                                                       │
        ▼                                                       │ Management Plane
+───────────────────────────────────+                           │ Wireless WiFi (<mgmt-subnet>)
| Raspberry Pi 3 Model B+ (Workload)|                           ▼
|                                   |       +───────────────────────────────────────────────────+
| * eth0: <workload-subnet> (Static)┼       | MacBook M5 · Gemma 4 Local Workstation Plane      |
|   Untrusted SDN Agent Data Plane  |       |                                                   |
|                                   |       | * 20-Core Apple Silicon Metal GPU (UMA VRAM)      |
| * wlan0: <mgmt-subnet> (Wi-Fi) <──+───────| * Local Ollama Engine: gemma4:26b (:11434)        |
|   Out-of-Band Management Backdoor |       | * Council Review Gate (Pre-push verification)     |
|                                   |       | * Zero-Dependency Plist XML Scanner (IOKit)       |
|                                   |       | * Deterministic BigInt Token Accounting Ledger    |
|                                   |       | * Epistemic Process Liveness Mutex (Signal 0)     |
|                                   |       | * Operator Console: http://localhost:3000 & Cloud |
|                                   |       | * Out-of-Band Safety: ssh agent@<pi-mgmt-ip>      |
+───────────────────────────────────+       +───────────────────────────────────────────────────+
```

### 2.1 Physical Interconnect & Interface Mapping Matrix

> [!NOTE]
> **Ground-Truth Device Registry**: Exact static IP allocations, hardware MAC addresses, and persistent device identifiers are managed exclusively in the local persistent context manager ([.agents/devices.local.md](file:///Users/andymorven/git/agentic-era-networking/.agents/devices.local.md)) to prevent credential/network leakage in public repositories.

| Node | Interface / Medium | Hardware Identity | Logical Network | Target / Destination | Role & Invariant |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Zodiac FX Switch** | Port 1 (100BASE-TX) | KSZ8795 Port 1 | Workload Data Plane (VLAN 100) | RPi 3B+ `eth0` | **Untrusted Workload Port**: Monitored agent data plane transit. |
| **Zodiac FX Switch** | Port 2 (100BASE-TX) | KSZ8795 Port 2 | Gateway Bridged (VLAN 100) | ISP Gateway / Mesh Node | **WAN / Gateway Uplink**: Egress to public internet. |
| **Zodiac FX Switch** | Port 3 (100BASE-TX) | KSZ8795 Port 3 | Port Mirror (VLAN 100) | Jetson `enx*` USB GbE | **Hardware Mirror Tap**: Zero-overhead port mirror for Coral/Jetson DPI. |
| **Zodiac FX Switch** | Port 4 (100BASE-TX) | KSZ8795 Port 4 | Switch Management (VLAN 200) | Jetson `enP8p1s0` | **OpenFlow 1.3 Control Channel**: Isolated switch management. |
| **Zodiac FX Switch** | Micro-USB (CDC-ACM) | Atmel VID 03eb PID 2404 | `/dev/ttyACM0` @ 115200 8N1 | Jetson USB Host | **Telemetry Stream**: 1–2 Hz hardware register stream. |
| **Jetson Orin Nano** | `enP8p1s0` (Onboard GbE) | Onboard Realtek GbE | Dedicated Control Subnet | Zodiac Port 4 | **OpenFlow Controller**: Listens on `:6633` (<1ms latency). |
| **Jetson Orin Nano** | `enx*` (USB 3.0 GbE) | ASIX AX88179 | Promiscuous (No IP) | Zodiac Port 3 | **Mirror Tap Ingress**: Line-rate packet capture for Coral TPU. |
| **Jetson Orin Nano** | `wlP1p1s0` (Wi-Fi) | M.2 Key-E Wi-Fi | Management Plane Subnet | Home Wireless LAN | **Management Plane**: Web UI (`:3003`), SSH, Cloud Relay. |
| **Google Coral TPU #1**| USB 3.0 SuperSpeed | Google VID 18d1 PID 9302 | USB 3.0 (`usb:0`) | Jetson USB-A | **Line-Rate Tap DPI**: 4 TOPS INT8 mirror tap packet triage (<500 µs). |
| **Google Coral TPU #2**| USB 3.0 SuperSpeed | Unichip VID 1a6e PID 089a | USB 3.0 (`usb:1`) | Jetson USB-A | **DNS Intent Sentinel**: 4 TOPS INT8 RFC 1035 DGA and exfiltration filter. |
| **SSD1306 OLED** | 4-Pin I2C (Bus 7) | Address `0x3c` | Jetson 40-Pin Header | Jetson Front Bezel | **Front Panel Telemetry**: 5-screen rotational physical display. |
| **Raspberry Pi 3B+** | `eth0` (Onboard GbE) | Microchip LAN7800 | Isolated Workload Subnet | Zodiac Port 1 | **Untrusted Agent Workload**: Target for SDN policy enforcement. |
| **Raspberry Pi 3B+** | `wlan0` (Wi-Fi) | Broadcom BCM43455 | Management Plane Subnet | Home Wireless LAN | **Out-of-Band Safety**: Dedicated SSH backdoor to prevent lockouts. |
| **MacBook M5 Workstation** | Wi-Fi 6/6E (802.11ax) | Apple M5 Pro Metal GPU | Management Plane Subnet | Home Wireless LAN / Cloud | **Local AI Workstation & Review Plane**: 20-Core Metal GPU executing `gemma4:26b` for Council pre-push code verification, IOKit telemetry, and deterministic BigInt token accounting ledger. |

### 2.2 Dual-Homed Workload Architecture & Asymmetric Routing Invariant

> [!IMPORTANT]
> **Subnet Isolation Law (Ghemawat Invariant)**:  
> The Raspberry Pi 3B+ data plane interface (`eth0`) is assigned an isolated subnet distinct from the management wireless LAN.  
>
> If `eth0` were assigned an address on the same subnet as the management network, Linux kernel route selection and Reverse Path Forwarding (rp_filter) would route SSH return packets destined for the operator workstation out through `eth0` into Zodiac Port 1 instead of returning over `wlan0`. Because OpenFlow has no active forwarding rule for unclassified host traffic, this immediately blackholes the SSH session.
>
> By strictly partitioning the data plane to an isolated subnet, operator SSH access over `wlan0` remains 100% immune to OpenFlow table flushes, flow timeouts, quarantine rules, and switch reboots. Exact subnet definitions and routes are documented in [.agents/devices.local.md](file:///Users/andymorven/git/agentic-era-networking/.agents/devices.local.md).

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
  * Port 3 of the Zodiac FX hardware-mirrors all data plane packet traffic (VLAN 100) directly to the Jetson Orin's dedicated ASIX AX88179 USB GbE adapter (`enx*`) in promiscuous mode.
  * **Stage 1 — Google Coral Edge TPU #1 (`usb:0`, 4 TOPS INT8)**: Dedicated exclusively to the Port 3 mirror tap. Executes ultra-fast, shallow INT8 quantized frame header anomaly classification (<100 µs), assessing inter-arrival time deltas ($\Delta t$), packet size distributions, and burst frequencies without consuming GPU/CPU cycles.
  * **Stage 2 — Jetson Orin TensorRT (67 TOPS Ampere)**: Deep anomaly detection models (1D-CNN autoencoder) evaluate suspicious sequences flagged by Stage 1 within a `< 1.0 ms` budget.
  * If the anomaly reconstruction error exceeds the policy boundary, the controller pushes an immediate OpenFlow `FLOW_MOD` with highest priority (`65535`) to drop or quarantine the offending agent's MAC/IP traffic on Port 1.
* **Dedicated Model Parallelism Invariant (Dean & Ghemawat)**:
  * **Why Dedicated Roles, Not Dynamic Auto-Balancing?**: Each Edge TPU possesses an 8 MB on-chip scratchpad SRAM. If two distinct models (Flow Anomaly vs. DNS Intent) were auto-balanced dynamically across both TPUs, each inference query would trigger a model eviction and reload over the USB bus, incurring a **5–15 ms latency penalty** per switch.
  * Dedicated role assignment achieves **zero model reload latency** (0 ns overhead) by pinning Model A permanently into Coral #1 SRAM and Model B into Coral #2 SRAM.
  * **Failover Invariant**: Only upon physical hardware failure or thermal throttling of one unit does the system fall back to time-sliced dual execution on the survivor.
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

### Role 4: DNS Sentinel & Agent Intent Classification (Dedicated Coral TPU #2)
* **Challenge**: Malicious or drifting agents can employ DNS exfiltration or algorithmic domain generation (DGA) to communicate outside approved environments.
* **Google Coral Edge TPU #2 (`usb:1`, 4 TOPS INT8) Sentinel**:
  * All agent DNS requests are serviced by the internal [src/dns/server.ts](file:///Users/andymorven/git/agentic-era-networking/src/dns/server.ts) resolver.
  * Rather than consuming Jetson GPU/CPU cycles, Coral #2 runs a dedicated character-level quantized sequence model in SRAM, evaluating the semantic intent, entropy, and DGA likelihood of requested FQDNs in <300 µs.
  * Queries identified as suspicious are rejected with `NXDOMAIN`, and an OpenFlow rule is dynamically synthesized to isolate the querying agent's MAC address on the Zodiac FX data plane.

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

The system employs a deterministic **three-tier storage and query routing architecture** governed by the **Jeff Dean Latency Invariant** (<10ms local RAM, <150ms local NVMe, <150ms WAN DB query) and **Sanjay Ghemawat's Zero-Bloat Invariant** (preventing connection exhaustion and unbounded database growth).

### Tier Overview

| Tier | Storage Medium | Location | Capacity | Surviving Restart? | Primary Consumer |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Tier 1 — Process RAM** | `ZodiacBridgeServer` in-memory ring buffer | Jetson Orin RAM | ~2.5 h (3600 × 2.5 s points) | No (checkpoint to disk, loaded on start) | Live UI polling (≤10 min range) |
| **Tier 2 — Local NVMe JSONL** | Append-log per calendar day, per device type | `/var/lib/zodiac/history/` | 30 days (~430 KB/day/device type) | **Yes** — survives reboots and crashes | Localhost historical queries (1h–30d) |
| **Tier 3 — Neon Postgres** | `ZodiacTelemetryPoint` table, indexed on `timestampMs` | Neon serverless Postgres (cloud) | 30 days (pruned daily at 03:00 UTC) | **Yes** — cloud-durable | Vercel historical queries (1h–30d) |

### Architectural Overview & Data Paths

```
  ┌─────────────────────────────────────────────────────────────────────────────────────┐
  │ JETSON ORIN NANO SUPER (LOCAL LAN)                                                   │
  │                                                                                      │
  │  Hardware ─(2.5s)─> RAM Ring Buffer (Tier 1) ──────────────────────────────────┐    │
  │                              │                                                  │    │
  │                              │ (every 30s flush)                                │    │
  │                              ▼                                                  │    │
  │              /var/lib/zodiac/history/*.jsonl (Tier 2)                           │    │
  │              zodiac-YYYY-MM-DD.jsonl                                            │    │
  │              jetson-YYYY-MM-DD.jsonl                                            │    │
  │              coral-YYYY-MM-DD.jsonl                                             │    │
  │                                                                                 │    │
  │  Browser GET /api/zodiac?range=1h|6h|24h|7d|30d                                │    │
  │    1. Query Tier 2 (local NVMe JSONL — always available, no internet)           │    │
  │    2. Query Tier 3 (Neon, if Tier 2 is empty — e.g. first run after install)   │    │
  │    3. Downsample Tier 1 ring buffer (fallback, max 2.5 h)                      │    │
  │                                                                                 │    │
  │  Browser GET /api/zodiac (live, no range) ─────────────────────────────────────┘    │
  │    → Served directly from Tier 1 RAM cache (<10 ms LAN latency)                     │
  │                                                                                      │
  └─────────────────────────────┬────────────────────────────────────────────────────────┘
                                │
                                │ Cloud Relay (fire-and-forget, exponential backoff)
                                │ X-Zodiac-Bridge-Secret HMAC authentication
                                │ Backoff: 5s → 10s → 20s → 40s → 60s cap (monotonic clock)
                                ▼
  ┌─────────────────────────────────────────────────────────────────────────────────────┐
  │ VERCEL PRODUCTION (https://agentic-era-networking.vercel.app)                        │
  │                                                                                      │
  │  POST /api/zodiac ──────> persistTelemetrySnapshot() ──> Neon Postgres (Tier 3)     │
  │                                                                                      │
  │  Browser GET /api/zodiac (live) ────────────────────────────────────────────────┐   │
  │    → Vercel serverless in-memory latestSnapshot (<20 ms edge latency)            │   │
  │                                                                                  │   │
  │  Browser GET /api/zodiac?range=1h|6h|24h|7d|30d                                 │   │
  │    → Neon Postgres SQL (bucketed integer downsampling, ≤360 pts) [<150 ms]      │   │
  │                                                                                  │   │
  │  Vercel Cron 03:00 UTC ──> /api/cron/prune-telemetry ──> DELETE WHERE ts < 30d  │   │
  └──────────────────────────────────────────────────────────────────────────────────┘
```

### Local JSONL History Engine (`src/db/local-telemetry-db.ts`)

Every 30 seconds `ZodiacBridgeServer` appends one averaged data point per device type to the current day's JSONL file using `fs.promises.appendFile` (never blocking the SDN event loop). Each flush uses `downsamplePoints(newPts, 1)` to average the ~12 raw 2.5 s points into a single representative point.

**Storage budget per device type:**
- 2 points/min × 60 min × 24 h = 2,880 points/day
- ~150 bytes/point (compact JSON, BigInt serialized as strings)
- ≈ 430 KB/day × 3 device types × 30 days ≈ **39 MB total** (well within 500 GB NVMe)

**Query flow:** `queryLocalHistory(range)` fans reads across all relevant day files in parallel via `Promise.all`, flattens with `.flat()`, sorts ascending, then applies the same `downsamplePoints` / `downsampleJetsonPoints` / `downsampleCoralPoints` bucketing used by the Neon path — producing ≤360 output points regardless of range.

**30-day retention:** `pruneLocalHistory()` runs synchronously on bridge server startup (before HTTP traffic begins), deleting files whose UTC date suffix predates the 30-day cutoff.

### Cloud Relay Resilience (`ZodiacBridgeServer.relaySnapshotToCloud`)

The relay fires from every 2.5 s hardware poll but is gated by an exponential backoff counter (`consecutiveRelayFailures`) measured on a monotonic `performance.now()` clock (immune to NTP adjustments):

| Failure Count | Next Retry After |
| :--- | :--- |
| 0 (healthy) | Immediate (next 2.5 s poll) |
| 1 | 5 s |
| 2 | 10 s |
| 3 | 20 s |
| 4 | 40 s |
| ≥5 | 60 s (cap) |

On recovery, `consecutiveRelayFailures` resets to 0 and the bridge logs the outage duration. Because the relay always sends `snapshot.timeSeries.slice(-MAX_RELAY_POINTS)`, the next successful relay naturally backfills the most recent missed window (up to ~12.5 min) into Neon.

### Ingestion vs. Query Lifecycle Matrix

| User Action / UI State | Deployment Target | Data Source | Cadence | Latency Budget | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Live Appliance Dashboard** | Local LAN (`:3003`) | Tier 1 — Jetson RAM | 2 s poll | `< 10 ms` | `cachedSnapshot` direct read; zero DB dependency. |
| **Local Historical Range** | Local LAN (`:3003`) | Tier 2 — Local JSONL → Tier 3 Neon fallback → Tier 1 | On-demand | `< 150 ms` NVMe | Tier 2 always tried first; internet not required. |
| **Hardware Cloud Relay** | Jetson → Vercel | Tier 3 — Neon Postgres | ~2.5 s (gated by backoff) | `< 3000 ms` WAN | Exponential backoff prevents hammering on 5xx/network errors. |
| **Live Cloud Dashboard** | Vercel (`.vercel.app`) | Vercel serverless RAM | 2 s poll | `< 20 ms` | `latestSnapshot` in-memory; never hits Neon on live path. |
| **Cloud Historical Range** | Vercel (`.vercel.app`) | Tier 3 — Neon Postgres | On-demand | `< 150 ms` | SQL integer-bucketed downsampling; ≤360 output points. |
| **Automated Pruning Cron** | Vercel Cron | Tier 3 — Neon Postgres | Daily 03:00 UTC | `< 500 ms` | `/api/cron/prune-telemetry`; `DELETE WHERE timestampMs < cutoff`. |
| **Local Pruning on Start** | Jetson (startup) | Tier 2 — Local JSONL | Once at boot | `< 100 ms` | `pruneLocalHistory()` deletes files > 30 days before HTTP server opens. |

### Design Rationales

1. **Why Local JSONL (Tier 2) Instead of Querying Neon Locally**:
   The in-memory ring buffer is capped at ~2.5 h. Historical ranges (6 h, 24 h, 7 d, 30 d) previously required querying Neon over WAN — which fails when the Jetson has no internet or Vercel is degraded. Local JSONL files on the NVMe SSD are always available, have zero network dependency, and survive process restarts. The Jetson becomes fully self-sufficient for 30-day history without Neon.

2. **Why Append-Only JSONL (Not SQLite or a Database)**:
   Introducing SQLite or any embedded database adds a runtime dependency, lock files, WAL management, and non-trivial startup overhead. Append-only JSONL files with one averaged point per 30 s flush have zero new dependencies (only `node:fs/promises`), are trivially inspectable with `cat`, survive partial writes without corruption (each line is atomic at the OS level with `O_APPEND`), and can be parsed in parallel with `Promise.all`.

3. **Why Live Polling Still Bypasses All Storage Tiers**:
   Polling any persistent store (disk or DB) every 2 s from concurrent browser clients causes unnecessary I/O and latency jitter. The Tier 1 RAM cache guarantees deterministic <10 ms TTFB for live metrics.

4. **Why Cloud Relay Cadence Stays at ~2.5 s (with Backoff)**:
   The relay payload is bounded to `MAX_RELAY_POINTS` points, keeping WAN payloads under 512 KB. Neon's `persistTelemetrySnapshot()` enforces a 10 s minimum write cadence server-side (deduplication), so frequent relay calls don't cause write amplification — they just keep the serverless RAM cache warm for the live Vercel dashboard.

---

## 5. The Local AI Workstation Tier: MacBook M5 & Local Gemma 4 Engine
 
 ### 5.1 Architecture & Computational Role
 The MacBook Pro M5 is elevated from a passive management console into an active **Local AI Workstation Tier** within the Zodiac topology:
 - **Silicon Acceleration:** 20-core Apple Silicon Metal GPU coupled with Unified Memory Architecture (UMA) providing high-bandwidth memory access for local model weights.
 - **Local Inference Engine:** Hosts Google's `gemma4:26b` (26B parameter model) on Ollama (`http://localhost:11434`), executing local code reviews, patch audits, and agent policy verification with zero cloud latency and zero API cost.
-- **Dual-Stage Council Review Architecture (Demis Hassabis & Oriol Vinyals):**
-  - **Stage 1 (Local Edge Workstation Gate):** Executes the 5-Council pre-push code audit locally using local Metal GPU compute, providing instant feedback to the engineer before git push.
-  - **Stage 2 (Server-Side Symbolic Invariant Gate):** To enforce true **Verification Asymmetry** (*"Probabilistic generation proposes. Deterministic systems dispose"*), local pre-push evaluation is complemented by mandatory, immutable server-side CI/CD verification gates. Unverified agentic modifications are deterministically blocked from merging to `main` until passing formal symbolic verification, BigInt invariant suites, and cryptographic provenance checks.
+
+### 5.2 Physical IOKit Telemetry Engine & Fail-Closed Platform Boundary (`src/sdn/hardware-probe.ts`)
+To satisfy Council Invariant 6 (Goodhart's Law & Epistemic Telemetry Provenance) and Sanjay Ghemawat's invariant rigor:
+- **Strict Platform Boundary & Fail-Closed Isolation:** Darwin-specific tools (`ioreg`, `sysctl`) are strictly confined to macOS. `probeWorkstationHardware()` and `queryAppleGpuMetrics()` evaluate `os.platform() !== 'darwin'` at the entry boundary, immediately failing closed to safe offline defaults (`connected: false`, `gpuUtilizationPct: 0`, `0` counters) without spawning child processes. The Master Appliance (Jetson Orin) executes its own Linux sysfs/tegrastats probes independently, ensuring zero platform cross-contamination.
+- **Metal GPU Statistics:** On Darwin, probed via `ioreg -r -c IOAccelerator -d 1 -a` to extract exact physical metrics: `gpuUtilizationPct` (Device Utilization %), `rendererUtilizationPct`, `tilerUtilizationPct`, `gpuMemoryUsedBytes` (In use system memory), and `gpuMemoryAllocatedBytes` (Alloc system memory).
+- **Formal Property List XML Parser:** Implements `parseApplePlistXml`, a deterministic, zero-dependency character-by-character scanner and bounded AST parser supporting CDATA blocks, DOCTYPE declarations, entity unescaping, and depth bounds (`MAX_PLIST_DEPTH = 32`) to eliminate fragile regex heuristics and protect against stack exhaustion.
+- **Fail-Closed Offline Reporting:** When Ollama or IOKit is disconnected, metrics evaluate to physical truth: `0` velocities, `0%` utilization, and explicit `OFFLINE` badges. Synthetic wave generation is strictly prohibited.
+
+### 5.3 Deterministic 64-Bit BigInt Token Accounting Ledger
+Council Invariant 2 mandates absolute determinism in telemetry and metering. All token counters avoid IEEE-754 floating-point casting:
+- **Counters:** `totalTokens`, `totalPromptTokens`, `totalCompletionTokens`, and `totalInferences` are computed using native `BigInt`.
+- **Wire Serialization:** Transported over JSON boundaries as decimal strings (e.g. `"14820"` rather than raw floats or scientific notation), preventing precision drift past $2^{53}-1$ across heterogeneous consumers.
+- **Real-Time Velocities & Latency Profiling:**
+  - Token Generation Velocity (`tok/s` = `(completionTokens * 1e9) / evalDurationNs`)
+  - Prompt Evaluation / Prefill Velocity (`tok/s` = `(promptTokens * 1e9) / promptEvalDurationNs`)
+  - Peak velocities (`peakTokensPerSecond`, `peakPromptTokensPerSecond`)
+  - Time-To-First-Token (TTFT) and Inter-Token Latency (ITL) jitter evaluated against Jeff Dean's Systems Latency standard (500ms–2000ms SLA).
+  - Per-token generation latency (`ms/token`).
+  - Context window saturation (`tokens / maxTokens · pct`) and edge compute ratio (`edgeComputeRatioPct: 100.0%`).
+
+### 5.4 Multi-Process Concurrency & Mutex (`scripts/ai-utils.mjs`)
+To prevent Read-Modify-Write (RMW) race conditions when concurrent inference tasks or pre-push gates execute:
+- **Intra-Process Serialization:** An asynchronous Promise queue (`enqueueTelemetryMutation`) guarantees serial execution of telemetry file mutations within the Node.js runtime.
+- **Inter-Process Mutual Exclusion:** A file-level mutex (`withTelemetryFileLock`) uses `open(lockPath, 'wx')` for atomic lock acquisition.
+- **Epistemic Process Liveness Detection:** Abandoned locks from crashed processes are recovered by probing kernel signal 0 (`process.kill(pid, 0)` -> `ESRCH`), eliminating brittle hardcoded timeouts while ensuring deterministic lock clearance.
+
+### 5.5 Hybrid Edge-to-Cloud Offload Plane & Anti-Runaway Controls (Quoc Le Invariant)
+The workstation operates as the primary edge reasoning tier with an autonomous fallback chain:
+1. `gemma4:26b` (Local Apple Silicon Metal GPU — primary)
+2. `gemini-pro-latest` (Google Cloud fallback)
+3. `claude-opus-4-8` (Anthropic Cloud fallback)
+4. `gpt-4o` (OpenAI Cloud fallback)
+5. `gemini-3.8-flash` → `claude-sonnet-4-6` → `gpt-4o-mini` (High-speed fallbacks)
+
+To prevent non-deterministic distribution shifts, latency runaway, and unbounded cloud recursion:
+- **Circuit Breaker:** Hard cap of 3 consecutive cloud attempts before failing closed to local edge quarantine.
+- **Strict Timeout Budget:** Every cloud API request enforces an immutable 10-second timeout (`AbortSignal.timeout(10000)`), preventing lagging WAN links from blocking agentic reasoning loops.
+- **Edge Compute Ratio Invariant:** Continuous telemetry tracking of `edgeComputeRatioPct`. If edge compute falls below the 90.0% SLA threshold, the system flags an invariant warning (`WARN_CLOUD_DISTRIBUTION_SHIFT`) and throttles background tasks to preserve edge sovereignty and prevent runaway cloud billing.
+- **Verifiable Ledger:** All cloud token consumption is recorded in `recordCloudInferenceMetrics` with cryptographic attribution and model metadata.
+


