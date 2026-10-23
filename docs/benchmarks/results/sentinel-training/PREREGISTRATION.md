# Fitting the GPU sentinel's ten weights: pre-registration

Written 2026-10-23, before the training script is run and before any held-out number is looked at. Same convention
as [`track-c-scenario3-portscan/PREREGISTRATION.md`](../track-c-scenario3-portscan/PREREGISTRATION.md): results go in
`README.md` next to this file; this file is not edited afterwards except to add a dated note saying what changed and
why.

## The claim under test

`docs/benchmarks/results/sentinel-detection/README.md` and `labelled-runs/README.md` both disclose that the GPU
sentinel's "autoencoder" is ten hardcoded scalar constants (`src/gpu/gpu_anomaly_kernel.cu`,
`0.20, 0.30, 0.25, 0.25, 0.05, 0.50, 0.02, 0.85, 1.50, 0.40`) and that nothing in the repository trains it.
`load_cuda_model_weights()` exists and works (it is declared, implemented, and type-checked from the Python ctypes
loader) but is never called. This work fits those ten weights against real benign traffic and measures, honestly,
whether fitted weights do better than the hardcoded ones at the one job an autoencoder-based anomaly detector has:
scoring benign traffic low and attack traffic high, on data the fit never saw.

This is explicitly **not** a redesign. The architecture (`kernel_loss` in `scripts/sentinel-replay.py`, mirrored
exactly in `src/gpu/gpu_anomaly_kernel.cu`) stays as it is: four weight-tied encoder weights and a bias applied
identically to every packet's four features, a second linear+ReLU bottleneck, a broadcast decoder, and a sigmoid
output — ten trainable scalars, nothing more. The window size (64 packets), the four input features, and the overall
shape are fixed by the repo's prior work and are out of scope here.

## Data and the honesty problem with it

`docs/benchmarks/results/labelled-runs/` has 51 recorded runs; `scripts/score-labelled-runs.py`'s existing validity
rule (sender seen at least 20 times at the tap, rack recorded healthy after the run) leaves 45 scored: **27 benign,
18 attack**, across 12 distinct benign workload patterns and 7 attack patterns, each with 1 to 3 repeats recorded on
one host pair over a few days.

**This is thin for fitting anything, and thinner still for validating it.** Ten parameters is small enough that even
27 benign runs can fit them without obviously memorizing noise, but most patterns have only 2 or 3 repeats of what is
mechanically the same traffic shape (same tool, same rate, same two hosts), so repeats are highly correlated with
each other, not independent draws from "benign traffic in general." A held-out split built by holding out individual
*runs* instead of whole *patterns* would let the fit see two ping-5pps captures and "validate" against a third,
near-identical one — that would not test generalization, it would test memorization of a pattern already seen in a
different repeat. The split below holds out whole patterns instead, which is a stronger test but leaves the held-out
set covering only 4 benign shapes out of 12. **The headline numbers below describe this one small lab rig, this one
switch, and these specific workloads — not detection in general** and should not be read as more than that.

## Split (fixed now, by pattern, not by run)

Benign **training** patterns (8 patterns, 18 runs): `benign-ping-5pps`, `benign-ping-5pps-node01`,
`benign-idle-60s`, `benign-interactive-8eps`, `benign-http-5rps`, `benign-http-20rps`, `benign-udp-small-10pps`,
`benign-udp-burst-tailscale-like` (its one valid repeat, `-ok`).

Benign **held-out** patterns (4 patterns, 9 runs): `benign-ping-20pps`, `benign-udp-small-50pps`,
`benign-http-burst-8conns`, `benign-bulk-tcp-2mbit`.

**All 7 attack patterns (18 runs) are held out always** — never fit on, consistent with "an autoencoder trains on
normal data only." The 3 ARP-flood and 3 UDP-burst-drop runs stay excluded, same as the existing scorer and for the
same reasons (the deployed daemon cannot see ARP sources; the UDP-burst-drop runs coincided with a switch outage).

Rationale for which patterns are held out: two are higher-rate variants of a trained protocol/shape
(ping at 20 pps vs. trained 5 pps; small UDP at 50 pps vs. trained 10 pps), testing whether the fit generalizes
within a family it has seen at a different rate; two are shapes the fit never sees at all (bursty multi-connection
HTTP, large-frame bulk TCP), testing whether it generalizes across shape, not just rate. Assignment is by whole
pattern so a repeat of a trained pattern can never leak into the held-out set.

## What is being fit

The exact nested formula in `kernel_loss()` (`scripts/sentinel-replay.py`), identical by construction to
`src/gpu/gpu_anomaly_kernel.cu` (pinned by `test/invariants/sentinel-replay.test.ts`): ten scalars `w0..w9`, no other
free parameters.

**Objective:** minimize the nested mean of per-window reconstruction MSE — mean over the 8 training *patterns* of
(mean over the runs in that pattern of (mean over that run's windows)) — so a long, high-packet-rate capture
(thousands of windows) cannot dominate the fit over a short one (tens of windows), and no pattern dominates another
just because it has more repeats recorded.

**Bounds:** `[-3.0, 5.0]` for all ten weights. Wide enough to contain the current hardcoded values (max magnitude
1.5) with headroom; bounded to keep a global search tractable and to avoid numerically degenerate saturated
solutions (e.g. a sigmoid argument large enough to make the reconstruction a constant 0 or 1 everywhere).

**Optimizer:** `scipy.optimize.differential_evolution` (global, derivative-free), `seed=42`, `popsize=20`,
`maxiter=150`, `tol=1e-10`, `polish=True`; followed by a local `scipy.optimize.minimize(method='Nelder-Mead')` polish
from the DE result (`maxiter=5000`). Justification: the loss surface has ReLU/max kinks (genuinely non-smooth,
gradient-based methods can get stuck on a flat region with zero local gradient), the search space is only 10
dimensions (small enough for a population-based global method to cover in a reasonable number of evaluations, unlike
a full grid which would need an astronomically large sample at any useful resolution), and a derivative-free local
polish after the global search cleans up without assuming smoothness. Both phases use the exact training objective
above; nothing in the objective or the optimizer ever sees a held-out run or an attack run.

**Detection threshold for the trained weights:** `base_tau = mean + 2.5 * std` of the per-window training losses
(pooled across every training window, using the trained weights), computed strictly from training data. The `2.5`
mirrors the sensitivity sigma already built into the deployed `Adaptive` EMA controller
(`scripts/sentinel-replay.py`'s `Adaptive` class and the live sentinel's `AdaptiveThresholdController`, both
`sensitivity_sigmas=2.5`); this derives a comparable fixed base threshold for a different loss scale rather than
reusing a threshold (`0.15`) calibrated for the hardcoded weights' very different loss distribution. The `Adaptive`
EMA logic itself (`alpha=0.05`, `sigma=2.5`, starting mean `tau*0.75`, starting variance `(tau*0.15)**2`) is kept
exactly as it already exists in `scripts/sentinel-replay.py` and `scripts/score-labelled-runs.py`; only its base
`tau` input changes between the baseline and trained conditions.

## Validation (on data never touched by fitting)

Score both conditions — **baseline** (hardcoded weights, `tau=0.15`, today's deployed behavior) and **trained**
(fitted weights, the `base_tau` above) — on the exact same held-out split (9 benign + 18 attack = 27 runs), using
`scripts/score-labelled-runs.py`'s own methodology unmodified: the `Adaptive` EMA controller, "names sender"
attribution (most frequent source IP in the 64-packet window), and the same invalid-run exclusion rule. The scorer
is extended (not duplicated) with an optional `sentinel_base_tau` parameter so the same scoring code path is reused
for both conditions.

**Reported, head to head, held-out split only:**

- Attack runs detected with the right sender (`x`/18).
- Benign runs with any alert — false positives (`x`/9).
- Runs naming a non-sender (misattribution).
- The same per-workload breakdown table `score-labelled-runs.py` already prints.

## What would count as an improvement, decided before looking

Trained weights are reported as better only if, on the held-out split, they achieve a **higher or equal** attack-hit
rate **and** a **lower or equal** false-positive rate than baseline, with at least one of the two strictly better — a
weak Pareto improvement, not a single blended score that could hide a worse false-positive rate behind a better hit
rate or vice versa. Anything else (worse on both, or better on one and worse on the other) is reported as "not a
clear improvement," not rounded up. If trained weights only change the one valid `udp-burst` held-out run or move a
single benign/attack run's verdict, that is also stated as exactly what it is (a change of 1 run out of 9 or 18) —
with this few held-out runs per workload, a one-run swing is a large fraction of a group, not a stable rate.

## Limits stated now

27 benign and 18 attack runs, one host pair, one switch, short captures, is a small fitting problem for even 10
parameters and a thin validation set for anything claimed as a rate rather than a one-off count — stated again here
so it cannot be read past in the results section. The architecture's heavy weight-tying (the same 4 weights applied
identically to all 64 packets; the same 2 decoder weights broadcast across all 256 outputs) caps how much a fit can
possibly discriminate between traffic shapes regardless of how well it is optimized; a worse-than-hoped result would
not necessarily mean the optimizer failed, it could mean ten weight-tied scalars are not enough capacity for this
job, which is itself a legitimate finding about the existing architecture, not about this fitting procedure. This
exercise fits the Jetson's native CUDA kernel's parameterization (`gpu_anomaly_kernel.cu` / `kernel_loss`); the
PyTorch fallback path in `scripts/gpu-sdn-anomaly-sentinel.py` is a structurally different, randomly-initialized
convolutional network and is out of scope — fitting it would be a separate exercise, not a ten-scalar fit, and this
work does not touch it.
