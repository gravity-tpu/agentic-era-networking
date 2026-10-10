# Physical Testbed & Hardware Blueprint

> **Revised 2026-10-09.** This document is the hardware blueprint of the Zodiac testbed: wiring, interfaces and the management plane. The project is a verifier and testbed for agent-proposed SDN policy (see [ROADMAP](../ROADMAP.md)); the earlier "autonomous master appliance" framing has been removed. Corrections made in this revision: the Zodiac FX latency row and throughput figure now use the measured values from the [whitepaper](../benchmarks/zodiac-infrastructure-bandwidth-whitepaper-2026-10-04.md), and the roles that described unimplemented components were replaced by an accurate description.

> **Zodiac Hardware Specification & Integration Blueprint**  
> **Device under test:** Northbound Networks Zodiac FX OpenFlow switch (SAM4E8E MCU, KSZ8795 switch IC, 128-rule table)  
> **Controller and detector host:** NVIDIA Jetson Orin Nano Super with dual Google Coral Edge TPUs  
> **Workload tier:** Raspberry Pi 5 (Hailo-8 NPU, adversary) and Raspberry Pi 3B+ (client workload) behind a NETGEAR GS105Ev2 smart switch  
> **Tap interface:** ASIX AX88179 USB 3.0 GbE adapter (`enx*`, promiscuous) on Zodiac Port 3  
> **Operator workstation:** Apple Silicon Mac (local model host for review tooling; not on the data plane)

---

## 1. Why physical hardware

When studying agent-proposed network policy, software emulation (e.g., Mininet, OVS) abstracts away critical physical artifacts: hardware buffer overruns, physical link state bounces, serialization jitter, and thermal throttle events.

The testbed grounds the Zodiac controller and verifier in **physical hardware**:

- **Zodiac FX Switch**: Physical 4-port 10/100 Mbit/s OpenFlow switch (Microchip KSZ8795 switch IC + Atmel SAM4E8E 120 MHz ARM Cortex-M4 MCU) with a deterministic 128-entry flow table.
- **Intermediate Aggregation Switch (NETGEAR GS105Ev2)**: 5-Port Gigabit Smart Managed Switch bridging the high-speed GbE workload tier to Zodiac Port 1 (100BASE-TX) with IEEE 802.3x Flow Control backpressure and 802.1Q VLAN isolation capability.
- **Controller host (NVIDIA Jetson Orin Nano Super)**: Low-power (7W–15W) host for the OpenFlow 1.3 controller daemon (`:6633`), the RFC 1035 resolver (`:53`), the policy verifier, the anomaly detector (GPU), the SSD1306 OLED status daemon, and a local userspace Open vSwitch daemon (`br-sim` on `:6634`) serving as a bounded (10,000 rules) reference sandbox for Track A rule verification.
- **Dual Google Coral Edge TPUs**: Dedicated 8 TOPS INT8 USB 3.0 coprocessors ingesting mirrored tap frames for on-silicon inference (TPU 0; throughput/latency verified, trained classifier pending, ROADMAP Milestone 2C) and RFC 1035 DNS intent analysis (TPU 1) without taxing the Jetson GPU pipeline.
- **Dedicated Mirror Tap Interface (ASIX AX88179 USB GbE)**: Dedicated secondary physical NIC (`enx*`) on the Jetson Orin operating in promiscuous mode, directly cabled to Zodiac Port 3 for zero-loss packet inspection.
- **Untrusted Agent Workload Tier**:
  - **Raspberry Pi 5 + Hailo-8** (`rpi-hailo`, renamed from `agentic-node-02` on 2026-10-09): Adversarial workload (red team) on `eth0` (`10.0.2.51`) via Netgear Port 4; 26 TOPS INT8 Hailo-8 NPU over PCIe Gen 3.0 x1 (`/dev/hailo0`, HailoRT 4.20) for CNN packet-classifier validation and surrogate-model evasion testing (traffic generation runs on the host CPU/NIC); out-of-band management via `wlan0` (`10.0.0.179`).
  - **Raspberry Pi 3 Model B+** (`agentic-node-01`): Physical client agent workload on `eth0` (`10.0.2.50`) via Netgear Port 3; out-of-band management backdoor via `wlan0` (`10.0.0.45`).
  - **Raspberry Pi 3 Model B+** (`agentic-node-02`, added 2026-10-09): second workload node on `eth0` (`10.0.2.52`) via Netgear Port 1; management via `wlan0` (`10.0.0.177`) and Tailscale (`100.105.255.18`). Planned role: legitimate client in the target topology (see [ROADMAP](../ROADMAP.md)).
- **Operator workstation (Apple Silicon Mac)**: Hosts local models for the pre-push review tooling and records IOKit hardware profiling and a BigInt token ledger. It is development infrastructure and has no data-plane role.

---

## 2. Desktop Interconnect & Physical Wiring Topology

```text
                                            +───────────────────────────────────+
                                            |    Public Internet / Lab LAN     |
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
        │                        |  * USB-C Port: L4T Device Mode (192.168.55.1 / CDC-ACM)  |
        │                        +──────────────┬───────────────────────────┬───────────────+
        │                                       │                           │
        │                                       │ Dual USB 3.0              │ DIRECT HIGH-SPEED USB-C CABLE
        │                                       │ (Tap DPI & DNS Sentinel)  │ [Link 9: Management Tether]
        │                                       ▼                           │ * CDC-NCM: 192.168.55.1 <-> en8
        │                           +───────────────────────────────────+   │ * CDC-ACM: /dev/cu.usbmodem*
        │                           | Dual Google Coral Edge TPUs       |   │ * 5 Gbps SuperSpeed USB 3.0
        │                           | * TPU 0: Port 3 Mirror Tap DPI    |   │ * Priority: Tier 1 (Metric 50)
        │                           | * TPU 1: RFC 1035 DNS Sentinel    |   │ * Fail-Closed (Zero Route Bleed)
        │                           +───────────────────────────────────+   │
        ▼                                                                   ▼
+───────────────────────────────────+               +───────────────────────────────────────────────────+
| NETGEAR GS105Ev2 5-Port GbE Switch|               | MacBook M5 · Gemma 4 Local Workstation Plane      |
|                                   |               |                                                   |
| * Port 5: Uplink to Zodiac Port 1 | (AIR-GAPPED:  | * Direct USB-C Hardware Tether (Link 9):          |
| * Port 4: RPi 5 (10.0.2.51)       |  NO CONNECTION|   - CDC-NCM: en8 (169.254.91.144 <-> 192.168.55.1)|
|   - 26 TOPS Hailo-8 M.2 NPU       |  BETWEEN RPIS |   - CDC-ACM: /dev/cu.usbmodem17916261208203       |
| * Port 3: RPi 3B+ (10.0.2.50)     |  AND MACBOOK) | * 20-Core Apple Silicon Metal GPU (UMA VRAM)      |
| * Port 2: RPi 5 USB-GbE (capture) |               | * Local Ollama Engine: gemma4:26b (:11434)        |
| * 802.3x Flow Control Enabled     |               | * Dual-Stage Review Gate                         |
| * 802.1Q Multi-Tenant Ready       |               | * Zero-Dependency Plist XML Scanner (IOKit)       |
|                                   |               | * Operator Console: http://localhost:3000 & Cloud |
+───────────────────────────────────+               +───────────────────────────────────────────────────+
```

### Dedicated Jetson Orin ↔ MacBook M5 Direct USB-C Hardware Interconnect (Link 9)

```text
+─────────────────────────────────────────────+                 +─────────────────────────────────────────────+
|    NVIDIA Jetson Orin Nano Super Appliance  |                 |       Apple MacBook M5 Workstation          |
|                                             |                 |                                             |
|  [USB-C Device Mode Controller]             |                 |  [Thunderbolt 4 / USB-C Port]               |
|  * Linux for Tegra (L4T) Gadget Stack       |                 |  * VID: 0x0955 (NVIDIA), PID: 0x7020        |
|  * CDC-NCM Bridge: l4tbr0 (192.168.55.1/24) |================>|  * en8 Point-to-Point IP: 169.254.91.144   |
|  * CDC-ACM Serial Debug TTY (115200 8N1)    |  HIGH-SPEED     |  * Direct TTY: /dev/cu.usbmodem17916261208203|
|  * Fail-Closed: net.ipv4.ip_forward = 0     |  USB-C CABLE    |  * Routing Priority: Tier 1 (Metric 50)     |
|    (Zero Leakage into SDN Tenant Flows)     |  (5 Gbps Link)  |  * Physical IOKit IOUSBHostDevice Verified  |
+─────────────────────────────────────────────+                 +─────────────────────────────────────────────+
```

### 2.1 Physical Interconnect & Interface Mapping Matrix

> [!NOTE]
> **Ground-Truth Device Registry**: Exact static IP allocations, hardware MAC addresses, and persistent device identifiers are managed exclusively in the local persistent context manager ([.agents/devices.local.md](file:///Users/andymorven/git/agentic-era-networking/.agents/devices.local.md)) to prevent credential/network leakage in public repositories.

| Node | Interface / Medium | Hardware Identity | Logical Network | Target / Destination | Role & Invariant |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Zodiac FX Switch** | Port 1 (100BASE-TX) | KSZ8795 Port 1 | Workload Data Plane (VLAN 100) | NETGEAR Port 5 | **Untrusted Workload Transit**: Monitored agent data plane aggregation uplink. |
| **Zodiac FX Switch** | Port 2 (100BASE-TX) | KSZ8795 Port 2 | Gateway Bridged (VLAN 100) | ISP Gateway / Mesh Node | **WAN / Gateway Uplink**: Egress to public internet. |
| **Zodiac FX Switch** | Port 3 (100BASE-TX) | KSZ8795 Port 3 | Port Mirror (VLAN 100) | Jetson `enx*` USB GbE | **Hardware Mirror Tap**: Zero-overhead port mirror for Coral/Jetson DPI. |
| **Zodiac FX Switch** | Port 4 (100BASE-TX) | KSZ8795 Port 4 | Switch Management (VLAN 200) | Jetson `enP8p1s0` | **OpenFlow 1.3 Control Channel**: Isolated switch management. |
| **Zodiac FX Switch** | Micro-USB (CDC-ACM) | Atmel VID 03eb PID 2404 | `/dev/ttyACM0` @ 115200 8N1 | Jetson USB Host | **Telemetry Stream**: 1–2 Hz hardware register stream. |
| **NETGEAR GS105Ev2** | Ports 1–5 (1000BASE-T) | GS105E v2 | Workload Subnet Aggregation | P5: Zodiac P1, P4: RPi 5, P3: RPi 3, P2: RPi 5 USB-GbE capture, P1: Res | **Intermediate Aggregation Switch**: GbE aggregation layer, 128KB packet buffer, IEEE 802.3x flow control, rate transition bridging. |
| **Jetson Orin Nano** | `enP8p1s0` (Onboard GbE) | Onboard Realtek GbE | Dedicated Control Subnet | Zodiac Port 4 | **OpenFlow Controller**: Listens on `:6633` (<1ms latency). |
| **Jetson Orin Nano** | `enx*` (USB 3.0 GbE) | ASIX AX88179 | Promiscuous (No IP) | Zodiac Port 3 | **Mirror Tap Ingress**: Line-rate packet capture for Coral TPU. |
| **Jetson Orin Nano** | `wlP1p1s0` (Wi-Fi) | M.2 Key-E Wi-Fi | Management Plane Subnet | Lab Wireless LAN | **Management Plane**: Web UI (`:3003`), SSH, Cloud Relay. |
| **Jetson Orin Nano** | `br-sim` (Virtual OVS) | Userspace `netdev` | Internal Sandbox | Localhost (`:6634`) | **Reference Switch Sandbox**: Software OpenFlow 1.3 bridge for Track A large-scale rule validation without MCU memory limits. |
| **Google Coral TPU Primary** | USB 3.0 SuperSpeed | Pre-firmware: Global Unichip VID `1a6e` PID `089a` → Post-firmware: Google VID `18d1` PID `9302` (uncompiled) / `9303` (delegate loaded) | USB path `2-1.3` | Jetson USB-A (Realtek hub port 3) | **Active Inference — Line-Rate Wire-Tap DPI**: `zodiac-coral.service` targets this TPU first (`CORAL_PRIMARY_USB_PATH=2-1.3`). MobileNet V2 INT8 shallow packet classifier on Port 3 mirror tap. `standbyMode: false` in telemetry. |
| **Google Coral TPU Standby** | USB 3.0 SuperSpeed | Pre-firmware: Global Unichip VID `1a6e` PID `089a` → Post-firmware: Google VID `18d1` PID `9302` / `9303` | USB path `2-1.2` | Jetson USB-A (Realtek hub port 2) | **Standby — Failover Tap DPI**: `zodiac-coral.service` activates this TPU if primary is absent or exceeds `MAX_CONSECUTIVE_ERRORS=5`. Runs identical MobileNet V2 INT8 model. `standbyMode: true` in telemetry. DNS Sentinel role planned for Phase 2. |
| **SSD1306 OLED** | 4-Pin I2C (Bus 7) | Address `0x3c` | Jetson 40-Pin Header | Jetson Front Bezel | **Front Panel Telemetry**: 5-screen rotational physical display. |
| **Raspberry Pi 5** | `eth0` (Onboard GbE) | Broadcom BCM54213PE | Isolated Workload Subnet | NETGEAR Port 4 | **Adversarial workload**: Red Team workload generator, rate-limiting stress testing. |
| **Raspberry Pi 5** | `wlan0` (Wi-Fi) | Synaptics BCM43455 | Management Plane Subnet | Lab Wireless LAN | **Out-of-Band Safety**: Dedicated SSH backdoor to prevent lockouts. |
| **Hailo-8 M.2 NPU** | PCIe Gen 3.0 x1 | Hailo-8 AI Accelerator | `/dev/hailo0` (HailoRT 4.20) | RPi 5 PCIe M.2 HAT+ | **Edge NPU Coprocessor**: 26 TOPS INT8 CNN inference accelerator (not an LLM runtime) for packet-classifier validation and surrogate-model evasion testing on the untrusted tier; outputs are advisory (`source: 'hailo_surrogate'`), never an enforcement input. |
| **Raspberry Pi 3B+** | `eth0` (Onboard GbE) | Microchip LAN7800 | Isolated Workload Subnet | NETGEAR Port 3 | **Untrusted Agent Workload 1**: Target for SDN policy enforcement. |
| **Raspberry Pi 3B+** | `wlan0` (Wi-Fi) | Broadcom BCM43455 | Management Plane Subnet | Lab Wireless LAN | **Out-of-Band Safety**: Dedicated SSH backdoor to prevent lockouts. |
| **MacBook M5 Workstation** | USB-C to USB-C (High-Speed) | Apple T8142 USBXHCI | Direct Tether (`192.168.55.1/24` ↔ `en8`, metric 50) | Jetson USB-C Device Port (L4T Gadget: `l4tbr0` CDC-NCM + `g_serial` CDC-ACM) | **Direct Hardware Management Tether**: Point-to-point subnet `192.168.55.0/24` (metric 50, highest priority). CDC-ACM serial console at `115200 8N1` (`/dev/cu.usbmodem*`). MTU 1500 on `en8`. IP forwarding between `192.168.55.0/24` and SDN subnets permanently disabled (`net.ipv4.conf.l4tbr0.forwarding=0`) — strictly bound to OOB management, zero data-plane transit. L4T USB Gadget modules (`g_ether`, `g_serial`) must be loaded in initramfs before network stack init to guarantee enumeration before the management plane comes up. |
| **MacBook M5 Workstation** | Wi-Fi 6/6E (802.11ax) | Apple M5 Pro Metal GPU | Management Plane Subnet | Lab Wireless LAN / Cloud | **Local AI Workstation & Review Plane**: 20-Core Metal GPU executing `gemma4:26b` for pre-push code review, IOKit telemetry, and deterministic BigInt token accounting ledger. |

### 2.2 Management Plane Routing Hierarchy & Fail-Closed Invariants

To eliminate routing ambiguity, split-brain conditions, and non-deterministic interface flapping between the USB-C hardware tether and wireless network (fail-closed and stability invariants), the management plane enforces a strict metric priority and interface isolation:

1. **Deterministic Recovery Hierarchy**:
   - **Tier 1 — Direct Hardware Tether (Highest Priority, Metric 50)**: USB-C CDC-NCM point-to-point network (`en8` <-> `l4tbr0`, invariant subnet `192.168.55.0/24`). Lowest administrative distance for deterministic, ultra-low-latency operator access and telemetry bridging.
   - **Tier 2 — Wireless Management Plane (Secondary, Metric 200)**: 802.11ax Wi-Fi (`en0` / `wlP1p1s0`, dynamic `<mgmt-subnet>`). Untethered roaming and cloud telemetry relay to Vercel/Neon.
   - **Tier 3 — Hardware Serial Console (Emergency Out-of-Band)**: USB CDC-ACM direct serial device (`/dev/cu.usbmodem*` @ 115200 8N1). Zero-network kernel debugging and rescue console, operational even under total TCP/IP stack failure.
2. **Subnet Non-Leakage Law (Fail-Closed Isolation)**:
   - The point-to-point subnet `192.168.55.0/24` is strictly bound to `l4tbr0` on the Jetson appliance. Kernel IP forwarding between `192.168.55.0/24`, `<ctrl-subnet>` (`10.0.1.0/24`), and `<workload-subnet>` (`10.0.2.0/24`) is permanently disabled (`net.ipv4.conf.all.forwarding = 0`), preventing cross-plane packet leakage or routing bleed into SDN tenant flows.
   - **No contradiction with Control Plane functionality**: The Jetson is an OpenFlow *controller*, not a software *router*. All inter-subnet packet forwarding (workload ↔ control) is performed in hardware by the Zodiac FX switch's 128-entry OpenFlow flow table (KSZ8795 ASIC). The Jetson kernel never routes data-plane packets; it only sends OpenFlow `PACKET_OUT` and `FLOW_MOD` messages over the switch serial link. `all.forwarding = 0` is therefore correct and complete.
3. **USB Gadget Boot Determinism**:
   - L4T USB Gadget modules (`g_ether` for CDC-NCM, `g_serial` for CDC-ACM) must be specified in `initramfs` and declared as `BindsTo=` dependencies in the `zodiac-bridge.service` systemd unit. If the USB gadget subsystem fails to enumerate before the management plane comes up, `zodiac-bridge.service` must not start — the Tier 2 (Wi-Fi) fallback activates instead. This prevents a silent management-plane blackout caused by a USB enumeration race at the `initramfs` → rootfs handoff.

### 2.3 Dual-Homed Workload Architecture & Asymmetric Routing Invariant

> [!IMPORTANT]
> **Subnet Isolation Law**:  
> The Raspberry Pi 3B+ data plane interface (`eth0`) is assigned an isolated subnet distinct from the management wireless LAN.  
>
> If `eth0` were assigned an address on the same subnet as the management network, Linux kernel route selection and Reverse Path Forwarding (rp_filter) would route SSH return packets destined for the operator workstation out through `eth0` into Zodiac Port 1 instead of returning over `wlan0`. Because OpenFlow has no active forwarding rule for unclassified host traffic, this immediately blackholes the SSH session.
>
> By strictly partitioning the data plane to an isolated subnet, operator SSH access over `wlan0` remains 100% immune to OpenFlow table flushes, flow timeouts, quarantine rules, and switch reboots. Exact subnet definitions and routes are documented in [.agents/devices.local.md](file:///Users/andymorven/git/agentic-era-networking/.agents/devices.local.md).

> [!TIP]
> **Physical Chassis & Display Subsystem**: For full mechanical assembly, 4-pin I2C OLED pinouts, button jumper wiring, and the 5-screen physical telemetry daemon, see the dedicated [Jetson Orin & Panini Case Architecture](file:///Users/andymorven/git/agentic-era-networking/docs/design/jetson-orin/README.md).

---

## 3. Latency budget

Cloud LLMs are unsuited to direct packet-level or flow-level admission control due to Time-To-First-Token (TTFT) latency:

```text
Operation                                 Latency (ns)             Human Time       Viability for Flow Control
---------------------------------------------------------------------------------------------------------------
L1 cache reference                             0.5 ns                               Data plane lookup
KSZ8795 Hardware Fast-Path                   1,000 ns               1 µs            Hardware line-rate forwarding
Zodiac FX Cortex-M4 per packet              58,000 ns (+4,240/rule)  58 µs           Software OpenFlow lookup (measured, see whitepaper)
Datacenter LAN Roundtrip                   500,000 ns             0.5 ms            Local cluster transit
Jetson Orin TensorRT INT8 Inference        800,000 ns             0.8 ms            ML flow decision (figure not measured here)
WAN Roundtrip (Cross-continent)        150,000,000 ns             150 ms            Cloud round-trip (FAIL)
Cloud LLM TTFT (API Call)            1,000,000,000 ns           1,000 ms (1 s)      Cloud Agent Reasoning (FAIL)
```

The Jetson Orin Nano Super executes quantized TensorRT neural inference in **< 1.0 ms**, allowing real-time intervention before switch input buffers overflow.

---

## 4. Components: detector, verifier and deferred roles

### Detector and quarantine path (exists; accuracy not yet measured)

> [!NOTE]
> **Deployed topology (Phases 0.12–0.13)**: The Coral and Jetson GPU run as **two independent parallel inference paths on separate interfaces** — not as a Stage 1 → Stage 2 pipeline. No handoff occurs between them in the current codebase. The staged pipeline is the Phase 2 target once USB hub contention is resolved and dedicated per-TPU host controllers are available.

- **Challenge**: AI agents executing tool-use loops can trigger rogue network behaviors (DDoS against local services, aggressive subnet scanning, abnormal packet burst frequencies, exfiltration bursts).

- **Deployed Path A — Google Coral Edge TPU (Phase 0.13, live)**:
  - `zodiac-coral.service` captures frames via AF_PACKET raw socket on `enx*` (the ASIX AX88179 USB GbE adapter in promiscuous mode on Zodiac Port 3 mirror tap).
  - Runs stock MobileNet V2 INT8 as a wire-tap inference benchmark: 1 wire frame ingested = 1 physical Coral inference (<500 µs per inference). The output tensor is not yet consumed, so no classification is produced until a trained model lands (ROADMAP Milestone 2C).
  - Outputs telemetry to `/run/zodiac/coral-telemetry.json` — inference rate, USB path, `standbyMode` flag. **Does not feed output to the Jetson GPU.** Operates independently.
  - Primary TPU at USB path `2-1.3`; standby failover to `2-1.2` after `MAX_CONSECUTIVE_ERRORS=5`.

- **Deployed Path B — Jetson Ampere GPU 1D-CNN Autoencoder (Phase 0.12, live)**:
  - Native CUDA kernel (`src/gpu/gpu_anomaly_kernel.cu`, compiled for `sm_87`) runs a 1D-CNN autoencoder on live wire packet feature vectors.
  - **Operates independently** — does not consume Coral output. Captures its own packet stream via `hardware-burst-daemon.py`.
  - **0.271 ms** average inference latency (verified: 174 live inferences; budget < 1.0 ms).
  - `AdaptiveThresholdController` (EMA-based, no magic constants) gates quarantine decisions.
  - Verified end-to-end: **24 anomalies detected → 24 OpenFlow 1.3 `FLOW_MOD` (Priority 65535, action DROP) installed on Zodiac FX hardware** via `POST /api/sdn/quarantine`.

- **Aspirational Phase 2 — Staged Split-Inference Pipeline**:
  - Once USB hub contention is eliminated (dedicated USB host controller per TPU or PCIe Coral), the Coral will act as Stage 1 (shallow frame-level triage, <100 µs), feeding only anomalous packet windows to the Jetson GPU Stage 2 (deep 1D-CNN autoencoder, <1.0 ms). This eliminates redundant full-stream GPU processing and maximises CPU/memory headroom.
- **Deployed Architecture — Primary/Standby Single-Active Mode (Phase 0.13)**:
  - **`zodiac-coral.service`** (`deploy/jetson/zodiac-coral.service`) runs `scripts/coral-inference-daemon.py` as a `zodiac` service user (CAP_NET_RAW only) with `Restart=always` and `StartLimitBurst=10/600s` flap termination.
  - **Single-Active Invariant**: Only one Coral TPU runs inference at any time. Attempting concurrent dual-TPU execution on the shared tegra-xusb hub (Realtek `0bda:0489`) causes hub autosuspend races during idle gaps between AF_PACKET GbE bursts and Coral bulk-in callbacks — producing `LIBUSB_ERROR_NOT_FOUND` and libedgetpu `abort()` (SIGABRT). One active TPU eliminates the contention window.
  - **Primary → Standby Failover**: On startup the daemon targets `CORAL_PRIMARY_USB_PATH=2-1.3`. After `MAX_CONSECUTIVE_ERRORS=5` consecutive USB inference failures, the daemon exits non-zero; systemd restarts it and re-probes the primary before falling back to `CORAL_STANDBY_USB_PATH=2-1.2`. `standbyMode: true` is set in telemetry when the standby path is active.
  - **Future Dedicated Parallel Roles (Phase 2)**: Once USB hub contention is eliminated (dedicated USB host controller per TPU or PCIe Coral), the two TPUs will be re-assigned dedicated static roles: Primary = wire-tap shallow DPI, Standby = RFC 1035 DNS Intent Sentinel. Each Edge TPU's 8 MB on-chip scratchpad SRAM pins a single quantized model permanently — eliminating the 5–15 ms USB model-eviction reload penalty of dynamic load balancing.
- **USB Resilience Stack**:
  - **Root Cause Identified**: Realtek USB 3.0 hub (`0bda:0489`) defaults to `autosuspend_delay_ms=0, control=auto`. With zero delay, the hub suspends during idle windows between concurrent AF_PACKET GbE transfers and Coral bulk-in DMA callbacks. The suspended hub causes libedgetpu's `HandleQueuedBulkIn` to receive `LIBUSB_ERROR_NOT_FOUND (-5)`, which unconditionally calls `abort()` → `SIGABRT`, wedging the Coral at PID `18d1:9302` and preventing delegate reload on restart.
  - **Permanent Fix — udev Autosuspend Rules** (`deploy/jetson/99-coral-usb-power.rules`): `ACTION=="add"` rules write `power/control=on` for both Coral PIDs (`1a6e:089a`, `18d1:9302`, `18d1:9303`) **and** the Realtek parent hub (`0bda:0489`), preventing hub power-cycling across the entire tegra-xusb Bus 02 tree.
  - **Fail-Closed ExecStartPre Reset** (`scripts/reset-coral-usb.sh`): Runs as root (`ExecStartPre=+`) before each daemon start. Scans sysfs for Coral devices: if `18d1:9302/9303` found, de-authorizes then re-authorizes each (1 s deauth delay, `udevadm settle --timeout=10`). If only `1a6e:089a` (fresh post-replug pre-firmware state) found, skips reset and exits 0. Exits 1 only if no Coral device exists at all — blocking daemon start against missing hardware (fail-closed invariant).
- **Fail-Closed Invariant**: if the ML detector fails or is ambiguous, the system defaults to DROP/QUARANTINE.

### Policy verifier (partly implemented)

- **Purpose**: A neural or LLM proposer can emit degenerate, unsafe or unaffordable rule sets. Deterministic code checks a proposal before any flow-mod is sent.
- **Implemented**: `verifyPort1Isolation` (isolation and hairpin checks over the rule set) and `verifyIsolationReadback` (compares the switch's flow-stats readback with intent on match fields) in `src/sdn/port1-isolation.ts`.
- **Not implemented**: shadowed-rule and conflict analysis, rule and capacity budget checks using the measured cost model, output-action readback and the model-versus-wire conformance probe. See [ROADMAP](../ROADMAP.md), tracks A and B.
- **Superseded**: `SymbolicRouteVerifier.verifyLoopFree()` is a cycle check over hop lists. A static flow table has no routing loops to find, and its call sites pass one-hop lists that cannot fail. It is not the verifier.

### Deferred roles

The earlier plan described a GNN or pointer-network route proposer, an INT8 contextual-bandit rate tuner driving the switch's hardware rate meters and `AdaptiveFlowController`, and a Coral-hosted DNS intent sentinel. None is implemented as described, none is on a data path, and none is on the current roadmap. The DNS resolver in `src/dns/` exists without the sentinel model.

---

## 5. Zodiac FX Hardware Constraints & Design Patterns

1. **Table Capacity Bound**: The switch supports a maximum of **128 flow entries** (`MAX_FLOWS = 128`).
   - *Invariant Solution*: The controller must implement deterministic LRU eviction with explicit `idle_timeout` and `hard_timeout` allocations.
2. **Software Pipeline Throughput**: Packets forwarded via OpenFlow are processed by the 120 MHz SAM4E8E MCU in tail-tag mode, yielding a per-packet cost of about 58 µs plus 4.24 µs per rule. Measured capacity is up to 94.45 Mbit/s (1470-byte UDP, empty table) and falls to 8.2 Mbit/s (600-byte) with 126 rules; see the whitepaper.
   - *Invariant Solution*: Native traffic is delegated to KSZ8795 hardware VLAN switching; only agent-monitored, security-critical, and test traffic is routed through the OpenFlow pipeline.
3. **Fail-Closed State Enforcement**:
   - CLI configuration `set failstate secure` ensures that if the OpenFlow controller or USB serial connection terminates, all transit traffic is immediately dropped rather than leaked.

---

## 6. Telemetry Ingestion, Multi-Tier Storage & Query Routing Architecture

The system employs a deterministic **three-tier storage and query routing architecture** governed by latency budgets (<10ms local RAM, <150ms local NVMe, <150ms WAN DB query) and a zero-bloat rule (preventing connection exhaustion and unbounded database growth).

### Tier Overview

| Tier | Storage Medium | Location | Capacity | Surviving Restart? | Primary Consumer |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Tier 1 — Process RAM** | `ZodiacBridgeServer` in-memory ring buffer | Jetson Orin RAM | ~2.5 h (3600 × 2.5 s points) | No (checkpoint to disk, loaded on start) | Live UI polling (≤10 min range) |
| **Tier 2 — Local NVMe JSONL** | Append-log per calendar day, per device type | `/var/lib/zodiac/history/` | 30 days (~430 KB/day/device type) | **Yes** — survives reboots and crashes | Localhost historical queries (1h–30d) |
| **Tier 3 — Neon Postgres** | `ZodiacTelemetryPoint` table, indexed on `timestampMs` | Neon serverless Postgres (cloud) | 30 days (pruned daily at 03:00 UTC) | **Yes** — cloud-durable | Vercel historical queries (1h–30d) |

### Architectural Overview & Data Paths

```text
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
- **Dual-stage review architecture:**
  - **Stage 1 (Local Edge Workstation Gate):** Executes the pre-push AI code review locally using local Metal GPU compute, providing instant feedback to the engineer before git push.
  - **Stage 2 (Server-Side Symbolic Invariant Gate):** To enforce true **Verification Asymmetry** (*"Probabilistic generation proposes. Deterministic systems dispose"*), local pre-push evaluation is complemented by mandatory, immutable server-side CI/CD verification gates. Unverified agentic modifications are deterministically blocked from merging to `main` until passing formal symbolic verification, BigInt invariant suites, and cryptographic provenance checks.

### 5.2 Physical IOKit Telemetry Engine & Fail-Closed Platform Boundary (`src/sdn/hardware-probe.ts`)

To satisfy Invariant 6 (Goodhart's Law & Epistemic Telemetry Provenance) and invariant rigor:

- **Strict Platform Boundary & Fail-Closed Isolation:** Darwin-specific tools (`ioreg`, `sysctl`) are strictly confined to macOS. `probeWorkstationHardware()` and `queryAppleGpuMetrics()` evaluate `os.platform() !== 'darwin'` at the entry boundary, immediately failing closed to safe offline defaults (`connected: false`, `gpuUtilizationPct: 0`, `0` counters) without spawning child processes. The Master Appliance (Jetson Orin) executes its own Linux sysfs/tegrastats probes independently, ensuring zero platform cross-contamination.
- **Metal GPU Statistics:** On Darwin, probed via `ioreg -r -c IOAccelerator -d 1 -a` to extract exact physical metrics: `gpuUtilizationPct` (Device Utilization %), `rendererUtilizationPct`, `tilerUtilizationPct`, `gpuMemoryUsedBytes` (In use system memory), and `gpuMemoryAllocatedBytes` (Alloc system memory).
- **Formal Property List XML Parser:** Implements `parseApplePlistXml`, a deterministic, zero-dependency character-by-character scanner and bounded AST parser supporting CDATA blocks, DOCTYPE declarations, entity unescaping, and depth bounds (`MAX_PLIST_DEPTH = 32`) to eliminate fragile regex heuristics and protect against stack exhaustion.
- **Fail-Closed Offline Reporting:** When Ollama or IOKit is disconnected, metrics evaluate to physical truth: `0` velocities, `0%` utilization, and explicit `OFFLINE` badges. Synthetic wave generation is strictly prohibited.

### 5.3 Deterministic 64-Bit BigInt Token Accounting Ledger

Invariant 2 mandates absolute determinism in telemetry and metering. All token counters avoid IEEE-754 floating-point casting:

- **Counters:** `totalTokens`, `totalPromptTokens`, `totalCompletionTokens`, and `totalInferences` are computed using native `BigInt`.
- **Wire Serialization:** Transported over JSON boundaries as decimal strings (e.g. `"14820"` rather than raw floats or scientific notation), preventing precision drift past $2^{53}-1$ across heterogeneous consumers.
- **Real-Time Velocities & Latency Profiling:**
  - Token Generation Velocity (`tok/s` = `(completionTokens * 1e9) / evalDurationNs`)
  - Prompt Evaluation / Prefill Velocity (`tok/s` = `(promptTokens * 1e9) / promptEvalDurationNs`)
  - Peak velocities (`peakTokensPerSecond`, `peakPromptTokensPerSecond`)
  - Time-To-First-Token (TTFT) and Inter-Token Latency (ITL) jitter evaluated against a 500ms–2000ms latency budget.
  - Per-token generation latency (`ms/token`).
  - Context window saturation (`tokens / maxTokens · pct`) and edge compute ratio (`edgeComputeRatioPct: 100.0%`).

### 5.4 Multi-Process Concurrency & Mutex (`scripts/ai-utils.mjs`)

To prevent Read-Modify-Write (RMW) race conditions when concurrent inference tasks or pre-push gates execute:

- **Intra-Process Serialization:** An asynchronous Promise queue (`enqueueTelemetryMutation`) guarantees serial execution of telemetry file mutations within the Node.js runtime.
- **Inter-Process Mutual Exclusion:** A file-level mutex (`withTelemetryFileLock`) uses `open(lockPath, 'wx')` for atomic lock acquisition.
- **Epistemic Process Liveness Detection:** Abandoned locks from crashed processes are recovered by probing kernel signal 0 (`process.kill(pid, 0)` -> `ESRCH`), eliminating brittle hardcoded timeouts while ensuring deterministic lock clearance.

### 5.5 Hybrid Edge-to-Cloud Offload Plane & Anti-Runaway Controls

The workstation operates as the primary edge reasoning tier with an automatic fallback chain:

1. `gemma4:26b` (Local Apple Silicon Metal GPU — primary)
2. `gemini-pro-latest` (Google Cloud fallback)
3. `claude-opus-4-8` (Anthropic Cloud fallback)
4. `gpt-4o` (OpenAI Cloud fallback)
5. `gemini-3.8-flash` → `claude-sonnet-4-6` → `gpt-4o-mini` (High-speed fallbacks)

To prevent non-deterministic distribution shifts, latency runaway, and unbounded cloud recursion:

- **Circuit Breaker:** Hard cap of 3 consecutive cloud attempts before failing closed to local edge quarantine.
- **Strict Timeout Budget:** Every cloud API request enforces an immutable 10-second timeout (`AbortSignal.timeout(10000)`), preventing lagging WAN links from blocking agentic reasoning loops.
- **Edge Compute Ratio Invariant:** Continuous telemetry tracking of `edgeComputeRatioPct`. If edge compute falls below the 90.0% SLA threshold, the system flags an invariant warning (`WARN_CLOUD_DISTRIBUTION_SHIFT`) and throttles background tasks to preserve edge sovereignty and prevent runaway cloud billing.
- **Verifiable Ledger:** All cloud token consumption is recorded in `recordCloudInferenceMetrics` with cryptographic attribution and model metadata.
