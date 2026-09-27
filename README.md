# Zodiac

> **Zodiac — Autonomous, Verifiable SDN Control Plane**  
> Focus: Autonomous Monitoring, Latency Profiling, DNS Resolution Engines & Software Defined Networking (SDN).  
> Hosted at: [https://github.com/gravity-tpu/agentic-era-networking](https://github.com/gravity-tpu/agentic-era-networking)

---

## 1. The Technical Staff Council: Governing Perspectives

This codebase is governed by the collective engineering rigor of five foundational systems and AI pioneers:

1. **Jeff Dean** (Systems Scale, Latency & Distributed Resilience):
   - Nanosecond-to-WAN latency profiling (L1=0.5ns, RAM=100ns, 10Gbps=1µs, LAN=0.5ms, WAN=150ms, LLM=1s).
   - Zero blocking synchronous I/O on packet paths; graceful degradation under split-brain partitions.
2. **Sanjay Ghemawat** (Radical Simplicity, Invariants & Flat Layouts):
   - The Ghemawat Razor: *"Make it work, make it simple, make it fast. If the abstraction is complex, you haven't understood the problem yet."*
   - Elimination of unnecessary wrappers and indirection; cache-friendly flat state structures.
3. **Quoc Le** (Neural Architecture Search & Adaptive Self-Tuning Control):
   - Banning brittle handcoded magic constants for buffers, rate limits, and timeouts.
   - Self-tuning feedback loops that continuously adjust against observed traffic arrival distributions; robustness under distribution shift.
4. **Oriol Vinyals** (Graph Routing, Sequence Optimization & Multi-Agent Equilibrium):
   - Graph sequence representations for Software Defined Networking (SDN) and topology mapping.
   - Multi-agent coordination with hysteresis damping to prevent competitive route flapping and oscillations.
5. **Demis Hassabis** (Verification Asymmetry & Hybrid Neuro-Symbolic Systems):
   - The AlphaProof Invariant: *"Probabilistic generation proposes. Deterministic systems dispose."*
   - Formal symbolic verifiers (e.g. loop-free DAG validation) must gate every agent-proposed routing or policy update before execution on the data plane.

---

## 2. Physical Hardware Architecture: Autonomous Master Appliance Co-Design

This repository grounds autonomous SDN invariants in physical hardware, elevating the appliance from a passive coprocessor into a **dedicated 24/7 Autonomous Master Controller** supported by a multi-tier hardware ecosystem:

- **Detailed Specification**: [docs/design/physical-sdn-edge-tpu.md](file:///Users/andymorven/git/agentic-era-networking/docs/design/physical-sdn-edge-tpu.md)
- **Data Plane Switch**: Northbound Networks Zodiac FX OpenFlow Switch (4× 10/100 RJ-45 ports, Microchip KSZ8795 switch IC, Atmel SAM4E8E 120 MHz MCU, 128-flow bounded table).
- **Autonomous Master Appliance**: NVIDIA Jetson Orin Nano Super (67 TOPS Ampere Architecture, Tri-Interface stack, 500GB NVMe SSD @ 1.8 GB/s, 7W–15W 24/7 low-power operation, TensorRT INT8 neural engine, SSD1306 OLED telemetry).
- **Edge Inference Accelerators**: Dual Google Coral Edge TPUs (8 TOPS INT8 total compute; TPU 0 for line-rate tap DPI, TPU 1 for RFC 1035 DNS sentinel).
- **Dedicated Tap Ingress**: ASIX AX88179 USB 3.0 GbE Adapter (`enx*` in promiscuous mode attached to Zodiac Port 3).
- **Untrusted Client Workload**: Raspberry Pi 3 Model B+ (isolated workload data plane on `eth0` attached to Zodiac Port 1, out-of-band management via `wlan0`).
- **Gateway Transit**: ISP Gateway / Mesh Extender providing continuous internet uplink over 100BASE-TX to Zodiac Port 2.
- **Local AI Workstation**: MacBook Pro M5 (20-core Apple Silicon Metal GPU, Unified Memory Architecture, 26B Gemma 4 local inference, zero-dependency Property List XML parser, 64-bit BigInt token accounting ledger).

### System Architecture Diagram

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
| Raspberry Pi 3 Model B+ (Workload)|               | MacBook M5 · Gemma 4 Local Workstation Plane      |
|                                   |               |                                                   |
| * eth0: <workload-subnet> (Static)| (AIR-GAPPED:  | * Direct USB-C Hardware Tether (Link 9):          |
|   Untrusted SDN Agent Data Plane  |  NO CONNECTION|   - CDC-NCM: en8 (169.254.91.144 <-> 192.168.55.1)|
|   (Zodiac Port 1 VLAN 100)        |  BETWEEN RPi  |   - CDC-ACM: /dev/cu.usbmodem17916261208203       |
|                                   |  AND MACBOOK) | * 20-Core Apple Silicon Metal GPU (UMA VRAM)      |
| * wlan0: <mgmt-subnet> (Wi-Fi)    |               | * Local Ollama Engine: gemma4:26b (:11434)        |
|   Out-of-Band Wireless Management |               | * Dual-Stage Council Review Gate                  |
|   (Home WiFi LAN Only)            |               | * Zero-Dependency Plist XML Scanner (IOKit)       |
|                                   |               | * Operator Console: http://localhost:3000 & Cloud |
+───────────────────────────────────+               +───────────────────────────────────────────────────+
```

### Dedicated Jetson Orin ↔ MacBook M5 Direct USB-C Hardware Interconnect (Link 9)

```
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

### Physical Interconnect Matrix

> [!NOTE]
> Detailed private IP allocations, hardware MAC addresses, and physical port assignments are documented in the local persistent context manager ([.agents/devices.local.md](file:///Users/andymorven/git/agentic-era-networking/.agents/devices.local.md)).

| Link | Source | Interface / Medium | Destination | Protocol / Speed | Role & Invariant |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Link 1** | Jetson Orin (`enP8p1s0`) | RJ-45 Patch Cable | Zodiac FX Port 4 | 100BASE-TX (Native Management) | **OpenFlow 1.3 Control Channel**: Isolated `:6633` plane (<1ms latency). |
| **Link 2** | Zodiac FX (Micro-USB) | USB Cable | Jetson Orin (USB-A) | USB CDC (`/dev/ttyACM0` @ 115200) | **Hardware Register Telemetry**: 1–2 Hz continuous register stream. |
| **Link 3** | Zodiac FX Port 2 | RJ-45 Patch Cable | ISP Gateway / Extender | 100BASE-TX (VLAN 100) | **WAN / Gateway Uplink**: Public Internet transit. |
| **Link 4** | Zodiac FX Port 1 | RJ-45 Patch Cable | RPi 3B+ (`eth0`) | 100BASE-TX (VLAN 100) | **Untrusted Workload Port**: Monitored client agent data plane. |
| **Link 5** | Zodiac FX Port 3 | RJ-45 Patch Cable | Jetson (`enx*` USB GbE) | 100BASE-TX (Port Mirror) | **Promiscuous Tap Ingress**: Line-rate packet capture for Coral Edge TPU. |
| **Link 6** | Dual Coral Edge TPUs | Dual USB 3.0 | Jetson Orin (USB-A) | USB 3.0 (`18d1:9302`, `1a6e:089a`) | **Dedicated Edge Accelerators**: 8 TOPS INT8 total (TPU 0 Tap DPI, TPU 1 DNS Sentinel). |
| **Link 7** | RPi 3B+ (`wlan0`) | Wireless 802.11n | Home Wi-Fi LAN | WiFi (<mgmt-subnet>) | **Out-of-Band Safety Link**: Guaranteed SSH access immune to SDN table flushes. |
| **Link 8** | Jetson Orin (`wlP1p1s0`)| Wireless 802.11ax | Home Wi-Fi LAN | WiFi (<mgmt-subnet>) | **Management Plane**: Web UI (`:3003`), SSH console, Vercel/Neon cloud relay. |
| **Link 9** | Jetson Orin (USB-C) | USB-C to USB-C Cable | MacBook M5 (USB-C) | USB CDC-NCM (`en8`) + CDC-ACM (`/dev/cu.usbmodem*`) | **Direct Hardware Management Tether**: Point-to-point IP plane (`192.168.55.1` <-> `en8`) & serial console immune to network failure. |
| **Link 10** | MacBook M5 Workstation | Wireless 802.11ax | Home Mesh WiFi | WiFi 6 / 6E | **Local AI Workstation & Review Plane**: 20-core Metal GPU executing `gemma4:26b` for Council pre-push code verification, IOKit telemetry, and deterministic BigInt token accounting ledger. |


### Management Plane Routing Hierarchy & Fail-Closed Invariants

To eliminate routing ambiguity, split-brain conditions, and non-deterministic interface flapping between the USB-C hardware tether and wireless network (Council Invariants 3 & 5), the management plane enforces a strict metric priority and interface isolation:

1. **Deterministic Recovery Hierarchy**:
   - **Tier 1 — Direct Hardware Tether (Highest Priority, Metric 50)**: USB-C CDC-NCM point-to-point network (`en8` <-> `l4tbr0`, invariant subnet `192.168.55.0/24`). Lowest administrative distance for deterministic, ultra-low-latency operator access and telemetry bridging.
   - **Tier 2 — Wireless Management Plane (Secondary, Metric 200)**: 802.11ax Wi-Fi (`en0` / `wlP1p1s0`, dynamic `<mgmt-subnet>`). Untethered roaming and cloud telemetry relay to Vercel/Neon.
   - **Tier 3 — Hardware Serial Console (Emergency Out-of-Band)**: USB CDC-ACM direct serial device (`/dev/cu.usbmodem*` @ 115200 8N1). Zero-network kernel debugging and rescue console, operational even under total TCP/IP stack failure.
2. **Subnet Non-Leakage Law (Fail-Closed Isolation)**:
   - The point-to-point subnet `192.168.55.0/24` is strictly bound to `l4tbr0` on the Jetson appliance. Kernel IP forwarding between `192.168.55.0/24`, `<ctrl-subnet>` (`10.0.1.0/24`), and `<workload-subnet>` (`10.0.2.0/24`) is permanently disabled (`net.ipv4.conf.all.forwarding = 0`), preventing cross-plane packet leakage or routing bleed into SDN tenant flows.

### The 5 Autonomous Appliance Invariant Roles:
1. *Real-Time Flow Anomaly Detection & Fail-Closed Quarantine* (<4 ms intervention window).
2. *Verification Asymmetry & Symbolic Proof* (AlphaProof DAG loop-freeness verifier gating neural routing).
3. *Physical Hardware Reinforcement Learning* (Quoc Le self-tuning rate meters & dynamic buffer windows).
4. *DNS Sentinel & Agent Intent Classification* (Quantized DGA & exfiltration detection on wire queries).
5. *Local Edge Reasoning & Token Ledger* (Apple Silicon Metal GPU local inference, pre-push Council verification, and deterministic 64-bit BigInt token accounting).


---

## 3. Institutional Memory & Governance System

The repository embeds stateful governance directly in the codebase:

- **[AGENTS.md](file:///Users/andymorven/git/agentic-era-networking/AGENTS.md)**: Council rules and Dean latency numbers for any AI assistant working on the repo.
- **[.agents/rules/determinism-and-alignment.md](file:///Users/andymorven/git/agentic-era-networking/.agents/rules/determinism-and-alignment.md)**: The formal Technical Staff Council rulebook for networking systems.
- **[.agents/skills/senior-staff-overseer/SKILL.md](file:///Users/andymorven/git/agentic-era-networking/.agents/skills/senior-staff-overseer/SKILL.md)**: Overseer skill definition (L7+ Fellow track).
- **[.agents/workflows/overseer-audit.md](file:///Users/andymorven/git/agentic-era-networking/.agents/workflows/overseer-audit.md)**: 5-Gate Dialectic Review workflow (`@overseer` or `/grill-me`).
- **[.agents/audit-log.md](file:///Users/andymorven/git/agentic-era-networking/.agents/audit-log.md)**: Persistent institutional memory tracking invariant decisions, gate runs, and technical debt.
- **[.agents/hooks/pre-push](file:///Users/andymorven/git/agentic-era-networking/.agents/hooks/pre-push)**: Git hook enforcing TypeScript compilation, invariant tests, and determinism scanning before every push.

---

## 4. Multi-Model AI Code Review Pipeline

Automated AI review executes both locally and in GitHub Actions CI:
- **Council System Prompt**: Evaluates code through the combined standards of Dean, Ghemawat, Quoc Le, Vinyals, and Hassabis.
- **Fallback Chain**: `Google Gemini (3.8 Flash / Pro)` → `Anthropic Claude (Sonnet / Opus)` → `OpenAI (GPT-4o / mini)`.
- **Zero Dependencies**: Pure Node built-ins (`process.loadEnvFile`, `fetch`) — runs in CI without needing prior compilation.
- **Gating**: Flags 🔴 Critical Issues, 🟠 Warnings, 🟡 Suggestions, and emits a structured verdict. Exits with code 1 on `❌ CHANGES REQUESTED` to block faulty commits.

```bash
# Review staged changes
npm run review

# Review the last commit
npm run review:last

# Review all working directory changes (HEAD)
npm run review:head
```

---

## 5. Quick Start & Verification

### Prerequisites
- Node.js >= 22.x (see `.nvmrc`)
- Git

### 1. Install Dependencies & Git Hooks
```bash
npm install
npm run setup-hooks
```

### 2. Verify TypeScript & Invariant Test Suite
```bash
# Zero-defect compile check
npm run check-types

# Run deterministic invariant test suite (132+ tests passing)
npm run test
```

### 3. Configure Local Environment
Copy `.env.example` to `.env.local` and add your API keys:
```bash
cp .env.example .env.local
```

---

## 6. Co-Ownership & Cloud Setup

- **GitHub Repository**: [https://github.com/gravity-tpu/agentic-era-networking](https://github.com/gravity-tpu/agentic-era-networking)
  - Both collaborators have admin rights to push, manage pull requests, and configure CI secrets.
- **Neon Database**:
  - Provision a new dedicated Neon project (e.g. `agentic-networking-db`) and paste the connection string into `DATABASE_URL` in `.env.local` and GitHub repository secrets.
- **Local Telemetry History (Jetson)**:
  - The bridge server automatically writes 30-day JSONL history to `/var/lib/zodiac/history/` (falls back to `~/zodiac-history` or `/tmp/zodiac-history`).
  - No configuration needed — ensure the `zodiac` service user has write access to `/var/lib/zodiac/`.
  - After restarting the bridge server (`sudo systemctl restart zodiac-bridge`), history accumulates at ~2 points/min and historical ranges (`?range=6h` etc.) serve from local disk with no internet dependency.
- **Vercel Project (Optional)**:
  - Link `gravity-tpu/agentic-era-networking` to your Vercel project.
  - Add `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID` to GitHub Secrets/Vars. The CI deploy job is self-skipping until configured.
