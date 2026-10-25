# Two-anchor margin training: pre-registration (batch 1 — sanity check only)

**2026-10-24 addendum (batch 3, owner-approved, added before batch 3's own numbers were looked at):** batch 2
resolved batch 1's ambiguity against the sample-size explanation: at the full CIC attack-training cap, lab held-out
recall stayed exactly at 2/13 (identical to batch 1's smaller sample), and weight-bound pinning got worse (1/10 →
3/10), while the CIC-benign false-positive rate stayed at ~0% on both days in both batches. The owner approved one
more bounded data point: **`--beta-cic-benign 0.25`** (favoring the lab-benign term 4:1 over the CIC-benign term),
full attack-training cap (`20,000`/class, same as batch 2), everything else unchanged from batch 2 (bounds,
optimizer, seed, CIC-benign anchor size, lab-benign pool size).

**Two reference points already exist without re-running anything:** `BETA=0` is exactly round 3's original objective
(`docs/benchmarks/results/sentinel-training-margin-cic/README.md`: lab recall 8/13, lab FP 4/9, CIC-benign FP rate
9.05%/9.70% Wed/Fri, 2/10 weights pinned near the upper bound — `w7`, `w8`); `BETA=1.0` is batch 2 (lab recall 2/13,
lab FP 1/9, CIC-benign FP rate 0.00%/0.00%, 3/10 weights pinned — `w1` lower, `w5`/`w7` upper).

**Prediction, stated before running, so it can be checked rather than rationalized after the fact:** the continuous
training-objective components (`L_benign_lab`, `L_benign_cic`, `L_margin` raw hinge) are expected to move
*monotonically* between the two endpoints as `BETA` increases from 0 to 1 — they are averages over thousands of
windows, which smooths out the loss surface's ReLU/max kinks, so there is no specific reason to expect them to jump.
**The discrete lab-held-out metrics (recall, false positives — counts out of 13 and 9 runs) are expected to behave
less smoothly, and specifically are predicted to land closer to the `BETA=1.0` endpoint (2/13) than to a linear
interpolation's midpoint (~6-7/13) — i.e., in the 2-5/13 range, not 6+.** Reasoning: (1) these are threshold-crossing
decisions (the `Adaptive` controller's binary alert/no-alert call) on top of already-smooth continuous losses, so a
modest continuous shift can still flip a discrete outcome, especially with only 13 runs to read the result from, which
is coarse enough that "smooth underlying trend" and "jumpy observed count" are not in tension; (2) batch 2 showed
weight-bound pinning *getting worse*, not better, when the attack-training population scaled up at `BETA=1.0`-this
suggests the margin (hinge) term's own pressure toward extreme weights, driven by 40,000 full-scale attack windows,
is a strong force largely independent of how much the benign-cic term is weighted, and a quarter-strength competing
term is not expected to be enough to fully counteract it. **Symmetrically, the CIC-benign false-positive rate is
predicted to already be mostly fixed (closer to `BETA=1.0`'s ~0% than to `BETA=0`'s ~9-10%) even at `BETA=0.25`** —
the hypothesis here is that it does not take much opposing pressure on the specific weights (`w7`/`w8`) that round 3
diagnosed as the broad-sensitivity culprits to pull them back from the bound enough to stop the worst of the
false-positive blowup, even if that same modest pressure is not enough to also preserve lab recall.

**If both predictions hold** (recall closer to the collapsed end, CIC-benign FP rate closer to the fixed end, both
at the same `BETA=0.25`), that is read as evidence of a **sharp cliff**: the CIC-benign fix is "cheap" to get (a small
`BETA` buys most of it) but recall damage is not "expensive to avoid" in the same proportional way — there may be no
single `BETA` that buys both at once, and a workable middle ground may not exist on this axis alone (a different
mechanism — e.g. a smaller MARGIN, or down-weighting LAMBDA alongside BETA — might be needed instead, not tested
here). **If instead `BETA=0.25` lands closer to a linear interpolation on recall (6-7/13) with a correspondingly
only-partially-fixed CIC-benign FP rate (roughly 4-6%, not nearly 0%)**, that is read as evidence of a genuine
*gradient* — a workable middle ground plausibly exists and a finer sweep (e.g. `BETA` in `{0.1, 0.4, 0.6}`) would be
the next useful bounded step, not this document's business to run unprompted.

This addendum does not change anything else in this document: the objective formula, `LAMBDA`, bounds, optimizer, CIC
attack/benign sample sizes, or the "what this batch does not do" scope (still no four-axis evaluation, still no PR).

**2026-10-24 addendum (batch 2, owner-approved, added before batch 2's own numbers were looked at):** batch 1's
informal peek (never a formal result, flagged as such at the time) showed the lab held-out split's attack-detected
count collapsing from baseline's 10/13 to 2/13 under the two-anchor-trained weights, alongside one weight landing
within 0.0003 of its lower bound. Two explanations were left open in batch 1's report: (a) this is a small-sample
artifact of batch 1's deliberately 10x-shrunk CIC attack-training cap (2,000/class vs. round 3's 20,000/class), or
(b) it is a real cost of the equal-weighted (`BETA=1.0`) CIC-benign anchor term itself. The owner approved one more
bounded experiment to tell these apart, run before any full evaluation: **re-run the identical two-anchor objective
and weighting (same `BETA=1.0`, `LAMBDA=1.0`, hinge formula, bounds, optimizer config, and seed as batch 1) with the
CIC attack-training cap restored to round 3's full `20,000` windows/class for `DoS Hulk`/`DoS GoldenEye`, changing
nothing else.**

The CIC-benign anchor cap (2,000 windows/day) and the lab-benign training pool (unchanged, ~6,264 windows) are
**deliberately held fixed at batch 1's values, not scaled up**, even though scaling them too might arguably be "more
representative" of a real full run. This is a one-variable-at-a-time isolation, chosen specifically because the
question this experiment answers only has a clean answer if exactly one thing changed: if the CIC-benign anchor size
also changed, a recall change afterward could not be attributed to the attack-training sample size alone, which is
the entire point of running this second experiment instead of jumping straight to a full run. If the hypothesis this
experiment is testing needs a larger benign anchor too, that is exactly the kind of question a further, separately
pre-registered experiment should isolate — not something to fold into this one and lose the isolation.

**What counts as resolving the ambiguity, decided now, before batch 2 is run:**

- **Lab held-out attack-detected (right sender) of 6/13 or higher** (informal peek, same 9-benign/13-attack reduced
  split as every prior round, same caveat that this is a peek on a thin split, not a formal axis (a) evaluation): read
  as recall recovering materially toward baseline (10/13) and round 3's full-CIC run (8/13) — consistent with
  explanation (a), sample size, and two-anchor being reasonably read as ready for a full run (pending the other sanity
  checks below still looking sane).
- **3/13 or lower** (no material change from batch 1's 2/13): read as recall staying collapsed — consistent with
  explanation (b), a real cost of the equal-weighted CIC-benign term, and the next move being the pre-registered
  `BETA`-sweep fallback (a lower `--beta-cic-benign`) rather than a full run at `BETA=1.0`.
- **4-5/13**: reported honestly as partial/ambiguous, neither bucket forced, with the caveat repeated that 13 runs is
  too few for a one-run swing (≈8 percentage points) to be read as a stable rate either way.
- Independently of the recall threshold above, the weight-bound-proximity check (`BOUND_PIN_EPS=0.01`, same as batch
  1) and the no-NaN/Inf check are re-applied and reported on their own terms, not folded into the recall verdict —
  a run could resolve the recall ambiguity in either direction while also surfacing a new or worse pinning problem,
  and that would be reported as exactly that, not smoothed over.

This addendum does not change anything else in this document: the objective formula, `BETA`, `LAMBDA`, bounds,
optimizer, or the "what this batch does not do" scope (still no four-axis evaluation, still no PR this round).

## Batch 1 (original pre-registration, below, unedited)

Written 2026-10-24, before any two-anchor objective value is computed and before any held-out or sanity number is
looked at. Same convention as the three prior rounds'
[`../sentinel-training/PREREGISTRATION.md`](../sentinel-training/PREREGISTRATION.md),
[`../sentinel-training-margin/PREREGISTRATION.md`](../sentinel-training-margin/PREREGISTRATION.md), and
[`../sentinel-training-margin-cic/PREREGISTRATION.md`](../sentinel-training-margin-cic/PREREGISTRATION.md): results
go next to this file, and this file is not edited afterwards except to add a dated note saying what changed and why.

**This document covers a sanity check, not a full evaluation.** The owner's explicit instruction for this batch was
small and bounded: design the objective, pre-register it, run it on a small sample to see whether the optimizer
behaves (no NaN/Inf, fitted weights not pinned to their bounds, a sane objective value), and stop. No held-out
four-axis evaluation (the kind `../sentinel-training-margin-cic/README.md` ran) is performed in this batch, no PR is
opened, and nothing here is a claim about detection quality. A full run, if this batch's sanity check looks healthy,
is a decision for the owner to make after reading this batch's report — not something this batch pre-commits to.

## Why this round exists

[`../sentinel-training-margin-cic/README.md`](../sentinel-training-margin-cic/README.md) (round 3) refit the
lab-margin objective's attack side on CIC-IDS2017's much larger flood population and measured a real recall gain on
CIC's own held-out floods (e.g. Friday DDoS: 0.68% → 100.00%) bought at the cost of a false-positive rate on CIC's
*own* benign traffic of roughly 9-10% — 28-47x every other condition's rate on the same data. That round's diagnosis,
not just an observation: two of the ten weights (`w7 = 4.999854`, `w8 = 4.999229`) sit within 0.0008 of the
pre-registered upper bound (`5.0`). The fit did not learn to recognize CIC's attacks specifically — it moved the
whole reconstruction function into a broadly more reactive regime that fires on anything statistically unlike the
*one* benign pool (this lab's own training-benign windows) the objective was ever told to reconstruct well. Nothing
in rounds 1-3's objectives ever rewarded the fit for also reconstructing a second, independently-sourced "this is
normal" distribution well — every version anchors to exactly one benign reference, so "unfamiliar" and "hostile"
become indistinguishable to the fit by construction, not by bad luck of the random seed.

**The architectural fix tested here:** stop anchoring to a single benign pool. Add a second, independently-sourced
benign anchor — CIC-IDS2017's own benign traffic (Wednesday + Friday pre-attack periods) — so the objective has to
find weights that reconstruct *two* different organizations' ordinary traffic well, not just the lab's. Round 3's own
pipeline already extracted this data (`scripts/cic-flood-margin-sampler.py`'s `BENIGN` buckets) but only ever used it
as a one-off held-out check (round 3's axis (c)); this round is the first to feed it into the training objective
itself.

## What is being fit (architecture unchanged, objective gains a third term)

Identical scope restriction to all three prior rounds: the same ten scalars `w0..w9` in
`kernel_loss`/`gpu_anomaly_kernel.cu`, no redesign of the window size (64 packets), the four input features, or the
network shape. `scripts/train-sentinel-weights-cic.py` gains a new `--objective two-anchor` mode (reusing, not
duplicating, `scripts/train-sentinel-weights.py`'s `kernel_loss_batch`, `self_check`, `load_and_split`,
`pooled_training_losses`, `margin_target`, `score_holdout`, `validate_weights_payload`, `BOUNDS`/`SIGMA`/`DE_*`
constants, and `scripts/cic-flood-margin-sampler.py`'s cached `.npz` output via the existing `load_npz_bucket`
helper). The existing `--objective margin-cic` mode (round 3's exact objective) is untouched and still reproduces
round 3's published numbers unchanged — this round does not modify any code path that mode exercises.

## Exact objective

Three terms, not two:

- **`L_benign_lab(W)`** — unchanged from every prior round: the nested pattern/run/window mean of `kernel_loss` over
  the lab's own 8 training-benign patterns (`TRAIN_BENIGN_PATTERNS`, 18 runs, ~6,264 windows). This is the actual
  deployment target and is never reduced or resampled in this round, sanity check or not — it is already small by
  design (every prior round's own data-sufficiency caveat) and reusing it exactly, unshrunk, keeps this round's
  benign-lab numbers directly comparable to rounds 1-3's.
- **`L_benign_cic(W)`** — **new this round.** A nested day mean: mean over the 2 CIC benign day-blocks (Wednesday
  pre-attack, Friday pre-attack) of (mean over that day's windows of `kernel_loss`). Nested by day, not pooled flat
  across both days, for the same reason every other nested term in this project exists: a day with more sampled
  windows must not get more influence over the fit just because it is a larger block. CIC's own flood-attack margin
  term in round 3 used exactly this "one block per class, mean over blocks" structure for the same reason (CIC
  captures do not have the lab's multi-run repeat structure).
- **`L_margin(W)`** — **round 2/3's formula, reused unchanged**, no redesign. For each window `a` in the CIC
  attack-training set (Wednesday `DoS Hulk` + `DoS GoldenEye`, the same two labels round 3 trained on, for the same
  reason: largest-volume in-scope labels, two different HTTP-flood mechanics, not two rates of one shape):
  `hinge(a, W) = max(0, target(W) - kernel_loss(a; W))`, `target(W) = benign_mean(W) + SIGMA*benign_std(W) + MARGIN`.
  **`target(W)` is computed from the LAB benign pool only** (`benign_mean`/`benign_std` over `L_benign_lab`'s pool),
  never from the new CIC-benign anchor — unchanged from rounds 2 and 3. This keeps the training-time hinge target and
  the deployed `base_tau` (calibrated the same way, downstream, from lab-benign only) anchored to the same reference
  distribution this round as every prior round; the new CIC-benign anchor participates in the objective as its own
  separate reconstruction-quality term, not as a second source for the attack-margin threshold.
  `L_margin(W)` = nested mean over the 2 CIC training classes of (mean over windows of `hinge`), same as round 3.

**Total objective:** `L(W) = L_benign_lab(W) + BETA * L_benign_cic(W) + LAMBDA * L_margin(W)`.

### Term weights, decided now

- **`LAMBDA = 1.0`** — unchanged from rounds 2 and 3. The task that set up this round asked for justification only if
  the margin formula itself changes; it does not here, so its weight does not either.
- **`BETA = 1.0`** (CIC-benign anchor weighted equally with the lab-benign term). Reasoning, stated before any number
  is looked at:
  - The *deployed* operating point — the `base_tau` threshold actually used for detection, and every prior round's
    headline held-out metric (axis (a), the lab's own held-out split) — is calibrated **from the lab-benign pool
    only**, unchanged in this round. That anchoring is what makes the lab "the actual deployment target" in a way
    that survives this change: regardless of how the training *loss* weighs the two benign terms, the number that
    decides whether an alert fires in production never reads a CIC window. The deployment-fidelity protection this
    round's brief asked about is therefore already built into the pipeline one level downstream of the objective,
    not something the loss weighting itself needs to re-provide.
  - Given that, the loss-weighting question becomes narrower: how much should the *fit itself* be pulled by a second,
    independent "this is normal" signal versus the first? Equal weighting treats both benign pools as equally
    authoritative evidence about what a reconstruction function should look like for traffic that is not an attack —
    which is the literal content of the fix being tested (two independent anchors, neither structurally privileged by
    the objective's own arithmetic). Downweighting the CIC term now, before any evidence exists about how much pull
    it actually needs to stop the pinned-bound failure, would be choosing an answer to the question this batch exists
    to measure rather than measuring it.
  - The concrete risk of equal weighting — that the CIC anchor pulls the fit away from good lab-benign reconstruction
    — is exactly one of the things this batch's sanity check is designed to surface (via `L_benign_lab`'s own value at
    the fitted weights, reported separately, never blended with the other two terms). If a full run later shows `BETA
    = 1.0` measurably degrades lab-held-out performance relative to round 3, that is a concrete, evidence-based reason
    to downweight it in a follow-up batch — a decision this batch deliberately leaves for after there is a number to
    make it with, not before.
  - `BETA` is a named CLI flag (`--beta-cic-benign`, default `1.0`), not a buried constant, specifically so a future
    batch can sweep it without editing code.

### Bounds, optimizer: unchanged from every prior round

Weight bounds `[-3.0, 5.0]` for all ten scalars (`BOUNDS`, reused from `scripts/train-sentinel-weights.py`).
`scipy.optimize.differential_evolution` (`seed=42`, `popsize=20`, `maxiter=150`, `tol=1e-10`, `polish=True`) followed
by `scipy.optimize.minimize(method="Nelder-Mead", bounds=BOUNDS, ...)` (the round-2 bugfix that makes the polish step
actually respect the box, reused, not re-introduced). **Deliberately not scaled down for this sanity check**: the
question this batch asks is whether the *existing* optimizer configuration behaves sanely on the new three-term
objective shape; changing the search budget and the data scope in the same run would leave no way to tell whether a
bad result came from too little search or from the objective itself. If this makes the sanity run too slow for a
single sitting, the measured wall-clock time is reported honestly rather than the budget being quietly shrunk after
the fact.

## Data for THIS sanity check specifically — small and bounded, not the full round-3 scale

Round 3's cached `.npz` feature windows already exist at `/tmp/cic-flood-margin-cache/{wednesday,friday}.npz`
(confirmed present before writing this document; each file's `BENIGN__features` bucket has 25,000 windows per day,
and the `DoS_Hulk`/`DoS_GoldenEye` buckets have 20,000 each — round 3's own sampler output, not re-streamed from the
raw pcaps for this check). This batch reuses those files directly and draws a small, bounded subsample from each
bucket by contiguous index range (the buckets are already time-ordered by `load_npz_bucket`'s stable epoch sort, so
"first N" is a deterministic, reproducible time-ordered prefix, the same sampling discipline round 3's own sampler
used) — **no raw pcap is re-read for this batch.**

- **Lab benign training pool:** unchanged, full set (8 patterns, 18 runs, ~6,264 windows) — see above for why this is
  not shrunk.
- **CIC benign anchor (new term, training):** the first **2,000** windows of each day's cached `BENIGN` bucket
  (Wednesday, Friday) — **4,000 windows total**, a bounded subsample of round 3's cached 25,000-per-day sample, not
  the full amount.
- **CIC benign held-out peek (informal only, see "what counts as sane" below):** the *next* 2,000 windows of each
  day's cached `BENIGN` bucket, indices `[2000:4000)` — disjoint from the anchor slice, used only for an exploratory
  look, never for training, and not reported as a validated result.
- **CIC attack margin-training:** the first **2,000** windows of each of Wednesday's `DoS Hulk` and `DoS GoldenEye`
  cached buckets — **4,000 windows total**, a 10x-smaller subsample of round 3's 20,000-per-class training population.
- **Lab held-out split:** unchanged structure (9 benign + 13 attack runs, the same reduced split rounds 2/3
  published against), used only for the same kind of informal peek as the CIC-benign slice above — not a formal
  axis (a) evaluation.

Total training-objective window budget this batch: ~6,264 (lab benign) + 4,000 (CIC benign anchor) + 4,000 (CIC
attack margin) ≈ 14,264 windows per objective evaluation — well under round 3's ~46,264, and in line with the task's
instruction to use "a few thousand windows per term, not tens of thousands."

## What counts as "behaves sanely," decided before running

This batch is not graded on a held-out metric. It is graded on whether the optimizer's behavior is sane enough to be
worth a full run at all:

1. **No NaN/Inf.** The baseline (hardcoded) weights' three-term objective value, and the final `differential_evolution`
   / `Nelder-Mead` results, must all be finite. `self_check()` (reused unmodified from round 1) must pass on both a
   real lab window and a real CIC window before any fitting starts, exactly as round 3 ran it.
2. **Fitted weights not pinned to their bounds.** Any of the ten fitted weights within **0.01** of either bound
   (`-3.0` or `5.0` — a looser, more conservative flag than round 3's own disclosed `0.0008`, chosen so this batch
   does not under-report a near-miss) is reported explicitly, by index and value, as a repeat of round 3's failure
   mode — this is the single most direct, fastest-to-check signal this batch exists to get early.
3. **Objective value is sane relative to input scale.** Each of the three terms is reported separately at both
   baseline and fitted weights (`L_benign_lab`, `L_benign_cic`, and the raw mean-hinge value before `LAMBDA` is
   applied) — never blended into one number, so a win in one term hiding a blowup in another is visible immediately,
   not after the fact. "Sane" means: all three terms finite and of a magnitude comparable to the `kernel_loss` scale
   already established in rounds 1-3 (training losses there ranged roughly 0.10-0.25) — not a specific target value,
   since none is pre-registerable without first knowing what this new term's natural scale is.
4. **Informal peek, explicitly not a result:** the lab's existing 9-benign/13-attack held-out split and the disjoint
   4,000-window CIC-benign peek slice (2,000/day) are scored under baseline vs. this batch's fitted weights, using
   the same reused scoring code as every prior round, purely to catch an immediately, obviously broken outcome (e.g.
   100% false positives everywhere) before spending a full run finding it the slow way. This is explicitly **not**
   axis (a)/(b)/(c) from round 3 — no improvement verdict is computed or claimed from it, the sample is smaller and
   was not designed as a generalization test, and it is reported only as a sanity signal, not a number to cite later
   as evidence of quality.

If any of checks 1-2 fail, that is reported plainly as a broken or degenerate sanity check — a legitimate, useful
outcome for this batch, per the task's own instruction, not something to explain away.

## What this batch does not do, stated plainly

- No four-axis held-out evaluation (round 3's axis (a)/(b)/(c) battery).
- No PR, no recommendation to deploy, no claim about detection quality.
- No sweep of `BETA` or `LAMBDA` — one weighting, decided above, is tested once.
- No re-streaming of the raw CIC pcaps — this batch is scoped to what round 3's cached `.npz` files already contain
  at the index ranges listed above; if a full run needs more than 20,000-25,000 windows per bucket from either day,
  that full run would need to re-run `scripts/cic-flood-margin-sampler.py` against the raw files, which this batch
  does not do.

## What was and will not be changed in the live system

Identical boundary to all three prior rounds. `scripts/gpu-sdn-anomaly-sentinel.py`'s opt-in `--weights-file` /
`GPU_SENTINEL_WEIGHTS_FILE` loading path is untouched by this batch; this batch does not touch the systemd unit or
any Jetson hardware. This batch is pure offline research against already-cached derived data; nothing here touches
live hardware, and no weights produced by this batch are recommended for deployment regardless of outcome — that
question is out of scope for a sanity check by definition.
