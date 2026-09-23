---
name: hardware-burst
description: "Instant physical multi-device hardware traffic and neural inference stress burst. Injects wire-rate packet streams into Zodiac FX Port 3 (mirror tap) and Port 4 (controller link), drives continuous INT8 inference across dual Google Coral Edge TPUs, generates workload traffic to Raspberry Pi 3B+, and stresses the Jetson Orin Nano master appliance. Supports targeting specific devices and byte size limits (xMB, xGB)."
metadata:
  category: network-operations
  triggers:
    - hardware burst
    - burst traffic
    - traffic burst
    - send burst
    - burst
    - stress test
    - traffic flood
    - packet burst
    - coral stress
---

# Physical Multi-Device Hardware Burst Skill

Use this skill whenever you or the user need to immediately generate real physical network traffic and neural inference across the physical SDN switch, Coral Edge TPUs, Jetson Orin, or Raspberry Pi workload node.

---

## 1. Quick Invocation Commands

### Burst All Devices (Default)
```bash
# 15-minute live-streamed burst across ALL hardware:
npm run burst

# Custom duration:
npm run burst -- 5m
npm run burst -- 1m
npm run burst -- 30s

# Background / detached mode:
npm run burst -- 15m --detach
```

### Target Specific Devices (`--target` or `-t`)
By default, all devices are targeted (`all`). Use `--target` to direct traffic/stress to specific components:

```bash
# Target ONLY the Zodiac FX OpenFlow switch (Port 3 mirror tap + Port 4 controller plane):
npm run burst -- --target zodiac

# Target ONLY Zodiac Port 3 (promiscuous mirror tap raw frame burst):
npm run burst -- --target zodiac-p3

# Target ONLY Zodiac Port 4 (SDN controller channel UDP probe burst):
npm run burst -- --target zodiac-p4

# Target ONLY the Google Coral Edge TPUs (continuous INT8 neural inference across both):
npm run burst -- --target coral

# Target Coral TPU #1 ONLY (Tap DPI via Zodiac Port 3 raw mirror tap):
npm run burst -- --target coral-1

# Target Coral TPU #2 ONLY (DNS Sentinel via dedicated accelerator worker):
npm run burst -- --target coral-2

# Staggered independent bursts across Coral devices (TPU 1 solo -> rest -> TPU 2 solo -> rest -> dual peak):
npm run burst -- 60s --staggered

# Target ONLY the Raspberry Pi 3B+ workload node:
npm run burst -- --target rpi

# Target combinations (comma-separated):
npm run burst -- --target zodiac,coral
npm run burst -- --target rpi,zodiac
```

### Volume / Size-Bounded Bursts (`--size` or `-s`)
Cap total data transfer by size rather than waiting for duration. The burst terminates as soon as the size limit is reached:

```bash
# Send exactly 50 MB to the Zodiac switch:
npm run burst -- --target zodiac --size 50mb

# Send 100 MB to the Raspberry Pi workload node:
npm run burst -- --target rpi --size 100mb

# Send 1 GB across Zodiac and Corals:
npm run burst -- --target zodiac,coral --size 1gb

# Send 500 KB rapid validation burst:
npm run burst -- --target zodiac --size 500kb
```

Supported size units: `kb`, `mb`, `gb` (e.g. `500kb`, `50mb`, `1gb`, `2.5gb`).

### Status & Abort Commands
```bash
# Check if a burst is active, view PID, packet rates, and recent logs:
npm run burst:status

# Immediately stop any active burst cleanly across all devices:
npm run burst:stop
```

Via the unified `zodiac` CLI:
```bash
npm run zodiac -- burst --target zodiac --size 50mb
npm run zodiac -- burst:status
npm run zodiac -- burst:stop
```

---

## 2. Multi-Device Hardware Targets

When invoked, the burst daemon (`scripts/hardware-burst-daemon.py`) runs parallel threads targeting real physical hardware:

1. **Zodiac FX Switch (Port 3 Mirror Tap / Sniffer)**:
   - Injects raw Ethernet frames (`socket.AF_PACKET`) directly into Port 3 via the ASIX USB GbE adapter (`enx*`).
   - Sustains **~850–1,000 pps (~4.5–7.0 Mbps)** with varying payload sizes (64B to 1400B).
   - Port 3 hardware Rx counters increment in real time on the switch.

2. **Zodiac FX Switch (Port 4 Controller Plane)**:
   - Injects high-rate UDP probe packets via controller interface to the Zodiac switch management port.
   - Sustains **~150–200 pps**.

3. **Dual Google Coral Edge TPUs (8 TOPS INT8)**:
   - **TPU #1**: Dedicated to continuous packet triage under the central bridge server (`~215–230 inf/s`).
   - **TPU #2**: Dedicated to continuous INT8 inference under the burst daemon (`~215–230 inf/s`).
   - **Combined**: **~430–460 INT8 MobileNet V2 inferences/sec** continuously active on both USB 3.0 coprocessors.

4. **Raspberry Pi 3B+ (Untrusted Workload Node)**:
   - Injects probe packets from Jetson via management plane to the workload node at **~70–100 pps**.

5. **NVIDIA Jetson Orin Nano Master Appliance**:
   - Coordinates multi-threaded raw socket pipelines, USB 3.0 transfers to dual TPUs, and telemetry publishing.
   - Monitors CPU load and thermals (~45–47°C under sustained load).

---

## 3. Real-Time Dashboard & Telemetry Verification

During the burst, open the live web dashboard:
- **URL**: `http://localhost:3003` (or `http://<jetson-host>:3003`)
- Port 3 and Port 4 bandwidth graphs show immediate throughput spikes.
- Coral Edge TPU meters register `INFERENCE_ACTIVE` at `~215+ inf/s` per device.
- Jetson Orin system gauges show live CPU and thermal responses.

---

## 4. Technical Staff Council Invariants Enforced

- **Invariant 2 (Determinism - Dean & Ghemawat)**:
  All packet, byte, and size accounting uses pure integer counters. All timing uses monotonic nanosecond resolution (`time.monotonic_ns()`). Zero floating-point arithmetic on packet counters.
- **Invariant 6 (Anti-Simulation Law)**:
  Zero synthetic waveforms or simulated counters. All traffic is physically transmitted out kernel sockets onto copper wires and real Edge TPU silicon.
- **Invariant 1 (Zero Suppression of Reality)**:
  All socket errors, USB timeouts, or device bus errors are caught, surfaced to `stderr`, and logged to `/home/zodiac/burst-telemetry.log`.
