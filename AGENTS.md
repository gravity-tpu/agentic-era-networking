# Zodiac — Repository Invariants & Guidelines

This repository (`gravity-tpu/agentic-era-networking`) is **Zodiac: a real-hardware testbed and verifier for agent-proposed SDN policy.** It measures what a cheap OpenFlow switch can actually do, checks proposed rules against that model, and tests them against a live adversary. Goals, tracks and exit criteria are in [docs/ROADMAP.md](docs/ROADMAP.md); what the project does not claim is stated there too.

Agents working in this repo propose; deterministic code decides admissibility; a person approves. Nothing here is autonomous.

---

## The 6 Invariants

These are enforced by tests, CI and the pre-push gate. Code comments refer to them by number ("Invariant 3").

1. **No suppression of errors.**
   Never bypass TypeScript errors (`// @ts-ignore`, loose `any` casts) or runtime exceptions with an empty `catch (e) {}`. Errors are handled deterministically at the protocol and state boundary. When a type error appears, fix the type; do not mask it.
2. **Integer accounting and monotonic time.**
   No floating-point arithmetic in packet accounting, byte rates, QoS budgets or SLA tracking. Counters are 64-bit integers (`BigInt`). Timestamps for intervals and durations use monotonic nanoseconds (`process.hrtime.bigint()`).
3. **Fail closed.**
   Routing, DNS filtering and flow-rule evaluation are fail-closed by construction. If a packet, rule or tenant context is ambiguous or unrecognized, it is dropped or quarantined, never forwarded.
4. **Verify before actuating.**
   Anything an agent proposes (a rule set, a policy, a query) must pass deterministic checks before it touches the data plane, and a person approves the install. Checks must be able to fail: a check that cannot reject anything (for example a loop check over a one-hop list) is not verification and must not be described as such. Say exactly what a check proves and what it does not.
   Detector-driven containment is a different case from agent-proposed policy: a person approving each event would be minutes against a detector's milliseconds. It may act without a person only inside an envelope a person approved in advance (scope, protected hosts, a cap well under the table budget, a time limit; `src/sdn/quarantine-envelope.ts`), and every such action is time-limited, audited and releasable by hand. The envelope limits the damage of a wrong or steered decision (source addresses are forgeable on the untrusted segment); it does not prove the detection correct.
5. **Configurable, bounded and damped limits.**
   No buried magic numbers for timeouts, buffers or rate limits: they are named, configurable and bounded. Where a control loop adapts a limit, it must be damped so it cannot oscillate or flap rules, and it must be exercised against real traffic before it is described as adaptive.
6. **Provenance (no simulation passed off as live).**
   *When a measure becomes a target, it ceases to be a good measure.* Agents pressured to satisfy a UI or a test suite will fabricate plausible counters and thermals. Telemetry without physical or cryptographic provenance is not shown as live. When hardware is disconnected, telemetry reports `0` rates, `null` thermals (`--°C`) and an explicit offline status. Synthetic data is allowed only in declared sandboxes carrying `source: 'cloud_snapshot'` and a visible disclaimer. Demo widgets with hardcoded numbers do not belong in live views.

---

## Latency numbers every systems and network engineer should know

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

On this project's hardware the Zodiac FX adds about 58 µs per packet plus 4.24 µs per rule (measured; see the [whitepaper](docs/benchmarks/zodiac-infrastructure-bandwidth-whitepaper-2026-10-04.md)). Never perform blocking synchronous I/O or unbounded recursion on critical packet or telemetry pathways.

---

## Network engineering principles

The packet-forwarding and infrastructure rules (control/data plane separation, fate-sharing, loop-free forwarding, flow-table budgets, queue management, flap damping) are in [.agents/rules/network-engineering-principles.md](.agents/rules/network-engineering-principles.md). The network review skill also keeps the topology and state ledger in [.agents/network-context.md](.agents/network-context.md): physical and logical topology, VLAN allocations and the 128-rule table budget.

---

## Working in this repo

- Use measured numbers. Cite the artifact in `docs/benchmarks/results/` or say the value is modelled or unmeasured.
- Prefer the simplest thing that works: a flat table or a short pure function over layers of abstraction.
- Write the failing test first for a new verifier property; negative states (link down, zero traffic, sensor fault) are tested as rigorously as positive ones.
- Do not describe unimplemented work as implemented. The roadmap and README status tables are the source of truth for state.
- AI review (`npm run review`) is a second reader, not a verifier. Model output is not evidence of correctness.
- Model and subagent calls cost real money (tracked in `/tmp/zodiac-workstation-telemetry.json`'s `edgeComputeRatioPct`, `totalCloudTokens`, `totalCacheReadTokens` — see `npm run cost:audit`).
  - **Subagents/forks**: default to one focused pass. Spawning a subagent is justified only when the work is genuinely independent of what you're already doing (so it can run in parallel without the result depending on your in-progress context) or is adversarial verification of a specific claim you want checked without your own bias. It is not justified for routine, single-step work, for "just in case" exploration, or as a substitute for reading the code yourself. A multi-step campaign (training, sweeps, multi-batch evaluation) must have an explicit stopping condition and a named decision-maker for continuing, never an open-ended "keep spawning agents until it looks good."
  - **Offline/non-interactive cloud-LLM work**: if a task does not need an answer before the next action (training-data generation, bulk evaluation, grading many samples — e.g. `scripts/agent-eval.ts --batch`, Anthropic provider, protocol A), use the provider's Batch API rather than synchronous calls. Batches cost roughly half as much per token and are the correct default for anything that already tolerates a wait; reach for synchronous calls only when a human or another step is waiting on the result immediately.

---

## Reference guides

- Engineering rulebook: [.agents/rules/determinism-and-alignment.md](.agents/rules/determinism-and-alignment.md)
- Network engineering rulebook: [.agents/rules/network-engineering-principles.md](.agents/rules/network-engineering-principles.md)
- Invariant review skill: [.agents/skills/senior-staff-overseer/SKILL.md](.agents/skills/senior-staff-overseer/SKILL.md)
- Network review and context skill: [.agents/skills/ccie-network-engineer/SKILL.md](.agents/skills/ccie-network-engineer/SKILL.md)
- Network context and state matrix: [.agents/network-context.md](.agents/network-context.md)
- Interactive review workflow: [.agents/workflows/overseer-audit.md](.agents/workflows/overseer-audit.md)
- Network context sync workflow: [.agents/workflows/network-context-sync.md](.agents/workflows/network-context-sync.md)
- Decision and audit log: [.agents/audit-log.md](.agents/audit-log.md)
