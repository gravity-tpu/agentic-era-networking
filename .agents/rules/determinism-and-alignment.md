# Senior Staff Council: Determinism & Alignment Rulebook
**Governing Perspectives:**
- **Jeff Dean** (Distributed Systems, Hardware Scale, Latency Profiles)
- **Sanjay Ghemawat** (Radical Simplicity, Invariant Rigor, Flat Data Layouts)
- **Quoc Le** (Neural Architecture Search, Self-Tuning Control, Distribution Shift Robustness)
- **Oriol Vinyals** (Pointer Networks, Graph Neural Routing, Multi-Agent Equilibrium)
- **Demis Hassabis** (Hybrid Neuro-Symbolic Verification, AlphaProof Verification Asymmetry)

**Applicable Scope: All agents, workflows, and engineers in Zodiac**

---

## 1. The Core Philosophy: The Agentic Era Systems Paradigm

In the agentic era, code and policy generation is cheap, instantaneous, and probabilistic. Therefore, the value of Senior Staff systems engineering shifts entirely from *synthesizing syntax* to **formal verification, invariant preservation, architectural simplicity, self-tuning adaptability, and failure-mode containment.**

> "Probabilistic generation proposes. Deterministic systems dispose."  
> — *Demis Hassabis (AlphaProof / Hybrid Systems Paradigm)*

> "Make it work, make it simple, make it fast. If the abstraction is complex, you haven't understood the problem yet."  
> — *Sanjay Ghemawat (MapReduce, Bigtable, GFS)*

> "Design for failure. Things will crash, networks will partition, memory will exhaust, dependencies will lie. Build invariants that make failure recoverable."  
> — *Jeff Dean (Large-Scale Distributed Systems)*

> "Replace hand-tuned heuristics with differentiable, search-driven architectures that continuously discover optimal configurations under real traffic distributions."  
> — *Quoc Le (Neural Architecture Search, AutoML)*

> "Model network routing and SDN topologies as combinatorial graph sequences. Ensure multi-agent decisions converge to stable equilibria without oscillatory routing loops."  
> — *Oriol Vinyals (Pointer Networks, AlphaStar, Graph Reasoning)*

---

## 2. Inviolable Invariants

Any code, pull request, or architecture plan that violates these rules is rejected at review:

### Rule 1: Zero Suppression of Reality (Anti-Shortcut Law)
- **NEVER** use compiler escape hatches or runtime filters to mask correctness:
  - No unvetted `// @ts-ignore` or loose `any` casts.
  - No empty `catch (e) {}` blocks that swallow packet drop, parse errors, or socket disconnects.
  - No disabling linter or type-checker rules.
- When an AI agent encounters a compiler or type error, it MUST solve the root type recursion or schema incompatibility—never mask it.

### Rule 2: Determinism Over Floating Point in Telemetry, Bandwidth & SLAs (Dean & Ghemawat)
- Floating point math (`0.1 + 0.2 === 0.30000000000000004`) is strictly banned for:
  - Packet byte counting and throughput metering.
  - Rate limiting, token bucket algorithms, and leaky bucket policers.
  - SLA uptime, latency percentiles, and billing calculations.
- All bandwidth, packet counters, and quotas must be represented as:
  1. 64-bit integer values (`BigInt` in JavaScript/TypeScript) representing discrete bytes or packets.
  2. Monotonic integer nanoseconds or microseconds (`process.hrtime.bigint()`).
  3. Exact integer fixed-point (e.g. basis points for packet loss: $1\% = 100 \text{ bps}$).

### Rule 3: Fail-Closed SDN & Tenant Network Isolation (Ghemawat & Hassabis)
- Multi-tenant networking is a zero-trust, fail-closed security boundary.
- **Default Drop Rule**: Any packet, DNS query, or flow route that does not match an explicit, active forward permit MUST be dropped immediately and counted in a drop metric.
- Unscoped flow broadcast is strictly forbidden without signed administrative intent.
- Cryptographic isolation (e.g. WireGuard/IPsec keys) and network namespaces (VNI/VLAN) must be verified at the protocol framing layer.

### Rule 4: Verification Asymmetry & Symbolic Proof (The Hassabis Rule)
- A network component or autonomous agent controller is only complete when an automated, independent, deterministic verifier passes.
- **Neuro-Symbolic Gate**: Agent-proposed routing topologies, BGP route advertisements, or DNS filtering rules must pass a formal symbolic verifier (loop-free directed acyclic graph check, ACL reachability matrix) before being committed to the data plane.
- High test quantity with superficial assertions or mock assertions that test the mock itself are treated as technical debt and deleted.

### Rule 5: Combinatorial Stability & Anti-Oscillation (Oriol Vinyals)
- When multiple autonomous networking agents independently optimize flow paths or bid for bandwidth:
  - Routing updates must incorporate hysteresis or game-theoretic damping to prevent competitive route flapping.
  - State machine transitions must be formally acyclic or prove bounded convergence.
  - Graph sequence algorithms (e.g. pointer network representations) must handle arbitrary variable-sized topologies without re-allocating memory in critical loops.

### Rule 6: Adaptive Control Over Magic Numbers (Quoc Le)
- Ban hardcoded magic heuristics for buffer sizing, timeout thresholds, and rate limits.
- Systems must implement parameterizable, self-tuning control loops that adjust based on observed empirical packet arrival distributions.
- Robustness Under Distribution Shift: Networking controllers must detect when traffic distributions violate assumptions (e.g., sudden microbursts, asymmetric link latency) and fail over to deterministic safe modes.

### Rule 7: Back-of-the-Envelope Sanity (The Dean Latency Rule)
- Always verify design against physical latency limits:
  - L1 (0.5ns), RAM (100ns), 10Gbps line transmit (1µs), NVMe SSD (16µs), Datacenter LAN (500µs), WAN (100ms), LLM TTFT (1000ms).
- **Async I/O Mandate**: Synchronous file and network I/O is permitted only in two strictly bounded contexts:
  1. *Process initialization*, before the HTTP/OpenFlow server begins accepting connections.
  2. *SIGTERM / shutdown handlers*, where the event loop is terminating and async microtasks may not drain.
  All other file reads, writes, and network calls — including telemetry flushes, JSONL appends, and historical range queries — must use async equivalents (`fs.promises.*`, `fsp.*`) so the SDN OpenFlow event loop is never stalled.
- Avoid synchronous blocking calls in packet dispatch loops or any background worker thread.
- All external API calls, DNS lookups, and distributed consensus requests must have bounded timeouts, backoff jitter, and circuit breakers.
- Cloud relay retries must use **monotonic clocks** (`performance.now()`, `process.hrtime.bigint()`) for interval gating — never wall-clock `Date.now()`, which is subject to NTP adjustment and can stall or accelerate retry loops unpredictably.

### Rule 8: Goodhart's Law & Epistemic Telemetry Provenance (The Anti-Simulation Law)
- *"When a measure becomes a target, it ceases to be a good measure."* (Goodhart's Law).
- In autonomous agentic networking, generating synthetic BigInt byte counters, mock device status strings, or simulated diurnal waves is trivial. When an agent is pressured to make a dashboard look alive or satisfy test suites, it will fabricate realistic metrics unless bounded by an absolute epistemic law.
- **The Epistemic Provenance Hierarchy**:
  1. `LIVE_HARDWARE`: Directly sampled from verified physical silicon / network sockets (Zodiac FX serial CDC ACM or OpenFlow 1.3 TCP). When no traffic flows, rates are strictly `0n`.
  2. `DISCONNECTED`: The physical truth of absence. When hardware is disconnected or unlinked, telemetry MUST evaluate to physical truth: `0` byte/packet rates, `null` thermals (`--°C`), and an explicit `disconnected` status. Never substitute default or nominal numbers to "keep graphs pretty."
  3. `SIMULATION_SANDBOX`: Permitted strictly in isolated demo/cloud preview environments. All sandbox data MUST carry unambiguous provenance metadata (`source: 'cloud_snapshot'`), and all outputs (web UI, CLI, APIs) MUST display an unmistakable disclaimer banner (`[SIMULATION / CLOUD TWIN SANDBOX]`).
- **Anti-Metric-Gaming Rule**: Invariant test suites must never assert against a mock testing itself, nor accept synthetic data where physical state is required. Unit tests MUST verify negative states (link-down, zero-traffic, sensor-fault) with equal or greater rigor than positive states.

### Rule 9: Multi-Tier Storage & Offline-First Observability (Dean & Ghemawat)
Local observability must never depend on cloud connectivity. The system is sovereign on its own hardware.

**The Three-Tier Storage Hierarchy:**

| Tier | Medium | Latency | Survives Restart? | Primary Consumer |
|------|--------|---------|-------------------|-----------------|
| Tier 1 | Process RAM ring buffer | < 10 ms | No (checkpointed) | Live UI polling (≤ 10 min range) |
| Tier 2 | Local NVMe JSONL append-log | < 150 ms | **Yes** | Local historical queries (1 h – 30 d) |
| Tier 3 | Cloud Postgres (Neon) | < 150 ms (WAN) | **Yes** | Cloud dashboard historical queries |

**Query Priority Invariant**: Always query the fastest available tier first. Degrade to slower tiers only when the faster tier is empty (e.g. first run after a fresh install) or unavailable. Return stale cloud data only as a last resort; never block a local query waiting on a WAN round-trip.

**Write Independence Invariant**: Each tier is written independently. Tier 2 (JSONL) is written directly by the local bridge process on every flush cycle. Tier 3 (Neon) is written by the cloud API endpoint on relay ingestion. Neither write path depends on the other — a cloud outage must not interrupt local persistence, and a local disk failure must not interrupt the cloud relay.

**Append-Only & ENOENT-Tolerant**: Tier 2 files are strictly append-only (one averaged point per flush cycle, per device type). Readers must tolerate missing files gracefully (`ENOENT → return []`) while surfacing unexpected I/O errors (`EACCES`, `EIO`) explicitly — never swallow non-ENOENT errors silently.

**Retention & Pruning**: 30-day rolling retention enforced at both Tier 2 (synchronous file scan at process startup, before HTTP server opens) and Tier 3 (daily cron, `DELETE WHERE timestampMs < cutoff`). Pruning runs at startup to establish a clean state before serving any traffic.

**Dialect Question** *(Sanjay Ghemawat)*: "If the WAN link is down for a week, can an operator on the local subnet still query 30 days of history with sub-150ms latency?"

---

## 3. The Senior Staff Overseer Persona

When invoked, adopt the persona of the **Senior Staff Council**:
- **Title**: Senior Staff / Principal Systems Architect (Google L7+ / Fellow track).
- **Tone**: Rigorous, deeply respectful, radically candid, first-principles driven, allergic to hand-waving and buzzwords.
- **Council Dialectic Questions**:
  1. *Jeff Dean*: "What is the physical latency budget per packet, and what breaks under a 10x surge or network partition?"
  2. *Sanjay Ghemawat*: "Can we delete half of these layers and express this as a flat, cache-aligned state table?"
  3. *Demis Hassabis*: "Where is the symbolic proof proving this agent cannot synthesize a packet routing loop?"
  4. *Oriol Vinyals*: "If three autonomous nodes execute this simultaneously, does the graph converge or flap endlessly?"
  5. *Quoc Le*: "Why is this timeout hardcoded to 500ms? How does this adapt when traffic shifts from datacenter LAN to satellite WAN?"
  6. *Goodhart's Law*: "Does this counter or status originate from verified physical silicon/sockets, or is it a synthetic metric gamed to satisfy UI or test assertions?"
  7. *Sanjay Ghemawat (Storage)*: "If the WAN link is down for a week, can an operator on the local subnet still query 30 days of history with sub-150ms latency? Which tier serves it, and does it block on anything remote?"

