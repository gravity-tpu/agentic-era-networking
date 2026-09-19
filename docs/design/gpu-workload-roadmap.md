# Jetson Orin GPU Workload Mini-Roadmap (`gpu-workload`)

> **Autonomous Master Appliance Ampere GPU Pipeline**  
> **Silicon Target**: NVIDIA Jetson Orin Nano Super (1024 CUDA Cores, 32 Tensor Cores, 67 TOPS Ampere Architecture, JetPack 6.1 / L4T 36.4.7)  
> **Governing Council Invariants**: Jeff Dean (Latency Budgets & Zero-Bloat), Sanjay Ghemawat (Fail-Closed Default), Quoc Le (Self-Tuning Control Loops), Oriol Vinyals (Graph/Temporal Dynamics), Demis Hassabis (Symbolic Proof Asymmetry).

---

## 1. Executive Summary & Objective

While the Master Appliance CPU (ARM Cortex-A78AE) and external USB Google Coral Edge TPUs have been actively driving OpenFlow 1.3 and shallow packet triage, the **67 TOPS NVIDIA Ampere GPU** on the Jetson Orin has remained at 0% utilization.

The `gpu-workload` initiative establishes a structured progression to harness the Orin GPU for high-throughput, low-latency SDN control plane and data plane acceleration.

```
+───────────────────────────────────────────────────────────────────────────────+
|               NVIDIA Jetson Orin Nano Super (Master Appliance)                |
|                                                                               |
|  [ ARM Cortex-A78AE CPU ]          [ Dual Google Coral Edge TPUs (USB 3.0) ]  |
|  * OpenFlow 1.3 Controller (:6633) * TPU #1: Wire-Tap Shallow Triage (<100 µs)|
|  * Telemetry Bridge Server (:3003) * TPU #2: RFC 1035 DNS Sentinel (<300 µs) |
|  * I2C OLED Telemetry Daemon                                                  |
|                                                                               |
|  ===========================================================================  |
|  [ 67 TOPS Ampere GPU — 1024 CUDA Cores + 32 Tensor Cores ]                  |
|  ───────────────────────────────────────────────────────────────────────────  |
|  * Phase 1 / Quick Win : GPU Neural Burst Engine (Hardware Stress & Bench)     |
|  * Phase 2 / Real SDN  : Stage-2 Deep Anomaly Autoencoder & Quarantine        |
|  * Phase 3 / Adaptive  : Quoc Le Rate-Meter Optimizer (Contextual Bandit)     |
|  * Phase 4 / Temporal  : Micro-Burst & Congestion Forecaster (TCN / LSTM)     |
+───────────────────────────────────────────────────────────────────────────────+
```

---

## 2. Workload Items & Milestones

### Item 1: `gpu-workload-1` — GPU Neural Stress & Verification Burst Worker (Quick Win)
* **Status**: `PROPOSED` (Immediate Execution)
* **Goal**: Enable operator and automated stress testing of the Jetson Ampere GPU via `npm run burst -- --target jetson` (or `--target gpu`).
* **Implementation Details**:
  - Extend [scripts/hardware-burst-daemon.py](file:///Users/andymorven/git/agentic-era-networking/scripts/hardware-burst-daemon.py) with a dedicated `jetson_gpu_worker` thread.
  - Generates continuous, controlled CUDA/TensorRT matrix operations (FP16/INT8 GEMM and convolution passes).
  - Designed with graceful fallback: runs full CUDA tensor operations on Jetson Tegra Linux, while falling back cleanly on non-CUDA hosts (macOS dev workstation) without crashing.
  - Updates [scripts/burst-cli.ts](file:///Users/andymorven/git/agentic-era-networking/scripts/burst-cli.ts) to support `--target jetson`, `--target gpu`, and display live GPU utilization and thermal metrics.
* **Telemetry & Provenance**:
  - Live load registers on `/sys/devices/platform/bus@0/17000000.gpu/load` (scaling from 0% to 35%–75%).
  - Power consumption visible in `vddCpuGpuCv` via [src/sdn/hardware-probe.ts](file:///Users/andymorven/git/agentic-era-networking/src/sdn/hardware-probe.ts).

---

### Item 2: `gpu-workload-2` — Stage-2 Deep Traffic Anomaly Autoencoder & Fail-Closed Quarantine (Real SDN App)
* **Status**: `PROPOSED` (Immediate Execution)
* **Goal**: Implement the second tier of the Split-Inference pipeline defined in [docs/design/physical-sdn-edge-tpu.md](file:///Users/andymorven/git/agentic-era-networking/docs/design/physical-sdn-edge-tpu.md#role-1-real-time-flow-anomaly-detection--fail-closed-quarantine-coral--jetson-split-inference).
* **Architecture**:
  1. **Ingress**: Captures mirrored data frames from Port 3 via `enx9c69d39dd0a6` (or receives flagged candidate windows from Coral TPU #1).
  2. **Feature Extraction**: Converts sliding packet windows (inter-arrival $\Delta t$, frame sizes, TCP flags, byte entropy) into batched GPU tensors.
  3. **Neural Autoencoder**: Executes a 1D-CNN Autoencoder on CUDA to compute sequence reconstruction loss in `< 1.0 ms` (Dean latency budget).
  4. **Fail-Closed SDN Quarantine**: If reconstruction loss exceeds the dynamic anomaly threshold (detecting port scans, agentic infinite loops, volumetric floods, or exfiltration), the sentinel issues an emergency quarantine signal to the OpenFlow controller.
  5. **OpenFlow Enforcement**: Pushes an OpenFlow 1.3 `FLOW_MOD` (Priority 65535, `OFPFC_ADD`, action `DROP`) to isolate the offending agent on Zodiac Port 1.

---

### Item 3: `gpu-workload-3` — Quoc Le Adaptive Rate-Meter & Bufferbloat Optimizer
* **Status**: `PLANNED`
* **Goal**: Eliminate heuristic static rate limits by training a GPU-accelerated contextual bandit on live Zodiac 64-bit hardware counters (`fx_port_counts`, CRC errors, drops, byte deltas).
* **SDN Action**: Dynamically configures the Zodiac FX's 8 hardware rate meters and flow table timeouts to eliminate packet drops and queue oscillation under bursty multi-agent workloads.

---

### Item 4: `gpu-workload-4` — Real-Time Micro-Burst & Jitter Forecaster (Oriol Vinyals Graph Net)
* **Status**: `PLANNED`
* **Goal**: Proactive SDN routing using a Temporal Convolutional Network (TCN) or LSTM running on the Jetson GPU.
* **SDN Action**: Predicts switch buffer saturation 50 ms–200 ms ahead of time and proposes preemptive flow reroutes through the symbolic verifier (`SymbolicRouteVerifier.verifyLoopFree()`).

---

## 3. Telemetry & Council Invariant Verification

| Metric / Invariant | Invariant Principle | Target Specification |
| :--- | :--- | :--- |
| **GPU Inference Latency** | Jeff Dean Budget | `< 1.0 ms` per packet batch on Ampere Tensor Cores |
| **GPU Utilization** | Anti-Simulation Law | Physical sysfs truth (`/sys/devices/platform/bus@0/17000000.gpu/load`) |
| **Fail-Closed Isolation** | Ghemawat / Hassabis | Anomaly/Error defaults strictly to `DROP` (Priority 65535) |
| **Deterministic Accounting** | Invariant 2 | Monotonic 64-bit integer units (`BigInt`) for all counters |
| **Thermal Protection** | Graceful Degradation | Auto-throttle/quench if `gpuC` exceeds thermal threshold |
