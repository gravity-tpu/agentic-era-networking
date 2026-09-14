# Agentic Era Networking — Master Architecture Roadmap

Autonomous, verifiable networking infrastructure for the agentic era: telemetry/monitoring, DNS resolution, and Software Defined Networking (SDN).

Governed by the **Senior Staff Council Invariants**:
- **Jeff Dean**: Systems scale, nanosecond-to-WAN latency budgets, hardware co-design, and graceful degradation.
- **Sanjay Ghemawat**: Radical simplicity, invariant rigor, cache-friendly flat layouts, and zero-bloat abstractions.
- **Quoc Le**: Neural architecture search, adaptive self-tuning control loops, and robustness under distribution shift.
- **Oriol Vinyals**: Graph representation routing (Pointer Networks), multi-agent game-theoretic convergence, and flap prevention.
- **Demis Hassabis**: Verification asymmetry, hybrid neuro-symbolic verification (AlphaProof paradigm), and formal state bounds.

---

## Phase Overview

```
+---------------------------------------------------------------------------------------------------+
| Phase 0: Physical Hardware Telemetry & Web Dashboard (COMPLETE)                                   |
| - Zodiac FX Switch co-design (Ports 1-4, SAM4E8E MCU, KSZ8795 switch IC)                          |
| - Interactive SVG digital twin, dynamic port matrix, real-time rates, and serial terminal         |
| - Local bridge daemon & cryptographically authenticated cloud relay to Vercel                     |
+---------------------------------------------------------------------------------------------------+
                                                  |
                                                  v
+---------------------------------------------------------------------------------------------------+
| Phase 0.5: Enterprise Security & Historical Telemetry Persistence (IN PROGRESS)                   |
| - Milestone 0.5A: Google SSO Authentication Guard (OAuth 2.0 / OIDC, strict email allowlist)       |
| - Milestone 0.5B: Neon Postgres 30-Day Telemetry Persistence Engine (10s batching, downsampling)   |
+---------------------------------------------------------------------------------------------------+
                                                  |
                                                  v
+---------------------------------------------------------------------------------------------------+
| Phase 1: Zero-Config DNS Reverse Proxy Engine (NEXT)                                              |
| - RFC 1035 UDP interceptor & dynamic domain mapping (wildcard / exact / catch-all)                |
| - Transparent edge reverse proxy with nanosecond latency profiling                                |
| - OpenFlow 1.3 VIP traffic steering (Port 1 UDP 53 & TCP 80/443 -> Port 4 Host Controller)        |
+---------------------------------------------------------------------------------------------------+
                                                  |
                                                  v
+---------------------------------------------------------------------------------------------------+
| Phase 2: Real-Time Flow Anomaly Detection & Edge TPU Quarantine                                    |
| - Google Coral USB Edge TPU (4 TOPS INT8 coprocessor, <2.5ms inference budget)                    |
| - Port 3 mirror tap stream analysis for rogue agent scanning and burst anomaly classification    |
| - Fail-closed line-rate FlowMod quarantine (priority 65535 default drop)                          |
+---------------------------------------------------------------------------------------------------+
                                                  |
                                                  v
+---------------------------------------------------------------------------------------------------+
| Phase 3: AlphaProof Symbolic Verification & Self-Tuning Control                                   |
| - Hybrid neuro-symbolic verification: probabilistic route synthesis gated by formal DAG proof     |
| - Quoc Le self-tuning control loops: dynamic buffer windows adapting to packet arrival distributions |
+---------------------------------------------------------------------------------------------------+
                                                  |
                                                  v
+---------------------------------------------------------------------------------------------------+
| Phase 4: Multi-Agent Routing Stability & Flap Prevention                                          |
| - Pointer Network graph routing representations under multi-tenant agent traffic                 |
| - Hysteresis damping and game-theoretic convergence preventing route flap oscillations            |
+---------------------------------------------------------------------------------------------------+
                                                  |
                                                  v
+---------------------------------------------------------------------------------------------------+
| Phase 5: Autonomous Agent Intent Firewall                                                         |
| - Application-layer semantic inspection of autonomous tool-use payloads                           |
| - Cryptographic audit trail of all automated policy modifications                                 |
+---------------------------------------------------------------------------------------------------+
```

---

## Detailed Milestones

### Phase 0: Physical Hardware Telemetry & Web Dashboard
*Status: Complete (Commits `349d5d7`, `5cad520`, `4c9e4de`, `9b54887`)*
- [x] Physical co-design with Northbound Networks Zodiac FX OpenFlow 1.3 Switch.
- [x] Interactive SVG board visualizer with dynamic chip tooltips and port LEDs.
- [x] Live port analytics cards for Ports 1–4 with true box collapse and IP relocation.
- [x] OpenFlow 1.3 control plane daemon (Port 6633) with nanosecond latency tracking.
- [x] In-browser interactive CLI terminal emulator for Zodiac management commands.
- [x] Epistemic Telemetry Provenance: Cryptographic `ZODIAC_BRIDGE_SECRET` authentication.
- [x] Cloud Telemetry Relay to Vercel production with bounded rolling WAN window (HTTP 413 fix).

### Phase 0.5: Enterprise Security & Historical Telemetry Persistence
*Status: In Progress*
- [ ] **Milestone 0.5A: Google SSO Authentication Guard**:
  - OpenID Connect / OAuth 2.0 serverless auth flow (`/api/auth/login`, `/api/auth/callback`, `/api/auth/me`, `/api/auth/logout`).
  - Strict operator allowlist: `sekyereandy@gmail.com`, `natborks@gmail.com` (plus `ALLOWED_GOOGLE_EMAILS` env config).
  - Secure, signed HTTP-only session cookies (`agentic_session`).
  - Dual authentication boundary: Machine-to-machine hardware relay via `X-Zodiac-Bridge-Secret` + Operator SSO for dashboard users.
  - Dark-glass Google Sign-In modal gate on web UI.
- [ ] **Milestone 0.5B: Neon Postgres 30-Day Telemetry Persistence**:
  - Prisma models for `ZodiacTelemetryPoint` and `User` in Neon serverless Postgres.
  - 10-second batch ingest cadence from live bridge to database (~259k records/30 days, ~40MB).
  - Bucketed SQL downsampling API (`/api/zodiac?range=1h|6h|24h|7d|30d`) returning bounded (<360) data points.
  - Automated 30-day data retention pruning.
  - UI range selector extension with `30d` historical view.

### Phase 1: Zero-Config DNS Reverse Proxy Engine
*Status: Planned (Next)*
- [ ] Transparent RFC 1035 UDP DNS interception on Zodiac data ports without client proxy setup.
- [ ] Dynamic domain registry with wildcard and exact match mappings to local upstreams.
- [ ] Node HTTP reverse proxy with stream piping and Dean nanosecond latency headers (`X-Edge-Latency-Ns`).
- [ ] OpenFlow 1.3 steering rules redirecting UDP 53 and TCP 80/443 to the host controller.
- [ ] Formal loop-free verification before flow rule hardware deployment.

### Phase 2: Real-Time Flow Anomaly Detection with Edge TPU
*Status: Planned*
- [ ] Google Coral USB Accelerator co-design via host USB 3.0.
- [ ] Zodiac Port 3 mirror tap stream ingestion.
- [ ] Quantized INT8 anomaly detection model (<2.5ms inference budget).
- [ ] Fail-closed line-rate FlowMod quarantine on detected rogue agent traffic.

### Phase 3: AlphaProof Symbolic Verification & Self-Tuning Control
*Status: Planned*
- [ ] Formal symbolic verifier gating probabilistic routing updates.
- [ ] Quoc Le self-tuning control loops adapting to traffic distribution shifts.

### Phase 4: Multi-Agent Routing Stability & Flap Prevention
*Status: Planned*
- [ ] Graph sequence representations for topology mapping.
- [ ] Multi-agent coordination with hysteresis damping.

### Phase 5: Autonomous Agent Intent Firewall
*Status: Planned*
- [ ] Semantic tool-call payload inspection at network boundary.
- [ ] Cryptographic audit trail of all automated policy modifications.
