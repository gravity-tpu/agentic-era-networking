# Agentic Era Networking

> **Autonomous, Verifiable Networking Infrastructure for the Agentic Era**  
> Focus: Autonomous Monitoring, Latency Profiling, DNS Resolution Engines & Software Defined Networking (SDN).  
> Hosted at: [https://github.com/gravity-tpu/agentic-era-networking](https://github.com/gravity-tpu/agentic-era-networking)

---

## 1. The Senior Staff Council: Governing Perspectives

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

This repository grounds autonomous SDN invariants in physical hardware, elevating the appliance from a passive coprocessor into a **dedicated 24/7 Autonomous Master Controller**:

- **Detailed Specification**: [docs/design/physical-sdn-edge-tpu.md](file:///Users/andymorven/git/agentic-era-networking/docs/design/physical-sdn-edge-tpu.md)
- **Data Plane Hardware**: Northbound Networks Zodiac FX OpenFlow Switch (4× 10/100 RJ-45 ports, Microchip KSZ8795 switch IC, Atmel SAM4E8E 120 MHz MCU, 128-flow bounded table).
- **Autonomous Master Appliance**: NVIDIA Jetson Orin Nano Super (67 TOPS Ampere Architecture, GbE controller link, dedicated USB serial telemetry link, 7W–15W 24/7 low-power operation, TensorRT INT8 neural engine).
- **Gateway Transit**: ISP Gateway / Mesh Extender providing continuous internet uplink over 100BASE-TX.
- **Untethered Workstation**: Operator workstation (MacBook Pro) operates untethered over wireless WiFi 6/6E with zero downtime risk (closing the laptop lid or rebooting never interrupts the network data plane).

### System Architecture Diagram

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

### Physical Interconnect Matrix

| Link | Source | Interface / Medium | Destination | Protocol / Speed | Role |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Link 1** | Jetson Orin (GbE RJ45) | Ethernet Patch Cable | Zodiac FX Port 4 | 100BASE-TX (Native Management) | **OpenFlow 1.3 Control Channel** |
| **Link 2** | Zodiac FX (Micro-USB) | USB Cable | Jetson Orin (USB-A) | USB CDC (`/dev/ttyACM0`) | **Real-Time Telemetry & CDC Console** |
| **Link 3** | Zodiac FX Port 2 | Ethernet Patch Cable | ISP Gateway | 100BASE-TX (Home LAN) | **WAN / Internet Gateway Transit** |
| **Link 4** | Zodiac FX Port 1 | Ethernet RJ45 | Local Workload / Agent | 100BASE-TX (VLAN 100) | **Monitored Workload / Client Port** |
| **Link 5** | Zodiac FX Port 3 | Ethernet RJ45 | Packet Tap / Sniffer | 100BASE-TX (Mirror Mode) | **Wire Snooping & Packet Capture** |
| **Link 6** | MacBook Pro | Wireless 802.11ax | Home Mesh WiFi | WiFi 6 / 6E (LAN) | **Untethered Dashboard & SSH Access** |

### The 4 Autonomous Appliance Invariant Roles:
1. *Real-Time Flow Anomaly Detection & Fail-Closed Quarantine* (<4 ms intervention window).
2. *Verification Asymmetry & Symbolic Proof* (AlphaProof DAG loop-freeness verifier gating neural routing).
3. *Physical Hardware Reinforcement Learning* (Quoc Le self-tuning rate meters & dynamic buffer windows).
4. *DNS Sentinel & Agent Intent Classification* (Quantized DGA & exfiltration detection on wire queries).

---

## 3. Institutional Memory & Governance System

The repository embeds stateful governance directly in the codebase:

- **[AGENTS.md](file:///Users/andymorven/git/agentic-era-networking/AGENTS.md)**: Council rules and Dean latency numbers for any AI assistant working on the repo.
- **[.agents/rules/determinism-and-alignment.md](file:///Users/andymorven/git/agentic-era-networking/.agents/rules/determinism-and-alignment.md)**: The formal Senior Staff Council rulebook for networking systems.
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
- Node.js >= 20.12.0
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

# Run deterministic invariant test suite (18+ tests passing)
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
- **Vercel Project (Optional)**:
  - Link `gravity-tpu/agentic-era-networking` to your Vercel project.
  - Add `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID` to GitHub Secrets/Vars. The CI deploy job is self-skipping until configured.
