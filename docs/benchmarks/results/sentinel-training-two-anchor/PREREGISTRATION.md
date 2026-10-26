# Two-anchor margin training: pre-registration (batch 1 — sanity check only)

**2026-10-26 addendum (batch 12, owner-approved, hypothesis/method/bar written before any of this batch's numbers
were looked at):** batch 11 tested one fix for the lab held-out recall collapse (an `L_margin_lab` anchor term) and
got a PARTIAL result -- lab detection recovered from batch 10's 2/13 to 4/13, but CIC-benign Friday FP regressed to
3.30%, framed as possible evidence of a capacity conflict (a 10-parameter kernel cannot simultaneously satisfy
CIC-benign, CIC-attack, and lab-attack anchors without some give). **This batch tests that capacity-conflict reading
directly, isolating the other variable**: instead of adding a new lab-anchor term, hold batch 10's exact winning
config fixed (`--objective two-anchor-sequence-alert-rate --surrogate-temperature-frac 0.5`, `--lab-margin-lambda
0.0`, i.e. no lab anchor at all) and sweep `--lambda-weight` -- the CIC margin term's own weight, `tw.LAMBDA=1.0` by
default -- DOWN, at three points: `0.5`, `0.25`, `0.1`. Everything else is held byte-for-byte identical to batch 10:
same data caps (6,264 lab-benign / 2,000 CIC-benign-anchor-per-day / 2,000 CIC-attack-per-class), bounds `[-3.0,
5.0]`, seed `42`, optimizer budget (DE `popsize=20`/`maxiter=150`, Nelder-Mead polish `maxiter=5000`). A 50-window
smoke-scale run at `--lambda-weight 0.5` was used only to confirm the code path runs end to end without crashing
(it did, exit 0); its numbers are not used for the verdict below.

**Pre-registered bar (decided before any full-scale run's numbers were looked at):** for each `--lambda-weight`
value, report (a) lab held-out detected/FP, (b) CIC `DoS Hulk`/`DoS GoldenEye` recall (via the unmodified
`score_cic_block`), (c) CIC-benign FP both days. A value "recovers" lab detection if held-out detected `> 2/13`
(batch 10's number) **without** `DoS Hulk`/`DoS GoldenEye` recall falling below 80% (a meaningful floor, not just
"not zero"). The full curve is reported honestly regardless of outcome -- a clean negative (no lambda value recovers
meaningful lab detection without a severe CIC recall cost) is as useful a result here as a positive one.

**Result (full scale, all three points, seed 42, `--lab-margin-lambda 0.0` throughout):**

| `--lambda-weight` | lab held-out detected | lab held-out FP | CIC Hulk recall | CIC GoldenEye recall | CIC-benign FP (Wed / Fri) | Recovers? (bar above) |
| --- | --- | --- | --- | --- | --- | --- |
| 1.0 (batch 10, for reference) | 2/13 | 1/9 | 100.00% | 100.00% | 0.00% / 0.00% | -- (baseline) |
| **0.5** | **4/13** | 1/9 | 99.95% | 100.00% | 0.00% / **3.25%** | **YES** |
| 0.25 | 4/13 | 1/9 | **51.55%** | 100.00% | 0.00% / 2.80% | NO (Hulk < 80% floor) |
| 0.1 | 2/13 | 1/9 | **7.65%** | 100.00% | 0.00% / 0.00% | NO (no lab recovery, Hulk collapses below even the pre-two-anchor baseline of 28.58%) |

(Batch 11's own result, for direct comparison on the same row shape: `--lab-margin-lambda 1.0`, `--lambda-weight 1.0`
-- lab held-out 4/13 detected, FP 1/9, Hulk 100.00%, GoldenEye 100.00%, CIC-benign FP 0.00% / 3.30%.)

**The curve is not monotonic, and that is itself the finding.** `DoS GoldenEye` recall is untouched at 100.00% across
every lambda tried -- it is not the class under pressure here. `DoS Hulk` recall falls off a cliff as lambda drops
(100.00% -> 99.95% -> 51.55% -> 7.65%), and lab held-out detection does NOT track that decline monotonically: it
recovers to 4/13 at both `0.5` and `0.25`, then falls straight back to batch 10's 2/13 at `0.1`, where Hulk recall has
also collapsed to the point of failing the CIC objective itself (7.65%, worse than the pre-two-anchor-workstream
baseline of 28.58% Hulk has beaten every batch since batch 9). Reducing CIC-margin pressure does not uniformly "free
up capacity" for the lab; there appears to be a narrow band (`lambda` in roughly `[0.25, 0.5]`) where the search lands
on weights that both separate lab attacks and still clear the CIC margin, and pushing further destroys the CIC side
without buying any further lab recovery -- consistent with a specific local-optimum landscape, not a smooth
capacity-vs-cost dial.

**Verdict: `--lambda-weight 0.5` alone -- with ZERO lab-anchor term, `--lab-margin-lambda` left at its default `0.0`
-- recovers lab held-out detection to 4/13, matching batch 11's dedicated `L_margin_lab` fix exactly on that number,
with CIC Hulk/GoldenEye recall both still comfortably above the 80% floor (99.95%/100.00%). Its CIC-benign Friday FP
cost (3.25%) is statistically indistinguishable from batch 11's own cost (3.30%) for the identical 4/13 lab-recall
gain.** This is a clean, decisive answer to this batch's own question: the lab-recall collapse is NOT specifically
about the *absence* of a lab-attack anchor. A simple capacity knob -- turning down how hard the shared kernel is
pushed toward the CIC margin shape -- reaches the SAME operating point (same lab recall, same order-of-magnitude CIC-
benign cost, same intact CIC recall) that batch 11's purpose-built anchor term reached, with no new data, no new
objective term, and no risk of training against lab-attack patterns at all (even disjoint ones). This favors the
capacity-conflict reading over the missing-anchor reading: there is one shared "give" in this 10-parameter kernel
between lab-attack separability and CIC-benign Friday reconstruction, and at least two independent levers
(`--lambda-weight` down, `--lab-margin-lambda` up) spend that same give the same way, landing at roughly the same
price (~3.2-3.3 points of Friday FP for ~2/13 more lab attacks detected). Neither lever is a free fix, and this
batch found no point on the `--lambda-weight` curve that clears 4/13 lab recall without that cost -- `0.25` and `0.1`
do not recover MORE lab detection than `0.5` already does; they only trade CIC Hulk recall away for nothing in
return. Not committing any of these three weight files as a replacement for batch 10 or batch 11; recorded as a
disclosed diagnostic result, same as batch 11.

**What this does and does not tell us.** This is three points on one lever's curve, in one 10-parameter architecture,
with one seed -- it is not a proof that `~3.2%` Friday FP is an information-theoretic floor for 4/13 lab recall in
this kernel, only that the two levers tried so far (nine batches in, across two different mechanisms) both land
there. It also does not explain WHY the Hulk-recall cliff sits between `0.5` and `0.25` rather than somewhere else,
or why lab recall fails to track Hulk's decline monotonically at `0.1` -- those would need their own dedicated
investigation (e.g., tracing which of the 10 weights move most across the sweep, the same kind of trace batch 6 did
for the hinge-vs-Adaptive gap) and are flagged as open, not resolved, by this batch's three-point sweep.

**Most natural next batch, stated honestly:** this workstream is now 12 batches deep without a single batch that
clears CIC-benign FP, CIC Hulk/GoldenEye recall, AND lab held-out recall simultaneously at a level anyone would call
"fixed" -- batch 10 is clean on CIC-benign/CIC-recall but keeps lab recall at its worst-ever point (2/13); batches 9,
11, and this batch's `--lambda-weight 0.5` point all reach 4/13 lab recall but at a real, repeated ~3.2-3.3%
Friday-FP cost. Two independent 10-parameter-kernel levers landing at the same tradeoff point is itself evidence that
the next useful step is probably NOT a third lever searched inside the same 10-parameter architecture hoping for a
different answer -- batch 4 already showed capacity alone (85 parameters, no margin-shape change) does not resolve
this kind of conflict either. Three honest options going forward, in order of how much new infrastructure each
needs: (1) accept batch 10's CIC-only weights as the current best disclosed candidate, explicitly documenting lab
held-out detection as a known, unresolved gap rather than continuing to chase a unified fix; (2) treat CIC-shaped and
lab-shaped detection as two separately-deployed models/thresholds (e.g. an ensemble or a mode switch) rather than one
shared kernel, since this and batch 11 both suggest the two anchors may not be jointly satisfiable at this capacity;
or (3) a genuinely different, larger-capacity architecture (not just more of the same 10/85-parameter stage-1
expansion batch 4 already tried) if a unified detector remains a hard requirement. This batch's own evidence does not
pick among these three -- it only strengthens the case that continuing to add one-off terms or re-sweep existing
levers inside the current 10-parameter kernel is unlikely to produce a qualitatively different result from what
batches 9-12 have already found.

All 13 `test/invariants/train-sentinel-weights-cic.test.ts` tests pass (script untouched this batch --
`--lambda-weight` already existed as a CLI flag; this batch only supplies a non-default value). No PR, no four-axis
held-out evaluation, no deployment-path change, regardless of outcome, same boundary as every prior batch in this
workstream.

**2026-10-25 addendum (batch 11, owner-approved, hypothesis/method/bar written before this batch's numbers were
looked at):** batch 10's transcript surfaced a regression nobody had been tracking as a pass/fail metric: the
ORIGINAL hardcoded baseline weights (`sr.W`, pre-dating this whole workstream) detect 10/13 lab held-out attacks
with 4/9 benign false positives; by batch 10 the sequence-surrogate-trained weights were down to 2/13 detected
(batches 7-9 had been flat at 4/13). **Diagnostic finding (not pass/fail, read-only against batch 10's already-committed
weights):** replaying lab held-out runs through the exact `sr.Extractor`/`sr.Adaptive` construction
`scripts/score-labelled-runs.py` uses confirmed the mechanism is a feedback loop, not just a static gap shrinking —
`sr.Adaptive`'s own EMA mean assimilates early attack windows as "normal" once the baseline/trained loss gap to tau
gets too small, which then locks out detection for the rest of that run. The CIC-margin objective, by reshaping the
shared 10-parameter kernel to separate CIC Hulk/GoldenEye from CIC-benign, incidentally collapses lab-attack
separability that was never trained on or anchored at all.

**Fix tested:** an optional 4th objective term, `L_margin_lab(W)` — PR #106's own static hinge (no Adaptive replay),
`max(0, lab_target(W) - kernel_loss(window; W))` where `lab_target(W) = mean(lab-benign pool) + sigma*std(lab-benign
pool) + lab_margin`, trained on PR #106's own lab flood-attack patterns (`attack-synflood-200pps`,
`attack-udpflood-500pps-1400b`) — **disjoint from the held-out evaluation patterns**
(`portscan-*`/`attack-synflood-1000pps`), so any held-out improvement is genuine generalization within the lab's own
attack family, not training against the eval set. New `--lab-margin-lambda` (default `0.0`, exactly reproduces batch
10) and `--lab-margin` (default `tw.MARGIN`) CLI flags; everything else held identical to batch 10 (`--objective
two-anchor-sequence-alert-rate`, `--surrogate-temperature-frac 0.5`, same data caps, bounds, seed `42`, optimizer
budget).

**Pre-registered bar (decided before the full-scale run's numbers were looked at; a smoke-scale run at
`--cic-attack-train-cap 50` was used only to catch crashes, per this doc's own batch-1 convention, not for the
verdict):** MINIMUM BAR for "fixed" — lab held-out detected `> 2/13` AND FP `<= 2/9` AND `DoS Hulk`/`DoS GoldenEye`
recall `>= 95%` each AND CIC-benign FP `<= 1%` on both days. Falling short of any one of these is a partial result,
to be reported as such, not spun as a pass.

**Result (full scale, `--lab-margin-lambda 1.0`, `--lab-margin 0.02`, seed `42`):**

- Lab held-out: **detected 4/13** (up from batch 10's 2/13, matching batches 7-9's level — PASSES `> 2/13`), FP
  **1/9** (PASSES `<= 2/9`).
- `DoS Hulk` / `DoS GoldenEye` recall (via the unmodified `score_cic_block`): **100.00% / 100.00%** (PASSES `>= 95%`
  each, unchanged from batch 10).
- CIC-benign FP: Wednesday **0.00%** (PASSES `<= 1%`), Friday **3.30%** (66/2,000 windows) — **FAILS `<= 1%`**, and is
  a real regression from batch 10's clean 0.00%/0.00%, worse than batch 9's own 0.75% Friday regression that batch
  10 had fixed.
- One weight pinned near a bound this run (`w1 = -2.996259`, distance 0.0037 from the lower bound `-3.0`) — batches 9
  and 10 had none pinned.

**Verdict: PARTIAL, not fixed.** Three of the four pre-registered conditions pass (lab detection recovered, lab FP
held, CIC recall held), but the CIC-benign FP guardrail fails on Friday. The lab-attack anchor term does what it was
designed to do — it demonstrably pulls the shared 10-parameter kernel back toward a shape that also separates lab
attacks, confirming the diagnostic's mechanism — but at a real, measured cost to the CIC-benign anchor it wasn't
weighted against. This is consistent with hypothesis 3's capacity-conflict framing (a 10-parameter kernel cannot
fully satisfy a CIC-shaped anchor, a CIC-shaped margin, and a lab-shaped margin simultaneously without some give),
not just a missing-term problem solved by this one addition. Not committing this as a replacement for batch 10;
recorded as a disclosed, honest diagnostic result.

**2026-10-25 addendum (batch 10, owner-approved, hypothesis/method/bar written before this batch's numbers were
looked at):** batch 9's own commit message flagged one real, non-zero cost from its sequence-level surrogate:
CIC-benign false-positive rate held at batch 8's clean 0.00% on Wednesday but regressed to 0.75% (15/2,000 windows)
on Friday. **This batch holds batch 9's sequence-level alert-rate surrogate mechanism
(`make_sequence_alert_rate_objective`/`_replay_class_soft_alerts`) completely fixed — no change to the core idea —
and tests two independent, already-existing CLI levers against that one regression**, each in isolation (ONE
hyperparameter changed per run, everything else identical to batch 9's exact data caps (6,264 lab-benign / 2,000
CIC-benign-anchor-per-day / 2,000 CIC-attack-per-class), bounds `[-3.0, 5.0]`, seed `42`, and optimizer budget (DE
`popsize=20`/`maxiter=150`, Nelder-Mead polish `maxiter=5000`)):

1. `--beta-cic-benign`: the weight on the CIC-benign reconstruction anchor `L_benign_cic`, raised 3x from its
   pre-registered default (`1.0` → `3.0`), to push harder against the Friday-day CIC-benign windows specifically.
2. `--surrogate-temperature-frac`: the softness of the sigmoid alert-rate surrogate, swept away from batch 9's
   pre-registered default of `0.25` in both directions — sharper (`0.08`) and softer (`0.5`) — since temperature
   controls how "soft" the surrogate reward is near the decision threshold.

**Pre-registered bar (decided before any of the three runs' numbers were looked at):** PRIMARY — does Friday
CIC-benign FP return to 0.00%, or at least move meaningfully closer to it from batch 9's 0.75%? GUARDRAIL — do
`DoS Hulk` and `DoS GoldenEye` recall (via the unmodified `score_cic_block`) stay within a few points of batch 9's
99.20%/99.45%, not regress back toward batch 8's 0.00%/38.40%? If more than one run clears both, commit whichever
gets Friday FP closest to 0.00% with the smallest recall cost; if none clears it, report the best achieved tradeoff
point honestly rather than overclaim, and commit the better of the attempted points as this batch's disclosed
result. The lab held-out informal peek (batch 8/9's identical 4/13 recall, 1/9 FP) is checked for movement but is
not pass/fail.

**Result:**

- `--beta-cic-benign 3.0` (lever 1, Run A): `DoS Hulk` 100.00%, `DoS GoldenEye` 99.90% (both improve on batch 9).
  Friday CIC-benign FP got WORSE, not better: 1.30% (26/2,000), up from batch 9's 0.75%. Lab held-out peek: 4/13
  recall (unchanged), FP 2/9 (worse than batch 9's 1/9). **Lever 1 FAILS the primary bar, in the wrong direction** —
  raising the equal-weighted Wednesday+Friday nested-day-mean anchor term does not selectively suppress Friday's
  regression; it is a day-blind average, so it cannot differentially fix one day, and empirically it pushed the fit
  to a different, Friday-worse local optimum in the 10-parameter search space.
- `--surrogate-temperature-frac 0.08` (lever 2, sharper, Run B): `DoS Hulk` 100.00%, `DoS GoldenEye` 99.90%. Friday
  FP 0.80% (16/2,000) — statistically indistinguishable from batch 9's 0.75%, not an improvement. Lab held-out peek:
  4/13 recall (unchanged), FP 2/9 (worse). A sharper surrogate does not help.
- `--surrogate-temperature-frac 0.5` (lever 2, softer, Run C): `DoS Hulk` 100.00%, `DoS GoldenEye` 100.00% (both
  improve on batch 9 and on Runs A/B). **Friday CIC-benign FP 0.00% (0/2,000) — fully recovers batch 8's clean
  0.00%/0.00%, both days, with no non-zero regression left on either day.** Lab held-out peek: FP unchanged at 1/9
  (matches batch 9 exactly), but recall dropped to 2/13 from batch 8/9's 4/13 — a real, disclosed cost on this
  informal, non-pre-registered metric, the first time it has moved in this workstream.

**Chosen for this batch: `--surrogate-temperature-frac 0.5`, holding `--beta-cic-benign` at its pre-registered
default (`1.0`).** This is the only one of the three points tried that clears both the primary bar (Friday FP
exactly 0.00%, no regression at all) and the recall guardrail (both classes improve on batch 9, nowhere near batch
8's collapse). The direction is the OPPOSITE of this batch's own stated hypothesis ("a different (likely smaller,
sharper) temperature may reduce false alerts") — a SOFTER surrogate, not a sharper one, is what worked. A plausible
mechanism (not verified beyond this one data point, reported as a hypothesis, not a proven cause): batch 9's default
`0.25` produces a near-hard decision boundary for the optimizer, letting it specialize tightly enough to the
Wednesday-side training distribution that the resulting boundary still clips into Friday's distinct benign tail,
while a wider `0.5`-sigma band smooths the gradient over more of both distributions and leaves more margin on both
days. `--beta-cic-benign` is NOT a useful lever for this specific regression at the one value tried (`3.0`): it is a
day-blind nested mean, so it structurally cannot differentially fix one day's regression, and empirically pushing it
only moved the fit to a worse point for Friday specifically.

**What this result does and does not tell us:** this is one sweep point per lever, not a full grid — `0.5` is not
claimed to be the optimal temperature, only the better of the three values tried here, and the mechanism explanation
above is a plausible hypothesis, not a verified cause. The lab held-out recall cost (2/13, down from 4/13) is new
this batch and should be treated as this batch's own, not folded into the "same as every prior batch" framing
batches 7-9 used for that peek.

This addendum does not change anything else in this document: the objective formula
(`make_sequence_alert_rate_objective`), the architecture, bounds, optimizer, CIC data scope, and the
`margin_combine='mean'` default are all unchanged from batch 9.

**2026-10-25 addendum (batch 9, owner-approved "option 2", hypothesis/method/bar written before this batch's
full-scale (2,000-window-per-class) numbers were looked at — a small 50-window-per-class smoke test was run first,
purely to confirm the new code path runs end to end without crashing, and its numbers are not used for the pass/fail
verdict below):** batch 8's own commit message diagnosed a specific, falsifiable reason the Adaptive-replay-aware
margin (batches 7/8) might be the wrong training signal even though it is "Adaptive-aware": its per-window hinge
`max(0, threshold_from_adaptive.check() - loss)` scores each window independently against whatever threshold the
simulated `sr.Adaptive` happens to hold at that moment, but the actual metric graded against — `score_cic_block`'s
`alerts/n` — is an AGGREGATE alert rate over the WHOLE replayed sequence. A window can individually clear or miss its
momentary threshold without that translating cleanly into the sequence-level rate the deployed detector is judged
on. **This batch tests that diagnosis directly**: does replacing the per-window hinge with a genuinely
SEQUENCE-LEVEL, differentiable surrogate for `alerts/n` itself — the mean, across a class's whole cold-replayed
sequence, of a smooth `sigmoid((loss - threshold) / temperature)` standing in for each window's hard alert boolean,
with `sr.Adaptive`'s own mean/variance EMA update left completely untouched (only the alert decision is relaxed, not
the underlying statistics) — close the gap batches 7/8 could not close?

**Result (full-scale, 2,000-window-per-class run, matching batch 8's data/bounds/seed/optimizer budget exactly):
YES, decisively.** `DoS Hulk` recall 99.20% (vs. the 28.58% bar — batch 3's best-ever, and batch 8's own 0.00%),
`DoS GoldenEye` recall 99.45% (vs. the 63.20% bar — batch 5's best-ever, and batch 8's own 38.40%), both measured by
the unmodified `score_cic_block`, the real grading function. Both classes individually clear their bars by a wide
margin — this is a PASS on both the pre-registered per-class (AND/OR) bar and, for direct comparability, batches
7/8's stricter both-classes bar. The per-class surrogate recall at the trained weights (98.94% Hulk, 99.36%
GoldenEye — this objective's own differentiable estimate) tracked the real `score_cic_block` recall closely (within
~0.3-0.5 points), confirming the surrogate is a tight approximation of the sequence-level metric it was built to
approximate, unlike batches 7/8's per-window hinge whose training signal never tracked real recall at all. This is
strong evidence FOR batch 8's diagnosis: the Adaptive-replay-aware approach itself was not the problem; the
PER-WINDOW hinge, which never directly optimized the aggregate alert rate, was.

**The one real tradeoff, reported honestly, not minimized:** CIC-benign false-positive rate held at batch 8's clean
0.00% on Wednesday but regressed to 0.75% (15/2,000 windows) on Friday — a real, non-zero cost from batch 8's
cleanest-ever 0.00%/0.00%, not a wash. Lab held-out recall (informal peek only) dropped to 4/13 from the hardcoded
baseline's 10/13, with FP at 1/9 — both numbers happen to match batch 8's own lab-held-out peek exactly, so this
specialization-to-CIC-at-the-cost-of-the-lab's-own-attack-patterns tradeoff is not new to batch 9; it is consistent
with every Adaptive-replay/two-anchor batch so far and is not a verdict on this batch's one real change (the margin
formula). No weight pinned to a `BOUNDS` edge (0/10).

## The one change, and nothing else (batch 9)

`make_sequence_alert_rate_objective` (`scripts/train-sentinel-weights-cic.py`, `--objective
two-anchor-sequence-alert-rate`) keeps every other part of batch 8's mechanism identical: the same fresh, COLD
`sr.Adaptive(tau=base_tau(W))` per class (no warm-up, matching `score_cic_block` exactly), the same 10-parameter
architecture, the same `mean`-combine across classes (not stacked with batch 5's `max`-combine — a different,
already-tried lever), the same benign terms (pooled nested means over the lab-benign pool and the CIC-benign
anchor, no replay), the same data caps (6,264-window lab-benign pool, 2,000-window CIC-benign anchor per day,
2,000-window CIC attack-training pool per class — identical to batch 8), the same bounds `[-3.0, 5.0]`, the same
optimizer budget (`popsize=20`, `maxiter=150`, Nelder-Mead polish `maxiter=5000`), and the same seed (42). The ONLY
change is the margin term's formula: batch 8's per-window hinge against a momentary threshold snapshot is replaced
by `_replay_class_soft_alerts`' per-window `sigmoid((loss - threshold) / temperature)`, averaged across the WHOLE
class sequence into a surrogate recall, with `1 - surrogate_recall` (the surrogate miss rate) as the per-class loss
term the optimizer minimizes. `temperature` is set to `SEQUENCE_SURROGATE_TEMPERATURE_SIGMA_FRAC_DEFAULT = 0.25`
times the LAB training-benign pool's own std at the current candidate `W` (not a fixed absolute number — see that
constant's own comment in the script for why a W-relative scale is needed across the wide `BOUNDS` search space
differential_evolution explores). This temperature choice is fixed before the full-scale run and not tuned against
results.

## Success criterion — pre-registered, decided before full-scale numbers were looked at

**Primary:** for each of `DoS Hulk` and `DoS GoldenEye`, independently, does this batch's measured window-level
recall (via the unmodified `score_cic_block`, the same scoring function every batch is graded against) beat the
best-ever prior recall for that class — **Hulk's 28.58% (batch 3) AND/OR GoldenEye's 63.20% (batch 5)**? Unlike
batches 7/8's stricter "beats both or it's a FAIL" framing, this batch's own pre-registered bar is explicitly
per-class (AND/OR): beating either class individually is a PASS for that class, reported as such, not folded into a
single blended verdict.

**Secondary, reported for context, not pass/fail:** CIC-benign false-positive rate must not regress from batch 8's
0.00%/0.00% (the cleanest result in the workstream so far) — any tradeoff here is flagged explicitly even if recall
improves. Lab held-out recall/FP (informal peek only, not a held-out-validated result) is also reported for
continuity with every prior batch.

**What this batch does and does not tell us:** if the sequence-level surrogate beats one or both bars, that is
evidence FOR batch 8's diagnosis — the per-window hinge, not the Adaptive-awareness idea itself, was the wrong
training signal. If it still fails both bars, that is evidence the Adaptive-replay-aware approach as a whole
underperforms the simpler static-target hinges of batches 2/3/5 regardless of how the per-window-vs-sequence-level
distinction is handled, and the next batch should likely return to extending the static-target line (e.g. combining
batch 5's max-combine with a wider/deeper architecture) rather than continuing to refine Adaptive-replay.

**2026-10-25 addendum (batch 8, owner-approved, added before batch 8's own numbers were looked at):** batch 7's own
commit message found, after the fact, a real train/eval convention mismatch in its Adaptive-replay-aware margin:
training warmed the simulated `sr.Adaptive` instance on 500 lab-benign windows before replaying attack-training
windows through it (modeling "the daemon has been running a while before an attack"), but `score_cic_block` — the
unmodified function every batch, including batch 7, is actually graded against — starts each evaluation block's
`Adaptive` instance COLD (`ad = sr.Adaptive(tau=base_tau)`, initial `m = tau*0.75`, no warm-up at all; see
`score_cic_block`, line 126 at the time batch 7 was written). Batch 7 therefore optimized its margin against a
warmed dynamic while being scored against a cold one. **This batch isolates exactly that one variable**: does
cold-start replay (matching `score_cic_block`'s own convention exactly) recover batch 7's failed result, or does the
Adaptive-replay-aware margin idea itself not help regardless of warm-up?

**Result: FAILS on both, same as batch 7, and does not recover.** Hulk 0.00% (worse than batch 7's already-poor
1.50%, far below the 28.58% bar), GoldenEye 38.40% (essentially unchanged from batch 7's 39.10%, well below the
63.20% bar). The cold-start fix moved neither number meaningfully relative to batch 7 — Hulk got slightly worse,
GoldenEye was flat within noise. This is evidence against "the warm-up mismatch alone explains the failure": fixing
exactly that one variable did not recover anything close to batch 3's or GoldenEye's best-ever recall, so the
Adaptive-replay-aware margin mechanism itself, not just its training/eval convention, is the more likely explanation
for both batches' failure. CIC-benign FP: 0.00%/0.00%, unchanged from batch 7 — no regression on the one metric this
batch was flagged to watch. Weight-bound pinning: 0/10 (consistent with every departure from round 3's original
exact recipe in this workstream). Lab held-out: 4/13 recall, 1/9 FP (the recall figure is actually the best
lab-held-out number of the two adaptive-margin batches, though still an informal peek, not a held-out-validated
result, and not this batch's pre-registered metric). Per-class hinge (adaptive-replay-based): Hulk 0.0172, GoldenEye
0.0206 — both noticeably larger than batch 7's (0.0090, 0.0042), i.e. the cold-start objective is harder to drive
down (a cold `Adaptive` instance's threshold starts lower, at `tau*0.75`, before the EMA has a chance to drift
upward, so attack windows face a stricter bar from window 1) — this by itself does not translate into better
real-world recall, since `score_cic_block`'s alert-rate measurement is exactly that cold dynamic and the fitted
weights still do not clear it often enough.

## The one change, and nothing else

`_replay_class_hinge` no longer warms on any lab-benign windows before replaying a class's attack-training windows —
it constructs a fresh `sr.Adaptive(tau=base_tau)` and starts scoring the class's own windows immediately, the exact
same instantiation and initial-state convention `score_cic_block` uses. `build_benign_warmup_sequence` and the
500-window warm-up slice are removed entirely (not bypassed-but-kept — there is no warm-up sequence to build).
Everything else from batch 7 is unchanged: 10-parameter architecture, `mean`-combine (not stacked with batch 5's
`max` or batch 4's 85-parameter expansion), the same `--objective two-anchor-adaptive-margin` flag (no new flag —
this is a behavior change to the existing mode, the same way batch 5 added `--margin-combine` in place rather than
a new objective name), the same hinge formula (`max(0, threshold - loss)` read directly from `Adaptive.check()`'s
own second return value, no static `MARGIN` buffer), the same benign terms (pooled nested means, no replay), the
same data (6,264-window lab-benign pool, 2,000-window CIC benign anchor per day, 2,000-window CIC attack-training
pool per class), the same bounds `[-3.0, 5.0]`, the same optimizer budget (`popsize=20`, `maxiter=150`, Nelder-Mead
polish `maxiter=5000`), and the same seed (42).

## Success criterion — identical to batch 7's, so the two results are directly comparable

**Primary (pre-registered, decided before this run):** for each of `DoS Hulk` and `DoS GoldenEye`, is this batch's
measured window-level recall (via the unmodified `score_cic_block`) higher than the best-ever prior result for that
class individually — **Hulk's 28.58% (batch 3), GoldenEye's 63.20%**? Beating one class but not the other, or
beating neither, is a FAIL by the same rule batch 7 used (not a blended average, not "beats more batches than it
loses to").

**Secondary, reported for context, not pass/fail:** the same lab held-out recall/FP and CIC-benign FP numbers every
batch has reported. CIC-benign FP in particular is checked for regression from batch 7's 0.00%/0.00% (the cleanest
result in the workstream) — a real tradeoff there would be worth flagging explicitly even if recall improves.

**What this batch does and does not tell us:** if cold-start recovers the recall, the mismatch alone explains
batch 7's failure and the Adaptive-replay-aware idea is still live. If cold-start recall is similar to or worse than
batch 7's, the mismatch was not the (sole) explanation and the idea itself likely does not help at this scale —
either outcome is reported as exactly that, not spun.

**2026-10-25 addendum (batch 7, owner-approved, added before batch 7's own numbers were looked at):**
`scripts/trace-margin-adaptive-gap.py`'s traced example (batch 6's report) showed the actual mechanism behind the
recurring hinge-vs-recall disconnect: every margin formula tried so far (batches 2, 3, 5, 6) scores a training
window against a **static** target (`benign_mean(W) + SIGMA*std(W) + MARGIN`, one fixed number), but the real
deployed decision is made by `sr.Adaptive`, whose threshold is **dynamic and history-dependent** — frozen during a
sustained alert run, then capable of spiking sharply after just one or two post-alert dips (the variance update
squares the deviation from a still-low running mean). A weight configuration can clear the static bar by a wide
margin and still get swallowed by the real controller. This batch replaces the static target with a margin term
computed by **actually replaying attack-training windows through the real, unmodified `sr.Adaptive` class**,
sequentially, so the training objective is scored against the same dynamic decision the deployed system actually
makes.

## Scope boundary, repeated because it is the one that matters most this batch

This is a **training-side fix only**. `scripts/sentinel-replay.py`'s `Adaptive` class is used exactly as it already
is — imported, called via its existing public `check()` method, **never edited, subclassed with different logic, or
monkeypatched**. No deployment-path file, the native kernel, or `gpu-sdn-anomaly-sentinel.py`'s default behavior is
touched, identical boundary to every prior batch. The change here is entirely in *what training optimizes against*,
not in what the live system runs or how it decides.

## Design decisions, made and justified before running

- **Architecture and margin-combine: 10 parameters, `mean`-combine (batch 2/3's exact baseline), not stacked with
  batch 5's `max`.** This batch's question is narrower and more specific than "does any lever help" — it is "does
  making the margin term honest about the *dynamic* threshold, by itself, close the hinge-vs-recall gap." Stacking it
  with batch 5's still-unresolved class-imbalance fix (which batch 6 showed can itself produce a new failure mode —
  uniform collapse) would make it impossible to tell which change is responsible for any result. The cleanest
  isolation point is the simplest prior configuration this workstream has, batch 2/3's own baseline, changing only
  the margin mechanism.
- **Only the margin term changes; `L_benign_lab` and `L_benign_cic` stay exactly as pooled nested means, unchanged.**
  Reasoning (matching the task's own stated default): `Adaptive` replay specifically matters for *is this attack
  window's loss above the threshold it would actually face*, a sequential, order-dependent question. Whether benign
  traffic reconstructs well is not a sequential question in the same sense — those terms were never about "would an
  Adaptive replay flag this," they are about reconstruction fidelity, and introducing a sequential replay there would
  conflate two different questions (reconstruction quality vs. alerting behavior) that this project has kept
  separate since round 1.
- **No static `MARGIN` buffer added to the new hinge.** Every prior hinge used `target = benign_mean + SIGMA*std +
  MARGIN` (`MARGIN=0.02`), an explicit safety buffer beyond the bar a window had to clear. The real deployed decision
  has no such buffer — `Adaptive.check()` alerts the instant loss reaches its own computed threshold, nothing more.
  Keeping an artificial buffer here would reintroduce exactly the kind of "training optimizes against a proxy, not
  the real decision" gap this batch exists to remove. The new hinge is `max(0, threshold_from_adaptive - loss)`,
  where `threshold_from_adaptive` is **read directly from `Adaptive.check()`'s own second return value** (the exact
  quantity the real decision is made against), not a hand-rederived formula — this also means there is no new
  reimplementation of the threshold arithmetic to drift from the real class, by construction.
- **Warm-up: a fixed, deterministic 500-window sequence of the lab's own training-benign windows**, built once (not
  resampled per evaluation) by concatenating windows across the 8 training-benign patterns (sorted alphabetically)
  and their runs (sorted by run id) in that order, and taking the first 500. This models the real deployment
  scenario this fix is about: the daemon has been running continuously on **the lab's own traffic — the actual
  deployment target, same reasoning as every benign-anchoring choice this workstream has made** — before an attack
  ever starts, so its `Adaptive` instance already has real operating history, not a cold start. `base_tau(W)` for the
  instance's own `tau` floor is computed exactly as every prior round: `mean + SIGMA*std` of the **full** lab-benign
  training pool (not just the 500-window warm-up slice) — unchanged from every prior batch's calibration. 500 is a
  deliberately modest, bounded size (not the full 6,264-window pool): the per-objective-evaluation cost of this
  mechanism is a sequential Python loop, not a vectorized array op, and a smaller warm-up keeps a batch-1-scale
  sanity check fast without any evidence yet that a much longer history is needed to reach a representative EMA
  steady state (500 windows comfortably exceeds the `alpha=0.05` EMA's own effective memory window of roughly
  `1/alpha=20` updates many times over).
- **A fresh, independently-warmed `Adaptive` instance per attack class**, not one instance carried across both
  classes — each class represents an independent hypothetical "an attack of this shape starts now" scenario; sharing
  state across classes would make one class's hinge depend on an arbitrary artifact of which class happened to be
  replayed first, not a property of the class itself.
- **A real, disclosed limit of this simulation, stated now:** a fixed 500-window warm-up snapshot is far less varied
  than what the live `Adaptive` instance's operating history would actually look like at an arbitrary, unpredictable
  moment in continuous deployment (a single snapshot, not a distribution over "whatever the EMA happened to have seen
  recently"). This batch tests whether the mechanism moves the needle at all with a deliberately simple warm-up, not
  a claim that this warm-up is itself a faithful model of every possible operating state the real controller could be
  in when an attack begins.

## Data, bounds, optimizer: batch-1 scale, as in every batch except batch 2

Lab benign training pool unchanged (~6,264 windows, 8 patterns) — both for `L_benign_lab` and as the source of the
500-window warm-up slice. CIC benign anchor: 2,000 windows/day (Wednesday, Friday pre-attack), unchanged. CIC
attack-training population: 2,000 windows/class (`DoS Hulk`, `DoS GoldenEye`), unchanged — these are now **also** the
sequence replayed through the simulated `Adaptive`, in the same time order `load_npz_bucket` already provides.
Bounds `[-3.0, 5.0]` for all 10 weights, unchanged. **Optimizer budget: the original 10-dimensional scale**
(`popsize=20`, `maxiter=150`, `Nelder-Mead` polish `maxiter=5000`), unchanged from batch 2/3 — this batch's added
cost is a per-evaluation sequential replay (roughly `(500 warm-up + 2,000 attack) × 2 classes = 5,000` lightweight
Python-level `Adaptive.check()` calls per objective evaluation), not a dimensionality increase, so there is no
batch-4-style justification for reducing the search budget; the measured wall-clock cost is reported honestly rather
than the budget being shrunk pre-emptively on a guess.

## Self-check

Reuses `scripts/train-sentinel-weights.py`'s `self_check()` unchanged for the kernel formula itself (nothing about
`kernel_loss`/`kernel_loss_batch` changes this batch). **New check specific to this batch's own orchestration code**
(not the kernel, which is already covered): since nothing in the replay is randomized, replaying the *same* class's
windows through two independently-constructed, identically-warmed `Adaptive` instances must produce bit-identical
hinge sequences — this is checked once before fitting and fails loudly if it does not, catching any accidental
shared mutable state between classes or non-determinism in the orchestration, the same "catch a drift before fitting
against it" discipline every prior batch's self-check uses, applied to new code instead of the kernel math.

## Success criterion — the first batch where this is the thing being measured, not an afterthought

**Primary:** for each of `DoS Hulk` and `DoS GoldenEye`, is this batch's measured window-level recall (via
`scripts/train-sentinel-weights-cic.py`'s unmodified `score_cic_block`, the same real-`Adaptive`-scoring path every
prior batch has been judged against) **higher than the best recall any single prior batch achieved for that same
class**, measured at this batch's own calibrated `base_tau`? Concretely, from the published numbers so far: **Hulk's
best-ever prior result is batch 3's 28.58%; GoldenEye's best-ever prior result is batch 2's 63.20%.** Success this
batch means beating *both* individually, not a blended average and not "beats more batches than it loses to" — this
is a direct, concrete test of whether the Adaptive-replay-aware training signal finally produces a weight
configuration the real deployed scoring agrees is well-separated, which is exactly the question this batch exists to
answer.

**Secondary, reported for context, not pass/fail:** the same lab held-out recall/FP and CIC-benign FP numbers every
batch has reported, so this batch's full picture sits next to the other six's in the same terms.

**Honest framing, stated now:** this is a genuinely novel mechanism, never tried in this workstream, aimed precisely
at the mechanism batch 6 traced — there is real reason to expect it could help more than any prior lever (capacity
and margin-combine both left the static-vs-dynamic mismatch completely untouched). There is equally real reason it
might not fully resolve it (the warm-up simplification named above, and the fact that `max(0, threshold - loss)` is
still only a per-window, not a per-attack-run, success signal — a lone good window still doesn't guarantee a
*sustained* detection the way `score_cic_block`'s own alert-rate measurement cares about). Either outcome is reported
as exactly that.

As with every prior batch: no PR, no four-axis held-out evaluation, no deployment-path change, regardless of outcome.

**2026-10-24 addendum (batch 6, owner-approved, added before batch 6's own numbers were looked at):** batches 4 and 5
each independently changed one variable from batch 2's baseline configuration (10 params, `mean`-combined margin) and
each independently produced the same previously-never-seen result: **0 weights pinned to a bound** (batch 4: 0/85 at
85 params with `mean`; batch 5: 0/10 at 10 params with `max`). Both levers relieving the same pinning symptom
independently suggests they may share a root cause rather than being two unrelated fixes — this batch tests whether
they **compound** by combining both at once: **85 parameters (batch 4's exact un-tied-stage-1 architecture) + `max`
of per-class hinge (batch 5's exact margin fix), together, for the first time.**

## What changes, and what does not

Architecture: batch 4's exact 85-parameter shape (stage 1 un-tied per the window's 16 existing groups: 16×5 + 5 = 85
parameters; stages 2-4 unchanged, globally shared). Margin: batch 5's exact fix
(`L_margin(W) = max(hinge_mean_Hulk(W), hinge_mean_GoldenEye(W))`, not the mean). Everything else matches batch 4
(not batch 5): `BETA=1.0`, batch-1-scale data (lab benign ~6,264 windows, CIC-benign anchor 2,000/day, CIC
attack-margin-training 2,000/class), bounds `[-3.0, 5.0]` for all 85 parameters, and the **same reduced optimizer
budget batch 4 used** (`popsize=6`, `maxiter=60`, `Nelder-Mead` polish `maxiter=2000`) — the dimension is still 85, so
the same justification for reducing the budget (DE's population scales with `ndim`) still applies; this is not a new
deviation, it is reusing batch 4's already-justified one. `MARGIN=0.02`, `SIGMA=2.5`, `LAMBDA=1.0` unchanged, as in
every batch. Implementation: `scripts/train-sentinel-weights-expanded.py`'s
`make_two_anchor_objective_expanded`/`components_expanded` gain the same additive `margin_combine` parameter
(`'mean'` default, reproducing batch 4 exactly; `'max'` this batch) that
`scripts/train-sentinel-weights-cic.py` already has for the 10-parameter path, plus a parallel
`per_class_margin_hinge_expanded` diagnostic.

## Combined success bar: both prior bars, restated together, not loosened

**From batch 4 (the three-way bar):** lab held-out attack-detected ≥ 6/13, AND CIC-benign false-positive rate ≤ 2%
on both days, AND CIC-margin recall ≥ 20% on **both** `DoS Hulk` and `DoS GoldenEye`.

**From batch 5 (the balance bar, restated on recall, the metric that actually matters operationally — not the raw
hinge, which batch 5 already showed can be well-balanced without the recall being balanced):** neither class's
window-level recall is below 20% while the other is near its ceiling — concretely, both ≥20%, OR (if both land below
20%) the two values are within a factor of 3 of each other.

**This batch's combined bar is both of the above holding at once** — not an "or," and not a relaxed version of
either. Reported against each individually regardless of the combined outcome, exactly as batches 4 and 5 were, so a
partial result (e.g. the three-way bar met but balance not, or vice versa) is visible as exactly that.

## Prediction, stated before running

**I do not expect a clean compounding of gains.** Both batch 4 and batch 5 independently eliminated weight-pinning,
and I expect that to hold in combination too (pinning looks like a symptom both levers can independently relieve, so
there is no specific reason to expect it to reappear when both are applied together). I also expect the
**training-time** components (`L_benign_lab`, `L_benign_cic`, and especially the per-class hinges) to look as good as
or better than either batch alone — batch 4 alone drove the `mean`-combined hinge to 0.0024 (lower than batch 5's
`max`-combined 0.0229/0.0060), so more capacity plus a combination rule that cannot "rest" on one satisfied class
should plausibly push both classes' hinges down together, further than either lever achieved alone.

**What I do not expect to compound is the deployed-metric side.** Batches 2, 3, and 5 each separately showed the
same disconnect: training-time hinge satisfaction does not reliably predict the deployed `Adaptive` controller's
actual window-level recall (batch 5 in particular showed per-class hinges 3.8x apart translate to per-class *recall*
33x apart, in the opposite direction of which class "won"). Because that disconnect has now appeared under three
different configurations spanning both the capacity axis and the margin-formula axis, I have no specific mechanism to
expect combining the two levers would suddenly resolve it — my prediction is **"something else," not a clean
compounding of either gains or costs**: the training-objective numbers will likely look like the best yet in this
workstream, while the combined success bar (which is graded on deployed recall/FP, not training loss) still fails,
most likely on the same axes (lab recall below 6/13, and/or persistent recall imbalance) that failed batches 4 and 5
individually. The one sub-question I genuinely do not have a confident prediction for: whether batch 5's new
Friday-specific CIC-benign false-positive regression (7.45%, `max`-combine at 10 params) persists, worsens, or
resolves when combined with batch 4's extra capacity — I am flagging this as open, not predicting a direction.

## If the combined run does not resolve the hinge-vs-recall disconnect: trace one concrete example instead of a 7th aggregate table

Per the task's own instruction: if this batch's result does not resolve the recurring disconnect, the next step this
round is **not** another formula variant. It is picking one specific attack-training window where the training-time
hinge says "well-separated" (loss comfortably above `target(W)`) but the deployed-style `Adaptive` controller scores
it as not-anomalous, and tracing through *why* — most likely the EMA threshold ratcheting upward during a sustained,
only-moderately-elevated attack (the mechanism batch 2's and batch 3's READMEs already named as a hypothesis, never
directly traced through a single window's numbers end to end) rather than something else. This is a single concrete
trace, not a new aggregate metric, and is explicitly not required to produce a fix this round — only a traced
mechanism.

As with every prior batch: no PR, no four-axis held-out evaluation, no deployment-path change, regardless of outcome.

**2026-10-24 addendum (batch 5, owner-approved, added before batch 5's own numbers were looked at):** batch 4 showed
the CIC margin term's class-imbalance pattern (one attack class learned well, the other barely moved) reproduce
under a completely different architecture — 10 parameters (batches 2-3) and 85 parameters (batch 4) both landed on
one class near its ceiling and the other near its floor (batch 2: Hulk 1.19%/GoldenEye 63.20%; batch 4: Hulk
0.15%/GoldenEye 44.75%). The same failure surviving an 8.5x capacity change is strong evidence it comes from how the
margin term is *computed*, not from model capacity. This batch tests a specific, named mechanism for that and a
specific fix, isolating it from every other variable changed so far.

**Diagnosis of the mechanism:** `make_two_anchor_objective`'s `L_margin(W)` is a nested mean over attack classes:
`mean(hinge_mean_Hulk(W), hinge_mean_GoldenEye(W))`. The per-window hinge is floored at zero
(`max(0, target(W) - loss)`), so a class that already clears `target(W)` contributes exactly 0 and cannot be "spent"
to offset a worse class the way an unbounded loss could — but a **mean of two independent class-level hinges**
still lets the optimizer find comfort in fixing the *easier* class fully (hinge → 0) while leaving the *harder*
class only partially fixed, because once the easy class's contribution is zero, the mean's value and gradient depend
entirely on the hard class alone, and if other terms in the objective (`L_benign_lab`, `L_benign_cic`) make it costly
to push further on the hard class, a local optimum where the hard class stays only partly separated is a perfectly
comfortable resting point for a mean — there is no additional pressure that specifically punishes leaving one class
behind as long as the blended average looks small.

## What changes this batch: the margin combination rule only

**New formula: `L_margin(W) = max(hinge_mean_Hulk(W), hinge_mean_GoldenEye(W))`** — worst-of-both, not the mean.
Nothing else about the hinge changes: the per-window formula (`max(0, target(W) - loss)`), `target(W)`'s definition
(lab-benign pool only, unchanged), `MARGIN=0.02`, `SIGMA=2.5` are all identical to every prior round. Generalizes
cleanly to more than 2 classes (max over however many there are) if this project ever adds a third.

**Why `max`, not a sum of per-class hinges (the other option the task named):** summing two means instead of
averaging them (`hinge_mean_Hulk + hinge_mean_GoldenEye` vs. `(hinge_mean_Hulk + hinge_mean_GoldenEye) / 2`) is
**mathematically equivalent up to a constant factor of 2**, already fully absorbed by `LAMBDA`'s own scale — it has
the exact same critical points (same argmin over `W`), just a rescaled objective value. It is not a structural fix
for the mechanism diagnosed above; it changes nothing about *which* weight configurations are optimal, only how big
the number looks. `max`, by contrast, genuinely changes the gradient landscape: whichever class is currently worse
keeps full, undiminished pressure on the optimizer for as long as it stays worse, and only once it is pulled down to
match (or below) the other class does the pressure shift to whichever is worse *then* — there is no resting point
where one class is fully satisfied and the other is left comfortably behind, because the objective's value is
*defined* by whichever class is doing the worst at any point. This is the direct, named fix for the mechanism this
batch diagnosed, not a cosmetic rescaling of it.

**A risk named now, before running, not after:** forcing the optimizer to fully satisfy the *worse* class (rather
than letting it settle for a good average) may be harder to achieve without cost elsewhere — if the two classes'
natural separability from lab-benign really differs (as batches 2-4 suggest it does), `max` may force weights into a
regime that trades away some `L_benign_lab`/`L_benign_cic` quality, or lab recall/FP, to chase the harder class. If
that happens, it is reported plainly as a real cost of the fix, not hidden by only reporting the balance improvement.

## Architecture, objective, data: isolating the one variable

**Back to the 10-parameter architecture** (`scripts/sentinel-replay.py`'s original `kernel_loss` /
`kernel_loss_batch`), **not** batch 4's 85-parameter expansion — deliberately reverting that change so this batch
tests exactly one variable (the margin combination rule) against the same, best-understood configuration batches 2-3
used, rather than confounding it with the capacity change. `BETA=1.0` (batch 2's primary point, the hardest test of
the conflict, unchanged reasoning from that batch's pre-registration). Bounds `[-3.0, 5.0]` for all 10 weights,
unchanged. **Optimizer budget restored to the original 10-dimensional scale** (`popsize=20`, `maxiter=150`,
`Nelder-Mead` polish `maxiter=5000`) — batch 4's reduced budget was specifically a concession to DE's population
scaling with dimension at 85 parameters; back at 10 parameters there is no such justification for reducing it, and
not doing so keeps the optimizer identical to batch 2's, isolating the margin-formula change as the only input that
differs. Data: **batch-1 scale again** (lab benign pool ~6,264 windows unchanged; CIC benign anchor 2,000
windows/day; CIC attack margin-training 2,000 windows/class, `DoS Hulk` + `DoS GoldenEye`) — the same small, fast
sanity-check scale as every batch except batch 2's full-cap run, for a fast turnaround.

**Implementation:** additive only. `make_two_anchor_objective`/`two_anchor_components` in
`scripts/train-sentinel-weights-cic.py` gain an optional `margin_combine` parameter (`'mean'` default, reproducing
every prior batch's exact behavior unchanged; `'max'` this batch). A new `per_class_margin_hinge` diagnostic
function reports each class's own mean hinge value directly (regardless of which combine mode drives the fit), so
the balance this batch is testing for is visible on its own terms, not just inferred from the blended objective
value. `run_two_anchor` gains a `--margin-combine` CLI flag threading this through.

## Success criterion for this sanity check, decided now — the balance IS the headline this time

Unlike batch 4 (where the three-way lab-recall/lab-FP/CIC-benign-FP bar was primary), **this batch's primary
criterion is the per-class CIC-margin recall balance directly**, since that imbalance is the thing being tested:

- **Primary: neither `DoS Hulk` nor `DoS GoldenEye`'s window-level recall is below 20% while the other is anywhere
  near its ceiling** — concretely, both ≥20%, OR (if both land below 20%) the two values are within a factor of 3 of
  each other rather than one near-zero and the other near-100%. This is a direct test of *balance*, not of overall
  recall level — a `max`-combined fit that lands both classes at a modest but similar 15-20% would be read as the
  mechanism working as designed, even without clearing every batch-4-style bar.
- **Secondary, reported for context, not pass/fail this batch:** the same three-way lab-recall (≥6/13)/lab-FP (as
  good as or better than batch 2's 1/9)/CIC-benign-FP (≤2%) numbers batch 4 used, so this batch's result sits next
  to batches 2-4's in the same terms, and so the named risk above (fixing balance at a cost elsewhere) is visible if
  it occurs.

**Prediction, stated before running:** `max` is expected to narrow the per-class hinge *and* recall gap relative to
`mean` at the same `BETA=1.0` (batch 2's 1.19%/63.20% split, a ~53x ratio) — not necessarily by raising the worse
class all the way to the better class's level, but by moving the optimizer away from the "one class free, one class
abandoned" resting point `mean` permitted. If the gap does not narrow at all, that would be a surprising result
worth specific attention (it would suggest the imbalance is not explained by the mean-vs-max combination mechanism
and some other explanation is needed) rather than being read as "the fix didn't matter, move on."

As with every prior batch in this workstream: no PR, no four-axis held-out evaluation, no deployment-path change,
regardless of outcome.

**2026-10-24 addendum (batch 4, owner-approved, added before batch 4's own numbers were looked at):** batch 3 found a
sharp cliff, not a gradient — `BETA=0.25` already behaves identically to `BETA=1.0` on every held-out/peek metric
(lab recall 2/13, lab FP 1/9, CIC-benign FP ~0%), and the underlying weight vectors differ meaningfully between the
two `BETA` values despite landing on identical discrete outcomes. The owner's hypothesis for this batch: the
three-way conflict (low lab-benign loss + low CIC-benign loss + a wide lab-attack margin, all at once) may be a
genuine **capacity ceiling** of the current architecture — ten scalars, heavily weight-tied (the same 4 encoder
weights + bias applied identically to every one of the 64 packets in a window; the same 2 decoder weights broadcast
across all 256 reconstructed outputs) — rather than something any `BETA`/`LAMBDA`/`MARGIN` choice could fix. This
batch tests that hypothesis by giving the model more free parameters, **entirely offline, in the Python replica
only.**

**Explicit boundary, stated before any code is written:** `src/gpu/gpu_anomaly_kernel.cu` (the native CUDA kernel),
`scripts/sentinel-replay.py`'s `kernel_loss`/`Extractor`/`Adaptive` (the offline replica of that exact deployed
formula, pinned by `test/invariants/sentinel-replay.test.ts`), `scripts/gpu-sdn-anomaly-sentinel.py`'s default
behavior, and `scripts/score-labelled-runs.py` (the shared scoring harness several other things in this repo rely on
being stable) are **not modified** by this batch. `load_cuda_model_weights()` / `--weights-file` expects exactly the
existing 10-scalar shape; a differently-shaped model cannot be loaded by the live daemon without a new kernel variant,
hardware rebuild, and re-validation of the fail-closed loader for a new shape — a separate, much larger follow-on
project, not in scope here. Everything new this batch lives in a new script,
`scripts/train-sentinel-weights-expanded.py`, with one small, additive, backward-compatible change to
`scripts/train-sentinel-weights-cic.py`'s `score_cic_block` (an optional `kernel_loss_fn` parameter, default
unchanged, so the CIC-block scoring plumbing built over the last three batches can be reused for a different-shaped
kernel instead of being duplicated).

## Architecture: un-tie stage 1 only, per the existing 16 groups — 85 parameters, not the largest option

The current formula (`kernel_loss` in `scripts/sentinel-replay.py`) has four stages: **(1)** an encoder
(`W[:4]`, `W[4]`) mapping each packet's 4 features to one scalar `h`, with *the same 5 weights applied identically to
all 64 packets in the window*; **(2)** a bottleneck (`W[5]`, `W[6]`) that sums `h` within each of 16 groups of 4
consecutive packets (the same grouping the window already has from `h.reshape(16,4)`) and applies one shared
linear+ReLU; **(3)** a broadcast-decode step (`W[7]`) that repeats the 16 latent values cyclically back out to 64;
**(4)** a final decode (`W[8]`, `W[9]`) broadcasting those 64 values to the 256 output features via a shared
sigmoid. Round 1's own README already named stage (1)'s and (4)'s weight-tying as the specific thing that "caps how
much a fit can possibly discriminate between traffic shapes regardless of how well it is optimized."

**This batch un-ties stage (1) only, along the window's own existing 16-group boundary** (the same grouping stage
(2) already uses): instead of one shared 5-parameter encoder (4 weights + bias) applied to all 64 packets, each of
the 16 groups of 4 consecutive packets gets its **own** 5-parameter encoder. Stages (2), (3), (4) are left exactly
as they are — still one shared `W5`/`W6`, one shared `W7`, one shared `W8`/`W9`. **Total: 16 × 5 + 5 = 85
parameters** (vs. the current 10), laid out as an `(80,)` block of 16 per-group `(w0,w1,w2,w3,bias)` tuples followed
by the unchanged 5 shared scalars.

**Why this level, not more or less:** stage (1)'s tying is the most severe in the current formula — it forces the
reconstruction to treat a packet at the start of a 64-packet window identically to one at the end, discarding any
temporal-position information entirely, even though the detector's whole job is reading a time-ordered sequence for
burst/onset behavior. Un-tying it along the window's *own* existing grouping (not inventing a new one, e.g.
per-packet) is the smallest change that removes that specific blindness, reuses structure the formula already has,
and is cheap enough to search with a bounded optimizer budget at batch-1 data scale. A fuller expansion (per-packet
stage 1 = 64×5 = 320 params, or also un-tying stages 2-4 per group) was considered and rejected for *this* batch
specifically because the question being asked is "does *any* added capacity move the needle at all" — an 8.5x
increase (10 → 85) is already a substantial, clearly-motivated test of that question; reaching for the largest
possible expansion first would conflate "capacity doesn't help" with "the search couldn't cover a much bigger space
on a sanity-check budget," which this batch is specifically trying to avoid confounding.

## Objective, bounds, data: the two-anchor formula unchanged, `BETA=1.0` (not `0.25`)

Reuses the exact two-anchor objective from batches 1-2 (`L(W) = L_benign_lab(W) + BETA * L_benign_cic(W) + LAMBDA *
L_margin(W)`, same hinge formula, `MARGIN=0.02`, `SIGMA=2.5`, `LAMBDA=1.0`), with the loss arithmetic computed by a
**new** `kernel_loss_batch_expanded` instead of `kernel_loss_batch` — no change to the formula's shape, only to which
per-window scalar function evaluates it. **`BETA=1.0`**, not batch 3's `0.25`: this batch's question is whether more
capacity resolves the conflict under the *strongest* version of the competing pressure (where batches 1-2 measured
the worst recall collapse and the worst bound-pinning), which is the most informative place to test "does capacity
help at all" — if `BETA=1.0` still can't be satisfied with 85 parameters, a milder `BETA` is unlikely to need rescuing
by capacity either, and if it *can* be satisfied at `BETA=1.0`, that is unambiguous evidence capacity was the limit.

Bounds: `[-3.0, 5.0]` for all 85 parameters, unchanged from every prior round's box — reused for continuity (many of
the new parameters play the same functional role, an encoder weight or a bias, as the ones already in that box) and
because this batch is not testing whether a different box helps, only whether more free parameters inside the
*same* box do.

Data: **batch-1 scale, reused as-is** — the lab's unchanged full benign-training pool (~6,264 windows), the CIC
benign anchor (2,000 windows/day, Wednesday + Friday pre-attack), and the CIC attack margin-training pool (2,000
windows/class, `DoS Hulk` + `DoS GoldenEye`) — all drawn from the same cached `.npz` files and index ranges batch 1
used. The lab's existing 9-benign/13-attack reduced held-out split is reused for the same informal peek batches 1-3
used (not a formal axis (a) evaluation).

**Optimizer budget, deliberately reduced from batches 1-3 and why:** `scipy.optimize.differential_evolution`'s
`popsize` parameter is a *multiplier on the number of parameters* — the actual population is `popsize × ndim`. At
the prior rounds' `popsize=20` and `ndim=10`, that is a population of 200; at `ndim=85` it would be 1,700, roughly
8.5x more function evaluations per generation at the same `maxiter`. Run at that scale, this sanity check would cost
roughly 8.5x batch 1's runtime for no benefit to what this batch needs to learn. **`popsize` is reduced to `6`
(population 510) and `maxiter` to `60`** (vs. 150), chosen so the total evaluation budget (`population × (maxiter+1)`
≈ 31,110) lands close to batch 1's own `nfev` (30,211) — a deliberately *comparable total search budget* to batch 1,
not a comparable per-dimension budget (which would need far more). **This is disclosed plainly as a real limit of
this sanity check, not hidden**: an 85-dimensional space searched with roughly the same total evaluation count as a
10-dimensional one is a much sparser relative search, and a negative result here (capacity doesn't seem to help)
cannot fully rule out that a properly-scaled search budget would find a better 85-parameter fit. A positive result
(capacity does help, even under-searched) would be the stronger, more informative outcome either way. The
`Nelder-Mead` polish step's `maxiter`/`maxfev` are reduced from `5000` to `2000` for the same cost-bounding reason.

## Self-check: no pre-existing oracle exists for this formula, so one is built for this batch specifically

Every prior round's `self_check()` verifies a vectorized re-implementation against `sr.kernel_loss`, the known-good,
already-pinned reference for the *existing* 10-parameter formula. No such reference exists for the new 85-parameter
shape, because it has never been implemented before this batch. This batch writes an independent, deliberately
un-vectorized, loop-based scalar reference (`kernel_loss_scalar_expanded`, one packet/group at a time, no batching
tricks) of the *same intended formula* as `kernel_loss_batch_expanded`, and checks the two agree (same tolerance
discipline as the existing `self_check`: `1e-4`, loosened only at the `BOUNDS` corners where the sigmoid saturates)
at the compiled-in-style defaults (all-zero and a few arbitrary small values), both `BOUNDS` corners, and several
random interior points, on both a real lab window and a real CIC window — this is not a "does it match the deployed
kernel" check (there is nothing deployed to match), it is a "do two independently-written codings of the same new
formula agree" check, the same discipline for the same reason, applied to new code instead of old.

## Success criterion for this sanity check, decided now

Stated concretely, per the task's own framing, checked against the informal lab-held-out peek and the CIC-benign
peek (same small, non-formal samples as batches 1-3, not a held-out-validated claim either way):

- **Lab held-out attack-detected (right sender) ≥ 6/13**, AND
- **CIC-benign false-positive rate ≤ 2% on both days**, AND
- **Non-trivial CIC-margin recall on *both* training classes** (`DoS Hulk` and `DoS GoldenEye`), defined as **≥20%
  window-level recall on each**, not just one — batches 2 and 3 both showed one class at high recall and the other
  barely above baseline under the existing 2-class nested mean; requiring both classes to clear a bar avoids crediting
  the same lopsided-learning pattern as "capacity fixed it" when it may have just moved which class benefits.

**If all three hold:** read as real evidence that capacity, not the objective or the data, was the binding
constraint, and that a full-scale run of this architecture (not attempted this batch) is a reasonable next step.
**If lab recall or CIC-margin recall stay collapsed even with 85 parameters, while the CIC-benign fix still holds:**
read as evidence the cliff is a property of the *objective* (the three-way pull between the terms), not of capacity
— capacity alone, at least at this level and this search budget, does not resolve it, which is itself a legitimate,
useful, reportable finding, not a failed experiment. Partial outcomes (e.g. two of three criteria met) are reported
as exactly that, not rounded toward either reading.

As with every prior batch in this workstream: no PR, no four-axis held-out evaluation, no deployment-path change,
regardless of outcome.

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
