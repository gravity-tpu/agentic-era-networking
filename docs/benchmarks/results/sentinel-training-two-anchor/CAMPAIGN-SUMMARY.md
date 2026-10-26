# Two-anchor sentinel training campaign: summary and recommendation (batches 1-17, 2026-10-25/26)

**Status: campaign paused at batch 16, then resumed for one owner-directed follow-up (batch 17).** This document was
originally written at the point where two independent negative results on unifying the detector into one model
(batches 4 and 16) made continuing to search that direction a poor use of time relative to the working answer
already found (batch 13). Batches 1-16 live on the local, unpushed branch `feat/sentinel-two-anchor-training` with
no PR open, per the convention established at batch 1. **Batch 17 is a separate, owner-approved follow-up that
reviewed batch 13's recommendation, found its disclosed lab-benign false-positive cost (5/9) unacceptable for
production, and tried one specific fix (recalibrating Model B's own tau as an ensemble component).** It lives on its
own local, unpushed branch, `feat/sentinel-ensemble-fp-reduction`, based on current `main` post-PR-#125-merge — NOT
on `feat/sentinel-two-anchor-training`, which is already fully merged. See the batch 17 section below and
`PREREGISTRATION.md`'s batch 17 addendum for the full write-up. Nothing in either branch is final in the sense of
being merged, deployed, or acted on; this write-up is for the project owner to read and decide what, if anything, to
do next.

## The problem

The Jetson GPU anomaly-detection autoencoder (`sr.kernel_loss` / `sr.W`, a 10-scalar, 4-stage tied-weight kernel) is
the live detector feeding Track C's containment path (`docs/ROADMAP.md`). Its weights had never been evaluated
against real attack traffic beyond the lab's own small hand-run captures. This campaign asked: can this detector be
trained (or re-architected) to reliably catch both (a) CIC-IDS2017's labelled DoS attack traffic and (b) the lab's
own held-out attack patterns (portscans, SYN floods), without false-positiving on ordinary traffic from either
source?

## What was tried, in order

**Batches 1-8: find a training objective that works.** Early batches (1-6) tried static-target hinges of increasing
sophistication (per-class margins, max-vs-mean combination, wider architectures). Batches 7-8 tried making the
margin "Adaptive-aware" — training against a replay of the real, deployed `sr.Adaptive` dynamic threshold instead
of a fixed target — first with a training/eval warm-up mismatch (batch 7), then with that mismatch fixed (batch 8).
Both failed decisively (Hulk recall 0-1.5%, GoldenEye recall 38-39%, against a best-ever prior of 28.58%/63.20%).

**Batch 9: the actual breakthrough on the objective.** The real failure in batches 7-8 wasn't the warm-up
convention — it was optimizing a per-window hinge when the actual graded metric (`score_cic_block`'s `alerts/n`) is
a sequence-level aggregate. Replacing the hinge with a direct, smooth differentiable surrogate for that aggregate
rate took Hulk/GoldenEye recall from under 40% to 99-100%, verified via the real, unmodified scoring function (not
just the surrogate). Batch 10 tuned one hyperparameter (`--surrogate-temperature-frac`) to also clean up a
CIC-benign false-positive regression batch 9 had introduced, landing at 100%/100% recall with 0.00%/0.00%
CIC-benign FP — the best possible result on the CIC side alone.

**Batches 9-12: discover the capacity conflict.** The same CIC-focused training that fixed Hulk/GoldenEye recall
was, unnoticed at first, destroying the detector's ability to catch the lab's own attacks: the original hardcoded
baseline weights detect 10/13 lab held-out attacks; batches 7-9 held flat at 4/13; batch 10's CIC fix drove it down
further, to 2/13 (worst in the whole campaign). Batch 11 diagnosed the actual mechanism — not a static threshold gap
shrinking, but a feedback loop in `sr.Adaptive`'s own EMA, where early attack windows get assimilated as "normal"
once the loss-to-threshold gap gets small enough, locking out detection for the rest of a run — and tested a fix (a
dedicated lab-attack anchor term). It partially worked (lab recall back to 4/13) but introduced a new CIC-benign FP
cost (3.30% Friday). Batch 12 swept the CIC margin term's own weight down instead, with no lab anchor at all, and
landed at almost the *identical* tradeoff point (4/13 lab recall, 3.25% Friday FP) via a completely different lever.
Two unrelated mechanisms converging on the same operating point is strong evidence this is a genuine shared-capacity
limit of the 10-parameter kernel — not a tuning problem one more lever would fix.

**Batch 13: the answer that actually works.** Given the capacity conflict, the owner decided to stop unifying and
evaluate two independently-fitted specialist models combined by a simple rule instead of one shared kernel. Model A
= batch 10's CIC-shaped weights. Model B = the *original* pre-campaign baseline weights (empirically confirmed,
not assumed, to beat PR #106's own dedicated lab-margin weights at lab recall: 10/13 vs 6/13). Ensemble rule: alert
if *either* model's own `kernel_loss` crosses *its own* independently-calibrated threshold. Result: lab held-out
detected 10/13, CIC Hulk/GoldenEye recall 100%/100%, CIC-benign FP 0.00%/0.25% — clearing every pre-registered bar
by a wide margin, and the first result in the whole campaign to get near-original lab recall and clean CIC numbers
at the same time. Verified independently (not just trusted from the subagent's self-report): the new evaluation
script's self-checks pass, and Model A's solo numbers reproduce batch 10's committed numbers byte-for-byte.

**A real cost this result does not hide, but the pre-registered bar also did not gate on:** lab-benign false
positives. Model A alone: 1/9. Model B alone (the baseline): 4/9. The OR-combined ensemble: **5/9** — worse than
*either* model alone, which is the expected mechanical consequence of ORing two models' alerts (false positives can
only add, never cancel). Lab-held-out FP was never part of batch 13's pre-registered pass/fail bar (only CIC-benign
FP was), so the batch's own verdict of "clears the bar" is correct as stated — but a 5/9 (56%) false-alert rate
against ordinary lab traffic (bulk TCP, HTTP bursts, ping, small UDP) is a material, practical cost that belongs in
the headline result, not left for a reader to find by digging into the raw training transcript. Whether this
tradeoff — materially better real-attack recall at roughly double the false-alert rate on ordinary lab traffic — is
acceptable is a judgment call for whoever reviews this before any production wiring, not a decision this campaign
made on their behalf.

**Batch 14: honestly scope what the ensemble can't claim.** Model A was only ever anchored against two of
CIC-IDS2017's many attack classes (Hulk, GoldenEye). Tested against three classes it had never seen
(`DoS Slowhttptest`, `DoS slowloris`, `DDoS`, using data already cached locally): recall was near-zero on two of
three (2.3-3.5%) and modest on the third (16.2% for slowloris, plausibly because it's mechanistically similar to
Hulk/GoldenEye's HTTP-layer flood shape). The ensemble did not meaningfully outperform Model A alone on any
out-of-sample class — no evidence the lab-shaped kernel contributes complementary out-of-sample coverage. This is
the honest scope limit: **this detector family catches CIC-IDS2017 Hulk/GoldenEye-style volumetric HTTP floods, plus
partially slowloris-style ones, and the lab's own flood/scan patterns — it is not a general network intrusion
detector**, and should not be described as one.

**Batches 15-16: option 3, a structurally different unified architecture.** Per the owner's explicit instruction
("option 2 then option 3, in that order"), this tested whether a single, jointly-trained architecture could match
the ensemble's numbers without needing two separately-fitted models. Batch 15 read the real kernel math, confirmed
the Jetson's measured compute budget has ~369x headroom (so compute was never the limiting factor), diagnosed from
the committed weight vectors that the CIC/lab conflict moves at least 5 of 10 weights together (ruling out a
single-interaction-term fix), and designed a 23-parameter jointly-fit gate over two full sub-kernels. A smoke test
looked mechanistically promising. Batch 16 completed the full-scale run: it **failed** the pre-registered bar (lab
held-out 4/13 vs. a required ≥8/13; Hulk recall 5.60% vs. ≥90%; GoldenEye recall 50.25% vs. ≥90% — only the
CIC-benign FP guardrail passed). The fitted gate didn't learn real specialization — lab-benign windows got routed
mostly to the CIC-shaped sub-kernel, and CIC attacks split almost evenly between the two sub-kernels instead of
cleanly routing to whichever one actually catches them, landing in a local optimum that minimizes blended training
loss without reproducing what batch 13's externally-imposed, always-both-vote ensemble rule achieves by
construction. This is option 3's **second** negative result, after batch 4's (raw width expansion to 85 parameters
also didn't resolve the capacity conflict).

**Batch 17 (separate branch, `feat/sentinel-ensemble-fp-reduction`): the owner reviewed batch 13's disclosed 5/9
lab-benign FP cost and asked for it to be reduced, accepting some recall cost if needed.** The owner's target is
roughly a 90% "signal to noise" ratio on alerts (lab-benign FP toward ~1/9, ~10%). This batch tried the one lever
nobody in batches 1-16 had tried: recalibrating Model B's (the baseline's) own `tau` specifically for its role as an
ensemble component, holding Model A completely fixed. A 9-point sweep of Model B's tau (0.15 baseline up to 0.2236,
the ceiling derived from Model B's own loss distribution on its lab-benign training pool) found **tau_B=0.19 clears
a pre-registered bar** (lab-benign FP `<= 2/9`, lab held-out detected `>= 6/13`, CIC Hulk/GoldenEye recall `>= 90%`
each, CIC-benign FP `<= 2%` both days): lab-benign FP improves from 5/9 (56%) to 2/9 (~22%), CIC Hulk/GoldenEye
recall stays at 100.00%/100.00%, and CIC-benign FP actually improves too (0.25%→0.00% Friday) — at the cost of lab
held-out detection falling from 10/13 to 6/13. This does not reach the owner's ~10% target (2/9 is still roughly
double it), and the sweep found a sharp cliff just past this point (tau_B=0.205 reaches 1/9 FP but lab detection
collapses to 2/13) — reaching the full target from here would cost most of the remaining lab-attack recall. See
`PREREGISTRATION.md`'s batch 17 addendum for the full tradeoff table, the AND-rule reference point, and next steps.

## Recommendation

**Deploy consideration: batch 13's two-model ensemble, with batch 17's tau_B=0.19 recalibration as the owner-facing
alternative for lower lab-benign false positives**, not any single unified kernel. Batch 13's ensemble (Model A =
batch 10's weights, Model B = baseline `sr.W` at its own standalone tau=0.15) is the only configuration in 16 batches
to clear CIC recall, CIC-benign FP, and lab-attack recall simultaneously, verified against the real scoring functions
and independently checked for leakage/degenerate solutions before being accepted. **This comes with a real, disclosed
cost, not a free win: lab-benign false positives rise to 5/9 (56%), worse than either component model alone (Model A
1/9, Model B 4/9) — the expected consequence of ORing two models' alerts together.** Materially better real-attack
recall at roughly double the false-alert rate on ordinary lab traffic is the actual tradeoff batch 13 recommended,
and whether that's acceptable was explicitly left for the reviewer — the owner reviewed it and said no, prompting
batch 17. **Batch 17's tau_B=0.19 variant (same two weight sets, Model B's tau raised from 0.15 to 0.19) is a
disclosed, real alternative point on the same tradeoff curve: lab-benign FP 2/9 instead of 5/9, at the cost of lab
held-out detection 6/13 instead of 10/13, with CIC recall/FP unaffected or improved.** Neither point reaches the
owner's full ~90% signal/noise goal; which point (or whether to keep searching for a better one, e.g. jointly
retuning Model A's own tau) is a decision for the owner, not resolved by this campaign. Its outputs
(`scripts/eval-sentinel-ensemble.py`, `docs/benchmarks/results/sentinel-training-two-anchor/trained-weights-two-anchor-batch10-2026-10-25.json`
as Model A plus the original hardcoded `sr.W` as Model B) are not wired into
`scripts/gpu-sdn-anomaly-sentinel.py` — that integration was explicitly out of scope for this autonomous campaign
and needs the owner's review first. Batch 13's own report scoped roughly what it would take: two weight-set
configs instead of one, two independent `AdaptiveThresholdController` instances (each tracking its own EMA from its
own model's loss stream), two kernel inferences per window (cheap given the measured ~369x compute headroom, but
should be confirmed against the live kernel rather than assumed), the quarantine dispatch path OR-combining both
models' alerts with the reason field disclosing which fired, and a fresh end-to-end validation against the live
kernel before this becomes a non-opt-in default path.

**Disclose, don't paper over, the scope limit from batch 14.** Whatever gets deployed should be described
accurately: a detector tuned for CIC-IDS2017's Hulk/GoldenEye-style volumetric floods and the lab's own flood/scan
patterns, not a general intrusion detector. This is consistent with this project's own stated discipline (`AGENTS.md`:
"do not describe unimplemented work as implemented").

**Option 3 (a genuinely unified architecture) is not closed off forever**, but two independent negative results
(width expansion, and now joint gating) mean further search there should wait for a materially different idea —
e.g. a different gate feature set, training the gate and sub-kernels in separate phases rather than jointly, or a
much larger optimizer budget — rather than another one-off variant of what's already been tried twice.

## Batch index

| Batch | Commit | What it tried | Result |
| --- | --- | --- | --- |
| 1 | `4719cae` | Two-anchor objective, sanity check | baseline established |
| 2 | `ef13166` | Full-scale CIC attack-training cap | resolved batch 1's sample-size ambiguity |
| 3 | `0d4ccc0` | BETA=0.25 | best-ever Hulk recall 28.58% at the time |
| 4 | `409fdd2` | 85-parameter expanded architecture | capacity alone doesn't resolve the conflict (negative result #1) |
| 5 | `1250bad` | Max-combined per-class margin | best-ever GoldenEye recall 63.20% at the time |
| 6 | `d46ebd1` | 85-param + max-margin combined | traced the hinge-vs-Adaptive gap |
| 7 | `635c004` | Adaptive-replay-aware margin (warm-start) | FAIL, found a train/eval convention mismatch |
| 8 | `c263d4d` | Same, cold-start fix | still FAIL — ruled out the mismatch as the cause |
| 9 | `026dcfc` | Sequence-level alert-rate surrogate | Hulk/GoldenEye to 99-100%; surfaced the lab-recall regression |
| 10 | `89acd1c` | Softer surrogate temperature | 100%/100% recall, 0.00%/0.00% CIC-benign FP; lab recall worst-ever (2/13) |
| 11 | `6858fc7` | Dedicated lab-attack anchor term | PARTIAL — lab recall to 4/13, but new CIC-benign FP cost |
| 12 | `03039c1` | CIC-margin weight sweep (no lab anchor) | same 4/13 tradeoff point via a different lever — confirmed capacity conflict |
| 13 | `a213700` | Two-model OR ensemble (option 2) | **PASS** — 10/13 lab recall, 100%/100% CIC recall, 0.00%/0.25% CIC-benign FP; but lab-benign FP 5/9, worse than either model alone (not pre-registered, disclosed) |
| 14 | `f162817` | Out-of-sample CIC classes | honest scope limit: near-zero to modest generalization beyond Hulk/GoldenEye |
| 15 | `e1f4ef7` | Jointly-fit gated architecture (option 3), design + smoke test | INCOMPLETE at commit time (full run not finished) |
| 16 | `247aa5a` | Same architecture, full-scale run | FAIL — option 3's second negative result |
| 17 (own branch `feat/sentinel-ensemble-fp-reduction`) | (this batch) | Sweep Model B's own tau as an ensemble component, holding Model A fixed | tau_B=0.19 clears a pre-registered bar: lab-benign FP 5/9→2/9, lab held-out 10/13→6/13, CIC recall/FP unaffected or improved; does not reach the owner's full ~10% FP target |

## Verification discipline used throughout

Every batch above a certain weight followed the same pattern, applied independently of the batch's own self-report:
read the actual diff (not just the commit message), re-derive or spot-check the claimed numbers against the raw
training transcript, check for leakage (is the evaluation metric computed the same way the deployed decision would
be made?), check for degenerate solutions (bound-pinned weights, a collapsed false-positive-everything or
false-positive-nothing trivial solution), and run the existing test suite before accepting a commit. Several
batches' own self-reports flagged real caveats unprompted (batch 7 finding its own train/eval mismatch, batch 11
disclosing a new cost rather than overclaiming a fix, batch 15 reporting INCOMPLETE rather than padding a smoke
test into a false pass) — this discipline is itself part of why the batch 13 recommendation above can be trusted
rather than merely hoped for.
