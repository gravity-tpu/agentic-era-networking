# Sentinel — Bot & Crawler Mitigation Roadmap

> **Sentinel** — Network-layer autonomous bot detection and traffic enforcement.  
> Lives at: `sentinel/` within `gravity-tpu/agentic-era-networking`  
> Governed by the same **Technical Staff Council Invariants** as Zodiac.

---

## Why Sentinel, Not a New Repo?

The Sentinel module is **not** a separate product — it is the missing enforcement layer that sits between the existing Zodiac SDN data plane and the application origin server. The integration points are native:

| Zodiac Capability | Sentinel Usage |
|---|---|
| OpenFlow 1.3 `FLOW_MOD` quarantine (Priority 65535 DROP) | **Enforcement**: Block crawler IPs at the switch hardware, not in software |
| Dual Coral Edge TPU + Jetson GPU split-inference pipeline | **Detection**: INT8 traffic classification on mirror tap stream |
| RFC 1035 DNS Sentinel (TPU 1) | **Intent**: DNS query pattern analysis for bot hostname fingerprinting |
| Neon Postgres 30-day telemetry | **History**: Persistent IP reputation ledger and attack timeline |
| Vercel serverless edge layer | **API**: Lightweight detection API callable from any origin server |
| Tailscale mesh overlay | **Control**: Remote operator visibility and sentinel rule management from anywhere |

A separate repo would orphan Sentinel from the enforcement plane it depends on. **Ghemawat's Razor applies.**

---

## Problem Statement (from Zodiac Software Requirements v0.1)

The origin server(s) suffer from high-volume distributed scraping and crawler attacks that cause periodic **server downtime**:

1. **Distributed Rotating-IP Pattern**: Attackers use large IP pools — classical IP-based rate limiting is insufficient because no single IP exceeds thresholds. CrowdSec bans legitimate users (`http-crawl-non_statics` rule) while real crawlers rotate through undetected.
2. **Sister-Site Amplification**: A sister site (also under crawler attack) generates enormous inbound traffic volume (top-3 request source) that **cannot be blocked** — it is a trusted internal origin.
3. **Apache Overload**: Current mitigation is a reactive Python script that restarts Apache after it crashes. This is Goodhart-class noise: the measure (crash rate) has become the target; the root cause (bot traffic volume) is unaddressed.
4. **CrowdSec False Positive Tax**: Aggressive CrowdSec heuristics block real users (e.g., rapid clicks on a broken page), generating support burden and user-trust erosion.

### Root Cause (Vinyals Game-Theoretic Frame)
The attacker operates a multi-agent rotating-IP strategy. Each individual agent behaves "legitimately" in isolation (low request rate per IP). The collective is the signal. Current tools evaluate agents individually — Sentinel must evaluate **agent collectives**.

---

## Scope & Non-Goals

### In Scope
- A detection engine that identifies **bot collective behavior** by analyzing request patterns *across* IP ranges, not per-IP.
- An enforcement API that triggers Zodiac OpenFlow `FLOW_MOD` quarantine rules at the data-plane switch.
- A reputation ledger (Neon Postgres) tracking IP-range-level threat scores over time.
- A lightweight, installable edge middleware that any origin server (Apache, Nginx, Node.js) can call without modifying its deployment.
- A Vercel serverless API surface (`/api/sentinel/*`) for edge-callable reputation lookups.
- Dashboard integration into the existing Zodiac operator console.

### Non-Goals
- Replacing CrowdSec or Cloudflare — Sentinel is a **complementary layer**, not a replacement.
- Full L7 WAF functionality (SQL injection, XSS, etc.) — that is handled by existing tools.
- Managing Cloudflare rules or DNS settings directly.

---

## Architectural Characteristics (from §2.5)

| Characteristic | Sentinel Target | Council Invariant |
|---|---|---|
| **Scalability** | Absorb sudden crawler traffic bursts at line rate via SDN hardware DROP (not software firewall) | Jeff Dean: hardware enforcement < 100µs |
| **Accuracy** | False-positive rate < 0.1% on legitimate users; evaluated against real traffic traces | Quoc Le: adaptive threshold, no magic constants |
| **Fault Tolerance** | **Fail-Open** on detection engine failure (never block real users due to Sentinel crash); **Fail-Closed** only at confirmed quarantine threshold | Ghemawat + Hassabis: explicit failure mode |
| **Minimal Footprint** | Edge middleware < 5ms overhead per request on the hot path | Jeff Dean: LAN RTT = 0.5ms; stay within 10× |
| **Epistemic Provenance** | All threat scores sourced from real physical packet observations, never synthetic | Invariant 6: Anti-Simulation Law |

### Failure Mode Decision (from §2.4 open question)
**Sentinel is Fail-Open at the detection layer, Fail-Closed at the enforcement layer:**
- If the Sentinel detection API is unavailable → traffic passes through normally (no false positives).
- If the Zodiac SDN enforcement quarantine is triggered → it is a confirmed, time-bounded OpenFlow rule (Priority 65535, with TTL) that expires deterministically. No permanent blocking without human review.

---

## System Architecture

```
+─────────────────────────────────────────────────────────────────────────────────+
|                         Public Internet / Cloudflare Edge                        |
+──────────────────────────────────────┬──────────────────────────────────────────+
                                       │ HTTP/HTTPS
                                       ▼
+─────────────────────────────────────────────────────────────────────────────────+
|                      Apache / Nginx / Node.js Origin Server                      |
|                                                                                  |
|  ┌────────────────────────────────────────────────────────┐                      |
|  │  Sentinel Edge Middleware (sentinel/middleware/)        │                      |
|  │  * Per-request: extract IP, User-Agent, path, timing   │                      |
|  │  * Async reputation lookup: GET /api/sentinel/check    │                      |
|  │  * If score > threshold: return 429 / redirect          │                      |
|  │  * < 5ms overhead on hot path (Fail-Open on timeout)   │                      |
|  └──────────────────────────────┬─────────────────────────┘                      |
+─────────────────────────────────┼────────────────────────────────────────────────+
                                  │ HTTPS (Vercel or localhost)
                                  ▼
+─────────────────────────────────────────────────────────────────────────────────+
|                       Vercel Serverless Edge (api/sentinel/)                     |
|                                                                                  |
|  GET /api/sentinel/check?ip=x.x.x.x                                              |
|  POST /api/sentinel/report   ← origin server reports 4xx/5xx bursts             |
|  GET /api/sentinel/dashboard ← operator reputation ledger view                  |
|                                                                                  |
|  * Neon Postgres: IP-range threat score ledger (BigInt counters, 30-day history) |
|  * Sister-site allowlist: never penalize known trusted origins                   |
+─────────────────────────────────────────────────────────────────────────────────+
                                  │ Tailscale / Direct (Jetson)
                                  ▼
+─────────────────────────────────────────────────────────────────────────────────+
|                    Zodiac SDN Enforcement Plane (Jetson Orin)                    |
|                                                                                  |
|  * Coral TPU 0: Line-rate mirror tap DPI → first-pass bot triage (<100µs)       |
|  * Coral TPU 1: DNS Sentinel → bot hostname / DGA fingerprinting                 |
|  * Jetson GPU: Stage-2 Collective Pattern Autoencoder → IP-range anomaly scoring |
|  * OpenFlow 1.3 FLOW_MOD quarantine → enforced at Zodiac FX hardware switch     |
|    (Priority 65535, action DROP, TTL-bounded, loop-free verified)                |
+─────────────────────────────────────────────────────────────────────────────────+
```

---

## Phase Overview

```
+──────────────────────────────────────────────────────────────────────────────────+
| Sentinel Phase 0: Telemetry Foundation & IP Reputation Ledger (NEXT)             |
| - Neon Postgres schema: IP range threat scores, request volume counters (BigInt) |
| - /api/sentinel/report: origin server posts 429/5xx burst events                 |
| - /api/sentinel/check: fast reputation lookup with < 5ms P99 (Neon + in-memory)  |
| - Sister-site allowlist: hardcoded trusted CIDR ranges, never penalized           |
| - Operator dashboard: reputation ledger view in Zodiac console                   |
+──────────────────────────────────────────────────────────────────────────────────+
                                       |
                                       v
+──────────────────────────────────────────────────────────────────────────────────+
| Sentinel Phase 1: Collective Behavior Detection Engine                            |
| - Sliding-window collective request rate: group IPs by /24 subnet, not per-IP   |
| - Quoc Le Adaptive Threshold: no hardcoded request-rate magic numbers            |
| - Jetson GPU Stage-2 classifier: IP-range collective anomaly scoring             |
| - Coral TPU 0 mirror tap: real-time packet volume correlation with API logs      |
| - Formal verification: scoring function proven monotone (Hassabis invariant)     |
+──────────────────────────────────────────────────────────────────────────────────+
                                       |
                                       v
+──────────────────────────────────────────────────────────────────────────────────+
| Sentinel Phase 2: OpenFlow Hardware Enforcement Integration                       |
| - Confirmed bot collective → POST /api/sdn/quarantine → FLOW_MOD DROP on switch |
| - Time-bounded quarantine: TTL-expiring rules, no permanent blocks without review|
| - SymbolicRouteVerifier gate: loop-free proof before any hardware rule install   |
| - Operator review queue: high-confidence quarantines auto-applied; edge cases    |
|   held for 60s human review window before escalation                             |
+──────────────────────────────────────────────────────────────────────────────────+
                                       |
                                       v
+──────────────────────────────────────────────────────────────────────────────────+
| Sentinel Phase 3: Edge Middleware SDK & Origin Server Integration                 |
| - Lightweight npm package: sentinel-middleware (zero prod dependencies)           |
| - Express/Koa/Apache module: pluggable async reputation check hook               |
| - Apache mod_lua / mod_rewrite integration for non-Node origins                  |
| - Graceful degradation: timeout = fail-open, never stall request pipeline        |
| - Documented SLO: < 5ms P99, 99.9% uptime (Vercel edge), < 0.1% false positives |
+──────────────────────────────────────────────────────────────────────────────────+
                                       |
                                       v
+──────────────────────────────────────────────────────────────────────────────────+
| Sentinel Phase 4: Sister-Site Traffic Isolation & Trusted Origin Proxy           |
| - Authenticated origin tokens: sister-site requests carry HMAC-signed headers   |
| - Traffic shaping (not blocking): queue/deprioritize sister-site burst traffic   |
|   via OpenFlow meter rules rather than DROP — preserving internal connectivity  |
| - Separate telemetry stream for sister-site vs external crawler classification  |
+──────────────────────────────────────────────────────────────────────────────────+
```

---

## Detailed Milestones

### Sentinel Phase 0: Telemetry Foundation & IP Reputation Ledger
*Status: Planned (Starting Point)*

- [ ] **Milestone S0.A: Neon Postgres IP Reputation Schema**:
  - New Prisma models: `SentinelIPRecord` (ip_range CIDR, threat_score `BigInt`, request_count `BigInt`, last_seen_ns `BigInt`, quarantine_count `Int`, is_allowlisted `Boolean`).
  - All counters in 64-bit `BigInt` (Council Invariant 2 — no floating-point in packet accounting).
  - All timestamps monotonic nanosecond precision (`process.hrtime.bigint()`).
  - Migration under `prisma/migrations/` before any schema deploy (INV-006).
- [ ] **Milestone S0.B: `/api/sentinel/report` — Origin Burst Event Ingestor**:
  - Origin server POSTs burst metadata: `{ ip, path, status_code, timestamp_ns, request_count }`.
  - Authenticated with `X-Sentinel-Secret` (same HMAC-SHA256 pattern as `X-Zodiac-Bridge-Secret`).
  - Non-blocking async write to Neon with exponential backoff (same pattern as cloud relay, INV-009).
- [ ] **Milestone S0.C: `/api/sentinel/check` — Fast Reputation Lookup**:
  - Checks Neon IP reputation table; falls back to fail-open (score = 0) on timeout/error.
  - In-memory LRU cache (bounded, 10k entries) for hot-path IPs: < 1ms local, < 5ms Neon P99.
  - Sister-site CIDR allowlist checked first — allowlisted IPs always return score = 0 (never blocked).
- [ ] **Milestone S0.D: Sentinel Dashboard in Zodiac Operator Console**:
  - New tab in the existing Zodiac web UI: Sentinel Reputation Ledger.
  - Live table: top-N threat IPs/subnets, scores, quarantine counts, last-seen timestamps.
  - Real-time feed of incoming `report` events from origin servers.

### Sentinel Phase 1: Collective Behavior Detection Engine
*Status: Planned*

- [ ] **Milestone S1.A: /24 Subnet Sliding-Window Collective Rate Meter**:
  - Group request events by `/24` subnet prefix, not individual IP.
  - Sliding 60-second window: aggregate request counts, 4xx/5xx rates, path diversity scores.
  - All windowed counters implemented as `BigInt` ring buffers (Council Invariant 2).
- [ ] **Milestone S1.B: Quoc Le Adaptive Threshold (No Magic Constants)**:
  - Threshold for "bot collective" classification adapts to baseline traffic distributions.
  - EMA (Exponential Moving Average) of historical subnet request rates as baseline.
  - Classification only fires when subnet rate exceeds `baseline + k * σ` (k learned, not hardcoded).
- [ ] **Milestone S1.C: Coral TPU 0 Mirror Tap Correlation**:
  - Wire-level packet counts from the Coral mirror tap correlated with API-layer `report` events.
  - Discrepancy detection: high packet counts but low API reports = possible origin-bypass attacker (direct IP access, not via Cloudflare).
  - Addresses the open architectural question: *"Do crawlers have direct IP access to origin?"*
- [ ] **Milestone S1.D: Jetson GPU Collective Anomaly Scorer**:
  - Extend the existing `gpu_anomaly_kernel.cu` Stage-2 autoencoder to accept subnet-aggregated feature vectors.
  - Input features: `[subnet_req_rate, 4xx_rate, path_entropy, ua_diversity, time_of_day_norm]`.
  - Output: reconstruction error → mapped to `[0–100]` threat score via `AdaptiveThresholdController`.

### Sentinel Phase 2: OpenFlow Hardware Enforcement Integration
*Status: Planned*

- [ ] **Milestone S2.A: Confirmed Quarantine → `POST /api/sdn/quarantine`**:
  - When threat score crosses confirmation threshold, Sentinel fires the existing Zodiac quarantine API.
  - All quarantine calls pass through `SymbolicRouteVerifier.verifyLoopFree()` before touching hardware (Hassabis Invariant 4).
  - `QuarantineAuditEntry` written to `flowRuleRegistry` with Sentinel-specific metadata: `source: 'sentinel'`, `trigger: 'bot_collective'`, `subnet_cidr`.
- [ ] **Milestone S2.B: TTL-Bounded Quarantine Rules (No Permanent Blocks)**:
  - All Sentinel-triggered FLOW_MOD rules carry an explicit idle timeout (e.g., 300s default).
  - Automatic expiry with Sentinel re-evaluation on next request — no permanent block without operator confirmation.
  - Quarantine count increments in `SentinelIPRecord`; repeat offenders escalate TTL progressively.
- [ ] **Milestone S2.C: Human Review Queue for Edge Cases**:
  - High-confidence quarantines (score > 90) auto-apply immediately.
  - Mid-confidence quarantines (score 60–90) hold for 60-second operator review window before escalation.
  - Low-confidence (score < 60) only logged, no enforcement.

### Sentinel Phase 3: Edge Middleware SDK & Origin Server Integration
*Status: Planned*

- [ ] **Milestone S3.A: `sentinel-middleware` npm Package**:
  - Zero production dependencies (Ghemawat: Radical Simplicity).
  - Express/Koa/Fastify plugin: async reputation check with configurable `timeoutMs` (default 3000ms) and `failOpen: true`.
  - `X-Sentinel-Score` response header for audit logging.
- [ ] **Milestone S3.B: Apache Integration**:
  - `mod_lua` or `mod_rewrite` + `curl` hook calling `/api/sentinel/check` for non-Node origins.
  - Pre-fork worker model compatible — no shared state in Apache workers.
- [ ] **Milestone S3.C: SLO Definition & Measurement**:
  - P99 check latency ≤ 5ms (cached) / ≤ 50ms (Neon live query).
  - False-positive rate < 0.1% (validated against test traffic from known-legitimate users).
  - Uptime SLO: 99.9% (backed by Vercel edge serverless reliability).
  - All SLO metrics tracked in Neon and surfaced on Sentinel dashboard.

### Sentinel Phase 4: Sister-Site Traffic Isolation & Trusted Origin Proxy
*Status: Planned*

- [ ] **Milestone S4.A: HMAC-Authenticated Origin Tokens**:
  - Sister-site requests carry `X-Sentinel-Origin-Token` HMAC-SHA256 signed with shared secret.
  - Verified in < 1 µs (constant-time comparison, no Neon query on hot path).
  - Authenticated sister-site traffic bypasses collective scoring, enters dedicated meter.
- [ ] **Milestone S4.B: OpenFlow Traffic Shaping (Meter, Not DROP)**:
  - Sister-site burst traffic shaped via Zodiac FX hardware **rate meters** (not DROP rules).
  - Configures meter bands: `type=DROP, rate=N kbps` applied to sister-site VLAN flow — limits burst without severing connectivity.
  - Preserves trusted internal traffic while preventing it from starving the origin server under burst.
- [ ] **Milestone S4.C: Separate Telemetry Stream**:
  - Sister-site metrics isolated into `SentinelSisterSiteRecord` table.
  - Dashboard shows sister-site vs external crawler load side-by-side — operator visibility without conflation.

---

## Council Invariant Compliance Matrix

| Sentinel Component | Invariant | How It Complies |
|---|---|---|
| IP reputation counters, request rates | **INV-002** (BigInt/Integer only) | All counters `BigInt`, timestamps `hrtime.bigint()` nanoseconds |
| Detection API timeout handling | **INV-003** (Zero Error Suppression) | Explicit timeout → fail-open path; errors surface in telemetry, never silently swallowed |
| Quarantine enforcement | **INV-003** (Fail-Closed Isolation) | Default-drop when quarantine confirmed; always TTL-bounded |
| GPU anomaly scorer + collective detector | **INV-004** (Verification Asymmetry) | Agent-proposed quarantine must pass `SymbolicRouteVerifier` before hardware install |
| Adaptive collective threshold | **INV-005** (Adaptive Control) | EMA-based, no hardcoded magic numbers; eliminates false-positive oscillation |
| Threat scores derived from physical wire tap | **INV-006** (Epistemic Provenance) | Coral mirror tap = physical ground truth; no synthetic score fabrication |

---

## Open Questions (from §2.4 / architectural discussion)

1. **Origin Bypass?** Do crawlers have direct IP access to the origin servers (bypassing Cloudflare)? → Sentinel Phase 1 (S1.C Coral correlation) answers this definitively.
2. **Fail-Open vs Fail-Closed** → Decided: Fail-Open at detection layer, Fail-Closed at confirmed enforcement (see Architectural Characteristics above).
3. **SLO/SLA/SLI definition** → Defined at S3.C; tracked in Neon; surfaced on dashboard.
4. **CrowdSec replacement or complement?** → Complement. Sentinel does not modify CrowdSec rules. It adds the collective-behavior detection layer CrowdSec lacks.

---

## Directory Layout (proposed)

```
sentinel/
├── README.md                   ← Sentinel module overview
├── middleware/
│   ├── index.ts                ← Express/Koa/Fastify plugin (sentinel-middleware)
│   ├── apache-lua/             ← mod_lua hook for Apache integration
│   └── types.ts                ← SentinelCheckResponse, SentinelConfig types
├── detection/
│   ├── collective-detector.ts  ← /24 subnet sliding-window rate meter
│   ├── adaptive-threshold.ts   ← Quoc Le EMA adaptive threshold (no magic constants)
│   └── feature-vector.ts       ← GPU feature vector builder from Neon + mirror tap
├── enforcement/
│   └── quarantine-bridge.ts    ← Bridges Sentinel scores → POST /api/sdn/quarantine
└── test/
    └── invariants/
        ├── collective-detector.test.ts
        ├── adaptive-threshold.test.ts
        └── sentinel-reputation.test.ts
```

API routes live under the existing `api/` directory:
```
api/
└── sentinel/
    ├── check.ts     ← GET /api/sentinel/check?ip=x.x.x.x
    ├── report.ts    ← POST /api/sentinel/report
    └── dashboard.ts ← GET /api/sentinel/dashboard
```

Prisma schema additions go into the existing `prisma/schema.prisma` with a new migration.

---

## Bandwidth & Bottleneck Analysis

> **The Corals are NOT the bottleneck for Sentinel.** Sentinel's detection is collective and aggregate, not per-packet. This section establishes the full throughput envelope and identifies the two constraints that require explicit design attention.

### Summary Table

| Rank | Bottleneck | Hard Limit | Impact on Sentinel |
|:---|:---|:---|:---|
| 🔴 **#1** | **Zodiac FX port bandwidth** | **100 Mbps per port** | Physical ceiling for ALL traffic through the local SDN plane |
| 🔴 **#2** | **OpenFlow flow table** | **128 rules max** | Caps the number of simultaneously quarantined subnets |
| 🟠 **#3** | **Coral per-packet inference** | **~230 inf/s per TPU (current impl.)** | Only relevant for per-packet DPI — Sentinel uses aggregates, not full inspection |
| 🟡 **#4** | **Neon `/api/sentinel/check` cold query** | **~5ms P99** | Hot path only; mitigated by the bounded LRU cache defined in S0.C |

---

### Layer-by-Layer Throughput Breakdown

#### Layer 1: Physical Wire — The Hard Ceiling

Every port on the Zodiac FX is **100BASE-TX = 100 Mbps full-duplex** (Microchip KSZ8795CLX switch IC, SAM4E8E MCU):

```
Gateway uplink (Port 2):  100 Mbps max  ← ISP physical ceiling
Client port (Port 1):     100 Mbps max
Mirror tap (Port 3):      100 Mbps max  ← mirrored copy of Port 1/2 traffic
Total switch fabric:      ~400 Mbps aggregate (non-blocking KSZ8795)
```

In packet terms at typical HTTP request sizes (~600 bytes average):

```
100 Mbps ÷ (600 bytes × 8 bits/byte) ≈ 20,800 packets/second max through the switch
```

This is a generous budget relative to the real failure mode. Most crawler attacks are HTTP/1.1 with keepalive. Apache typically crashes at **1,000–5,000 concurrent connections** — far below the 20,800 pps the switch can forward. **The switch port is not what crashes. Apache's thread pool is.**

#### Layer 2: OpenFlow Flow Table — The Enforcement Ceiling

The Zodiac FX SAM4E8E MCU enforces a **deterministic 128-entry OpenFlow flow table**. This is the hardest architectural constraint for Sentinel's hardware enforcement path:

- Maximum **128 simultaneous active quarantine rules** at any point in time
- A rotating-IP attack distributed across hundreds of /24 subnets consumes one entry per rule
- Flow rule entries are consumed per CIDR match expression installed via `FLOW_MOD`

**Design constraint for Sentinel (captured in milestone S2.A):** Quarantine rules must target **supernet prefixes** (`/16` or `/20` blocks), not individual /32 IPs. A bot collective operating across 200 /24 subnets almost always originates from a handful of /16 autonomous system blocks. Installing one `/16` DROP rule consumes one flow table entry and neutralizes the entire rotating-IP pool within it.

#### Layer 3: Coral Edge TPU — NOT the Sentinel Bottleneck

Validated inference rate on physical hardware: **~230 inferences/second per TPU** (sourced from `hardware-probe.ts` telemetry, physical sysfs provenance per Invariant 6). With both TPUs active: **~450 inferences/second combined**.

At 100 Mbps line rate with 600-byte average packets:

```
20,800 packets/second on wire
÷   450 inferences/second Coral capacity
= Coral currently inspects ~2.2% of packets at line rate
```

This sounds like a gap, but **it is not a problem for Sentinel** because Sentinel's collective detection does not require 100% packet inspection. Its three signal sources are:

| Signal | Coverage | Source |
|:---|:---|:---|
| DNS queries | **100%** | TPU 1 RFC 1035 DNS Sentinel (query volume is small — hundreds/s at most) |
| Statistical packet sampling | **~2.2% sampled** | TPU 0 mirror tap (sufficient for aggregate subnet behavior; statistically valid) |
| HTTP request metadata | **100%** | Apache/middleware `report` hook — this is Sentinel's **primary detection signal** |

The 230 inf/s figure is also a **Python implementation ceiling, not a hardware ceiling.** The Coral USB 3.0 interface can physically sustain ~10,000 round-trip tensor transfers/second (USB 3.0 at ~100µs per transaction). The gap between 230 and 10,000 is Python inference loop overhead in `hardware-burst-daemon.py`. A C or TensorFlow Lite C++ implementation would approach the hardware limit. This is a future optimization opportunity, not a current Sentinel blocker.

#### Layer 4: Neon Sentinel Check Latency

The `/api/sentinel/check` endpoint serves reputation lookups from the Apache/middleware hot path:

| Query Type | Latency | Max Throughput |
|:---|:---|:---|
| LRU cache hit (in-memory, hot IP) | **~1ms** | ~50,000 req/s on Vercel |
| Neon Postgres live query (cold IP) | **~5ms P99** | ~200 req/s (limited by Neon connection pool) |

The cold-query path at 200 req/s is the constraint. Under a heavy crawler attack where thousands of new IPs rotate in, the Neon connection pool becomes the choke point. **Design constraint for Sentinel (captured in milestone S0.C):** The LRU cache must be the primary defense for the check hot path. Additionally, Neon's built-in PgBouncer connection pooling must be explicitly enabled — without it, Sentinel itself becomes a Neon connection-exhaustion amplifier under attack load.

---

### Production vs. Physical Plane Distinction

This is the most important architectural clarification for Sentinel:

```
+──────────────────────────────────────────────────────────────────────────────────+
|  PRODUCTION TRAFFIC PATH (where the attack actually lands)                       |
+──────────────────────────────────────────────────────────────────────────────────+
|                                                                                  |
|  Internet crawlers (rotating IPs, distributed /24 pool)                          |
|       │                                                                          |
|       ▼                                                                          |
|  [Cloudflare Edge]                                                               |
|  Effectively unlimited egress capacity (Tbps scale)                              |
|  ← Sentinel Phase 0: /api/sentinel/check callable here via Cloudflare Workers   |
|       │                                                                          |
|       ▼                                                                          |
|  [Apache / Nginx Origin Server]          ← REAL BOTTLENECK #1                   |
|  Thread pool: ~200–500 concurrent conn   ← crashes here, NOT at the switch      |
|  ← sentinel-middleware hooks here for 100% HTTP request coverage                |
|       │                                                                          |
|       ▼                                                                          |
|  [/api/sentinel/check — Vercel edge]     ← REAL BOTTLENECK #2 (cold queries)    |
|  LRU cache (hot IPs):   ~1ms / ~50K rps                                         |
|  Neon live query (cold): ~5ms / ~200 rps ← needs PgBouncer pooling              |
|       │                                                                          |
|       ▼                                                                          |
|  [Neon Postgres — IP reputation ledger]  ← REAL BOTTLENECK #3 (conn pool)      |
|  ~5ms P99 query latency                                                          |
|  Connection pool exhaustion under high cold-query load                           |
|                                                                                  |
+──────────────────────────────────────────────────────────────────────────────────+

+──────────────────────────────────────────────────────────────────────────────────+
|  ZODIAC PHYSICAL ENFORCEMENT PLANE (local lab substrate + hardware quarantine)   |
+──────────────────────────────────────────────────────────────────────────────────+
|  Zodiac FX port bandwidth:  100 Mbps / port   ← hard physical ceiling (local)  |
|  OpenFlow flow table:       128 rules max      ← HARDEST SDN CONSTRAINT         |
|                             → must quarantine at /16 not /32                    |
|  Mirror tap (Port 3):       100 Mbps mirrored copy of data plane traffic        |
|  Coral TPU 0 (DPI):         ~230 inf/s sampled ← Python impl. ceiling, not hw  |
|  Coral TPU 1 (DNS):         100% DNS query coverage                             |
|  Jetson GPU (Stage-2):      0.271ms/inference  ← NOT a bottleneck               |
+──────────────────────────────────────────────────────────────────────────────────+
```

The Zodiac FX **never sees production internet crawler traffic** — it is a local lab device on a home LAN. Its role in Sentinel is:
1. **Research substrate**: validates detection algorithms on controlled local traffic before production deployment.
2. **Local development enforcement**: quarantines test adversarial agents (e.g., the Raspberry Pi workload) during development and integration testing.
3. **DNS sentinel signal**: TPU 1 DNS Sentinel feeds into the reputation ledger for domain-level bot fingerprinting.

For the production attack scenario (crawlers hitting the real Apache origin server), the enforcement plane is **Vercel edge (rate-limiting) + Apache middleware (fail-open check hook) + Neon (reputation state)**.

---

### Sentinel Throughput Budget

| Component | Current Capacity | Status |
|:---|:---|:---|
| `/api/sentinel/check` — LRU cache hit | **~50,000 req/s, ~1ms P99** | ✅ Fine |
| `/api/sentinel/check` — Neon cold query | **~200 req/s, ~5ms P99** | 🔴 **Needs PgBouncer pooler** (S0.C) |
| Collective /24 sliding-window detector | Memory-bounded, O(n subnets), BigInt | ✅ Fine |
| OpenFlow quarantine rule enforcement | **128 rules max simultaneously** | 🔴 **Must use supernet /16 rules** (S2.A) |
| Coral mirror tap packet sampling | **~450 packets/s sampled** | ✅ Not the critical Sentinel path |
| Jetson GPU collective anomaly scorer | **0.271ms/inference** | ✅ Not a bottleneck |
| Apache middleware hook overhead | **< 5ms, fail-open on timeout** | ✅ Fine |
| Sister-site CIDR allowlist check | **< 1µs (in-memory, constant-time)** | ✅ Fine |

---

### Design Constraints Mandated by This Analysis

Two constraints must be reflected in Sentinel milestone specifications:

#### Constraint 1 → Milestone S2.A (OpenFlow Enforcement)
> **Quarantine rules MUST target supernet prefixes (`/16` to `/20`), never individual `/32` IPs.**  
> A rotating-IP collective operating across 200 /24 subnets almost always originates from a small number of /16 ASN blocks. One `/16` DROP rule neutralizes the entire pool and consumes one of 128 flow table entries. Installing per-IP rules will exhaust the 128-entry table in seconds under a serious rotating-IP attack, leaving no capacity for legitimate traffic steering rules.

#### Constraint 2 → Milestone S0.C (Reputation Lookup)
> **Neon's built-in PgBouncer connection pooler must be explicitly enabled before Sentinel goes to production.**  
> Without pooling, the cold-query path saturates at ~200 req/s under a fresh rotating-IP attack (every new IP is a cache miss → cold Neon query → new connection). Sentinel must not become a Neon connection-exhaustion amplifier. The LRU cache (bounded 10k entries) is the first line of defense; PgBouncer is the second. Both are required.
