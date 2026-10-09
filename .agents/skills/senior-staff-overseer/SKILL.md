---
name: senior-staff-overseer
description: "Invariant review skill for networking determinism, verification, simplicity and provenance. Walks a design or diff through the repository invariants and a five-gate review; use for architecture reviews, invariant audits and pre-merge checks."
metadata:
  category: architecture-review
  triggers:
    - overseer
    - determinism
    - bounce ideas
    - invariant audit
    - architecture review
    - networking review
---

# Invariant Review

**Role:** a rigorous reviewer applying the repository invariants in [AGENTS.md](../../../AGENTS.md) and the long-form rules in [determinism-and-alignment.md](../../rules/determinism-and-alignment.md). It is a second reader: findings are hypotheses to check against the code, not proofs, and it says when it is unsure.

---

## When to invoke

- Designing a new networking component, DNS handler, flow-rule checker or telemetry state machine.
- Suspecting non-determinism, races, floating-point drift or packet loss in state transitions.
- A suggested solution looks overly complex, relies on buried magic numbers, suppresses errors (`// @ts-ignore`, loose casts, empty `catch`) or claims verification that the code does not perform.
- A pre-merge invariant audit of a diff.

---

## What it checks

1. **Verification (invariant 4).** What deterministic check would reject a bad version of this, and can it actually fail? What does it not prove? A plan that does not say how a regression would be detected is incomplete. Vacuous checks (that cannot reject their input) are findings.
2. **Simplicity.** Can a flat table or a short pure function replace layers of classes and wrappers? Edge cases should disappear by construction, not through nested patches.
3. **Failure and latency.** What is the latency budget per packet (memory ~100 ns, line rate ~1 µs, LAN ~500 µs, WAN ~100 ms, LLM ~1 s; Zodiac FX ~58 µs + 4.24 µs per rule)? What is the degraded state when a peer is partitioned? Does it survive 10x load without unbounded memory growth?
4. **Stability (invariant 5).** If it runs twice or alongside another writer, does it converge or flap? Are limits named, configurable and bounded, and damped where they adapt?
5. **Provenance (invariant 6).** Do counters and statuses come from verified hardware or sockets? Disconnected links must report `0` rates, `null` thermals and an explicit `disconnected` status; sandbox data must carry `source: 'cloud_snapshot'` and a visible disclaimer. Hardcoded numbers in live views are findings.

---

## The five-gate dialectic

1. **Problem definition.** What exact network or state problem is being solved? Define protocol boundaries and schemas; strip buzzwords.
2. **Invariant specification.** What must hold always: monotonic non-decreasing 64-bit counters, default-drop for unmatched traffic, no hairpin or isolation leak, no telemetry without provenance.
3. **Failure and adversarial stress.** A 500 ms link flap; 10,000 malformed DNS packets; two writers issuing conflicting flow updates at once.
4. **Simplicity prune.** Can half the state variables or layers be removed?
5. **Deterministic proof harness.** Which automated tests prove it: unit tests on pure logic, property checks on rule sets, negative link-down tests, no mock-the-mock assertions.

---

## Commands

- `npm run check-types`: zero-defect TypeScript verification.
- `npm test`: invariant and behavior suite.
- `npm run check:provenance`: scan for untagged mocks and artificial counters.
- `npm run review`: multi-model AI review (a second reader, not a verifier).
- `npm run setup-hooks`: install the pre-commit and pre-push gates (once per machine).
