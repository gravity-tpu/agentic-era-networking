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

Model results against these baselines: [`../README.md`](../README.md).
