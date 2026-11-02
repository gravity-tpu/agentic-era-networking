# A8: every allow-rule count from 0 to 8 below the measured rule: pre-registration

Written 2026-11-01, before any measurement. Results go in a `README.md` in the run's directory; this file is not edited afterwards except to add a dated line saying what was changed and why. It follows [`PREREGISTRATION-allow-quarantine-mix-2026-11-01.md`](PREREGISTRATION-allow-quarantine-mix-2026-11-01.md) and its [results](run-2026-11-01-allow-quarantine-mix/README.md), and uses the same method, harness and rule form; the harness needs no new option (`--allow-js 0,1,2,3,4,5,6,7,8 --allow-priority 120 --allow-quarantines 8`).

## Why

The gate adds one allow rule per request. To reach 4 or 8 allow rules, an install passes through tables of 1, 2, 3, 5, 6 and 7 allow rules, so the model has to cover every count in between or an allow rule can never be admitted under a declared target. So far 0, 4 and 8 have been measured. This run measures all nine counts below the measured rule (priority 120) with 8 quarantine DROPs, the depth the gate evaluates on the live bridge. Allow rules above the measured rule (priority 300) are not part of this run: they did not behave additively at 8 rules and stay unverifiable.

## Method (fixed in advance)

- Target off for the window only (owner edits the env file and restarts; restored afterwards and confirmed with the refused probe). Owner present throughout. Same preconditions and setup as the earlier runs (isolation `verified`, no quarantines at the start, experiment endpoints off, the sender's neighbor entry and a promiscuous tap NIC set for the window and removed afterwards).
- One ascending pass: allow rules at priority 120, counts 0 to 8, cumulative (they cannot be removed without a bridge restart), with 8 quarantine DROPs in every step, installed after the allow rules.
- Stop at the first sign of session loss; partial results are kept.

## Predictions

Notation: `t(j)` is the time per packet at j allow rules with 8 quarantines (`1_000_000_000_000 // capacity` ps, shown in ns). The step is the mean of the two earlier mixed measurements below the path, `(7,336 + 6,364) / 2 = 6,850` ns.

1. **The setup reproduces.** `t(0)` is within 5% of 121,447 ns (the earlier run's 0-rule time).
2. **The step is the same for every count.** For each j from 1 to 8, `t(j)` is within 5% of this run's `t(0) + 6,850`.
3. **Capacity does not rise with the count beyond noise.** `t(j+1)` is not more than 2% below `t(j)` for any j from 1 to 7.

## What each outcome would mean

- **All hold:** the model covers allow-rule counts 1 to 8 below the path with 8 quarantines, with each count's own measured time (the measurement, not the prediction, is what makes a count covered); the gate can then admit one allow rule at a time up to 8 under the target when the model says it is met.
- **2 or 3 fails for some counts:** those counts are still covered by their own measurements if the measurements are repeatable; the model table holds measured times only, and a count with a suspect measurement is left unverifiable until repeated.
- **1 fails:** the setup differs from the earlier runs in a way not understood; nothing from this run goes into the model until it is.
- In every case other quarantine depths, counts above 8, other priorities, other match forms and the above-path placement stay `unverifiable`, and the gate keeps refusing them under a declared target.

## Limits stated now

One switch, firmware 0.86; one traffic path; 572 B UDP; inert allow rules (matching no traffic); one pass per count; quarantines installed after the allow rules (the restart path installs them before the policy, which this run does not cover); only the depth of 8 quarantines, so a table with a different number of quarantines in the table plus the room the envelope still has is not covered.
