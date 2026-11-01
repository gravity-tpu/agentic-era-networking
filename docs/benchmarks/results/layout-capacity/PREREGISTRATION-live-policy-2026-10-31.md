# A8 re-measurement on the live policy: pre-registration

Written 2026-10-31, before any measurement, and committed before the run. The results will be in a `README.md` in the run's directory; this file is not edited afterwards except to add a line saying what was changed and why. Method and harness are those of [`PREREGISTRATION.md`](PREREGISTRATION.md) (2026-10-20); read that first.

## Why

The deployed cost model (`src/sdn/deployed-cost-model.ts`: `t = 80.0 us + 5.42 us x k`, 572 B) was fitted on 2026-10-20 on a table of **six** rules: the isolation policy as it was then (one P1 ARP rule, one P2 ARP rule), with k quarantine DROPs above it. Two things changed since: the policy gained ARP-by-sender-address rules (A10, 2026-10-25), and the uplink ARP peer list was set to `none` (2026-10-27), which removes the P2 ARP rule. The model's shape check compares a table with `buildPort1IsolationPolicy()`'s default, which is now a **seven**-rule policy that includes an open P2 ARP rule. So the model accepts a table that was never measured and rejects the live one (six rules: `p1-ipv4-intra-segment`, `p1-arp-allow-10.0.2.50`, `p1-arp-allow-10.0.2.52`, `p2-ipv4-to-segment`, `p1-default-tap-only`, `p3-tap-return`), which the bridge's startup log reports as `A8 ... unverifiable`. The claim to test is that the model's coefficients still describe the live table.

## Method (fixed in advance)

Exactly `scripts/layout-capacity-run.py` as it is on `main` when the run starts (with its confirmation re-probe of a step that falls below the saturation ratio), `--ks 0,2,4,8 --rounds 2`, unchanged: k quarantine DROPs installed through the bridge's own quarantine path on the unused workload addresses 10.0.2.101 to 10.0.2.116; 572-byte UDP from `agentic-node-01` (10.0.2.50, `eth0`) to 10.0.0.119, matched by `p1-default-tap-only` and sent to P3; delivered rate read on the Jetson NIC on the P3 link (O2); ramp from 2,000 pps in steps of x1.2, stopping at the first step whose delivered/sent ratio is below 0.97, never above 16,000 pps, and stopping if the bridge's isolation status stops verifying. Two rounds per k, the second in reverse order.

Preconditions, checked and recorded before the run: the isolation status reads `verified` with the live six rules and the table-miss dropping; no active quarantines; the quarantine envelope allows at least 8; the experiment endpoints are disabled (this run does not use them); the NETGEAR VLANs are restored; the owner is present and can interrupt. The rule order and the bridge's configuration are recorded from the readback in the run's `provenance.json`.

## Predictions

1. The per-packet time at each k is within **5%** of the model: k = 0: 80.0 us (76.0 to 84.0), k = 2: 90.8 us (86.3 to 95.4), k = 4: 101.7 us (96.6 to 106.8), k = 8: 123.4 us (117.2 to 129.5). (The model's own tolerance is 2%; the live table differs in rule contents, so 5% is allowed.)
2. Capacity falls monotonically with k.
3. The round-to-round difference at the same k is at most 10%.

## What each outcome would mean

- **All three hold:** the model's coefficients are good for the live table on this path. The shape check may then be changed to recognise the live table explicitly (with a test), keeping the coefficients; this is a code change, made afterwards, on this evidence.
- **Prediction 1 fails:** the live table has its own coefficients; the model is refitted on this run for the live shape only, the old shape stays as measured, and the 6,000 pps target is re-derived from the new numbers.
- **Prediction 2 or 3 fails:** the method is too noisy on this table to say anything, and the run is repeated before any conclusion.
- In every case the gate keeps treating a table the model does not cover as `unverifiable`; nothing here widens what a pass claims beyond the path measured.

## Limits stated now

One switch, firmware 0.86; **one traffic path**: a frame matched by `p1-default-tap-only` at priority 150, after the four priority-200 rules (frames matched by other rules, for example intra-segment IPv4 to P2 and P3, are not measured); UDP only; a Python paced sender; quarantines installed after the policy (the restart path re-sends them before it, a layout this does not cover); switch CPU not read.
