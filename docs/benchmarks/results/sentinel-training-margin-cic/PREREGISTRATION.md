# CIC-IDS2017-augmented margin training: pre-registration

Written 2026-10-23, before any CIC window is ever run through `kernel_loss` and before any held-out number from this
round is looked at. Same convention as
[`../sentinel-training/PREREGISTRATION.md`](../sentinel-training/PREREGISTRATION.md) (the first, benign-only attempt)
and [`../sentinel-training-margin/PREREGISTRATION.md`](../sentinel-training-margin/PREREGISTRATION.md) (the lab-only
margin attempt, PR #106): results go in `README.md` next to this file; this file is not edited afterwards except to
add a dated note saying what changed and why.

**2026-10-23 addendum, added after this round's held-out numbers were already produced and published, documenting
pre-push-gate findings fixed afterward — none of which touched this document's objective, split, caps, or
improvement rule:** this round's first push was blocked by the repository's strict pre-push AI-review gate on five
findings in `scripts/cic-flood-margin-sampler.py` / `scripts/train-sentinel-weights-cic.py`, all fixed, not
bypassed: (1) `score_cic_block` stored derived false-positive/recall rates as floats rather than formatting them from
integer counts only at print time; (2) a comment claimed a held-out-split shape check that the code did not actually
perform; (3) a margin-training CIC bucket coming back under its pre-registered cap would have been silently
under-reported rather than failing loudly; (4) the benign-generalization cutoff's early-stop logic assumed
non-decreasing capture timestamps without checking it; (5) `self_check` had only ever been run against a lab-sourced
window, never a CIC-sourced one. Fixing (1) was display-only. Fixing one of the accompanying suggestions — using a
stable sort (`kind='stable'`) when re-sorting a loaded `.npz` bucket by epoch, rather than trusting an unstable
sort's tie-breaking to match the sampler's own emission order — **did change a handful of axis (b)/(c) counts by a
small amount** (a few windows out of 20,000-25,000 per cell; every change is within 0.02 percentage points at the
precision `README.md` reports, e.g. `DoS slowloris` baseline recall `5.24%→5.22%`, this round's `CIC-Wed-Benign`
false-positive rate `9.06%→9.05%`), because the `Adaptive` controller's EMA state is sequential and order-sensitive,
and a few windows shared a tied epoch. The fitted weights, calibrated `tau`, and training-objective value are
**unchanged, confirmed by direct comparison** (fitting is a pooled mean/std over windows, which is order-invariant;
only the sequential per-window `Adaptive` replay used for axis (b)/(c) reporting is order-sensitive). `README.md` was
updated to the corrected (stable-sort) numbers before this round's PR was opened; no number in it reflects the
unstable-sort run. None of this round's qualitative verdicts changed.
per-label flow counts in the CIC-IDS2017 CSVs, and the epoch ordering of attacks within each captured day. Nothing
below depends on any `kernel_loss` value, trained weight, or detection outcome.

## Why this round exists

[`../sentinel-training-margin/README.md`](../sentinel-training-margin/README.md) (PR #106) added a hinge/margin term
to the sentinel's objective using this lab's own flood-attack captures, and it worked on the one axis it was built
for (matched baseline 8/8 including the held-out rate) — but the flood class in that dataset is only 3 patterns
across 8 runs, too thin to know whether the result is real or an artifact of a small, idiosyncratic sample.
[`../cic-ids2017-adapter/README.md`](../cic-ids2017-adapter/README.md) (PR #107) validated a pipeline that joins the
public CIC-IDS2017 benchmark's raw packet captures to their flow labels at 99.98-99.99% coverage, but did not use
that data for anything — it only proved the join works. This round combines the two: refit the margin term using
CIC's much larger flood-attack population instead of the lab's 8-run set, while keeping the benign side of the
objective anchored to this lab's own traffic (the actual deployment target), and use CIC's own benign traffic as a
second, separate check of whether the result holds up on a different network entirely.

## Scope of the attack pool, and what is excluded

The task that set up this round named five CIC-IDS2017 labels as in-scope "flood-shaped" attacks: Wednesday's DoS
Hulk, DoS GoldenEye, DoS Slowloris, DoS Slowhttptest, and Friday's DDoS — all generated against the same simulated
victim IPs by a flooding/connection-exhaustion tool, the same broad behavioral category the sentinel's margin term
is meant to separate from benign reconstruction error. Three things are explicitly excluded, and why:

- **PortScan** (Friday, 158,930 flows): `scripts/portscan-rule-detector.py` (merged, PR #104) already gets 10/10
  port-scan detections with 0/30 false positives on this lab's own dataset using a dedicated, deterministic
  distinct-destination-port counter. Spending this round's objective on re-deriving port-scan separation inside the
  sentinel's ten shared weights would duplicate a solved problem and risk trading away margin on the attacks that
  still need it. Same reasoning PR #106 used for the lab's own portscan runs.
- **Bot** (Friday, 1,966 flows): command-and-control beaconing from an internal, already-compromised host is a
  fundamentally different traffic shape from a flood — low-rate, often indistinguishable in packet timing from
  ordinary client chatter — not a resource-exhaustion attack. Training a flood-margin term on it would conflate two
  different behaviors under one hinge target; out of scope for this objective by design, not an oversight.
- **Heartbleed** (Wednesday) — **verified, not assumed, from the real CSV**: `Label == 'Heartbleed'` appears in
  exactly **11 rows** of `Wednesday-workingHours.pcap_ISCX.csv` (counted directly: `python3 -c` with `csv.reader`
  over the real file, no sampling). This is far inside the "single/double digits -> drop it" threshold the task set
  in advance. 11 flows cannot support a training signal distinguishable from noise, and is excluded. (For contrast,
  every other in-scope label has at least 5,499 flows — three orders of magnitude more.)

Measured flow counts for every label in the two downloaded CSVs (Wednesday, Friday-Morning, Friday-Afternoon-x2),
counted directly from the real files, not estimated:

| Day | Label | Flows (rows) | In scope this round? |
| :--- | :--- | ---: | :--- |
| Wednesday | BENIGN | 440,031 | benign side, see below |
| Wednesday | DoS Hulk | 231,073 | **yes — margin-training** |
| Wednesday | DoS GoldenEye | 10,293 | **yes — margin-training** |
| Wednesday | DoS Slowhttptest | 5,499 | **yes — held-out** |
| Wednesday | DoS slowloris | 5,796 | **yes — held-out** |
| Wednesday | Heartbleed | 11 | no — too rare (verified above) |
| Friday | BENIGN | 414,322 (191,033 morning + 128,027+97,718... see note) | generalization check only |
| Friday | Bot | 1,966 | no — different behavioral shape |
| Friday | PortScan | 158,930 | no — dedicated detector exists |
| Friday | DDoS | 128,027 | **yes — held-out** |

(Friday's BENIGN count above is the morning CSV's own count; the two afternoon CSVs — PortScan and DDoS — each also
carry their own BENIGN rows for background traffic during those windows, not summed here since this round's CIC
benign sample is drawn only from the pre-attack morning period, see below.)

## Three components of the objective and evaluation: benign (lab), attack-train (CIC), held-out (lab + CIC + CIC-benign)

### Benign side: unchanged, reused verbatim from PR #105/#106

`TRAIN_BENIGN_PATTERNS` (8 lab patterns, 18 runs) and `HOLDOUT_BENIGN_PATTERNS` (4 lab patterns, 9 runs) are byte-for-
byte the same frozensets already in `scripts/train-sentinel-weights.py`, imported and reused, not redefined. This is
deliberate, not an oversight: the task this round was scoped under is explicit that the deployment target is this
lab network, not a generic enterprise network, so CIC's benign traffic must never become a training target — only a
held-out generalization check (below). `L_benign(W)` is the identical nested pattern/run/window mean PR #105/#106
used.

### Attack-training side: CIC flood data replaces the lab's flood runs for this round's objective

This round's margin term is trained on **CIC flood windows only, not the lab's own flood runs** (`attack-synflood-*`,
`attack-udpflood-*`). This is "instead of," not "in addition to," by design: the point of this round is to test
whether a far larger, more diverse attack population changes the result, which requires swapping the attack-side
population wholesale rather than mixing it with the thin lab set and confounding the comparison. The lab's own flood
runs are *not* abandoned — they move to the evaluation side (see "Lab held-out," below), which this round never
trains on, same as every other condition compared against it.

**Training classes (2): Wednesday DoS Hulk, DoS GoldenEye.** Chosen because (a) they are the two largest-volume
labels in scope (231,073 and 10,293 flows respectively — by far the most headroom above the per-class sample cap
chosen below), and (b) together they cover two different HTTP-flood mechanics — Hulk's brute-force high request
volume versus GoldenEye's keep-alive connection exhaustion — the same "two different shapes, not two rates of the
same shape" reasoning PR #106 used when it picked a SYN flood and a UDP flood for its own two training patterns.

### Held-out attack side: a genuinely different slice, by mechanism and by day — never touched by training

Three CIC attack groups are held out, never read by the margin term, matching the task's no-leakage requirement
(a different tool/variant or a distinct time period, not a random packet split within the same campaign):

1. **Wednesday DoS Slowloris + DoS Slowhttptest (same day, different mechanism).** These are explicitly "low and
   slow" resource-exhaustion attacks — few packets, long-held connections — a different attack *mechanism* from the
   high-packet-rate volumetric floods (Hulk, GoldenEye) the margin term actually trains on, despite being the same
   broad "HTTP DoS" family and the same day's capture. This tests whether the fit generalizes to a flood-family
   attack it was never shown, not just memorizes Hulk/GoldenEye's specific packet shape.
2. **Friday DDoS (different day, different tool entirely).** A different day's capture, a different attack
   campaign (CIC's documentation describes this as LOIC-driven), the largest single generalization gap in this
   round's evaluation: Wednesday's HTTP-DoS campaign was never shown this day's traffic, this protocol mix, or this
   tool's behavior at all.

This mirrors PR #106's own no-leakage design (train on one flood shape/rate, hold out a different one) but with two
independent held-out axes (same-day-different-mechanism, and cross-day-different-tool) instead of one, which is a
*stronger* generalization test than PR #106 ran, not a repeat of it.

### CIC-benign generalization check: a separate, held-out, never-trained-on axis

A capped sample of CIC BENIGN-majority windows, drawn **only from the time period before that day's first attack of
any kind begins** (a 60 s safety margin before the earliest attack flow's start epoch, on either day — see "sample
caps" below for the exact cutoff epochs), so there is zero possibility of boundary contamination from a nearby
attack window even under the label join's own 90 s slack. This is reported as its own section in `README.md`, never
folded into the primary lab-held-out or CIC-attack-held-out tables: it answers a different question ("does this stay
quiet on an entirely different organization's ordinary traffic"), not "does it still catch our lab's attacks."

## Sample-size caps, fixed before extraction

CIC's flood attacks alone are hundreds of thousands of flows and millions of windows; fitting 10 scalar parameters
does not need remotely that much data, and reading all of it would be slow for no statistical benefit. Caps, chosen
in advance:

- **`TRAIN_CAP_PER_CLASS = 20,000` windows** (Hulk, GoldenEye). Far below the hundreds of thousands to millions
  naturally available for either class, so no wasted dissection time; roughly 2-4x PR #106's *total* margin-training
  window count (~10,815 windows pooled across its two lab patterns) **per class alone** here — a real increase in
  statistical power, not a token one. The cap does not affect optimizer wall-clock cost: `kernel_loss_batch` is
  vectorized, so a mean/std over 20,000 rows costs microseconds; the cap exists to bound *extraction* time against
  the pcap, not search time.
- **`HOLDOUT_CAP_PER_CLASS = 20,000` windows** (Slowloris, Slowhttptest, DDoS) — the same cap, for consistency.
  Slowloris and Slowhttptest's natural availability (22,690 and 31,223 windows respectively, by the already-published
  full-file label distribution in `../cic-ids2017-adapter/README.md`) means this cap captures most-to-all of what
  exists for those two — effectively close to a census, not a thin sample — while still bounding Friday DDoS (over a
  million available) to a tractable, comparable size.
- **`BENIGN_GENERALIZATION_CAP = 25,000` windows per day** (Wednesday pre-attack, Friday pre-attack; 50,000 total).
  Slightly larger than the attack caps because a false-positive-rate estimate benefits from more samples in the
  (expected) low-alert-rate regime, and this sample is the cheapest to collect — it is satisfied within the first few
  minutes of each day's stream, before any attack begins.
- **Sampling method, disclosed plainly:** each capped bucket is filled with the *first N windows encountered in time
  order* within that class's labelled span, not a uniform random subsample across the full campaign (no RNG is used
  for this — the pass is a single deterministic sequential stream per day). This may bias a bucket toward the
  earlier-occurring instances of a class rather than representing its full multi-hour span uniformly. This is an
  accepted, disclosed simplification for this round, not presented as a uniform sample.

All actual sample sizes achieved (which may be below the cap where a class's own availability is smaller, as
expected for Slowloris/Slowhttptest) are reported in `README.md`, not assumed to equal the cap.

## Benign-cutoff epochs for the CIC-benign generalization sample (measured, not assumed)

Computed directly from `scripts/cic-ids2017-adapter.py`'s `scan_capture_window` (a full streaming pass reading only
`pkt.time`, independent of any attack label) plus the earliest `start_epoch` of any attack-labelled flow once
resolved by `scripts/cic-ids2017-labels.py`'s `TZ_OFFSET_HOURS = -3` fix:

- **Wednesday:** capture window `[1499254962.08, 1499285419.78]`. Earliest attack flow (DoS Slowloris) starts at
  `1499256060.0` (1,098 s into the capture). Benign-sample cutoff: `1499256000.0` (1,038 s in, a 60 s margin before
  the earliest attack of any kind).
- **Friday:** capture window `[1499428779.60, 1499457761.17]`. Earliest attack flow (Bot — out of scope for training
  but still an attack, so still excluded from the benign window) starts at `1499430840.0` (2,060 s into the
  capture). Benign-sample cutoff: `1499430779.6` (2,000 s in).

Only windows whose majority label is `BENIGN` **and** whose `window_end_epoch` is before that day's cutoff are
eligible for the generalization-check bucket.

## Exact objective: PR #106's formula, reused unchanged, attack-side population swapped

The hinge/margin formula itself is **not** changed from PR #106 — this round is a test of whether a different
*attack-training population* changes the result, not a test of a different formula; changing both at once would
confound the comparison. Exactly as before:

- `B` = the pooled set of lab training-benign windows (unchanged `TRAIN_BENIGN_PATTERNS` pool).
- `benign_mean(W)`, `benign_std(W)` = mean/std of `kernel_loss(w; W)` over every window in `B`.
- `L_benign(W)` = nested mean over the 8 lab training patterns of (mean over runs of (mean over windows)) —
  unchanged.
- `target(W) = benign_mean(W) + SIGMA * benign_std(W) + MARGIN`, `SIGMA = 2.5` (the same sensitivity sigma the
  deployed `Adaptive` EMA controller and both prior training rounds use), `MARGIN = 0.02` (unchanged fixed headroom).
- For each window `a` in the CIC attack-training set `A` (Hulk + GoldenEye, capped as above):
  `hinge(a, W) = max(0, target(W) - kernel_loss(a; W))` — unchanged, bounded below at zero, no reward for pushing
  attack loss arbitrarily past the target.
- `L_margin(W)` = nested mean over the **2 CIC training classes** of (mean over **exactly 1 block ("run") per
  class** of (mean over windows of `hinge`)). CIC captures do not have a natural "repeat trial" structure the way
  the lab's pcaps do (each lab pattern was captured multiple times as independent runs; each CIC attack label is one
  continuous campaign recorded once) — so each CIC training class contributes exactly one block rather than several
  runs. The nested pattern-mean still does its job (neither class's window count can dominate the other purely
  because it has more windows), it is just a mean over 2 single-block "patterns" instead of 2 multi-run ones.
- **Total objective:** `L(W) = L_benign(W) + LAMBDA * L_margin(W)`, `LAMBDA = 1.0` — unchanged.
- **Bounds, optimizer, threshold calibration: unchanged from both prior rounds.** Weight bounds `[-3.0, 5.0]` for all
  ten scalars; `scipy.optimize.differential_evolution` (seed=42, popsize=20, maxiter=150, tol=1e-10, polish=True)
  followed by `Nelder-Mead` polish with `bounds=BOUNDS` explicitly passed (the fix PR #106 made after finding the
  unbounded-polish bug — reused, not re-introduced). The deployed `base_tau` for this round's trained weights is
  `benign_mean(W*) + 2.5 * benign_std(W*)` computed **from the lab training-benign pool only** — never from CIC
  benign windows, deliberately, so the CIC-benign generalization check (below) is not circularly guaranteed by having
  calibrated the alarm threshold against the same data it is being asked to stay quiet on.

## Evaluation: three axes, scored by the mechanism appropriate to each, never blended into one number

### Axis (a): lab held-out split, for continuity with PR #105/#106's own published numbers

Reuses `scripts/train-sentinel-weights.py`'s existing `load_and_split(datadir, objective="margin")` **unchanged** —
the identical 9-benign/13-attack reduced held-out split PR #106 published its own headline table against (4
port-scan patterns, 10 runs, plus the held-out flood pattern `attack-synflood-1000pps`, 3 runs). This is the same
split, not a re-derived one, specifically so this round's numbers on this axis sit in the same rows PR #106 already
reported, not a different experiment using the same words. Scored via the unmodified `score_holdout` (run-level:
attack runs detected with the right sender, benign runs with any false positive, misattributions), for all four
conditions: baseline (hardcoded weights), PR #105 weights (benign-only), PR #106 weights (lab-only margin), and this
round's CIC-trained weights.

### Axis (b): CIC held-out flood windows (Slowloris, Slowhttptest, DDoS)

CIC captures are one continuous stream per day, not discrete short "runs" the way the lab's pcaps are, so run-level
scoring (`score_holdout`'s "did it name the sender") does not apply unmodified. Instead, each held-out class's capped
block of windows is fed through a **fresh `sr.Adaptive(tau=<condition's own base_tau>)`**, in the time order the
windows were captured — the same sequential, per-capture-reset pattern `scripts/score-labelled-runs.py`'s
`sentinel_alerts` already uses per lab run (a lab run is itself a short, bounded, independently-reset capture, not a
sample from one infinite always-on stream — treating each CIC block the same way is the same semantics, not a new
one). Reported per class, per condition:

- **Window-level recall:** the fraction of that class's windows that `Adaptive.check()` flags anomalous.
- **Attacker-IP agreement:** of the windows that alert, the fraction whose `majority_src_ip` (recorded at sampling
  time, independent of any detector) matches that attack's known attacker IP (`172.16.0.1` for every CIC DoS/DDoS
  class per the already-published spot-check in `../cic-ids2017-adapter/README.md`) — the CIC-scale analogue of the
  lab's "named the right sender."

This is a **different granularity than axis (a)'s run-level "x/13 detected"** and is reported as such, not merged
into the same column or averaged against it — window-level recall and run-level detection-with-right-sender are not
the same measurement even when both are called "detection," and presenting them as interchangeable would be exactly
the kind of blended, misleading number this repo's culture rejects.

**Also reported, separately, clearly labeled as training performance, not held out:** the same window-level
recall/attacker-IP metrics for the two CIC **training** classes (Hulk, GoldenEye), for all four conditions — the
three conditions that never trained on this data (baseline, PR #105, PR #106) alongside this round's own weights,
which did. Expected to look best for this round's condition since it optimized directly for exactly these windows;
reported for transparency about what the margin term actually saw, matching PR #106's own convention for its lab
training-attack runs.

### Axis (c): CIC-benign generalization check

The capped pre-attack CIC-benign sample (Wednesday + Friday, 50,000 windows combined, never read by training or by
threshold calibration) is scored the same way as axis (b)'s attack blocks — a fresh `Adaptive(tau=<condition's own
base_tau>)` per day's block, in time order — reporting the **window-level false-positive rate** (fraction of windows
flagged anomalous) per day, per condition. This is reported in its own section of `README.md`, not folded into axis
(a)'s or (b)'s tables: it is answering "does this stay quiet on a different organization's ordinary traffic," a
different and narrower claim than "does this still have a low false-positive rate on our lab's own held-out benign
traffic" (axis a already covers that question for this lab).

## What would count as an improvement, decided before looking

Applied per axis, never blended across axes:

- **Axis (a):** the same weak-Pareto rule PR #105/#106 used — this round's weights are reported as better than a
  reference condition (baseline, PR #105, or PR #106 — checked separately against each, since "beats baseline,"
  "beats the first training attempt," and "beats the lab-only margin attempt" are three different claims) only if
  they achieve a **higher-or-equal** attack-hit rate **and** a **lower-or-equal** false-positive rate on the
  identical held-out split, with at least one strictly better.
- **Axis (b):** per held-out CIC class, this round's condition is reported as showing a real improvement over a
  reference condition only if its **window-level recall is higher** on that class **and** this round's CIC-benign
  false-positive rate (axis c) is **not worse** than that reference's — recall and false-positive rate are measured
  on different data here (different CIC blocks), so the Pareto pairing spans axis (b)'s recall against axis (c)'s
  FP rate for the same two conditions, not two numbers from the same block.
- **Axis (c)** is reported on its own terms (a rate, with its sample size) and is one half of axis (b)'s Pareto
  pairing as above; it is not separately called an "improvement" or "regression" in isolation, since a rate alone
  has no reference direction without the recall side.
- **If this round is a clear win on some axes and not others — e.g., it closes the lab's own flood-generalization gap
  further but does worse on CIC's held-out Slowloris/Slowhttptest, or vice versa — that is reported exactly as what
  it is, per axis, not averaged into a single headline number.** The same applies to any regression on axis (a)'s
  port-scan rows, which this round's objective never targets, same caveat as PR #106 carried forward.

## Data-sufficiency situation, stated before results: better than PR #106's, but not unlimited

This round's CIC training population (up to 20,000 windows each for 2 classes = up to 40,000 training-attack
windows, from two genuinely distinct campaigns with hundreds of thousands of flows behind them) is a real increase
in scale and diversity over PR #106's 5 lab runs / ~10,815 windows across 2 patterns. It is **not** a claim that data
sufficiency is now a solved problem for this project:

- The margin term is still a nested mean over exactly **2** training classes, same structural thinness PR #106's own
  caveat flagged — a fit that happens to work well for one of the two HTTP-flood mechanics and poorly for the other
  would still show a plausible blended training objective, with no internal redundancy across many classes to catch
  that.
- CIC-IDS2017 is itself a single lab's single week of simulated traffic from 2017, generated by specific named
  attack tools against a specific simulated enterprise topology — a different, larger, and more external source of
  evidence than this project's own rig, but still one dataset, not an exhaustive survey of how floods or benign
  enterprise traffic can look.
- The held-out generalization battery here (same-day-different-mechanism, cross-day-different-tool, cross-
  organization-benign) is a stronger test than PR #106 ran, but three held-out groups plus one benign-generalization
  check is still a small number of distinct generalization probes, not a validated general claim that this margin
  objective solves flood detection broadly.

## What was and will not be changed in the live system

Identical boundary to both prior rounds. `scripts/gpu-sdn-anomaly-sentinel.py`'s opt-in `--weights-file` /
`GPU_SENTINEL_WEIGHTS_FILE` loading path is reused unmodified; this round does not touch it, the systemd unit, or any
Jetson hardware, and does not retrain port-scan detection. With neither flag nor environment variable set, the
deployed daemon keeps running the compiled-in hardcoded constants regardless of this round's result. This round is
pure offline research against downloaded files; nothing here touches live hardware.
