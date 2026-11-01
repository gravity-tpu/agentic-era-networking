# Track A: where each property is checked, enforced and tested (2026-10-31)

Track A's exit criterion is "A1 to A11 enforced in CI". This table says, for each property, the module that checks it, the point where an install is refused or a state is reported, the tests that run in CI (`npm test`, the Verify job), and what is **not** covered. It is not a second source of truth: the definitions and states are in `docs/ROADMAP.md`. `test/invariants/track-a-matrix.test.ts` fails if a file named here does not exist, so this table cannot silently rot.

| Property | Checked by | Enforced / reported at | Tests in CI | Not covered |
| :--- | :--- | :--- | :--- | :--- |
| A1 isolation | exact intent evaluation with the port-1 isolation intent (`src/sdn/intent-spec.ts`, `src/sdn/intents.ts`) | install gate when an intent is given (`src/sdn/install-gate.ts`); the bridge checks the whole table against it | `test/invariants/intent-spec.test.ts`, `test/invariants/install-gate.test.ts` | traffic outside the modelled fields |
| A2 hairpin | rule-level and wildcard-rule check (`src/sdn/install-gate.ts`) | install gate, all routes | `test/invariants/install-gate.test.ts`, `test/invariants/install-gate-routes.test.ts` | none known |
| A3 default drop | priority 0 reserved and priorities validated (`src/sdn/install-gate.ts`); the table-miss action is read back (`src/sdn/action-readback.ts`); a damped auto-repair re-sends the default DROP (`src/sdn/isolation-repair.ts`, off unless enabled) | install gate refuses; the bridge status reports `tableMiss` and `repair`; the isolation watcher pushes to a phone (`src/sdn/isolation-watch.ts`) | `test/invariants/install-gate.test.ts`, `test/invariants/isolation-repair.test.ts`, `test/invariants/isolation-repair-bridge.test.ts`, `test/invariants/isolation-watch.test.ts` | the repair is not yet validated on the switch (a supervised session is owed); presence only at the last readback; a wiped table is not auto-repaired |
| A4 quarantine precedence | `src/sdn/quarantine-precedence.ts` | install gate, allow and quarantine routes | `test/invariants/quarantine-precedence.test.ts`, `test/invariants/install-gate.test.ts` | none known |
| A5 shadowed rules | `src/sdn/rule-hygiene.ts` | install gate and the experiment path | `test/invariants/rule-hygiene.test.ts`, `test/invariants/experiment-install.test.ts` | none known |
| A6 conflicting or duplicate rules | `src/sdn/rule-hygiene.ts` | install gate and the experiment path | `test/invariants/rule-hygiene.test.ts`, `test/invariants/experiment-install.test.ts` | how the firmware breaks a tie is unmeasured |
| A7 rule budget | `src/sdn/capacity-budget.ts` | install gate and the experiment path | `test/invariants/capacity-budget.test.ts`, `test/invariants/install-gate.test.ts` | none known |
| A8 capacity | `src/sdn/capacity-budget.ts`, `src/sdn/deployed-cost-model.ts`, `src/sdn/zodiac-cost-model.ts` | install gate only when a target is declared (none is declared on the live bridge); advisory for quarantines | `test/invariants/capacity-budget.test.ts`, `test/invariants/deployed-cost-model.test.ts` | any table shape the cost models do not cover is `unverifiable`, and on 2026-10-31 that included the live 6-rule policy itself (the model expects the older 7-rule one); the target in effect was 7,900 pps until it was set to the 6,000 pps derived in the close-out plan on 2026-10-31 (advisory at startup; the policy is still unverifiable) |
| A9 layout | resolved by decision: A4 wins (see the ROADMAP decision record) | not a check | none (a decision, not a property) | |
| A10 ARP confinement | the policy builders and the ARP match fields in the intent and hygiene checks (`src/sdn/port1-isolation.ts`, `src/sdn/intent-spec.ts`, `src/sdn/rule-hygiene.ts`) | the deployed policy and the install gate | `test/invariants/uplink-arp-confinement.test.ts`, `test/invariants/rule-hygiene.test.ts` | the uplink peer list under real use; the management broadcast being dropped |
| A11 intent compliance | exact packet-class evaluation (`src/sdn/intent-spec.ts`) | install gate when an intent is given; the evaluation triage (`src/sdn/proposal-triage.ts`) | `test/invariants/intent-spec.test.ts`, `test/invariants/wire-run-dry.test.ts` | fields the model does not track (L4 ports, VLAN) |

## Related tests that apply to every refusal

- `test/invariants/install-gate.test.ts` and `test/invariants/install-gate-routes.test.ts`: the gate refuses, and the routes use it.
- `test/invariants/rejection-detail.test.ts`: every refusal names its property, a reason and the offending rules (or, for an unmet intent clause that falls to the table-miss, the clause).
- `test/invariants/gate-audit.test.ts`: a refusal is audited.
- `test/invariants/wire-run.test.ts`, `test/invariants/wire-session.test.ts` and `test/invariants/wire-run-dry.test.ts`: the on-wire measures and the safety behaviour of the conformance runner.

## What this table does not show

That a test is sufficient. It shows where each property is exercised, not that the exercise is complete: the wire results in `docs/benchmarks/results/conformance/` are the check that the model matches the switch, and they cover the flows chosen, not all traffic.
