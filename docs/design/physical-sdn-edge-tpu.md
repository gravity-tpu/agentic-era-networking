# Physical SDN & Autonomous Master Appliance Architecture

> **Hardware Specification & Integration Blueprint for the Agentic Era**  
> **Physical Substrates:** Northbound Networks Zodiac FX OpenFlow Switch + NVIDIA Jetson Orin Nano Super (Master Appliance)  
> **Autonomous Master Appliance:** NVIDIA Jetson Orin Nano Super (24/7 dedicated controller host, 67 TOPS Ampere GPU, TensorRT INT8 engine)  
> **Untethered Workstation:** MacBook Pro (remote operator console via wireless WiFi 6/6E)  
> **Governing Paradigms:** Jeff Dean (Latency Budgets), Sanjay Ghemawat (Fail-Closed Simplicity), Quoc Le (Self-Tuning Control), Oriol Vinyals (Graph Routing), Demis Hassabis (Symbolic Proof Asymmetry).

---

## 1. Executive Summary & The Architectural Role Inversion

In autonomous agent networks, software emulation (e.g., Mininet, OVS) abstracts away critical physical artifacts: hardware buffer overruns, physical link state bounces, serialization jitter, and thermal throttle events. 

This architecture grounds the `gravity-tpu/agentic-era-networking` control plane in **physical hardware**, elevating the compute node from a secondary peripheral into a **24/7 Autonomous Master Appliance**:
- **Zodiac FX Switch**: Physical 4-port 10/100 Mbit/s OpenFlow switch (Microchip KSZ8795 switch IC + Atmel SAM4E8E 120 MHz ARM Cortex-M4 MCU) with a deterministic 128-entry flow table.
- **Autonomous Master Appliance (NVIDIA Jetson Orin Nano Super)**: Dedicated, 24/7 low-power (7W–15W) master controller running the OpenFlow 1.3 controller daemon (`:6633`), the RFC 1035 transparent DNS resolver (`:53`), symbolic DAG route verification, and line-rate TensorRT neural anomaly detection (67 TOPS INT8).
- **Untethered Operator Workstation (MacBook Pro)**: Completely decoupled from physical data plane dependencies. The laptop can sleep, reboot, or travel without causing network flapping or interrupting traffic flow.

---

## 2. Desktop Interconnect & Physical Wiring Topology

```
                                +-----------------------------------+
                                |    Public Internet / Home LAN     |
                                +-----------------+-----------------+
                                                  | (Mesh WiFi)
                                                  v
                                +-----------------------------------+
                                |     ISP Gateway / Mesh Node       |
                                +-----------------+-----------------+
                                                  | 100BASE-TX Ethernet
                                                  v
   +-----------------------------------------------------------------------------------------+
   |                       Zodiac FX OpenFlow Switch (Data Plane)                            |
   |                                                                                         |
   |   [Port 1]                 [Port 2]                 [Port 3]               [Port 4]     |
   |   Local Workload /         Gateway Uplink           Hardware Tap /         Controller   |
   |   Test Agent Subnet        (ISP Gateway)            Port Mirror            (OpenFlow)   |
   |                                                                                 |       |
   |   Micro-USB: Serial CDC Telemetry Stream (/dev/ttyACM0 @ 115200 8N1) ----------+----+  |
   +--------------------------------------------------------------------------------|-----+  |
                                                                                    |     |  |
                                           +----------------------------------------+     |  |
                                           | OpenFlow 1.3 Control Channel (100M/GbE)      |  |
                                           |                                              |  |
                                           v                                              v  v
   +-----------------------------------------------------------------------------------------+
   |             Autonomous Master Appliance: NVIDIA Jetson Orin Nano Super (24/7)           |
   |                                                                                         |
   |  * OpenFlow 1.3 Controller Plane (:6633) -- Fail-Closed FlowMod Dispatch                |
   |  * Transparent RFC 1035 DNS Resolver (:53) with VIP Reverse Proxy Mapping               |
   |  * Edge ML Anomaly Detection (TensorRT 67 TOPS Ampere Neural Engine)                    |
   |  * Symbolic Route Verifier (AlphaProof DAG Loop-Free Verification Invariant)            |
   |  * Real-Time Telemetry Daemon, Neon DB Relayer & Local Bridge Server (:3003)            |
   +-----------------------------------------------------------------------------------------+
                                           ^
                                           | Wireless WiFi 6 / 6E (Untethered HTTPS / SSH)
                                           v
   +-----------------------------------------------------------------------------------------+
   |                      Untethered Operator Workstation (MacBook Pro)                      |
   |  * Web UI Dashboard (https://agentic-era-networking.vercel.app / http://localhost:3003)  |
   |  * Zero Dependency: Close lid, reboot, or travel without interrupting network services   |
   +-----------------------------------------------------------------------------------------+
```

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

### Role 1: Real-Time Flow Anomaly Detection & Fail-Closed Quarantine
* **Challenge**: Autonomous AI agents executing tool-use loops can trigger rogue network behaviors (DDoS against local services, aggressive subnet scanning, abnormal packet burst frequencies).
* **Jetson Orin TensorRT Mechanism**: 
  * Port 3 of the Zodiac FX mirrors packet ingress streams into the Jetson Orin controller.
  * The TensorRT engine evaluates an INT8 1D-CNN or autoencoder on sliding windows of flow headers and inter-arrival time deltas ($\Delta t$).
  * If the anomaly reconstruction error exceeds the policy boundary, the controller pushes an immediate OpenFlow `FLOW_MOD` with highest priority (`65535`) to drop or quarantine the offending agent's traffic.
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

