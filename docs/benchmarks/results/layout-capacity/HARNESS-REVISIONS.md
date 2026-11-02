# Which harness revision produced which stored run

Each run's `provenance.json` records the SHA-256 of `scripts/layout-capacity-run.py` as it was when the run started (`harnessSha256`). This table maps those hashes to the commit that holds that exact file, so a stored run can be tied to the code that produced it after the harness changes. Short hashes are the first 16 hex digits. `test/invariants/layout-capacity-harness-revisions.test.ts` fails if a stored run records a harness hash that is not listed here; add the row in the same change as the run.

| Harness SHA-256 (first 16) | Commit with that file | Runs recorded with it |
| -------------------------- | --------------------- | --------------------- |
| `14b466308d2b65d8` | `4aaff4b` (2026-10-20) | `run-2026-10-20` |
| `5850297cddeff25d` | `73f22cf` (2026-10-21) | `run-2026-10-31-live-policy`, `run-2026-10-31-live-policy-failed-attempt-1` |
| `d7bc16b7c940b0ac` | `a2dc68f` (2026-11-01) | `run-2026-11-01-allow-rules/failed-attempt-1-no-delivery`, `run-2026-11-01-allow-rules/failed-attempt-2-gate-refused` |
| `0629a08e8b9d1e08` | `124f884` (2026-11-01) | `run-2026-11-01-allow-rules/below`, `run-2026-11-01-allow-rules/above` |
| `f0162523cf55648f` | `e27c2d5` (2026-11-01) | `run-2026-11-01-allow-sweep/sweep`, `run-2026-11-01-allow-quarantine-mix/below`, `run-2026-11-01-allow-quarantine-mix/above`, `run-2026-11-01-allow-quarantine-mix/aborted-above-launch-no-capture` |
| `34725152e5eccd30` | the commit that added this row | none yet. The only change from the revision above: `idlePps` is recorded as an integer (`round(idle)`, not `round(idle, 2)`) |

Other values the harness records are derived display figures and are unchanged: the delivered-to-sent `ratio` (a dimensionless fraction compared with the saturation threshold, 0.97), and the printed `idle:.1f` log line.
