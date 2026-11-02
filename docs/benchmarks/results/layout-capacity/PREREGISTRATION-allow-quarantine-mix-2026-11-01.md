# A8: allow rules together with quarantine DROPs: pre-registration

Written 2026-11-01, before any measurement. Results go in a `README.md` in the run's directory; this file is not edited afterwards except to add a dated line saying what was changed and why. It follows [`PREREGISTRATION-allow-rules-2026-11-01.md`](PREREGISTRATION-allow-rules-2026-11-01.md) and its [results](run-2026-11-01-allow-rules/README.md), and uses the same method, harness and rule form, with one added option in `scripts/layout-capacity-run.py` (`--allow-quarantines`, default 0, so earlier behaviour is unchanged; committed with the results).

## Why

On an allow install the gate checks A8 at the table plus the quarantine room the envelope still has, which is 8 quarantine DROPs on the live bridge (`gateInstall`: `capacityReserve` is `maxActive` minus the quarantines already in the table). The 2026-11-01 run measured allow rules with no quarantines, and the 2026-10-31 run measured quarantines with no allow rules. The mixed table the gate evaluates has not been measured, so a model extended only from the earlier runs would still refuse every allow install under a declared target. This run measures it.

## Method (fixed in advance)

- The target is off for the window only (owner edits the bridge env file and restarts; restored to 6,000 afterwards, then confirmed with the refused probe). Owner present throughout.
- Same allow-rule form as before: `in_port 3`, an unused source MAC, output P1. Same traffic path, same sender and tap capture, same preconditions: isolation `verified`, no quarantines at the start, experiment endpoints off, the sender's neighbor entry for 10.0.0.119 on `agentic-node-01` and a promiscuous tap NIC, both set for the window and removed afterwards.
- Every step holds **8 quarantine DROPs** (installed after the allow rules, through the bridge's own quarantine route, as in the 2026-10-31 run).
- **Below run:** allow rules at priority 120, counts 0, 4, 8, one ascending pass. The bridge is then restarted (this removes the allow rules).
- **Above run:** priority 300, counts 0, 4, 8.
- Stop at the first sign of session loss (the OpenFlow session dropping or the isolation status leaving `verified`); partial results are kept.

## Predictions

Notation: `t(j)` is the time per packet at j allow rules with 8 quarantines, from the capacity the harness reports (`1_000_000_000_000 // capacity` ps). The steps are the means of the 2026-11-01 measurements at 4 and 8 rules: **5,664 ns below the path, 12,941 ns above**.

1. **Quarantines alone reproduce.** `t(0)` is within 5% of the 2026-10-31 model for 8 quarantines, 123.4 us (about 8,100 pps).
2. **The costs add.** In each run, `t(4)` and `t(8)` are each within 5% of that run's own `t(0)` plus the step for the placement.
3. **Flat between 4 and 8.** `t(4)` and `t(8)` of the same run differ by at most 3%.

## What each outcome would mean

- **All three hold:** the model is extended with the allow form: the live policy, then exactly 4 or 8 allow rules of this form at priority 120 or 300, then 0 to 8 quarantine DROPs. Its time is the existing quarantine model plus the placement's step; for fewer than 8 quarantines the time at 8 is used as the bound, because adding a quarantine only increases the time (earlier prediction 2, held on 2026-10-31). The gate then admits an allow rule of that form under the target when the model says the target is met.
- **2 fails (the costs do not add):** the combination has its own numbers; the model is fitted from this run for the measured combinations only.
- **1 fails:** the setup differs from the 2026-10-31 run in a way not understood; nothing from this run goes into the model until it is.
- **3 fails:** the cost depends on the count; counts other than those measured stay unverifiable and 4 and 8 are modelled from their own measurements.
- In every case other counts, other priorities, other match forms and any other combination stay `unverifiable`, and the gate keeps refusing them under a declared target.

## Limits stated now

One switch, firmware 0.86; one traffic path (a frame matched by `p1-default-tap-only`); 572 B UDP; inert allow rules (matching no traffic); one pass per count (a j = 0 step in each run checks drift); quarantines installed after the allow rules, not before (the restart path re-sends them before the policy, a layout this run does not cover); counts 0, 4 and 8 only; the model's claim for 1 to 3 or 5 to 7 allow rules is none.
