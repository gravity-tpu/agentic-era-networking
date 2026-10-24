# CIC-IDS2017-augmented margin training: results

Method, split, sample caps and the improvement rule were fixed in
[`PREREGISTRATION.md`](PREREGISTRATION.md) before any number below was looked at. Raw artifacts:
[`trained-weights-margin-cic-2026-10-23.json`](trained-weights-margin-cic-2026-10-23.json) (the fitted weights and
calibrated `tau`), [`training-output-margin-cic-2026-10-23.txt`](training-output-margin-cic-2026-10-23.txt) (the full
run log this document is drawn from).

## Headline: a real recall gain on CIC's own held-out floods, bought at the cost of broad false-positive sensitivity — not a clean win

This round's CIC-augmented weights catch far more of CIC's own held-out flood traffic than baseline, PR #105, or
PR #106 ever did (a measured recall gain, not a rounding effect — see axis (b) below), and improve the lab's own
held-out attack-detection count over both prior training attempts. **But they also raise the false-positive rate on
the lab's own held-out benign traffic back up to baseline's level, and raise the false-positive rate on CIC's own
benign traffic — the generalization check this round added specifically to catch this — by roughly 28-47x over every
other condition, to about 1 in 10 windows.** Per the pre-registered weak-Pareto rule, this fails to count as an
improvement on every axis once false positives are weighed against it, not just the one it does best on. This is
reported exactly as that: a real, measured effect in one direction, undercut by a real, measured cost in another,
not blended into one number.

## Data collected (actual sample sizes, caps were a ceiling not a target)

| Day | Label | Role | Cap | Collected | Natural availability (whole-day, from the already-published full validation) |
| :--- | :--- | :--- | ---: | ---: | ---: |
| Wednesday | DoS Hulk | margin-training | 20,000 | **20,000** | 2,289,360 windows |
| Wednesday | DoS GoldenEye | margin-training | 20,000 | **20,000** | 106,533 windows |
| Wednesday | DoS Slowhttptest | held-out (same-day, different mechanism) | 20,000 | **20,000** | 31,223 windows |
| Wednesday | DoS slowloris | held-out (same-day, different mechanism) | 20,000 | **20,000**, exhausting the whole day's supply (22,690) | 22,690 windows |
| Wednesday | BENIGN (pre-attack only) | generalization check | 25,000 | **25,000** | — |
| Friday | DDoS | held-out (cross-day, different tool) | 20,000 | **20,000** | 1,273,650 windows |
| Friday | BENIGN (pre-attack only) | generalization check | 25,000 | **25,000** | — |

Every bucket reached its cap except Wednesday's `DoS slowloris`, which collected every one of that day's 22,690
windows before hitting the 20,000 cap in time order (the sampler's own log independently confirms the processed
prefix contained exactly 22,690 slowloris-majority windows, matching the previously-published whole-file count
exactly — all of Wednesday's slowloris activity happened inside the streamed prefix, none was missed by stopping
early).

**Streaming cost, with the early-stop paying off as expected:** Wednesday's pass stopped after 9,997,306 of
13,788,878 packets (72.5% of the file, 644.7s) once every bucket was settled; Friday's stopped after 8,164,410 of
9,997,874 packets (81.7% of the file, 520.1s). Both saved real wall-clock time versus a full pass of either file
(previously measured at 14.3 and 19.7 minutes respectively) without needing to process either file to completion.

**Training pool size achieved:** 40,000 CIC attack windows (2 classes x 20,000), against the lab's unchanged 6,264
pooled benign-training windows (8 patterns, 18 runs) — about 3.7x PR #106's total margin-training window count
(~10,815, pooled across its 2 lab patterns) **per CIC class alone**, from genuinely distinct, far larger campaigns.

## Fitting

- Baseline hardcoded weights' hinge target (training-split diagnostic only): `0.2436`.
- Baseline hardcoded weights' training-objective value: `0.252045`.
- `differential_evolution`: `nfev=30211`, objective `0.113324`. `Nelder-Mead` polish (bounds respected, the PR #106
  bugfix reused unmodified): `nfev=710`, objective `0.113320`. Total fit time **1673.4s (27.9 minutes)** — slower
  than PR #106's lab-only fit (which trained on ~10,815 windows rather than 40,000), as expected from the larger
  per-evaluation array size, still well within a single sitting. (A first run, before the pre-push gate findings
  below were fixed, measured 1774.6s; both runs' `nfev`, objective values and fitted weights are identical — fitting
  wall-clock varies run to run with machine load, nothing else does.)
- **Trained weights:** `[4.506653, 3.939442, 0.222242, -0.527495, 2.472321, -2.951751, -0.437407, 4.999854,
  4.999229, 0.672571]`. **Worth flagging, not a bug:** two of the ten weights (`w7 = 4.999854`, `w8 = 4.999229`) land
  within `0.0008` of the pre-registered upper bound (`5.0`) — the optimizer is pressed right up against the box PR
  #105/#106 defined and this round reused unchanged. This is disclosed as a diagnostic fact about where this fit
  wants to sit, not re-litigated: the bound was fixed before this round ran, and no weight exceeded it (the
  `bounds=BOUNDS` fix to the `Nelder-Mead` polish step, found and fixed during PR #106, is confirmed still in effect
  here — nothing landed outside `[-3.0, 5.0]`).
- **Calibrated `tau`:** `mean=0.0968`, `std=0.0338` (pooled over the same 6,264 lab training-benign windows every
  prior round calibrated against, never CIC benign) → `base_tau = 0.1814`. This is only modestly higher than PR
  #106's `0.1716` and baseline's `0.15` in absolute terms — the dramatic behavioral differences below come from how
  the trained reconstruction function responds to different *distributions* of traffic at that threshold, not from
  the threshold number itself moving much.

## Axis (a): lab held-out split (identical 9-benign/13-attack reduced holdout PR #106 published against)

| Condition | Attacks detected (right sender) | Benign false positives |
| :--- | :---: | :---: |
| Baseline (hardcoded, tau=0.15) | 10/13 | 4/9 |
| PR #105 (benign-only) | 2/13 | 0/9 |
| PR #106 (lab-margin) | 6/13 | 1/9 |
| **This round (CIC-margin)** | **8/13** | **4/9** |

This round detects more lab attacks than either prior training attempt (8 vs. PR #106's 6, vs. PR #105's 2), closing
some of the gap to baseline's 10/13 — but its false-positive rate matches baseline's worst-in-class 4/9, erasing
both prior rounds' progress on specificity. **Verdict per the pre-registered weak-Pareto rule: NOT a clear
improvement over baseline, PR #105, or PR #106** — in each case the higher-or-equal-hit-rate condition is met, but
the lower-or-equal-false-positive-rate condition is not.

A detail worth noting: this round's 4 false positives land on **different** lab benign patterns than baseline's do.
Baseline alerts on `benign-ping-20pps` (2/2) and `benign-udp-small-50pps` (2/2); this round alerts on
`benign-bulk-tcp-2mbit` (1/2) and `benign-http-burst-8conns` (3/3, every held-out run of that pattern). Same
aggregate rate, a different failure shape — not simply "as bad as baseline in the same way."

Per-pattern breakdown (both prior rounds' held-out port-scan and SYN-flood numbers, re-quoted here from this run's
own identical-split re-scoring, not from either prior README, so the comparison is apples-to-apples on the exact
same held-out set):

| Pattern | Baseline | PR #105 | PR #106 | This round |
| :--- | :---: | :---: | :---: | :---: |
| `attack-portscan-1pps` (2 runs) | 2/2 | 1/2 | 1/2 | 1/2 |
| `attack-portscan-fast` (3 runs) | 2/3 | 0/3 | 1/3 | 3/3 |
| `attack-portscan-half-pps` (2 runs) | 0/2 | 0/2 | 0/2 | 0/2 |
| `attack-portscan-slow` (3 runs) | 3/3 | 1/3 | 1/3 | 1/3 |
| `attack-synflood-1000pps` (3 runs, the lab's own held-out flood-generalization test) | 3/3 | 0/3 | 3/3 | 3/3 |

This round matches PR #106's full recovery of the lab's held-out `attack-synflood-1000pps` generalization test (3/3,
same as baseline) and happens to do best of all four conditions on `attack-portscan-fast` (3/3) even though
port-scan detection was never part of any training objective in any round — read as noise from a 2-3-run-per-pattern
sample, not a signal the CIC-trained weights learned something about port scans.

## Axis (b): CIC held-out flood windows — window-level recall, a different granularity than axis (a)

| CIC class (held out, never trained on) | Baseline | PR #105 | PR #106 | **This round** |
| :--- | ---: | ---: | ---: | ---: |
| DoS Slowhttptest (Wednesday, same-day/different-mechanism) | 0.17% | 0.00% | 0.00% | **57.80%** |
| DoS slowloris (Wednesday, same-day/different-mechanism) | 5.22% | 0.00% | 0.01% | **20.50%** |
| DDoS (Friday, cross-day/different-tool) | 0.68% | 0.00% | 0.00% | **100.00%** |

Attacker-IP agreement (of the windows that alert, the fraction whose majority source IP is the known `172.16.0.1`
attacker): this round scores 94.82% (Slowhttptest), 70.26% (slowloris), 75.28% (DDoS) — high enough to say the alerts
are substantially tracking the real attacker, not firing at random, though not perfect (baseline's much smaller
alert counts happen to have higher agreement, 89.71-100%, consistent with alerting only on the clearest cases).

**This is the clearest, largest effect measured in this round:** every other condition (including baseline) misses
nearly all of these three held-out CIC flood classes; this round catches the majority to effectively all of them,
across both the same-day-different-mechanism test and the cross-day-different-tool test the pre-registration
specifically designed to be a stringent, non-leaking generalization probe. Taken alone, this says the CIC-trained
margin term generalizes to flood shapes and a campaign it never saw in training far better than a lab-only sample of
8 runs ever did. It is **not** taken alone — see axis (c).

**Training-performance context (NOT held out, reported for transparency only):**

| CIC class (margin-training) | Baseline | PR #105 | PR #106 | This round |
| :--- | ---: | ---: | ---: | ---: |
| DoS Hulk | 1.51% | 0.00% | 0.00% | **100.00%** |
| DoS GoldenEye | 5.69% | 0.00% | 0.00% | **10.64%** |

A finding the pre-registration's data-sufficiency caveat anticipated: **the margin term trained on both Hulk and
GoldenEye with equal (nested-mean) weighting, but the resulting fit separates Hulk from benign almost perfectly
(100.00%) while barely moving GoldenEye's own recall (10.64%, versus baseline's already-nonzero 5.69%).** A blended
training objective over exactly 2 classes gave no internal signal that it was fitting one of them far better than
the other — exactly the failure mode the pre-registration flagged as a risk of a 2-class nested mean, now measured,
not hypothetical.

## Axis (c): CIC-benign generalization check — the axis this round added specifically to catch a result like this

| CIC-benign sample (pre-attack, never trained on or used for tau calibration) | Baseline | PR #105 | PR #106 | **This round** |
| :--- | ---: | ---: | ---: | ---: |
| Wednesday (25,000 windows) | 0.19% | 0.00% | 0.00% | **9.05%** |
| Friday (25,000 windows) | 0.34% | 0.00% | 0.24% | **9.70%** |

This round's false-positive rate on a different organization's ordinary traffic is **roughly 28-47x baseline's own
rate** and far above both prior training attempts' near-zero rates, on both days independently. **Paired against axis
(b)'s recall gain per the pre-registration's explicit rule (recall higher AND the CIC-benign false-positive rate not
worse), this round fails the pairing on every held-out CIC class: the false-positive side got dramatically worse, not
merely not-better.** The huge recall numbers in axis (b) are real, but per the rule fixed in advance, they do not
count as an improvement once weighed against this.

**Read together, axes (b) and (c) tell one coherent story, not two unrelated ones:** this round's fit did not learn
to recognize CIC's attacks by recognizing anything specific to CIC's attacks — it moved the detector into a broadly
more reactive operating regime (consistent with two of its ten weights sitting at the edge of their bounds, see
"Fitting" above) that happens to fire on most traffic statistically unlike this lab's own narrow benign distribution,
whether that traffic is a CIC flood or ordinary CIC background chatter. Feeding the margin term a much larger and
more diverse attack population did not teach it a narrower, more targeted separation; it taught it to be
indiscriminately more sensitive to anything off-distribution, attack or not. This is the opposite of what PR #106's
own lab-only result achieved (a real but thin recall gain with specificity preserved) — this round traded that
specificity away for a much bigger but much less trustworthy recall number.

## Data-sufficiency situation, now versus before

- **Scale of the attack-training population:** this round's 40,000 CIC windows (2 classes, hundreds of thousands to
  millions of windows available behind each) is a genuine increase over PR #106's ~10,815 lab windows (2 classes, 8
  total runs available). That part of the pre-registration's goal — more statistical power per class, drawn from
  genuinely distinct campaigns — was achieved and is not in question.
- **What more data did not fix:** the structural thinness of a 2-class nested mean is still exactly as thin as PR
  #106's, regardless of how many windows sit behind each of the 2 classes — and this round measured, concretely, the
  exact failure mode the pre-registration warned a 2-class mean could hide (Hulk at 100% recall, GoldenEye at
  10.64%, both nominally "trained on" with equal weight).
- **A new, larger problem surfaced that more same-source data would not have caught:** the generalization gap this
  round actually has is not "not enough flood-attack examples" (axis (b) shows the fit generalizes to unseen CIC
  floods just fine) — it is "the fit does not generalize *narrowly*": it cannot tell a never-seen flood apart from
  never-seen ordinary traffic, because both are off-distribution from the one lab's benign pool the benign term is
  still anchored to. More CIC attack data, by itself, made this worse, not better, because it had no corresponding
  pressure in the objective to stay quiet on CIC-like benign traffic (CIC benign was deliberately excluded from
  training, per the task's own scope — this is not a case for undoing that choice, since doing so would mean
  training this lab's deployed detector to match a different organization's normal-traffic profile; it is a measured
  reason to distrust a large single-source attack-only data injection into a 10-shared-scalar-weight objective
  without an equally diverse benign-side signal to balance it).
- **Bottom line:** this project now has strong evidence that "more attack data from one large external source" is
  not sufficient on its own to produce a generalizing, trustworthy margin term — a different and more useful finding
  than "we need more data," and one PR #106's thinner sample was too small to have surfaced either way.

## Reproduction

The capped CIC window samples (`wednesday.npz`, `friday.npz` — raw per-window feature arrays, not just losses, so
they can be re-scored against any weight set without re-reading the pcaps) are **not committed to this repo**, same
reasoning as the raw pcaps themselves not being committed: they are large (about 2.5 MB combined here, small in this
case, but derived, regenerable data, not source). They were written to `/tmp/cic-flood-margin-cache/` during this
round and are not guaranteed to persist. To regenerate them and reproduce the numbers above:

```sh
python3 scripts/cic-flood-margin-sampler.py \
  ~/Downloads/cic-ids2017-raw/Wednesday-workingHours.pcap \
  "<path-to>/Wednesday-workingHours.pcap_ISCX.csv" \
  --bucket "DoS Hulk=20000" --bucket "DoS GoldenEye=20000" \
  --bucket "DoS Slowhttptest=20000" --bucket "DoS slowloris=20000" \
  --benign-cap 25000 --benign-cutoff-epoch 1499256000.0 \
  --out /tmp/cic-flood-margin-cache/wednesday.npz

python3 scripts/cic-flood-margin-sampler.py \
  ~/Downloads/cic-ids2017-raw/Friday-WorkingHours.pcap \
  "<path-to>/Friday-WorkingHours-Morning.pcap_ISCX.csv" \
  "<path-to>/Friday-WorkingHours-Afternoon-PortScan.pcap_ISCX.csv" \
  "<path-to>/Friday-WorkingHours-Afternoon-DDos.pcap_ISCX.csv" \
  --bucket "DDoS=20000" --benign-cap 25000 --benign-cutoff-epoch 1499430779.6 \
  --out /tmp/cic-flood-margin-cache/friday.npz

python3 scripts/train-sentinel-weights-cic.py docs/benchmarks/results/labelled-runs \
  --wednesday-npz /tmp/cic-flood-margin-cache/wednesday.npz \
  --friday-npz /tmp/cic-flood-margin-cache/friday.npz \
  --pr105-weights docs/benchmarks/results/sentinel-training/trained-weights-2026-10-23.json \
  --pr106-weights docs/benchmarks/results/sentinel-training-margin/trained-weights-margin-2026-10-23.json \
  --out-weights docs/benchmarks/results/sentinel-training-margin-cic/trained-weights-margin-cic-<date>.json
```

The `GeneratedLabelledFlows.zip` CSVs are the same label archive `scripts/cic-ids2017-labels.py` has always required
(see `docs/design/cic-ids2017-adapter.md`); the benign-cutoff epochs are the measured values from
`PREREGISTRATION.md`'s "Benign-cutoff epochs" section, specific to these two exact downloaded files.

## What was and will not be changed in the live system

Identical boundary to all three prior rounds. `scripts/gpu-sdn-anomaly-sentinel.py`'s opt-in `--weights-file` /
`GPU_SENTINEL_WEIGHTS_FILE` loading path is reused unmodified; this round does not touch it, the systemd unit, or any
Jetson hardware, and does not retrain port-scan detection. With neither flag nor environment variable set, the
deployed daemon keeps running the compiled-in hardcoded constants regardless of this round's result. Given this
round's own measured false-positive behavior on both the lab's held-out benign traffic and CIC's benign traffic,
**these weights are not recommended for deployment** even behind the existing opt-in flag; this is a research
artifact documenting a negative/mixed result, not a candidate for the live system.
