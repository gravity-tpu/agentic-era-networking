# A8 with allow rules in the table: pre-registration

Written 2026-11-01, before any measurement, and committed before the run. Results go in a `README.md` in the run's directory; this file is not edited afterwards except to add a line saying what was changed and why. Method and harness are those of [`PREREGISTRATION-live-policy-2026-10-31.md`](PREREGISTRATION-live-policy-2026-10-31.md), with the allow-rule mode added to `scripts/layout-capacity-run.py` (`--allow-js`, `--allow-priority`; the default behaviour is unchanged).

## Why

With a throughput target declared (6,000 pps), the install gate refuses every `/api/sdn/allow` install on the live bridge, because the cost model covers only the live policy followed by quarantine DROPs. A live probe on 2026-11-01 showed this (A8 refusal naming both shapes). The model says nothing about allow rules, so the gate cannot tell a harmless one from a costly one. This run measures what an allow rule costs, so that the model can cover a stated form of allow rule and the gate can admit it under the target.

## Method (fixed in advance)

- The target is dropped for the measurement window only (owner edits the bridge env file and restarts; restored to 6,000 and restarted afterwards). Without a target, A8 is a note and the allow route admits rules that pass A2 to A7 and A11.
- Every allow rule has the same form: `in_port 2`, a source MAC that never appears on the wire (`02:00:00:00:00:NN`), output P1, so it adds a lookup entry and carries no traffic. The form is admitted by the gate offline (checked 2026-11-01 with `admitInstall`: below and above placements both admit).
- Quarantines: none (k = 0).
- **Below run:** allow rules at priority 10, under the measured rule (`p1-default-tap-only`, 150), counts 0, 4, 8, one ascending pass.
- The bridge is restarted (the session restart removes allow rules and re-sends the policy), readback must say 6/6 verified with no allow rules.
- **Above run:** allow rules at priority 300, above every policy rule, counts 4, 8 (j = 0 is the same table as the below run's j = 0 and is not repeated).
- Preconditions as for the 2026-10-31 run: isolation `verified`, table-miss dropping, no active quarantines, experiment endpoints disabled. Owner present throughout. Stop at the first sign of session loss (the OpenFlow session dropping or the isolation status leaving `verified`); the partial result is kept.
- The measured traffic path is the same as before (frames matched by `p1-default-tap-only`), so what is measured is the cost of table entries on the lookup of that path, not of the allow rules' own traffic.

## Predictions

Baseline: the 2026-10-31 run measured 12,448 pps at k = 0 (80.0 us per packet by the model).

1. **Below:** at j = 4 and j = 8 capacity is within **5%** of the same run's j = 0 capacity. (Hypothesis: entries below the matched rule add no cost; this is the one most likely to be wrong.)
2. **Above:** per-packet time at j = 4 and j = 8 is within **5%** of `80.0 us + 5.42 us x j` (101.7 us and 123.4 us; about 9,830 and 8,100 pps).
3. Capacity does not rise with j in either run, and rounds at the same j differ by at most 10% (one pass per j here, so the check is j = 0 in the above run against j = 0 in the below run).

## What each outcome would mean

- **1 and 2 hold:** the model is extended with a measured allow-rule form: policy, then up to 8 allow rules of this form, then quarantine DROPs; below-path rules cost nothing and above-path rules cost the quarantine coefficient. The gate then admits an allow rule of this form under the target when the model says the target is met, and keeps refusing anything else as unverifiable. Code change made afterwards, with tests, on this evidence.
- **1 fails (below rules cost something):** the cost depends on the count of entries, not their position; the model is refitted for the allow form from this run.
- **2 fails:** above-path allow rules have their own coefficient; refitted from this run, and the 6,000 pps target is rechecked against it.
- **3 fails:** the method is too noisy to say anything; repeat before concluding.
- In every case the gate keeps treating other forms (other match fields, output to more than one port, other priorities relative to the policy, more than 8 rules) as unverifiable.

## Limits stated now

One switch, firmware 0.86; one traffic path; 572 B UDP; inert rules (an allow rule that matches real traffic changes which rule that traffic hits and is not covered); the allow rules' match field is `in_port` plus `srcMac`, a different match shape from the in_port-only rules of the 2026-10-04 benchmark; counts to 8 only; a Python pacer on the sender. Allow rules are removed only by a bridge restart, so the two placements need a restart between them.

_Added 2026-11-01, after the first attempt and before the valid run: the form of allow rule was wrong. The live gate also checks the isolation intent (A11) and A5, which my offline check had left out, and refused `in_port 2` rules (A11: they reach P1, which the default-deny clause does not permit) and any in_port 1 or 3 rule below the rule that already matches that port (A5: it never wins). The rule form is now `in_port 3`, an unused source MAC (`02:00:00:00:00:NN`), output P1, at priority **120** for the below run (between `p3-tap-return`, 100, and the measured rule `p1-default-tap-only`, 150) and **300** for the above run; both admit offline against the real intent. Predictions, counts and the rest of the method are unchanged. The first ladder attempt that ran (j = 0 only, 12,675 pps, within 2% of the 2026-10-31 k = 0 value) is kept with the results, along with a run stopped at its first step because the sender's neighbor entry and the tap NIC's promiscuous mode were no longer set (about 1 packet per second delivered): both are preconditions of this method and are now stated here._

_Added 2026-11-01, after the below run and before the above run: the above run uses counts 0, 4 and 8, not 4 and 8. The below run showed 12,790 pps at j = 0 and 11,925 and 11,927 pps at j = 4 and 8 (6.8% and 6.7% lower; prediction 1 as written fails), and with one pass per count a step cannot be told from drift between steps; a j = 0 measurement after the restart checks that. Predictions 2 and 3 are unchanged, and prediction 3 now has a direct test: the j = 0 values of the two runs._
