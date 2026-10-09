# Jetson Orin GPU Workload Mini-Roadmap (`gpu-workload`)

> **Archived 2026-10-09.** The GPU workload series is deferred; no current data path needs it. See [ROADMAP](../../ROADMAP.md).

> **Autonomous Master Appliance Ampere GPU Pipeline**  
> **Silicon Target**: NVIDIA Jetson Orin Nano Super (1024 CUDA Cores, 32 Tensor Cores, 67 TOPS Ampere Architecture, JetPack 6.1 / L4T 36.4.7)  
> **Governing Council Invariants**: Jeff Dean (Latency Budgets & Zero-Bloat), Sanjay Ghemawat (Fail-Closed Default), Quoc Le (Self-Tuning Control Loops), Oriol Vinyals (Graph/Temporal Dynamics), Demis Hassabis (Symbolic Proof Asymmetry).

---

## 1. Executive Summary & Objective

While the Master Appliance CPU (ARM Cortex-A78AE) and external USB Google Coral Edge TPUs have been actively driving OpenFlow 1.3 and shallow packet triage, the **67 TOPS NVIDIA Ampere GPU** on the Jetson Orin has remained at 0% utilization.

The `gpu-workload` initiative establishes a structured progression to harness the Orin GPU for high-throughput, low-latency SDN control plane and data plane acceleration.

```text
+───────────────────────────────────────────────────────────────────────────────+
|               NVIDIA Jetson Orin Nano Super (Master Appliance)                |
|                                                                               |
|  [ ARM Cortex-A78AE CPU ]          [ Dual Google Coral Edge TPUs (USB 3.0) ]  |
|  * OpenFlow 1.3 Controller (:6633)                                            |
|  * Telemetry Bridge Server (:3003) * Primary (2-1.3): MobileNet V2 INT8      |
|  * I2C OLED Telemetry Daemon         Wire-Tap DPI on enx* mirror tap         |
|                                      DEPLOYED ✅ — zodiac-coral.service       |
|                                    * Standby (2-1.2): Failover only;         |
|                                      DNS Sentinel role PLANNED (Phase 2)     |
|                                                                               |
|  NOTE: Coral and GPU run as INDEPENDENT parallel paths on separate            |
|  interfaces. No Stage 1→Stage 2 handoff exists in deployed code.             |
|  Staged pipeline is the Phase 2 target once USB hub contention is resolved.  |
|                                                                               |
|  ===========================================================================  |
|  [ 67 TOPS Ampere GPU — 1024 CUDA Cores + 32 Tensor Cores ]                  |
|  ───────────────────────────────────────────────────────────────────────────  |
|  * gpu-workload-1 ✅ : GPU Neural Stress & Verification Burst Worker          |
|  * gpu-workload-2 ✅ : Standalone Full-Stack Anomaly Autoencoder & Quarantine |
|                        (independent of Coral; 0.271ms; 24 live quarantines)  |
|  * gpu-workload-3    : Quoc Le Rate-Meter Optimizer (Contextual Bandit)      |
|  * gpu-workload-4    : Micro-Burst & Congestion Forecaster (TCN / LSTM)      |
+───────────────────────────────────────────────────────────────────────────────+
```

---

## 2. Workload Items & Milestones

### Item 1: `gpu-workload-1` — GPU Neural Stress & Verification Burst Worker (Quick Win)

* **Status**: `COMPLETED` (Verified on Silicon)
* **Goal**: Enable operator and automated stress testing of the Jetson Ampere GPU via `npm run burst -- --target jetson` (or `--target gpu`).
* **Implementation Details**:
  * Implemented in [scripts/hardware-burst-daemon.py](file:///Users/andymorven/git/agentic-era-networking/scripts/hardware-burst-daemon.py) with dedicated `jetson_gpu_worker` thread.
  * Successfully validated in a live 10-minute multi-accelerator burst on the Jetson Orin Nano Super.
  * Generates continuous, controlled CUDA matrix operations with physical thermal and load tracking.
* **Telemetry & Provenance**:
  * Live load verified via sysfs (`/sys/devices/platform/bus@0/17000000.gpu/load`).
  * Monitored power consumption and thermals in [src/sdn/hardware-probe.ts](file:///Users/andymorven/git/agentic-era-networking/src/sdn/hardware-probe.ts).

---

### Item 2: `gpu-workload-2` — Standalone Full-Stack Deep Traffic Anomaly Autoencoder & Fail-Closed Quarantine

* **Status**: `COMPLETED` (Verified on Live Wire & Silicon)
* **Goal**: Deploy an independent, end-to-end GPU anomaly detection and quarantine pipeline on the Jetson. Originally described as "Stage 2 of the Split-Inference pipeline" (Coral Stage 1 → GPU Stage 2), the deployed implementation runs **standalone** — the GPU captures its own packet stream via `hardware-burst-daemon.py` and does not consume Coral output. The Coral (`zodiac-coral.service`) operates as a parallel independent inference path on the mirror tap. See [docs/design/physical-sdn-edge-tpu.md Role 1](file:///Users/andymorven/git/agentic-era-networking/docs/design/physical-sdn-edge-tpu.md#role-1-real-time-flow-anomaly-detection--fail-closed-quarantine) for the deployed topology and the Phase 2 staged-pipeline target.
* **Architecture & Verification**:
  1. **Native CUDA Kernel**: [src/gpu/gpu_anomaly_kernel.cu](file:///Users/andymorven/git/agentic-era-networking/src/gpu/gpu_anomaly_kernel.cu) compiled for Ampere (`sm_87`) executing 1D-CNN autoencoder reconstruction with parallel CUDA warp reductions directly on the 1024 CUDA cores.
  2. **Sub-Millisecond Inference**: Achieved **0.271 ms** average inference latency (Dean latency budget: < 1.0 ms) across 174 live inferences.
  3. **Adaptive Threshold**: `AdaptiveThresholdController` dynamically tracks baseline variance via EMA and adapts $\tau$ to prevent route flap storms (Council Invariant 5).
  4. **Live Wire Anomaly Quarantine**: Verified on physical interface `enP8p1s0` with coordinated microburst exploit injection: 24 anomalies detected and 24 OpenFlow 1.3 `FLOW_MOD` (Priority 65535, action `DROP`) rules successfully installed on the Zodiac FX hardware switch via `POST /api/sdn/quarantine`.

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
