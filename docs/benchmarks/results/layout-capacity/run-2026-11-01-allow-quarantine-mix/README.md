# A8: allow rules together with quarantine DROPs: results (2026-11-01)

Pre-registration: [`../PREREGISTRATION-allow-quarantine-mix-2026-11-01.md`](../PREREGISTRATION-allow-quarantine-mix-2026-11-01.md) (no amendments). Earlier results: [`../run-2026-11-01-allow-rules/README.md`](../run-2026-11-01-allow-rules/README.md).

**Result: below the measured rule, all three predictions hold; above it, prediction 1 holds, prediction 2 holds at 4 rules and fails at 8, and prediction 3 fails.**

## Measured

Live six-rule isolation policy (firmware 0.86), 8 quarantine DROPs in every step (installed after the allow rules), 572 B UDP, a frame matched by `p1-default-tap-only`, throughput target off for the window. Allow rule form: `in_port 3`, an unused source MAC, output P1. Time per packet is the integer division `1_000_000_000_000 // capacity` in ps, shown in whole nanoseconds (ps // 1000). The "predicted" column is the same run's 0-rule time plus the step from the 2026-11-01 run with no quarantines (5,664 ns below, 12,941 ns above); the last column is the percentage of that prediction (rounded for the prose).

| Placement | Allow rules | Capacity (pps) | Time per packet (ns) | Predicted (ns) | Deviation from the prediction |
| --------- | ----------- | -------------- | -------------------- | -------------- | ----------------------------- |
| below (priority 120) | 0 | 8,234 | 121,447 | | |
| below | 4 | 7,765 | 128,783 | 127,111 | +1.3% |
| below | 8 | 7,824 | 127,811 | 127,111 | +0.6% |
| above (priority 300) | 0 | 8,317 | 120,235 | | |
| above | 4 | 7,523 | 132,925 | 133,176 | -0.2% |
| above | 8 | 6,837 | 146,262 | 133,176 | +9.8% |

The bridge was restarted between the two runs (this removes the allow rules). One pass per count.

## Predictions

1. **Quarantines alone reproduce the 2026-10-31 model for 8 quarantines (123.4 us, within 5%). Holds** at both 0-rule steps: 121,447 ns and 120,235 ns (1.6% and 2.6% below the model).
2. **The costs add (within 5% of the same run's 0-rule time plus the placement's step). Holds below at 4 and 8 rules and above at 4 rules; fails above at 8 rules** (+9.8%).
3. **4 and 8 rules differ by at most 3%. Holds below** (0.8%, the 8-rule step is the smaller). **Fails above** (10.0%).

## What this shows and what it does not

- With no quarantines, 4 and 8 allow rules above the path cost the same (90,983 and 91,257 ns). With 8 quarantines they do not (132,925 and 146,262 ns). So above the path the allow-rule cost is **not additive with the quarantine cost** at 8 rules. The cause is not known; one pass per count cannot say whether it is a real interaction or an outlier of the 8-rule step (a repeat of that step would). Nothing here is fitted around it.
- Below the path, the allow-rule step grows slightly with quarantines present (about 7.3 us at 4 rules and 6.4 us at 8, against 5.7 us with none), within the prediction's band.
- The no-quarantine measurements and these cover **only counts 0, 4 and 8**. The measured counts are what a model may cover.

## What the model may claim from this and what it cannot yet

- A table of the live policy, exactly 4 or 8 allow rules of this form at priority 120 or 300, and 8 quarantine DROPs (the depth the gate evaluates on the live bridge) is a measured combination, with the six times above as its measurements. Other quarantine depths, counts, priorities and match forms are not measured.
- The gate adds one allow rule per request. Reaching 4 or 8 rules therefore passes through tables of 1, 2, 3, 5, 6 and 7 allow rules, none of which was measured, so a model covering only 4 and 8 would admit nothing through `/api/sdn/allow`. This is stated here before any code, because it decides whether the change is worth making: see the next measurement proposed in the pull request.

## Failed or empty attempts, kept

- `aborted-above-launch-no-capture/`: the above run was launched once without the Jetson capture holding the tap NIC promiscuous (the capture's restart command killed its own shell) and was stopped by hand two seconds after its first line, before any step; it has no results.

## Provenance and limits

- Harness: `scripts/layout-capacity-run.py` with the `--allow-quarantines` option as committed with these results (SHA-256 of the file in each `provenance.json`). Bridge commit as in `provenance.json` (the Jetson's checkout reported 3 entries in `git status` earlier today; they are untracked build leftovers and no tracked file differed from the recorded commit, checked 2026-11-01). The throughput target was removed for the window (`#ZODIAC_CAPACITY_TARGET_PPS` in `/etc/zodiac/zodiac-bridge.env`) and restored afterwards, and the refused probe showed the A8 violation again at the end.
- One switch, firmware 0.86; one traffic path; 572 B UDP; inert allow rules (matching no traffic); one pass per count; quarantines installed after the allow rules (the restart path installs them before the policy, which this run does not cover); sender and capture setup as in the 2026-10-31 run (neighbor entry and promiscuous tap NIC, set for the window and removed).
