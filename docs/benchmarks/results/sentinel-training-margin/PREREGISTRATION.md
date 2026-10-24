# Margin-trained GPU sentinel weights: pre-registration

Written 2026-10-23, before the margin objective is optimized and before any held-out number is looked at. Same
convention as [`../sentinel-training/PREREGISTRATION.md`](../sentinel-training/PREREGISTRATION.md) (the first,
benign-only attempt) and [`../track-c-scenario1-arp-spoof/PREREGISTRATION.md`](../track-c-scenario1-arp-spoof/PREREGISTRATION.md):
results go in `README.md` next to this file; this file is not edited afterwards except to add a dated note saying
what changed and why.

**2026-10-23 addendum, added before any held-out number from this round was used in the final report:** the first
run of the fitting procedure below surfaced a latent bug in `scripts/train-sentinel-weights.py`, reused unmodified
from the first attempt — the `scipy.optimize.minimize(method="Nelder-Mead")` polish step did not pass `bounds=BOUNDS`
and was therefore actually unconstrained, letting one weight land at `-66.8`, far outside the `[-3.0, 5.0]` box this
document declares and justifies below. This was fixed (`bounds=BOUNDS` added to that call, both `--objective`
modes) and the fit was re-run before any number was treated as final; the fix was also checked against
`--objective benign` and confirmed to reproduce the first attempt's exact published numbers unchanged (its polish
had stayed inside the box anyway). See `README.md`'s "a bug found and fixed along the way" section for the full
account. Nothing in this document's objective, split, bounds, hyperparameters, or improvement rule was changed
because of this — only the optimizer call was corrected to actually enforce what this document already specified.

## Why this round exists

[`../sentinel-training/README.md`](../sentinel-training/README.md) fit the GPU sentinel's ten weights
(`scripts/sentinel-replay.py`'s `kernel_loss`, identical by construction to `src/gpu/gpu_anomaly_kernel.cu`) by
minimizing reconstruction error on benign-only training windows — the textbook one-class autoencoder objective. On
the held-out split it measured, honestly, that this **lost at the one job the detector has**: baseline (hardcoded
weights, `tau=0.15`) caught 15/18 attacks with 4/9 benign false positives; the benign-only fit caught 4/18 attacks
with 0/9 false positives. The diagnosis in that README: nothing in a benign-only objective rewards the model for
keeping attack windows apart from the benign distribution, so the easiest way to lower benign loss with only ten
weight-tied scalars turned out to be flattening the whole reconstruction (including most attacks) rather than
sharpening it. The baseline's 15/18 was also shown to not be "good separation" either — it is a fixed `tau=0.15`
that most training-benign windows already sit above the mean of by only a fraction of a standard deviation (see
"what we found before training" below), so baseline catches attacks mostly by being trigger-happy, not by a wide
discriminative margin.

This round's fix: give the objective a reason to keep attack windows separated from benign ones, using labelled
attack data that was only ever used for held-out validation before — but scoped to the attack class this detector
is actually needed for.

## Scope: flood attacks only, not port scans

`scripts/portscan-rule-detector.py` (merged, PR #104) is a dedicated, deterministic distinct-destination-port
counter that already gets 10/10 port-scan detections with 0/30 false positives on this same dataset. Spending this
round's limited labelled-attack budget on re-deriving port-scan separation inside the sentinel's ten weights would
duplicate a solved problem. This round's margin term is fit **only** on the three flood attack patterns in
`docs/benchmarks/results/labelled-runs/`: `attack-synflood-200pps`, `attack-synflood-1000pps`,
`attack-udpflood-500pps-1400b` (and their `-r2`/`-r3` repeats where present). `attack-portscan-*` and
`attack-arpflood-*` runs are never used by the margin term; port-scan and ARP-flood runs are still scored on the
held-out split for a complete, honest picture (ARP-flood runs are invalid under the existing scorer's validity rule
regardless — see "data this round still cannot use" below — so they contribute 0 valid runs to any condition's
score, same as every prior write-up).

## What is being fit (architecture unchanged)

Identical scope restriction to the first attempt: the same ten scalars `w0..w9` in `kernel_loss`/`gpu_anomaly_kernel.cu`,
no redesign of the window size (64 packets), the four input features, or the network shape. Only the **objective**
changes. `scripts/train-sentinel-weights.py` gains a `--objective margin` mode (reusing, not duplicating, its data
loading, self-check against the real kernel, and held-out scoring via `scripts/score-labelled-runs.py`); the default
`--objective benign` mode is untouched and reproduces the first attempt's exact numbers.

## Split

### Benign split: unchanged from the first attempt, reused verbatim

Benign **training** patterns (8 patterns, 18 runs): `benign-ping-5pps`, `benign-ping-5pps-node01`,
`benign-idle-60s`, `benign-interactive-8eps`, `benign-http-5rps`, `benign-http-20rps`, `benign-udp-small-10pps`,
`benign-udp-burst-tailscale-like` (its one valid repeat, `-ok`).

Benign **held-out** patterns (4 patterns, 9 runs): `benign-ping-20pps`, `benign-udp-small-50pps`,
`benign-http-burst-8conns`, `benign-bulk-tcp-2mbit`.

Reusing the identical benign split (not redesigning it) is deliberate: it is the only way the benign false-positive
numbers in this round's three-way table are the same measurement as the first attempt's, not a different experiment
that happens to use the same words.

### Attack split: new this round, flood patterns only, and thinner than the benign side

There are only **3 flood patterns, 8 valid runs total**: `attack-synflood-200pps` (3 runs: base, `-r2`, `-r3`),
`attack-synflood-1000pps` (3 runs: base, `-r2`, `-r3`), `attack-udpflood-500pps-1400b` (2 runs: base, `-r3`; no
`-r2` was recorded). Holding out even one whole pattern, the same discipline the benign split already uses (never
split near-duplicate repeats of one pattern across train/held-out), leaves at most 2 patterns and 5-6 runs to fit
the margin term on. **This is very little data and is flagged as such now, not after the results are in** — see
"data-sufficiency caveat" below.

**Margin-training attack patterns (2 patterns, 5 runs):** `attack-synflood-200pps` (3 runs), `attack-udpflood-500pps-1400b`
(2 runs). These two were chosen, not the alternative pairing, because together they cover the two distinct *shapes*
of flood traffic in this dataset — small fixed-size TCP SYN packets at a moderate rate, and large (1400 B) UDP
frames — giving the margin term two different attack shapes to generalize a discriminative gap from, rather than
two rate variants of the same shape.

**Held-out flood pattern (1 pattern, 3 runs), never touched by the margin term:** `attack-synflood-1000pps`. This
mirrors the first attempt's own benign design (train on a protocol/shape at one rate, hold out a faster variant of
the *same* protocol/shape to test whether the fit generalizes within a family rather than only memorizing the exact
rate it was shown) — except here the "family" is "TCP SYN flood," trained at 200 pps and held out at 1000 pps. It
is also, as it turns out, the hardest of the three flood patterns to separate from benign under the current
hardcoded weights (see next section), which makes it a meaningfully stringent held-out test, not a soft one.

All other attack patterns — every `attack-portscan-*` pattern (4 patterns, 10 valid runs) and `attack-arpflood-*`
(0 valid runs, invalid for the reason given below) — are held out exactly as before: never used by any objective
this round, scored only for the honest complete picture.

### Data this round still cannot use (reused from the first attempt's scorer, not re-litigated)

The 3 `attack-arpflood-200pps*` runs and the 3 `benign-udp-burst-tailscale-like-drop-*` runs are invalid under
`scripts/score-labelled-runs.py`'s existing validity rule (sender never seen at the tap at the required 20-frame
minimum, for the ARP-flood runs — `src/gpu` receiver attribution does not see ARP sources; and the rack not
recorded healthy after the run, for the drop runs — they coincided with a switch outage). This is the scorer's own
rule, unmodified; this round did not touch it or relax it to manufacture more data.

## What we found before training (exploratory, training-split only, descriptive of the existing fixed baseline — not a held-out result, and not used to tune anything in the new method)

Using the already-published, already-public baseline weights (`0.20, 0.30, 0.25, 0.25, 0.05, 0.50, 0.02, 0.85, 1.50,
0.40` — no new information from this round's fit) against the training-split windows only:

- Pooled training-benign loss (8 training patterns, 6,264 windows): mean `0.1391`, std `0.0338`.
- `attack-synflood-1000pps` (the pattern held out this round) per-run mean loss: `0.1469`-`0.1509` — barely above the
  benign mean, and its per-run *minimum* window loss (`0.1318`-`0.1337`) is actually *below* the benign mean. Baseline's
  3/3 detection of this pattern depends on a minority of high-outlier windows (max `0.2255`-`0.2279`) crossing the
  adaptive controller's ratcheting threshold over a sustained attack, not on a wide, stable per-window margin.
- `attack-synflood-200pps` per-run mean loss: `0.1756`-`0.1792`. `attack-udpflood-500pps-1400b` per-run mean loss:
  `0.2029`-`0.2058`. Both clearly above the benign mean, but (see next point) still below where this round's margin
  target sits.
- The benign-mean-plus-2.5-sigma quantity this round's margin target is built from (see "exact objective" below)
  computes to `0.1391 + 2.5*0.0338 ≈ 0.224` under baseline weights — *above* the per-run mean loss of all three flood
  patterns, including the two trained on this round. In other words: **even the two flood patterns this round trains
  on are not yet reliably separated from benign at this target under today's hardcoded weights** — there is real
  headroom for the margin term to close, not a gap that is already closed and about to be reported as a fake win.

This is consistent with the first attempt's finding that baseline's attack recall comes from being trigger-happy
(a static `tau=0.15`, well below any of these means) rather than from the hardcoded weights discriminating well.

## Exact objective

Let `B` = the pooled set of training-benign windows across all 8 training patterns (unchanged from the first
attempt's `pooled_training_losses`). At a candidate weight vector `W`:

- `benign_mean(W)`, `benign_std(W)` = mean and std of `kernel_loss(w; W)` over every window in `B`.
- `L_benign(W)` = the first attempt's unchanged objective: the nested mean over the 8 training *patterns* of (mean
  over that pattern's runs of (mean over that run's windows of `kernel_loss`)) — pattern-first nesting so a long
  capture or a pattern with more repeats cannot dominate the fit.
- `target(W) = benign_mean(W) + SIGMA * benign_std(W) + MARGIN`, with `SIGMA = 2.5` (reusing, not reinventing, the
  same sensitivity sigma the deployed `Adaptive` EMA controller and the first attempt's own `base_tau` calibration
  already use — this ties the margin's target to the same operational threshold definition the live detector is
  actually calibrated against, rather than an unrelated made-up constant) and `MARGIN = 0.02` (a fixed extra
  headroom beyond that operational threshold, chosen before training: on the scale above — benign std `~0.034` under
  baseline weights — `0.02` is about 0.6 standard deviations of extra cushion, modest relative to the gap already
  needed to clear `target(W)` itself, not an aggressive overreach).
- For each window `a` in the margin-training attack set `A` (the 5 runs of `attack-synflood-200pps` and
  `attack-udpflood-500pps-1400b` only): `hinge(a, W) = max(0, target(W) - kernel_loss(a; W))`. This is zero once an
  attack window's loss clears `target(W)` and grows linearly, not unboundedly, below it — the optimizer is never
  rewarded for pushing attack loss arbitrarily high past the target, only for closing the gap up to it, so it cannot
  trade away benign reconstruction quality for an unbounded "maximize attack loss" payoff that would not actually
  improve detection past the threshold that matters.
- `L_margin(W)` = the same nested-mean discipline as `L_benign`, applied to `A`: mean over the 2 margin-training
  attack *patterns* of (mean over that pattern's runs of (mean over that run's windows of `hinge`)) — so the 3 runs
  of `attack-synflood-200pps` cannot outweigh the 2 runs of `attack-udpflood-500pps-1400b` (or vice versa) just
  because one has more repeats or more windows per run (`~5,940` vs `~4,875`).
- **Total objective:** `L(W) = L_benign(W) + LAMBDA * L_margin(W)`, with `LAMBDA = 1.0` (chosen before training: at
  baseline weights, `L_benign ≈ 0.156` (the first attempt's measured value) and `L_margin` is of comparable
  magnitude given the per-pattern mean hinges implied by the numbers above — an equal weighting means neither term
  starts out swamping the other's gradient signal; this is a training-split-only diagnostic, not a held-out number).

This satisfies the brief directly: benign reconstruction quality still has its own unweighted term in the
objective (it is not downweighted or dropped), so a solution that lets benign loss blow up to chase separation
is not rewarded; the margin term only ever reads training-split flood attack windows, never the held-out split;
and the hinge is bounded below at zero with no reward for overshooting, unlike a plain "maximize attack loss" term.

**Bounds, optimizer, and threshold calibration for the final trained weights are unchanged from the first attempt,
reused exactly:** weight bounds `[-3.0, 5.0]` for all ten scalars; `scipy.optimize.differential_evolution` (global,
`seed=42`, `popsize=20`, `maxiter=150`, `tol=1e-10`, `polish=True`) followed by a `Nelder-Mead` local polish
(`maxiter=5000`); the deployed `base_tau` for the final trained weights is `benign_mean(W*) + 2.5 * benign_std(W*)`
computed from the training-benign pool only (no `MARGIN` added to the deployed threshold itself — `MARGIN` only
ever appears inside the training-time hinge target, never in what gets written to the weights file or used for
held-out scoring, so the held-out numbers below are judged against the same operational threshold definition as the
first attempt, not a loosened one).

## Validation (on data never touched by either objective)

The held-out set this round is **smaller than the first attempt's** because 5 attack runs moved from "held out" to
"used by the margin term": **9 benign runs (unchanged) + 13 attack runs** (4 port-scan patterns, 10 runs, plus the
1 held-out flood pattern `attack-synflood-1000pps`, 3 runs). ARP-flood contributes 0 valid runs to either round, as
always.

Because the held-out set size changed, the first attempt's baseline and benign-only-trained numbers are **not
directly comparable to this round's headline table as originally published** (they were measured against 18 attack
runs, this round's table against 13). The three-way comparison is made fair by re-scoring all three conditions —
baseline (hardcoded weights, `tau=0.15`), benign-only-trained (the first attempt's exact weights and
`tau=0.1696` from `docs/benchmarks/results/sentinel-training/trained-weights-2026-10-23.json`), and this round's
margin-trained weights — on the **identical** reduced held-out set, using `scripts/score-labelled-runs.py`'s
unmodified methodology (the `Adaptive` EMA controller, "names sender" attribution, the same invalid-run exclusion
rule).

**Reported, head to head, held-out split only, for all three conditions:**

- Attack runs detected with the right sender (`x`/13).
- Benign runs with any alert — false positives (`x`/9).
- Runs naming a non-sender (misattribution).
- The per-pattern breakdown (same shape `score-labelled-runs.py` already prints), specifically calling out
  `attack-synflood-1000pps` (this round's held-out generalization test) and the port-scan/ARP-flood patterns (held
  out, untouched by this round's objective, reported in full even if the result is a regression).
- **Separately, clearly labeled as training performance, not a held-out result:** how all three conditions score on
  the 5 runs the margin term trained on (`attack-synflood-200pps`, `attack-udpflood-500pps-1400b`). This number is
  expected to look good for the margin-trained condition since it was optimized partly for exactly these runs; it
  is reported for transparency about what the margin term actually saw, not folded into the held-out headline.

## What would count as an improvement, decided before looking

Same rule as the first attempt, applied on this round's held-out set: margin-trained weights are reported as better
than baseline only if they achieve a **higher or equal** attack-hit rate **and** a **lower or equal**
false-positive rate, with at least one strictly better — a weak Pareto improvement over baseline, not a blended
score. The same rule is applied, separately, against the benign-only-trained condition (the direct prior attempt),
since "beats the hardcoded baseline" and "beats the previous training attempt" are two different claims and neither
implies the other. **If the held-out `attack-synflood-1000pps` result (3/3 under baseline) regresses under
margin-trained weights, that is reported exactly as what it is — a regression on the one pattern this round
specifically designed a held-out generalization test for — not minimized or left out of the headline.** The same
goes for any regression on the port-scan or ARP-flood patterns this round's objective never targeted.

## Data-sufficiency caveat: the flood side is thinner than the benign side, and is said plainly now

8 valid flood runs across 3 patterns, with 5 runs across 2 patterns used for margin fitting and 3 runs of 1 pattern
held out, is very little data — thinner than the benign split's already-flagged 18 training / 9 held-out runs
across 12 total patterns. Concretely:

- The margin term's own "nested mean over patterns" is a mean over exactly **2** numbers. A fit that happens to find
  weights that work well for one of the two trained shapes (TCP SYN packets vs. large UDP frames) and poorly for
  the other would still show a plausible-looking blended training objective; with only 2 patterns there is no
  internal redundancy to catch that the way averaging over 8 benign patterns at least partially can.
- The held-out flood test is **1 pattern, 3 runs**. A single run's outcome changes that pattern's held-out rate by
  33%. This is thinner than even the benign side's thinnest held-out groups (2-3 runs) and should not be read as a
  stable estimate of "does the margin term generalize to flood attacks in general" — it is one data point about one
  specific rate variant of one specific tool, on one lab rig, repeated 3 times.
- **This should be read, at best, as "does this specific margin objective, fit on this specific small sample, show
  any sign of the generalization it was designed to test for" — not as a validated claim that margin training solves
  flood detection in general.** If the result is positive, it is a reason to gather more flood-attack data and
  repeat this with a larger, less thin split before trusting it operationally; it is not itself sufficient grounds
  for that trust.

## What was and will not be changed in the live system

Identical boundary to the first attempt. `scripts/gpu-sdn-anomaly-sentinel.py`'s opt-in `--weights-file` /
`GPU_SENTINEL_WEIGHTS_FILE` loading path (already implemented, already fail-closed, already tested) is reused
unmodified; this round does not touch it, the systemd unit, or any Jetson hardware. With neither flag nor
environment variable set, the deployed daemon keeps running the compiled-in hardcoded constants exactly as it does
today, regardless of this round's result.
