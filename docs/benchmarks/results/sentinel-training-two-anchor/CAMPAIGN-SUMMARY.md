# Two-anchor sentinel training campaign: summary and recommendation (batches 1-18, 2026-10-25/26)

**Status: campaign paused at batch 16, then resumed for two owner-directed follow-ups (batches 17-18).** This
document was originally written at the point where two independent negative results on unifying the detector into
one model (batches 4 and 16) made continuing to search that direction a poor use of time relative to the working
answer already found (batch 13). Batches 1-16 live on the local, unpushed branch `feat/sentinel-two-anchor-training`
with no PR open, per the convention established at batch 1. **Batches 17-18 are a separate, owner-approved follow-up
that reviewed batch 13's recommendation, found its disclosed lab-benign false-positive cost (5/9) unacceptable for
production, and tried two successive, independent fixes (batch 17: recalibrating Model B's own tau as an ensemble
component; batch 18: a diagnostic plus a joint Model-A/Model-B tau sweep).** They live on their own local, unpushed
branch, `feat/sentinel-ensemble-fp-reduction`, based on current `main` post-PR-#125-merge — NOT on
`feat/sentinel-two-anchor-training`, which is already fully merged. See the batch 17/18 sections below and
`PREREGISTRATION.md`'s batch 17/18 addenda for the full write-up.

**Decision (owner, 2026-10-26): accept batch 17's tau_B=0.19 point (6/13 lab recall, 2/9 lab-benign FP) as this
architecture's practical ceiling.** Batch 18 showed this is a real, four-way-converged limit of the specific kernel
and feature set used throughout this campaign, not an under-searched tuning gap — see "What this does and does not
prove" under Recommendation below for exactly what is and is not proven. Richer features, a different nonlinear
model class, or a larger optimizer budget remain open as deliberate future research, not pursued here. Production
integration (opt-in, strongly recommended; live cost reconfirmation; live end-to-end validation) follows in a
separate PR.

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
the Jetson's measured compute budget has ~369x headroom (so compute was never the limiting factor — this figure was
later re-derived directly against the live kernel during production integration and corrected to ~0.164ms, ~6x
headroom under the <1.0ms budget, still comfortable but a real measured number rather than this archived one; see
"Production integration" below), diagnosed from
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

**Batch 18 (same branch): diagnosed which model fires on the two remaining lab-benign FP patterns at tau_B=0.19,
then tried the joint tau_A/tau_B lever batch 17 flagged as the natural next step.** A new `--verbose-per-model-flags`
diagnostic (reusing, not reimplementing, the ensemble replay helpers' own internal is_a/is_b flags) found a SPLIT
attribution: Model A alone causes the `benign-bulk-tcp-2mbit` false positive; Model B alone, even after batch 17's
recalibration, still causes the `benign-ping-20pps` false positive. Because Model A is responsible for one of the
two, tau_B alone can never fix it — confirming the joint-lever branch was the right one to pursue. A 25-point
tau_A x tau_B grid (tau_A's own range derived from its lab-benign calibration pool and its DoS Hulk/GoldenEye raw
loss distributions, the same discipline batch 17 used for tau_B) found an even sharper cliff than batch 17's: Hulk
recall collapses from ~100% to 30.85% between tau_A=0.195 and 0.20, traced to a specific, verified mechanism —
`AdaptiveThresholdController` seeds its own dynamic threshold at `1.125 x base_threshold` before any window is
observed, and that seed already sits almost exactly at DoS Hulk's own lowest-loss window at the CURRENT tau_a, a
razor-thin margin inherited from batch 10's own calibration. Even within tau_A's narrow safe band, raising it buys
zero improvement on `benign-bulk-tcp-2mbit` (its own loss range genuinely overlaps DoS Hulk/GoldenEye's), and pushing
tau_A far enough to suppress it (tau_A>=0.30) does reach lab-benign FP 1/9 with lab detected holding at 6/13 — but
collapses CIC Hulk recall to ~1% and GoldenEye to 2-43%, both catastrophically failing the recall floor. An
exploratory check swapping in PR106's weights as Model B reproduced an identical 2/9 tradeoff point with a
completely different weight vector. **No point on the grid, nor the exploratory swap, clears batch 18's own
pre-registered bar (lab-benign FP<=1/9 AND lab detected>=6/13 AND CIC recall>=90% each AND CIC-benign FP<=2% both
days).** Three independent probes (tau_B alone, tau_A+tau_B jointly, a Model-B weight swap) now converge on the same
~2/9 FP floor for >=6/13 lab detected with this Model-A/Model-B pair — strong evidence of a real ceiling in this
two-scalar-threshold architecture, not just an under-searched tuning gap. See `PREREGISTRATION.md`'s batch 18
addendum for the full grid, the mechanism trace, and two concrete untried levers named for a future batch (a
dedicated lab-benign anchor term for Model A's training, or a deterministic pre-filter feature ahead of the OR rule).

## Recommendation

**Decided: deploy batch 17's tau_B=0.19 variant** — Model A (batch 10's weights, unchanged) OR Model B (the original
baseline `sr.W`, with tau raised from its own standalone-optimal 0.15 to 0.19). Lab held-out detection 6/13,
lab-benign FP 2/9 (~22%), CIC Hulk/GoldenEye recall 100%/100%, CIC-benign FP 0.00%/0.00%.

The owner's actual target was tighter — roughly a 90% signal-to-noise ratio on alerts (lab-benign FP near ~10%).
Batch 18 tested whether that target was reachable with this architecture: a full joint tau_A/tau_B grid (25 points,
ranges derived from each model's own measured loss distribution, not guessed) found that the two remaining
lab-benign false positives at tau_B=0.19 have **split root causes** — `benign-bulk-tcp-2mbit` is Model A firing
(its loss genuinely overlaps Hulk/GoldenEye's loss range, a real feature-space collision, not a miscalibrated
threshold), `benign-ping-20pps` is Model B firing. Since two different models cause the two remaining alerts, no
single threshold adjustment on either model can remove both. The one grid point that did reach FP≤1/9
(`tau_A=0.30, tau_B=0.19`) did so by desensitizing Model A so much that Hulk recall collapsed to 1% and GoldenEye to
43% — proving FP≤1/9 and detected≥6/13 are not mutually exclusive in principle, but not achievable together without
destroying the recall this whole effort exists to get.

**What this does and does not prove.** Four independent angles — architecture width (batch 4), a jointly-trained
gate (batches 15-16), threshold tuning alone (batch 17), and threshold tuning jointly (batch 18) — all converge on
essentially the same ceiling for this specific kernel family and feature set. That is real, verified evidence of a
limit in *this* design space (a small, mostly-linear, 4-features-per-packet, weight-tied autoencoder kernel), not
proof that no cheap detector could ever separate `benign-bulk-tcp-2mbit` from a volumetric HTTP flood. Three
concrete, untried directions remain open for later, deliberate research rather than another quick batch: (1) richer
features (e.g. inter-arrival timing variance, port diversity) that might carry the discriminating signal the current
4 features don't; (2) a genuinely different nonlinear model class, since the one nonlinear form tried (a jointly-
trained gate) failed on optimization, not because no solution exists; (3) a substantially larger optimizer search
budget than the batch-scale budgets used throughout this campaign. None of these were pursued here deliberately —
the decision was to ship the verified 6/13-recall, 2/9-FP point now rather than open a new, open-ended research
line before closing this one out.

## Production integration

`scripts/gpu-sdn-anomaly-sentinel.py` now has an opt-in `--enable-ensemble` flag (default off — zero behavior change
to the pre-existing single-model path unless explicitly passed) implementing batch 17's recommended configuration:
Model A = `trained-weights-two-anchor-batch10-2026-10-25.json` (tau=0.187660), Model B = the original compiled-in
baseline (tau=0.19), each with its own independent `AdaptiveThresholdController` (separate EMA state, never
shared), alerting if either fires, with the quarantine reason field disclosing exactly which model(s) fired.

**A real, serious bug was found and fixed during the required live validation, not before it.** The native CUDA
engine's weight buffer (`d_weights` in `src/gpu/gpu_anomaly_kernel.cu`) is a single, process-global static pointer
with no per-instance state. Two `Gpu1DAutoencoder` Python instances in one process (Model A and Model B) silently
shared it: whichever instance's constructor loaded weights LAST determined what BOTH instances' inference calls
actually ran against, for the rest of the process's life. The first live `--enable-ensemble` run on the Jetson
showed this directly — Model A and Model B reported byte-identical losses on every single window, despite genuinely
different weights being loaded. This could not have been caught by the offline evaluation batches (9-18), which
never ran two native-engine instances in one process, or by a Mac-only smoke test (the non-CUDA fallback path has
no shared native state to collide on). Fixed by having each instance re-upload its own weights immediately before
its own inference call, every window, only when `--enable-ensemble` is set — zero added cost to the default path.
Re-measured live on the Jetson after the fix, with the two models genuinely producing different losses: this is
where the corrected ~0.164ms compute-cost figure above comes from (up from an earlier, bug-confounded ~0.102ms
estimate that had unknowingly measured two calls against the same weights).

Still ahead of a non-opt-in default: broader live validation against real tap traffic (this integration's live test
used synthetic demo-mode traffic against the real kernel, confirming correctness and cost, not real-world detection
behavior), and the scope-limit disclosure is now in the module docstring, the `--enable-ensemble` startup banner,
and this document — not yet in any operator dashboard, if one exists.

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
| 17 (own branch `feat/sentinel-ensemble-fp-reduction`) | `f9b84a6` | Sweep Model B's own tau as an ensemble component, holding Model A fixed | tau_B=0.19 clears a pre-registered bar: lab-benign FP 5/9→2/9, lab held-out 10/13→6/13, CIC recall/FP unaffected or improved; does not reach the owner's full ~10% FP target |
| 18 (same branch) | (this batch) | Diagnosed which model fires on the two remaining lab-benign FP patterns, then jointly swept Model A's and Model B's own tau | split attribution (Model A causes one FP pattern, Model B the other); 25-point joint grid found an even sharper, mechanistically-traced cliff on tau_A with zero marginal benefit in its safe range; no point clears batch 18's own tighter bar; three independent levers now converge on the same ~2/9 FP ceiling |

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
