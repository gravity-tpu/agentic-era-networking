# Deterministic baselines for the agent-proposal evaluation (INTENT-1)

`scripts/eval-baselines.ts` passes the reference policy (`buildPort1IsolationPolicy`) and its single-point mutations
(`src/sdn/rule-mutations.ts`) through the same triage the model proposals go through. `summary.json` has the counts.

- **Reference policy:** 6 rules, admissible under `port1-isolation/v1`. The runner refuses to continue if it is not.
- **Mutants:** 40, of which the triage rejects **29** and accepts 11.

| Operator | Mutants | Rejected | Accepted |
| :--- | ---: | ---: | ---: |
| drop-rule | 6 | 4 | 2 |
| widen-prefix | 3 | 3 | 0 |
| remove-match-field | 13 | 13 | 0 |
| add-output | 4 | 4 | 0 |
| remove-output | 8 | 4 | 4 |
| raise-priority | 6 | 1 | 5 |

Rejected by primary category: `ERR_INTENT_LEAK` 12, `ERR_INTENT_MISSING` 8, `ERR_AMBIGUITY` 4, `ERR_SHADOWED` 3, `ERR_PREREQUISITE` 2.

## The 11 accepted mutants

I read each one against the intent; this is a reading, not a machine proof of equivalence.

- 4 remove the tap output (P3) from a rule, or drop the tap-only and tap-return rules: the intent lets traffic reach P3
  (`mayReach`) but never requires it (`mustReach`), so a missing tap copy is permitted.
- 2 drop `p1-default-tap-only` and `p3-tap-return`: the table-miss drop gives the same permitted behaviour.
- 5 raise the priority of a rule that overlaps no other rule it could newly shadow (each is already the highest in its
  overlap set, or matches a different ingress port).

So all 11 look like mutants that the intent allows. The consequence is about the intent, not the checker: INTENT-1 does not
require the tap copy, so the checks cannot call its loss a fault. If the tap copy matters, the intent needs a `mustReach`
for it. Until then, 29 of 40 is a lower bound on what the checks can catch, and "all 29 non-equivalent mutants caught" is
a claim this file supports only through that reading.

## INTENT-2 to 4 (2026-10-19)

The same procedure for the other three intents, each with its own hand-written reference policy
(`src/sdn/intent-references.ts`); files in `dns-confinement_v1/`, `quarantine-precedence_v1/` and `tap-return-isolation_v1/`.
Every reference is admissible under its intent. `test/invariants/eval-baselines.test.ts` regenerates all four files and compares them.

| Intent | Mutants | Rejected | Accepted |
| :--- | ---: | ---: | ---: |
| `port1-isolation/v1` (INTENT-1) | 40 | 29 | 11 |
| `dns-confinement/v1` (INTENT-2) | 42 | 31 | 11 |
| `quarantine-precedence/v1` (INTENT-3) | 56 | 45 | 11 |
| `tap-return-isolation/v1` (INTENT-4) | 40 | 35 | 5 |

- **INTENT-4 confirms the tap gap named above.** It requires the tap copy and the return path that INTENT-1 only permits, and
  it rejects 35 of 40 mutants against 29 of 40. The 5 it accepts are all `raise-priority` mutants of rules that overlap nothing they
  could newly shadow (same reading as before: by hand, not a proof).
- **INTENT-2 and INTENT-3 inherit INTENT-1's permissive tap clauses**, so they accept the same kind of mutant (a lost tap copy or
  tap return). INTENT-3's accepted list also includes raising the priority of the two quarantine rules, which are already the
  highest-priority rules, so those cannot change behaviour.
- **INTENT-2 is weaker than the plan's text.** The match model has no layer-4 fields, so "UDP port 53 only" cannot be written or
  checked; the intent confines the workload to the resolver host `10.0.2.1`. It does not prove that only DNS reaches that host.
- **INTENT-3 does not cover ARP from the quarantined host**: ARP carries no IPv4 source in the match model, so it is still permitted.
- The reference for INTENT-4 is the same six rules as INTENT-1's: only the intent differs.

Model results against these baselines: [`../README.md`](../README.md).
