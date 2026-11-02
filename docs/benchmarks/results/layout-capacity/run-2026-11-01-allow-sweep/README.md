# A8: every allow-rule count from 0 to 8 below the measured rule: results (2026-11-01)

Pre-registration: [`../PREREGISTRATION-allow-sweep-2026-11-01.md`](../PREREGISTRATION-allow-sweep-2026-11-01.md) (no amendments). Earlier results: [no quarantines](../run-2026-11-01-allow-rules/README.md) and [with 8 quarantines, counts 0, 4, 8](../run-2026-11-01-allow-quarantine-mix/README.md).

**Result: prediction 1 holds; predictions 2 and 3 fail. The additive step per allow rule does not show up consistently, and the run-to-run spread of the same table is as large as the step. What the data supports is a floor on capacity, not a per-count cost.**

## Measured

Live six-rule isolation policy (firmware 0.86), allow rules at priority 120 (below the measured rule), form `in_port 3` plus an unused source MAC, output P1, 8 quarantine DROPs in every step, 572 B UDP, a frame matched by `p1-default-tap-only`, throughput target off for the window, one ascending pass. Time per packet is `1_000_000_000_000 // capacity` in ps, shown in whole nanoseconds (ps // 1000). The prediction is this run's 0-rule time plus 6,850 ns (the mean of the earlier mixed steps, 7,336 and 6,364 ns).

| Allow rules | Capacity (pps) | Time per packet (ns) | Predicted (ns) | Deviation from the prediction | Change from the previous count |
| ----------- | -------------- | -------------------- | -------------- | ----------------------------- | ------------------------------ |
| 0 | 8,234 | 121,447 | | | |
| 1 | 8,012 | 124,812 | 128,297 | -2.7% | +2.8% |
| 2 | 7,928 | 126,135 | 128,297 | -1.7% | +1.1% |
| 3 | 8,317 | 120,235 | 128,297 | -6.3% | -4.7% |
| 4 | 8,013 | 124,797 | 128,297 | -2.7% | +3.8% |
| 5 | 8,235 | 121,432 | 128,297 | -5.4% | -2.7% |
| 6 | 8,325 | 120,120 | 128,297 | -6.4% | -1.1% |
| 7 | 8,012 | 124,812 | 128,297 | -2.7% | +3.9% |
| 8 | 8,292 | 120,598 | 128,297 | -6.0% | -3.4% |

## Predictions

1. **The setup reproduces (0-rule time within 5% of 121,447 ns). Holds**, exactly: 8,234 pps in both runs.
2. **Every count within 5% of the 0-rule time plus 6,850 ns. Fails at counts 3, 5, 6 and 8** (4 of 8). Every count came in below the prediction, so the prediction was pessimistic everywhere.
3. **Each count is not more than 2% faster than the one before. Fails at counts 3, 5 and 8.**

## What this shows and what it does not

- The capacities of the nine counts lie between 7,928 and 8,325 pps with no trend by count. Counts 3, 5, 6 and 8 cost about as much as having no allow rule at all.
- **The same table does not repeat across runs.** 8 rules measured 7,824 pps in the mix run and 8,292 pps here (6% apart); 4 rules measured 7,765 and 8,013 pps (3% apart). The spread between runs is as large as the step the predictions tried to model (about 5%), so a per-count cost cannot be resolved by one pass per count. Repeating each count several times would be the way to resolve a real step; this run does not claim there is none, only that it is not seen above the noise.
- What the measurements do support, pooled with the two mix-run measurements of the same table with 8 quarantines below the path (counts 4 and 8): **across all 10 measurements of 1 to 8 allow rules, capacity was never below 7,765 pps, and it was at most 8,325 pps.** That is a floor over the measurements made, in the measured form (`in_port 3` plus an unused source MAC, output P1, priority 120), at the depth the gate evaluates (8 quarantine DROPs), for a frame matched by `p1-default-tap-only`. It is not a model of cost per rule and says nothing about counts above 8, other priorities, other match forms, rules that match real traffic or other quarantine depths.
- With the model's 2% tolerance the floor is 7,610 pps, about 27% above the 6,000 pps target. A floor like this can support admitting that measured form under the target; its weakness is the sample (10 points; counts 4 and 8 twice, the others once), which is why it is stated as a floor over measurements and not as a guarantee.

## Provenance and limits

- Harness: `scripts/layout-capacity-run.py` with `--allow-js 0,1,2,3,4,5,6,7,8 --allow-priority 120 --allow-quarantines 8` (SHA-256 of the file in `provenance.json`). The throughput target was removed for the window (`#ZODIAC_CAPACITY_TARGET_PPS` in `/etc/zodiac/zodiac-bridge.env`) and restored afterwards; the refused probe showed the A8 violation again at the end. The Jetson's checkout reported 3 entries in `git status` earlier today; they are untracked build leftovers (`dist-new/`, `dist-prev-a10/`, one built asset) and no tracked file differed from the recorded commit (checked 2026-11-01).
- One switch, firmware 0.86; one traffic path; 572 B UDP; inert allow rules (matching no traffic); one pass per count; quarantines installed after the allow rules (the restart path installs them before the policy, which this run does not cover); sender and capture setup as in the earlier runs (neighbor entry and promiscuous tap NIC, set for the window and removed).
