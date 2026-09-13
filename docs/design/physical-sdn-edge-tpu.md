# Physical SDN & Edge TPU Co-Design Architecture

> **Hardware Specification & Integration Blueprint for the Agentic Era**  
> **Physical Substrates:** Northbound Networks Zodiac FX OpenFlow Switch + Google Coral USB Accelerator (Edge TPU)  
> **Host Interconnect:** MacBook Pro via DisplayLink Desktop Dock  
> **Governing Paradigms:** Jeff Dean (Latency Budgets), Sanjay Ghemawat (Fail-Closed Simplicity), Quoc Le (Self-Tuning Control), Oriol Vinyals (Graph Routing), Demis Hassabis (Symbolic Proof Asymmetry).

---

## 1. Executive Summary & Hardware Topology

In autonomous agent networks, software emulation (e.g., Mininet, OVS) abstracts away critical physical artifacts: hardware buffer overruns, physical link state bounces, serialization jitter, and thermal throttle events. 

This architecture grounds the `gravity-tpu/agentic-era-networking` control plane in **physical desktop hardware**:
- **Zodiac FX Switch**: A physical 4-port 10/100 Mbit/s OpenFlow switch (Microchip KSZ8795 switch IC + Atmel SAM4E8E 120 MHz ARM Cortex-M4 MCU) with a deterministic 128-entry flow table.
- **Google Coral USB Accelerator (Edge TPU)**: Dedicated tensor coprocessor delivering 4 TOPS of INT8 inference at ~0.5 W per TOPS over USB 3.0.
- **Host Controller (MacBook via DisplayLink Dock)**: Unified host orchestrator running the OpenFlow 1.3 controller, the TypeScript symbolic verifier, and the telemetry ingest daemon.

### Standalone Edge TPU (No Raspberry Pi Required)
A standalone single-board computer (such as a Raspberry Pi) is **not** required. The Google Coral USB Accelerator connects directly to the USB 3.0 bus of your DisplayLink dock or MacBook USB-C hub. 

Running the Coral accelerator directly on the workstation host provides substantial advantages:
1. **Zero Intermediate Serialization Latency**: Feature vectors extracted from network telemetry are transferred directly across the high-speed local USB 3.0 / PCIe bus rather than traversing an intermediate network link to an SBC.
2. **Superior Host CPU Preprocessing**: Apple Silicon / workstation CPUs vectorize packet headers, compute inter-arrival time deltas, and format INT8 tensors exponentially faster than low-power SBC cores.
3. **Single Operational Pane**: All daemons—the Node/TypeScript OpenFlow 1.3 controller, serial telemetry monitor, Edge TPU inference engine, and Prometheus metrics—run within a unified, easily observable environment.

---

## 2. Desktop Interconnect & Physical Wiring

```
                   +-------------------------------------------------------------+
                   |                 MacBook (Host Controller)                   |
                   |                                                             |
                   |  - Symbolic Route Verifier (Demis Hassabis Loop-Free Proof) |
                   |  - Adaptive Flow Controller (Quoc Le Dynamic Window)        |
                   |  - OpenFlow 1.3 Server (:6633) & Prometheus Telemetry       |
                   +------------------------------+------------------------------+
                                                  | USB 3.0 / Thunderbolt
                                                  v
                   +-------------------------------------------------------------+
                   |                DisplayLink Desktop Dock                     |
                   +---------------+-----------------------------+---------------+
                                   |                             |
                       USB 3.0 Bus |                 Ethernet    | (Controller LAN)
                                   v                             v
           +-------------------------------+             +---------------+
           |    Google Coral USB Edge TPU  |             | Zodiac Port 4 |
           |  * 4 TOPS INT8 Inference      |             |  (Native Mgmt)|
           |  * Sub-4ms Anomaly Detection  |             +-------+-------+
           +-------------------------------+                     |
                                                                 | Internal
                                                                 v
+---------------------------------------------------------------------------------+
|                       Zodiac FX OpenFlow Switch (Desktop)                       |
|                                                                                 |
|   Micro-USB: Serial CDC CLI (/dev/cu.usbmodem* @ 115200 8N1) -> To Dock USB     |
|   Port 1: Test Workload / Sandbox Agent Host                                    |
|   Port 2: Outbound Gateway / Uplink                                             |
|   Port 3: Mirror / Tap Port (Real-time packet capture)                          |
|   Port 4: Controller Port (Connected to DisplayLink Ethernet, default 10.0.1.99)|
+---------------------------------------------------------------------------------+
```

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
Google Coral Edge TPU Inference          2,500,000 ns             2.5 ms            Autonomous ML Flow Decision (PASS)
WAN Roundtrip (Cross-continent)        150,000,000 ns             150 ms            Cloud round-trip (FAIL)
Cloud LLM TTFT (API Call)            1,000,000,000 ns           1,000 ms (1 s)      Cloud Agent Reasoning (FAIL)
```

The Coral Edge TPU executes quantized neural inference in **2.5 ms**, allowing real-time intervention before switch input buffers overflow.

---

## 4. The 4 Architectural Roles for Coral TPU in Agentic Networking

### Role 1: Real-Time Flow Anomaly Detection & Fail-Closed Quarantine
* **Challenge**: Autonomous AI agents executing tool-use loops can trigger rogue network behaviors (DDoS against local services, aggressive subnet scanning, abnormal packet burst frequencies).
* **Edge TPU Mechanism**: 
  * Port 3 of the Zodiac FX mirrors packet ingress streams into the host controller.
  * The Edge TPU evaluates an INT8 1D-CNN or autoencoder on sliding windows of flow headers and inter-arrival time deltas ($\Delta t$).
  * If the anomaly reconstruction error exceeds the policy boundary, the controller pushes an immediate OpenFlow `FLOW_MOD` with highest priority (`65535`) to drop or quarantine the offending agent's traffic.
* **Fail-Closed Invariant**: Conforms to Sanjay Ghemawat & Demis Hassabis rules: if the ML detector fails or is ambiguous, the system defaults to DROP/QUARANTINE.

### Role 2: Verification Asymmetry & Symbolic Proof (AlphaProof Paradigm)
* **Challenge**: Neural networks are probabilistic and non-deterministic; they can suggest degenerate or cyclical routing rules.
* **Edge TPU Mechanism**:
  * The Coral Edge TPU runs a Graph Neural Network (or Pointer Network) predicting optimal path transitions under varying link costs.
  * **The Verification Invariant**: The neural model merely *proposes* a candidate topology update.
  * Before the candidate FlowMod touches the Zodiac FX's 128-entry table, the deterministic `SymbolicRouteVerifier.verifyLoopFree()` formally proves the route is a Directed Acyclic Graph (DAG). Any cycle immediately throws `RoutingLoopDetectedError` and halts installation.

### Role 3: Physical Hardware Reinforcement Learning (Quoc Le Adaptive Control)
* **Challenge**: Hardcoded rate limits and buffer sizes cause queue oscillation and bufferbloat under bursty agent workloads.
* **Edge TPU Mechanism**:
  * The Zodiac FX exposes 64-bit hardware counters: `fx_port_counts` (RX/TX packets, drops, CRC errors) and `fx_flow_counts` (matched packets and bytes).
  * An INT8 contextual bandit model running on the Coral TPU observes real-time packet loss and latency feedback.
  * Dynamically reconfigures the Zodiac FX's 8 hardware rate meters and the software `AdaptiveFlowController` window using exact integer basis points (`BigInt`), completely eliminating magic constants.

### Role 4: DNS Sentinel & Agent Intent Classification
* **Challenge**: Malicious or drifting agents can employ DNS exfiltration or algorithmic domain generation (DGA) to communicate outside approved environments.
* **Edge TPU Mechanism**:
  * All agent DNS requests are serviced by the internal [src/dns/server.ts](file:///Users/andymorven/git/agentic-era-networking/src/dns/server.ts) resolver.
  * The Edge TPU runs a character-level quantized sequence model classifying the semantic intent and entropy of requested FQDNs in <1 ms.
  * Queries identified as suspicious are rejected with `NXDOMAIN`, and an OpenFlow rule is dynamically synthesized to isolate the querying agent's MAC address.

---

## 5. Zodiac FX Hardware Constraints & Design Patterns

1. **Table Capacity Bound**: The switch supports a maximum of **128 flow entries** (`MAX_FLOWS = 128`).
   * *Invariant Solution*: The controller must implement deterministic LRU eviction with explicit `idle_timeout` and `hard_timeout` allocations.
2. **Software Pipeline Throughput**: Packets forwarded via OpenFlow are processed by the 120 MHz SAM4E8E MCU in tail-tag mode, yielding ~3–10 Mbps throughput.
   * *Invariant Solution*: Native traffic is delegated to KSZ8795 hardware VLAN switching; only agent-monitored, security-critical, and test traffic is routed through the OpenFlow pipeline.
3. **Fail-Closed State Enforcement**:
   * CLI configuration `set failstate secure` ensures that if the OpenFlow controller or USB serial connection terminates, all transit traffic is immediately dropped rather than leaked.
