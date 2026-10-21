# Hardware confirmation of the A4 versus A9 decision: pre-registration

Written 2026-10-20, before any measurement was taken, and committed before the run. The results (when they exist) are in `README.md` next to this file; this file is not edited afterwards except to add a line saying what was changed and why.

## The claim under test

`docs/ROADMAP.md` (Track A, "Decision record, A4 versus A9") says: with quarantine DROPs placed above all forwarding rules, each active quarantine costs about **4.24 µs per packet** on top of the forwarding cost, taken from the fitted base-layout model (`src/sdn/zodiac-cost-model.ts`). That model was fitted on two in_port-only forwarding rules plus /32 DROPs, not on the deployed six-rule policy. This run measures the deployed policy.

## Method (fixed in advance; see `scripts/layout-capacity-run.py` for the code)

- Layout: the **deployed** isolation policy (six rules) with k quarantine DROPs installed above it through the bridge's own quarantine path (propose, then approve), k = 0, 2, 4 and 8, on unused workload addresses. This is the A4 layout by construction.
- Traffic: 572-byte UDP from node-01 (10.0.2.50) to 10.0.0.119, paced; under the deployed policy it is matched by `p1-default-tap-only` and sent to P3 only.
- Observation: packets per second the switch delivers on the P3 link, read as the receive counter of the Jetson NIC on that link, sampled every 0.1 s and corrected for the idle rate measured just before each ramp.
- Ramp: offered rate from 2,000 pps in steps of x1.2. It **stops at the first step whose delivered/sent ratio is below 0.97**, so the offered rate never exceeds 1.2x the capacity (the 2026-10-04 ladder lost the OpenFlow session at 1.3 to 2.3x and survived 1.25x). Hard ceiling 16,000 pps. It also stops if the bridge's isolation status stops verifying.
- Capacity: the median of the 1 s delivered rates inside the saturated step. Two rounds per k, the second round in reverse order of k.

## Predictions

1. Per-packet time t(k) = 1 / capacity(k) rises **linearly** in k. A least-squares line through the per-k means has a slope of **4.24 µs per quarantine, accepted within ±20% (3.4 to 5.1 µs)**.
2. Capacity falls monotonically with k.
3. I make **no prediction for the intercept** (the deployed layout's fixed cost): that is the unmeasured part.

## What would count against the decision

- A slope outside 3.4 to 5.1 µs per quarantine. A much smaller slope would mean the deployed layout is cheaper than modelled (the decision is conservative, not wrong); a much larger one would mean the model understates the cost of quarantine-first on the deployed policy and the cap should be lowered.
- Capacity not monotonic in k, or a round-to-round difference at the same k larger than 10%, which would mean this method is too noisy to say anything.

## Limits stated now

One switch, firmware 0.86; one traffic path (a frame matched by the tap-only rule at priority 150, after the four priority-200 rules); UDP only; a Python paced sender (the run records whether it reached each target). The forwarding-first layout is **not** measured here (the quarantine path cannot build it, because A4 forbids it): the "24% less capacity than forwarding-first" figure in the decision record stays model-derived from the 2026-10-04 ladder. Switch CPU is not measured.
