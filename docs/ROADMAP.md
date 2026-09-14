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
| Phase 0.5: Enterprise Security & Historical Telemetry Persistence (COMPLETE)                      |
| - Milestone 0.5A: Google SSO Authentication Guard (OAuth 2.0 / OIDC, strict email allowlist)       |
| - Milestone 0.5B: Neon Postgres 30-Day Telemetry Persistence Engine (10s batching, downsampling)   |
| - Milestone 0.5C: Content-Addressable Asset Pipeline (SHA-256 immutable edge caching)            |
+---------------------------------------------------------------------------------------------------+
                                                  |
                                                  v
+---------------------------------------------------------------------------------------------------+
| Phase 0.6: Zero-Trust Cloud Edge Security & External Attack Shield (IN PROGRESS)                 |
| - Air-Gapped Command Diode (Vercel public layer read-only; zero mutating access to switch plane)  |
| - Edge rate limiting & anti-DDoS shield on all serverless endpoints                               |
| - Monotonic HMAC request signatures & replay protection on cloud-to-hardware telemetry bridge     |
| - Strict CSP, CORS fail-closed lockdown, and external vulnerability quarantine                   |
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
| Phase 2: Real-Time Flow Anomaly Detection, Jetson TensorRT & Web Wireshark Packet Dissector      |
| - NVIDIA Jetson Orin Nano Super (67 TOPS Ampere Architecture, <1.0ms inference budget)            |
| - Port 3 mirror tap stream analysis for rogue agent scanning and burst anomaly classification    |
| - In-Browser Wireshark: Real-time packet dissector (L2-L7), interactive hex dump & PCAP export   |
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
*Status: Complete (Commits `b33eb1f`, `32e102f`, `eb1dc5b`, `935b76e`, `5d1c0ba`, `e80f6d0`, `85857c2`)*
- [x] **Milestone 0.5A: Google SSO Authentication Guard**:
  - OpenID Connect / OAuth 2.0 serverless auth flow (`/api/auth/login`, `/api/auth/callback`, `/api/auth/me`, `/api/auth/logout`).
  - Strict operator allowlist: `sekyereandy@gmail.com`, `natborks@gmail.com` with `ALLOWED_GOOGLE_EMAILS` wildcard and domain support.
  - Fail-Closed isolation: session cookie defaults to `; Secure` flag, constant-time HMAC-SHA256 session token verification.
  - Zero-overhead hoisted environment constants (`IS_VERCEL`, `IS_PRODUCTION`) per Jeff Dean Latency Invariant.
  - Dual authentication boundary: Machine-to-machine hardware relay via `X-Zodiac-Bridge-Secret` + Operator SSO for dashboard operators.
  - Dark-glass Google Sign-In modal gate & Operator profile header in Web UI.
  - Non-revealing error messages (fail-closed, zero operator enumeration).
  - Sanjay Ghemawat Radical Simplicity: Flat `SessionCookieOptions` configuration object.
- [x] **Milestone 0.5B: Neon Postgres 30-Day Telemetry Persistence**:
  - Prisma models for `ZodiacTelemetryPoint` and `User` in Neon serverless Postgres (`@prisma/adapter-pg` / `@neondatabase/serverless`).
  - 10-second non-blocking batched persistence engine adhering to Ghemawat backpressure invariant (~259k records/30 days, ~40MB).
  - Bucketed SQL downsampling API (`/api/zodiac?range=1h|6h|24h|7d|30d`) returning bounded (<360) data points.
  - Automated 30-day data retention pruning.
  - Sub-millisecond monotonic clock calculation preserving microsecond precision (`performance.now() * 1000000`).
  - UI historical time range selector with explicit canvas watermark on database degradation/unreachable state (Anti-Shortcut / Anti-Simulation Law).
- [x] **Milestone 0.5C: Content-Addressable Asset Pipeline & Edge Caching**:
  - Automated content-addressed asset build script (`scripts/build-assets.ts`) generating SHA-256 asset hashes (`zodiac.[hash].css`, `zodiac-app.[hash].js`).
  - Immutable edge cache headers (`Cache-Control: public, max-age=31536000, immutable`) on Vercel and local bridge server.

### Phase 0.6: Zero-Trust Cloud Edge Security & External Attack Shield
*Status: In Progress*
- [x] **Milestone 0.6A: Edge Command Diode (Anti-Pivoting / Zero-Ambient Mutating Access)**:
  - Strict read-only boundary for cloud serverless execution: Vercel edge runtime is mathematically decoupled from the local hardware control plane.
  - Zero arbitrary command injection: Remote commands evaluate strictly against mock sandbox templates with explicit simulation watermarks unless attested with verified local socket provenance.
- [ ] **Milestone 0.6B: Token-Bucket Edge Rate Limiting & Anti-DDoS Shield**:
  - In-memory and distributed edge rate limiters on `/api/*` (e.g., 60 req/min for telemetry reads, 10 req/min for auth callbacks) preventing denial-of-service against Neon DB and edge runtimes.
  - Strict 429 Too Many Requests with deterministic `Retry-After` headers.
- [ ] **Milestone 0.6C: Cryptographic Command Attestation & Replay Protection**:
  - Monotonic nanosecond timestamp + HMAC-SHA256 signature verification on all bridge payloads (`X-Zodiac-Signature`, `X-Timestamp-Ns`) preventing replay attacks.
  - Strict Origin and Host pinning to prevent DNS rebinding or SSRF pivot attacks into the private LAN subnet (`10.0.1.0/24`).
- [ ] **Milestone 0.6D: Hardened Content Security Policy & Security Headers**:
  - Strict CSP headers (`default-src 'self'`, `script-src 'self'`, `connect-src 'self' https://accounts.google.com`, `frame-ancestors 'none'`).
  - Strict transport security (`Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`).

### Phase 1: Zero-Config DNS Reverse Proxy Engine
*Status: Planned (Next)*
- [ ] Transparent RFC 1035 UDP DNS interception on Zodiac data ports without client proxy setup.
- [ ] Dynamic domain registry with wildcard and exact match mappings to local upstreams.
- [ ] Node HTTP reverse proxy with stream piping and Dean nanosecond latency headers (`X-Edge-Latency-Ns`).
- [ ] OpenFlow 1.3 steering rules redirecting UDP 53 and TCP 80/443 to the host controller.
- [ ] Formal loop-free verification before flow rule hardware deployment.

### Phase 2: Real-Time Flow Anomaly Detection, Jetson TensorRT & Web Wireshark Packet Dissector
*Status: Planned*
- [ ] **Milestone 2A: Jetson TensorRT Line-Rate Anomaly Detection**:
  - NVIDIA Jetson Orin Nano Super co-design (67 TOPS INT8 Ampere GPU).
  - Zodiac Port 3 mirror tap stream ingestion.
  - Quantized TensorRT INT8 anomaly detection model (<1.0ms inference budget).
  - Fail-closed line-rate FlowMod quarantine on detected rogue agent traffic.
- [ ] **Milestone 2B: In-Browser Wireshark Packet Dissector Engine**:
  - Real-time deep packet inspection (DPI) & protocol dissection from Port 3 mirror tap and OpenFlow `PACKET_IN` streams.
  - Multi-layer protocol decoders: Layer 2 (Ethernet, 802.1Q VLAN), Layer 3 (IPv4, IPv6, ARP, ICMP), Layer 4 (TCP, UDP), Layer 7 (DNS, HTTP/1.1, OpenFlow 1.3).
  - Interactive Web UI Packet Inspector: Real-time packet table with colorized protocol streams, expandable protocol tree, and synchronous Hex/ASCII dump inspector.
  - Display filter engine (BPF-like syntax, e.g., `ip.src == 10.0.1.2 && tcp.port == 80`) and one-click `.pcap` / `.pcapng` export.

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
