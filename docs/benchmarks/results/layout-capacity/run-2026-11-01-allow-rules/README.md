# A8 with allow rules in the table: results (2026-11-01)

Pre-registration: [`../PREREGISTRATION-allow-rules-2026-11-01.md`](../PREREGISTRATION-allow-rules-2026-11-01.md) (with two dated amendments, both written before the run they affect).

**Result: predictions 1 and 2 fail as written; prediction 3 holds. Allow rules are not free, and what they cost does not grow with the count between 4 and 8 rules.**

## Measured

Live six-rule isolation policy (firmware 0.86), no quarantines, 572 B UDP, a frame matched by `p1-default-tap-only`, throughput target off for the window. Allow rule form: `in_port 3`, an unused source MAC (`02:00:00:00:00:NN`), output P1, installed through `/api/sdn/allow`. Capacity is the median delivered rate at the first saturated step (the harness's own definition); time per packet is `1e12 / capacity` in ps, rounded to 0.01 us.

| Placement | Allow rules | Capacity (pps) | Time per packet (us) | Change from this run's 0 (us) |
| --------- | ----------- | -------------- | -------------------- | ----------------------------- |
| below (priority 120, under the measured rule at 150) | 0 | 12,790 | 78.19 | |
| below | 4 | 11,925 | 83.86 | +5.67 |
| below | 8 | 11,927 | 83.84 | +5.65 |
| above (priority 300, above every policy rule) | 0 | 12,791 | 78.18 | |
| above | 4 | 10,991 | 90.98 | +12.80 |
| above | 8 | 10,958 | 91.26 | +13.08 |

One pass per count (the allow rules cannot be removed without a bridge restart, so the pass is ascending and the bridge was restarted between the two placements). The two 0-rule values, 12,790 and 12,791, were measured before and after a restart.

## Predictions

1. **Below: within 5% of the same run's 0-rule capacity. Fails.** 11,925 and 11,927 are 6.8% and 6.7% lower.
2. **Above: within 5% of `80.0 us + 5.42 us x j`. Fails.** The model gives 101.7 us at 4 rules and 123.4 us at 8; the measurement is 90.98 us and 91.26 us (10.5% and 26% below the model's times, so the model is pessimistic here, which is the safe direction for a gate, but it is wrong, not a pass).
3. **Capacity does not rise with the count; the 0-rule values of the two runs agree within 10%. Holds** (12,790 against 12,791; no rise).

## What this shows and what it does not

- Allow rules of this form cost something wherever they sit: about 5.7 us below the measured rule and about 13 us above it.
- Between 4 and 8 rules the cost does not move (83.86 and 83.84 us below; 90.98 and 91.26 us above). That is a step, not a slope, for those two counts. **The data cannot say where the step begins** (counts 1 to 3 were not measured) **or whether it is tied to this match form** (`in_port` plus `srcMac`, unlike the quarantine DROPs); a different match form is not covered.
- Nothing here says an allow rule that matches real traffic costs the same; these rules matched none.
- The hardware shows effects the model of 2026-10-20 does not describe (a step for the first rules of another kind, and a placement effect). Whatever the cause, the model treats any table of this kind as `unverifiable` until it is extended from these numbers.

## What the next change may claim

Per the pre-registration (predictions 1 and 2 failed), the model is refitted for the allow form from this run, not extended with the quarantine coefficient. The supportable change is narrow: the live policy, then exactly 4 or 8 inert-form allow rules at priority 120 or 300, then quarantine DROPs only if they are measured together with them (they were not: this run had no quarantines). Any other count, priority, match form or combination with quarantines stays `unverifiable`, and the gate keeps refusing it under a declared target. Those limits are a consequence of what was measured, not a preference.

## Failed attempts, kept

- `failed-attempt-1-no-delivery/`: stopped at its first step. About 1 packet per second was delivered against 2,000 sent (ratio 0.001), so its "capacity" of 1 pps means nothing. The sender's neighbor entry for 10.0.0.119 on `agentic-node-01` (`eth0`) had gone back to `FAILED` and the tap NIC was not promiscuous (the two preconditions found on 2026-10-31, not yet listed in the method). Both were set again, temporarily, for the valid runs and removed afterwards (the neighbor entry deleted, the capture stopped, promiscuity back to 0).
- `failed-attempt-2-gate-refused/`: its 0-rule step ran and measured 12,675 pps (within 2% of the 2026-10-31 value of 12,448), and then the first allow install was refused by the live gate: `in_port 2` rules reach P1, which the intent's default-deny clause forbids (A11). An offline check without the intent had admitted them. Nothing was installed. This changed the rule form (amendment 1 of the pre-registration).

## Provenance and limits

- Harness: `scripts/layout-capacity-run.py` with the allow mode and the rule form as committed with these results (SHA-256 of the file in each `provenance.json`). Bridge commit `6dd6f8e` (the Jetson's checkout reported 3 modified files in `git status`; not investigated here), bridge dist `64ee69a1…`.
- The throughput target was removed for the window (`#ZODIAC_CAPACITY_TARGET_PPS` in `/etc/zodiac/zodiac-bridge.env`) and restored afterwards; a leftover systemd drop-in that set 7,900 pps was found and removed the same day. Effective value during the earlier days was not read from the process (permission denied).
- One switch, firmware 0.86; one traffic path; one pass per count; inert rules; counts 0, 4 and 8 only; a Python paced sender; the receiver-side offset of about 1.3% seen in earlier runs is not re-measured here.
