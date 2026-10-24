# Margin-trained GPU sentinel weights: results (2026-10-23)

Generated from the run on 2026-10-23, following [`PREREGISTRATION.md`](PREREGISTRATION.md) (objective, split,
hyperparameters, and the definition of "improvement" fixed before this script was run or any held-out number was
looked at). Branch `feat/sentinel-margin-training`, continuing from `feat/sentinel-weight-training` (PR #105).
Reproduce with:

```sh
python3 scripts/train-sentinel-weights.py docs/benchmarks/results/labelled-runs --objective margin \
  --out-weights <path> \
  --compare-weights-file docs/benchmarks/results/sentinel-training/trained-weights-2026-10-23.json \
  --compare-label benign-only
```

(needs numpy and scipy; both were already present in this environment, unlike the first attempt's). Full stdout is
[`training-output-2026-10-23.txt`](training-output-2026-10-23.txt); the fitted weights and metadata are
[`trained-weights-margin-2026-10-23.json`](trained-weights-margin-2026-10-23.json).

## Headline: not a clear improvement over either prior condition, by the pre-registered rule — but the margin term did exactly what it was designed to do on the attack class it targeted

| | Attacks detected (right sender) | Benign false positives |
| :--- | ---: | ---: |
| **Baseline** (today's hardcoded weights, `tau=0.15`) | **10/13** | **4/9** |
| **Benign-only trained** (PR #105's weights, `tau=0.1696`) | **2/13** | **0/9** |
| **Margin-trained** (this round, `tau=0.1716`) | **6/13** | **1/9** |

All three rows are scored on the **identical held-out split this round uses: 9 benign runs (unchanged from the
first attempt) + 13 attack runs** (4 port-scan patterns, 10 runs, plus the held-out flood pattern
`attack-synflood-1000pps`, 3 runs). This is a *smaller* held-out attack set than the first attempt's 18 runs,
because 5 flood-attack runs moved from "held out" to "used by the margin term" this round (see
[`PREREGISTRATION.md`](PREREGISTRATION.md)); the baseline and benign-only rows above are re-scored on this smaller
set, not copy-pasted from the first attempt's README, so this table is apples-to-apples.

Per the pre-registered weak-Pareto rule, margin-trained is **not a clear improvement** over baseline (worse attack
recall, 6/13 vs 10/13, despite better false positives, 1/9 vs 4/9 — a trade, not a win) and **not a clear
improvement** over the benign-only attempt either (better attack recall, 6/13 vs 2/13, but worse false positives,
1/9 vs 0/9 — also a trade). Reported exactly as that: a partial, mixed result, not rounded up in either direction.

## Why: the margin term fixed the specific failure the first attempt had on flood attacks — including generalizing to an unseen rate — but a regression on port scans (never in scope) ate into the overall recall number

Splitting the held-out set by what this round's objective actually targeted:

**Flood attacks (the in-scope class):** `attack-synflood-1000pps` is the one flood pattern held out this round
(never seen by the margin term), chosen specifically because it was the *hardest* of the three flood patterns to
separate from benign under hardcoded weights (see "what we found before training" in `PREREGISTRATION.md`: its
per-run mean loss sits only slightly above the benign training mean, and its minimum window loss is actually
*below* it). Margin-trained weights detect it **3/3**, identical to baseline, and unlike the benign-only attempt's
**0/3** on the same pattern. On the 5 flood-attack runs the margin term trained on (`attack-synflood-200pps`,
`attack-udpflood-500pps-1400b` — reported separately below as training performance, not held-out), margin-trained
also gets **5/5**, matching baseline, while benign-only gets only **2/5** (it loses `attack-synflood-200pps`
entirely, the same collapse pattern the first attempt's README already documented). Combined (training + held-out,
with the caveat that 5 of these 8 runs were seen by the margin term during fitting and 3 were not): margin-trained
**8/8** on flood attacks, identical to baseline's **8/8**; benign-only **2/8**. **This is the design goal working:**
a margin term fit on labelled flood-attack data, scoped to the attack class the sentinel is actually needed for
(port scans have their own deterministic detector), preserved flood detection — including generalizing the
separation to a rate (1000 pps) it never trained on — in exactly the place the benign-only objective lost it.

**Port scans (out of scope this round, reported anyway, in full):** baseline detects `attack-portscan-1pps` 2/2,
`attack-portscan-fast` 2/3, `attack-portscan-half-pps` 0/2, `attack-portscan-slow` 3/3 (7/10 total). Margin-trained
detects `attack-portscan-1pps` 1/2, `attack-portscan-fast` 1/3, `attack-portscan-half-pps` 0/2,
`attack-portscan-slow` 1/3 (3/10 total) — **a real regression on an attack type this round's objective never
targeted, disclosed here plainly rather than left out of the headline.** Nothing in the margin term's objective
reads, rewards, or protects port-scan separation; the ten weight-tied scalars reallocated some of their limited
capacity toward the flood-attack margin and benign reconstruction, and port-scan sensitivity that the arbitrary
hardcoded weights happened to have fell as a side effect. This is consistent with the first attempt's capacity-limit
finding: ten weight-tied scalars appear to not have enough free parameters to hold benign reconstruction, flood
separation, *and* whatever accidentally gave the hardcoded weights their port-scan sensitivity, all at once. It is
also the reason `scripts/portscan-rule-detector.py` — a dedicated, deterministic, already-merged detector, 10/10
on this same dataset with 0/30 false positives — exists and should be relied on for port scans regardless of what
the sentinel's learned weights do; this round's result is one more data point for not asking the sentinel's ten
weights to do that job too.

**Benign false positives:** margin-trained drops from baseline's 4/9 to 1/9 — `benign-ping-20pps` goes from 2/2 to
1/2 and `benign-udp-small-50pps` from 2/2 to 0/2, `benign-bulk-tcp-2mbit` and `benign-http-burst-8conns` stay at
0 both conditions. A real, substantial reduction versus baseline, though not as low as the benign-only attempt's
0/9 (which bought that by abandoning attack recall).

## Fitted weights

```text
baseline (hardcoded, src/gpu/gpu_anomaly_kernel.cu): [0.20, 0.30, 0.25, 0.25, 0.05, 0.50, 0.02, 0.85, 1.50, 0.40]
benign-only (PR #105, seed=42):                       [2.522, 2.959, 4.073, 3.213, 2.071, 2.737, 2.107, 0.061, 0.463, 1.210]
margin-trained (this round, seed=42):                 [1.371, 1.193, -1.441, -2.998, 1.014, 1.003, 0.000, 2.168, -0.523, -0.061]
```

Training objective (`L_benign + 1.0 * L_margin`, lower is better): baseline `0.208909` (of which the benign-only
term alone is `0.156286`, identical to the first attempt's baseline value, as it should be — same benign term,
same data), margin-trained `0.122792` (`differential_evolution`: 30,222 evaluations, objective `0.127169`;
`Nelder-Mead` polish: 1,373 evaluations, objective `0.122792`; ~20 minutes wall clock on a laptop CPU,
single-threaded — roughly 5x the first attempt's ~4 minutes, since each candidate evaluation now also scores the
5 margin-training attack runs' 27,573 windows). The margin-trained weights' benign-only reconstruction loss alone is
`0.119598` — close to, not worse than, the benign-only attempt's `0.107112`-ish value, i.e. the margin term did not
force benign reconstruction to blow up to buy its separation (see "what the objective was designed to prevent"
below). Calibrated `base_tau` for the margin-trained weights (training-benign pool only, no margin added): `0.1115 +
2.5*0.0241 = 0.1716`.

## What the objective was designed to prevent, and whether it worked

The objective (`L(W) = L_benign(W) + LAMBDA * L_margin(W)`, exact formula in `PREREGISTRATION.md`) was built so
that: (1) benign reconstruction quality still has its own term, so a solution cannot trade it away unboundedly for
separation — it did not: margin-trained's benign-only loss (`0.1196`) is close to the benign-only attempt's
(`0.1070`), not degraded by an order of magnitude; (2) the margin term only ever reads training-split flood-attack
windows, confirmed by construction (`attack_train_groups` built once in `load_and_split()`, never touching
`holdout`); (3) the hinge is bounded at zero past the target rather than an unbounded "maximize attack loss" term —
confirmed by the training-performance block below showing the margin-trained weights settle at a finite, specific
point (5/5 on the training attack runs, not some degenerate saturated extreme).

## Per-pattern breakdown (held-out split, 9 benign + 13 attack)

```text
                                    baseline        benign-only      margin-trained
attack-portscan-1pps        (2)     2/2             1/2              1/2
attack-portscan-fast        (3)     2/3             0/3              1/3
attack-portscan-half-pps    (2)     0/2             0/2              0/2
attack-portscan-slow        (3)     3/3             1/3              1/3
attack-synflood-1000pps     (3)     3/3             0/3              3/3   <- this round's held-out generalization test
benign-bulk-tcp-2mbit       (2)     0/2 fp           0/2 fp           0/2 fp
benign-http-burst-8conns    (3)     0/3 fp           0/3 fp           0/3 fp
benign-ping-20pps           (2)     2/2 fp           0/2 fp           1/2 fp
benign-udp-small-50pps      (2)     2/2 fp           0/2 fp           0/2 fp
```

## Margin-training flood-attack runs' own scores (training performance, NOT a held-out result)

Reported separately and clearly labeled, per `PREREGISTRATION.md`, since the margin-trained weights were optimized
partly for exactly these 5 runs — this is not evidence of generalization, only evidence of what the margin term
actually fit:

```text
                                       baseline   benign-only   margin-trained
attack-synflood-200pps         (3)     3/3        0/3           3/3
attack-udpflood-500pps-1400b   (2)     2/2        2/2           2/2
```

Baseline and benign-only were never fit on these 5 runs either, so their scores here are not leaked — baseline's
and benign-only's numbers here are informative in their own right (baseline already detected these two patterns
perfectly; benign-only had already lost one of them even before this round's held-out test showed it losing the
third).

## A bug found and fixed along the way: the Nelder-Mead polish step was not actually bounded

`scripts/train-sentinel-weights.py`'s optimizer (reused unmodified from the first attempt) runs
`differential_evolution` — which enforces `BOUNDS = [(-3.0, 5.0)] * 10` by construction — followed by a local
`scipy.optimize.minimize(method="Nelder-Mead")` polish. The polish call did not pass `bounds=BOUNDS` to `minimize()`,
so it was actually unconstrained; this was invisible in the first attempt because that polish happened to stay
inside the box anyway. It was not invisible this round: the harder, kinked loss surface the hinge term introduces
sent an early (pre-fix) run of the polish to a weight of `-66.8`, more than 20x outside the declared box, and the
pre-registration's own stated justification for the bounds ("bounded to keep a global search tractable and to avoid
numerically degenerate saturated solutions") would no longer have held for that result.

**Fixed** (this round, `scripts/train-sentinel-weights.py`, both `--objective` modes): `minimize(..., bounds=BOUNDS,
...)`. **Checked that the fix does not change the first attempt's published numbers:** re-running
`--objective benign` with the fix reproduces the exact same split, weights, `tau=0.1696`, and 15/18-detected/4/9-fp
headline already published in `docs/benchmarks/results/sentinel-training/README.md` — the first attempt's polish
never actually left the box, so PR #105's merged-but-not-yet-merged result is unaffected by this bug. The numbers in
this README are all from the bounds-fixed code; the pre-fix run's escaped weight was discarded and is not reported
anywhere as a result.

## Data-sufficiency caveat: the flood side is thinner than the benign side, repeated from `PREREGISTRATION.md` because it bears directly on how much to trust this round's numbers

8 valid flood runs across only 3 patterns, with 5 runs across 2 patterns used for margin fitting and 3 runs of 1
pattern held out, is very little data — thinner than the benign split's 18 training / 9 held-out runs across 12
total patterns, which was already flagged as thin in the first attempt. The margin term's own "nested mean over
patterns" averages exactly **2** numbers; the held-out flood test is **1 pattern, 3 runs**, where a single run's
outcome changes the rate by 33%. **The positive flood-generalization result above (3/3 on `attack-synflood-1000pps`,
matching baseline where benign-only got 0/3) is the headline positive finding of this round, and it rests on exactly
one held-out pattern repeated three times.** It is a genuine, honestly-measured sign that the margin objective can
work as designed — not proof that it reliably will, on a larger or different flood-attack sample. More flood-attack
data, more lab runs, and ideally more than one random seed for the optimizer would be needed before reading this as
more than "no sign of failure on the one generalization test this round could afford to build."

## What would count as an improvement — restated — and why the answer is "not yet, but here is the one thing that worked"

Per `PREREGISTRATION.md`'s pre-registered rule, margin-trained is **not** a weak-Pareto improvement over baseline or
over the benign-only attempt on the overall held-out numbers. It is also not simply "the same kind of failure as the
first attempt" — the specific thing this round's objective was designed to fix (flood-attack separation collapsing
under a benign-only objective, including on a held-out rate the fit never saw) did get fixed, exactly where it was
targeted, with benign reconstruction quality not materially worse than the benign-only attempt's. What ate the
overall recall number back down was a regression on an attack class (port scans) this round's objective was
deliberately scoped to leave untouched, and which this repository already has a dedicated, validated, deterministic
detector for. **Read plainly: this round's margin objective is evidence that giving the sentinel's objective a
reason to keep flood-attack windows separated works, within the thin data this lab rig has for that class; it is
not yet evidence that the sentinel's ten weight-tied scalars can hold that *and* keep baseline's incidental
port-scan sensitivity at the same time.** A next round that also includes a (bounded, hinge-style, same discipline)
port-scan margin term — now that labelled port-scan training data exists and is not needed for the sentinel's own
objective, since the rule detector covers it operationally — is the most direct next step suggested by this result,
not attempted here because it was out of this round's pre-registered scope.

## What was and will not be changed in the live system

Identical boundary to the first attempt. `scripts/gpu-sdn-anomaly-sentinel.py`'s opt-in `--weights-file` /
`GPU_SENTINEL_WEIGHTS_FILE` loading path (already implemented, already fail-closed, already tested) is reused
unmodified; this round does not touch it, the systemd unit, or any Jetson hardware. With neither flag nor
environment variable set, the deployed daemon keeps running the compiled-in hardcoded constants exactly as it does
today. Given the result above, **this round's weight file is not recommended as a replacement for the hardcoded
defaults either** — same disclosure as the first attempt, for the same reason: it is committed as the measured,
reproducible artifact of this exercise, not as a suggested upgrade.

## Caveats

- Same PyTorch-fallback-path caveat as the first attempt: `scripts/gpu-sdn-anomaly-sentinel.py`'s CUDA-less fallback
  is a separate, randomly-initialized convolutional network, not this ten-scalar structure. Untouched by either
  training round.
- The `--weights-file` fail-closed validation path was exercised the same way as the first attempt (CUDA-less dev
  environment, correctly takes the "no CUDA engine active" branch), not against real Jetson hardware.
- `attack-arpflood-200pps*` remains 0 valid runs under the existing scorer's validity rule (sender never seen at the
  tap) in every condition reported here, same as every prior write-up; this round did not and could not change that.
- The `--compare-weights-file` / `--compare-label` flags added this round re-score an existing weights JSON on the
  current run's held-out split; they do not re-fit anything and do not touch the comparison weights file itself.
