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

## 2. Physical Hardware Co-Design: Zodiac FX Switch & Google Coral Edge TPU

This repository grounds SDN invariants in physical desktop hardware:
- **Architecture Specification**: [docs/design/physical-sdn-edge-tpu.md](file:///Users/andymorven/git/agentic-era-networking/docs/design/physical-sdn-edge-tpu.md)
- **Data Plane Hardware**: Northbound Networks Zodiac FX OpenFlow Switch (4× 10/100 RJ-45 ports, Microchip KSZ8795 switch IC, Atmel SAM4E8E 120 MHz MCU, 128-flow bounded table).
- **Inference Coprocessor**: Google Coral USB Accelerator (Edge TPU) connected directly to the DisplayLink dock (4 TOPS INT8, ~2.5 ms inference latency).
- **The 4 Architectural Roles**:
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
