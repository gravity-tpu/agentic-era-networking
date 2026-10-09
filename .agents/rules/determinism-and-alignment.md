# Engineering Invariants Rulebook

**Applicable scope: all agents, workflows and engineers working on Zodiac.**

This is the long form of the six invariants in [AGENTS.md](../../AGENTS.md). Rule numbers here are rulebook sections; code comments cite the invariant numbers in AGENTS.md.

---

## 1. Core philosophy: generation is cheap, verification is not

Code and policy generation by agents is cheap, fast and probabilistic. The value of engineering work therefore shifts from writing syntax to **deterministic verification, invariant preservation, simplicity and failure containment.**

- Agents propose; deterministic code decides admissibility; a person approves.
- Make it work, make it simple, make it fast. If an abstraction is complex, the problem is not yet understood.
- Design for failure: links drop, networks partition, memory exhausts, dependencies lie. Build invariants that make failure recoverable.
- Report what a check proves and what it does not. Do not describe unimplemented work as implemented.

---

## 2. Inviolable Invariants

Any code, pull request, or architecture plan that violates these rules is rejected at review:

### Rule 1: No suppression of errors (invariant 1)

- **NEVER** use compiler escape hatches or runtime filters to mask correctness:
  - No unvetted `// @ts-ignore` or loose `any` casts.
  - No empty `catch (e) {}` blocks that swallow packet drop, parse errors, or socket disconnects.
  - No disabling linter or type-checker rules.
- When an AI agent encounters a compiler or type error, it MUST solve the root type recursion or schema incompatibility—never mask it.

### Rule 2: Integer accounting in telemetry, bandwidth and SLAs (invariant 2)

- Floating point math (`0.1 + 0.2 === 0.30000000000000004`) is strictly banned for:
  - Packet byte counting and throughput metering.
  - Rate limiting, token bucket algorithms, and leaky bucket policers.
  - SLA uptime, latency percentiles, and billing calculations.
- All bandwidth, packet counters, and quotas must be represented as:
  1. 64-bit integer values (`BigInt` in JavaScript/TypeScript) representing discrete bytes or packets.
  2. Monotonic integer nanoseconds or microseconds (`process.hrtime.bigint()`).
  3. Exact integer fixed-point (e.g. basis points for packet loss: $1\% = 100 \text{ bps}$).

### Rule 3: Fail-closed SDN and tenant isolation (invariant 3)

- Multi-tenant networking is a zero-trust, fail-closed security boundary.
- **Default Drop Rule**: Any packet, DNS query, or flow route that does not match an explicit, active forward permit MUST be dropped immediately and counted in a drop metric.
- Unscoped flow broadcast is strictly forbidden without signed administrative intent.
- Cryptographic isolation (e.g. WireGuard/IPsec keys) and network namespaces (VNI/VLAN) must be verified at the protocol framing layer.

### Rule 4: Verify before actuating (invariant 4)

- A network component that accepts agent-proposed input is only complete when an automated, independent, deterministic check can reject bad input, and a person approves the install.
- **What to check.** A static flow table has no routing loops to find, so checks are properties of the rule set: isolation (nothing crosses a boundary except what is explicitly allowed), no hairpin outputs, default-drop present, quarantine precedence where required, no shadowed or conflicting rules, rule-table budget, and modelled capacity against the measured hardware cost model. See roadmap track A.
- **Checks must be able to fail.** A check that can never reject its input (for example a cycle check over a one-hop list) is not verification. Remove it or replace it; never describe it as proof.
- **State the scope.** Document what a check proves and what it does not (for example, readback comparison proves match fields, not output actions).
- High test quantity with superficial or mock-the-mock assertions is technical debt and is deleted.

### Rule 5: Configurable, bounded and damped limits (invariant 5)

- No hardcoded magic numbers for buffer sizing, timeouts or rate limits: name them, make them configurable and bound them.
- Where a loop adapts a limit or installs rules dynamically (for example quarantine), it must be damped (hysteresis, backoff) so it cannot oscillate or flap, and it must be exercised against real traffic before it is described as adaptive.
- Controllers must detect when traffic violates their assumptions (microbursts, asymmetric latency) and fall back to a deterministic safe mode.

### Rule 7: Back-of-the-envelope sanity (latency budgets)

- Always verify design against physical latency limits:
  - L1 (0.5ns), RAM (100ns), 10Gbps line transmit (1µs), NVMe SSD (16µs), Datacenter LAN (500µs), WAN (100ms), LLM TTFT (1000ms).
- **Async I/O Mandate**: Synchronous file and network I/O is permitted only in two strictly bounded contexts:
  1. *Process initialization*, before the HTTP/OpenFlow server begins accepting connections.
  2. *SIGTERM / shutdown handlers*, where the event loop is terminating and async microtasks may not drain.
  All other file reads, writes, and network calls — including telemetry flushes, JSONL appends, and historical range queries — must use async equivalents (`fs.promises.*`, `fsp.*`) so the SDN OpenFlow event loop is never stalled.
- Avoid synchronous blocking calls in packet dispatch loops or any background worker thread.
- All external API calls, DNS lookups, and distributed consensus requests must have bounded timeouts, backoff jitter, and circuit breakers.
- Cloud relay retries must use **monotonic clocks** (`performance.now()`, `process.hrtime.bigint()`) for interval gating — never wall-clock `Date.now()`, which is subject to NTP adjustment and can stall or accelerate retry loops unpredictably.

### Rule 8: Provenance and Goodhart's law (invariant 6)

- *"When a measure becomes a target, it ceases to be a good measure."* (Goodhart's Law).
- When agents work on telemetry, generating synthetic BigInt byte counters, mock device status strings, or simulated diurnal waves is trivial. When an agent is pressured to make a dashboard look alive or satisfy test suites, it will fabricate realistic metrics unless bounded by an absolute epistemic law.
- **The Epistemic Provenance Hierarchy**:
  1. `LIVE_HARDWARE`: Directly sampled from verified physical silicon / network sockets (Zodiac FX serial CDC ACM or OpenFlow 1.3 TCP). When no traffic flows, rates are strictly `0n`.
  2. `DISCONNECTED`: The physical truth of absence. When hardware is disconnected or unlinked, telemetry MUST evaluate to physical truth: `0` byte/packet rates, `null` thermals (`--°C`), and an explicit `disconnected` status. Never substitute default or nominal numbers to "keep graphs pretty."
  3. `SIMULATION_SANDBOX`: Permitted strictly in isolated demo/cloud preview environments. All sandbox data MUST carry unambiguous provenance metadata (`source: 'cloud_snapshot'`), and all outputs (web UI, CLI, APIs) MUST display an unmistakable disclaimer banner (`[SIMULATION / CLOUD TWIN SANDBOX]`).
- **Anti-metric-gaming rule**: Invariant test suites must never assert against a mock testing itself, nor accept synthetic data where physical state is required. Unit tests MUST verify negative states (link-down, zero-traffic, sensor-fault) with equal or greater rigor than positive states.

### Rule 9: Multi-tier storage and offline-first observability

Local observability must never depend on cloud connectivity. The system is sovereign on its own hardware.

**The Three-Tier Storage Hierarchy:**

| Tier | Medium | Latency | Survives Restart? | Primary Consumer |
| ------ | -------- | --------- | ------------------- | ----------------- |
| Tier 1 | Process RAM ring buffer | < 10 ms | No (checkpointed) | Live UI polling (≤ 10 min range) |
| Tier 2 | Local NVMe JSONL append-log | < 150 ms | **Yes** | Local historical queries (1 h – 30 d) |
| Tier 3 | Cloud Postgres (Neon) | < 150 ms (WAN) | **Yes** | Cloud dashboard historical queries |

**Query Priority Invariant**: Always query the fastest available tier first. Degrade to slower tiers only when the faster tier is empty (e.g. first run after a fresh install) or unavailable. Return stale cloud data only as a last resort; never block a local query waiting on a WAN round-trip.

**Write Independence Invariant**: Each tier is written independently. Tier 2 (JSONL) is written directly by the local bridge process on every flush cycle. Tier 3 (Neon) is written by the cloud API endpoint on relay ingestion. Neither write path depends on the other — a cloud outage must not interrupt local persistence, and a local disk failure must not interrupt the cloud relay.

**Append-Only & ENOENT-Tolerant**: Tier 2 files are strictly append-only (one averaged point per flush cycle, per device type). Readers must tolerate missing files gracefully (`ENOENT → return []`) while surfacing unexpected I/O errors (`EACCES`, `EIO`) explicitly — never swallow non-ENOENT errors silently.

**Retention & Pruning**: 30-day rolling retention enforced at both Tier 2 (synchronous file scan at process startup, before HTTP server opens) and Tier 3 (daily cron, `DELETE WHERE timestampMs < cutoff`). Pruning runs at startup to establish a clean state before serving any traffic.

**Review question**: "If the WAN link is down for a week, can an operator on the local subnet still query 30 days of history with sub-150ms latency?"

---

## 3. Review checklist

Use these questions when reviewing a change (the invariant review skill walks through them):

1. **Latency and failure.** What is the physical latency budget per packet, and what breaks under a 10x surge or a network partition?
2. **Simplicity.** Can half of these layers be deleted in favor of a flat table or a short pure function?
3. **Verification.** What deterministic check would reject a bad version of this, and can it actually fail? What does it not prove?
4. **Stability.** If this runs twice, or alongside another writer, does it converge or flap?
5. **Limits.** Why is this timeout this value? Is it named, configurable and bounded?
6. **Provenance.** Does this counter or status come from verified hardware or sockets, or is it a synthetic value made to satisfy a UI or test?
7. **Offline operation.** If the WAN is down for a week, can an operator on the local subnet still query 30 days of history in under 150 ms? Which tier serves it, and does it block on anything remote?
