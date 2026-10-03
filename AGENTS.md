# Zodiac — Repository Invariants & Guidelines

This repository (`gravity-tpu/agentic-era-networking`) (Zodiac) designs autonomous, verifiable networking infrastructure for the agentic era: telemetry/monitoring, DNS resolution, and Software Defined Networking (SDN).

---

## The Technical Staff Council: Determinism & Alignment Invariants

**Governing Minds & Perspectives:**

1. **Jeff Dean**: Systems Scale, Nanosecond-to-WAN Latency Budgets, Hardware Co-Design & Graceful Degradation.
2. **Sanjay Ghemawat**: Radical Simplicity, Invariant Rigor, Cache-Friendly Flat Layouts & Zero-Bloat Abstractions.
3. **Quoc Le**: Neural Architecture Search, Adaptive Self-Tuning Control Loops & Robustness Under Distribution Shift.
4. **Oriol Vinyals**: Graph Representation Routing (Pointer Networks), Multi-Agent Game-Theoretic Convergence & Flap Prevention.
5. **Demis Hassabis**: Verification Asymmetry, Hybrid Neuro-Symbolic Verification (AlphaProof Paradigm) & Formal State Bounds.

---

## The 6 Inviolable Council Invariants

1. **Zero Suppression of Reality (Anti-Shortcut Law)**:
   Never bypass TypeScript errors (`// @ts-ignore`, loose `any` casts) or runtime exceptions with empty `catch (e) {}`. All errors must be handled deterministically at the protocol and state boundary.
2. **Determinism in Telemetry, Metering & Routing (Dean & Ghemawat)**:
   Banish floating-point arithmetic from packet accounting, byte rate calculations, QoS budgets, and SLA tracking. All counters must use 64-bit integer units (`BigInt`). Timestamps must use monotonic nanosecond precision (`process.hrtime.bigint()`).
3. **Fail-Closed Isolation & Default-Drop (Ghemawat & Hassabis)**:
   Routing, DNS filtering, and SDN flow rule evaluation must be fail-closed by construction. If a packet, rule, or tenant context is ambiguous or unrecognized, it must be dropped or quarantined, never forwarded.
4. **Verification Asymmetry & Symbolic Proof (Hassabis & Vinyals)**:
   In the agentic era, probabilistic synthesis of routing tables or telemetry queries by agents is cheap; verification must be programmatic, formal, and deterministic. Every agent-proposed route must pass a symbolic loop-free verifier before touching the data plane.
5. **Adaptive Control & Multi-Agent Stability (Quoc Le & Oriol Vinyals)**:
   Eliminate brittle hardcoded heuristic magic numbers. Dynamic buffer and rate limits must adapt to traffic distributions without causing multi-agent route flapping or oscillation.
6. **Goodhart's Law & Epistemic Telemetry Provenance (Anti-Simulation Law)**:
   *"When a measure becomes a target, it ceases to be a good measure."* In the agentic era, agents pressured to satisfy UI targets or test suites will fabricate plausible BigInt counters, fake CPU thermals, and simulated waves. Telemetry without verifiable physical or cryptographic provenance is fiction. When hardware is disconnected or unlinked, telemetry MUST evaluate to physical truth: `0` rates, `null` thermals (`--°C`), and explicit offline status. Synthetic digital twins are permitted ONLY in declared sandboxes carrying unambiguous provenance metadata (`source: 'cloud_snapshot'`) and prominent disclaimer banners. Never allow synthetic data to masquerade as live silicon.

---

## Latency Numbers Every Systems & Network Engineer Must Know (The Dean Invariant)

```text
L1 cache reference:                    0.5 ns
Branch mispredict:                     5   ns
L2 cache reference:                    7   ns
Mutex lock/unlock:                    25   ns
Main memory reference:               100   ns
Compress 1K bytes with Zstandard:  2,000   ns  (2 µs)
Send 1K bytes over 10 Gbps network: 1,000   ns  (1 µs)
Read 4K randomly from SSD:        16,000   ns (16 µs)
Datacenter roundtrip (LAN):      500,000   ns (0.5 ms)
WAN Roundtrip (cross-continent): 150,000,000 ns (150 ms)
LLM Time-To-First-Token (TTFT):  500,000,000–2,000,000,000 ns (0.5–2 s)
```

Never perform blocking synchronous I/O or unbounded recursion on critical packet or telemetry pathways.

---

## Reference Guides

- Invariant Rulebook: [.agents/rules/determinism-and-alignment.md](file:///Users/andymorven/git/agentic-era-networking/.agents/rules/determinism-and-alignment.md)
- Senior Staff Overseer Skill: [.agents/skills/senior-staff-overseer/SKILL.md](file:///Users/andymorven/git/agentic-era-networking/.agents/skills/senior-staff-overseer/SKILL.md)
- Interactive Review Dialectic: [.agents/workflows/overseer-audit.md](file:///Users/andymorven/git/agentic-era-networking/.agents/workflows/overseer-audit.md)
- Institutional Memory Audit Log: [.agents/audit-log.md](file:///Users/andymorven/git/agentic-era-networking/.agents/audit-log.md)
