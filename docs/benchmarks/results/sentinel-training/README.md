# Fitting the GPU sentinel's ten weights: results (2026-10-23)

Generated from the run on 2026-10-23, following [`PREREGISTRATION.md`](PREREGISTRATION.md) (split, bounds,
optimizer, threshold-calibration rule and the definition of "improvement" fixed before this script was run or any
held-out number was looked at). Bridge/repo commit `84aafa0` on `main`. Reproduce with
`python3 scripts/train-sentinel-weights.py docs/benchmarks/results/labelled-runs --out-weights <path>` (needs numpy
and scipy; scipy is not a dependency of anything else in this repo). Full stdout of the run recorded here is
`training-output-2026-10-23.txt`; the fitted weights and metadata are `trained-weights-2026-10-23.json`.

## Headline: not a clear improvement

| | Attacks detected (right sender) | Benign false positives |
| :--- | ---: | ---: |
| **Baseline** (today's hardcoded weights, `tau=0.15`) | **15/18** | **4/9** |
| **Trained** (fitted weights, `tau=0.1696`, calibrated on training data) | **4/18** | **0/9** |

Both numbers are on the same 27-run held-out split (9 benign, 18 attack), none of which the fit ever saw. Per the
pre-registered rule (a weak Pareto improvement — equal-or-better on both axes, strictly better on at least one), this
is **not an improvement**: trained weights eliminate every held-out false positive but also lose 11 of the 15 attacks
the hardcoded weights catch. This is a straight precision/recall trade, not a win, and it is reported as exactly
that — the pre-registration fixed in advance that a result like this would not be rounded up.

## Why: the fit minimizes benign reconstruction error, which is not the same job as separating classes

Training literally does what it was pre-registered to do: minimize reconstruction MSE on benign windows only
(objective value 0.107 vs. the hardcoded weights' 0.156 on the same training objective — the fit genuinely found a
better *benign reconstruction*). But a better benign reconstruction is not the same thing as a bigger gap between
benign and attack loss. Nothing in the training objective ever sees an attack window or rewards separating it from
benign; the result is a weight set that reconstructs *everything* better, including most attacks, which shrinks the
margin the adaptive threshold has to work with rather than widening it. Per-pattern, the trained weights kept
detecting only `attack-udpflood-500pps-1400b` (2/2, unchanged) — large frames that apparently still reconstruct badly
under the new weights — and lost almost all of both SYN-flood variants (3/3 to 0/3, twice) and most of the port-scan
variants. This is consistent with the capacity limit flagged in the pre-registration: ten weight-tied scalars (the
same four encoder weights applied identically to every packet; the same two decoder weights broadcast across all 256
outputs) may simply not have enough free parameters to both reconstruct benign traffic well *and* keep a
discriminative gap open for attacks, when nothing in the objective asks for the second thing.

## Fitted weights

```text
baseline (hardcoded, src/gpu/gpu_anomaly_kernel.cu): [0.20, 0.30, 0.25, 0.25, 0.05, 0.50, 0.02, 0.85, 1.50, 0.40]
trained (this run, seed=42):                          [2.522, 2.959, 4.073, 3.213, 2.071, 2.737, 2.107, 0.061, 0.463, 1.210]
```

Training objective (nested mean over patterns/runs/windows, lower is better): baseline `0.1563`, trained `0.1070`
(`differential_evolution`: 30,332 evaluations, objective 0.1071; `Nelder-Mead` polish: 1,818 evaluations, objective
0.1070; ~4 minutes wall clock on a laptop CPU, single-threaded). Calibrated `base_tau` for the trained weights:
`mean + 2.5*std` of the 6,264 pooled training-window losses = `0.0925 + 2.5*0.0308` = `0.1696`.

## What this does and does not say

- **Does not say the fitting procedure is broken.** The optimizer found a genuinely lower training-objective value
  than the hardcoded constants (0.107 vs. 0.156) — it did its job. The result says that *minimizing benign
  reconstruction error alone*, the textbook autoencoder training objective, does not produce a better anomaly
  detector than the current arbitrary hardcoded weights on this architecture and this dataset.
- **Does not rule out that a different objective could do better** — e.g. one that also penalizes a small loss
  margin on attack windows (which would no longer be "train only on normal data," a different and larger exercise,
  out of scope here per the constraint against redesigning the architecture or its training regime) — but that is
  a separate, larger piece of work, not a tweak to this one.
- **Does say the hardcoded weights' 15/18-detected, 4/9-false-positive point is not obviously beatable by a
  straightforward benign-only fit of the existing ten-parameter structure**, at least not with this data and this
  search budget.
- **One real, mild improvement surfaced along the way that is worth separating out from the headline:** zero
  false positives on all four held-out benign patterns, including the two the hardcoded weights flag on every single
  run (`benign-ping-20pps` 2/2, `benign-udp-small-50pps` 2/2). If an operator's priority were "never alert on
  ordinary pings and small UDP, accept much lower attack recall," the trained weights are a real, honestly-measured
  option for that specific trade — not a general-purpose upgrade.

## Data-sufficiency concern (repeated from the pre-registration, because it bears directly on how much to trust either number)

27 benign and 18 attack runs, 12 benign and 7 attack *patterns*, most with only 2 or 3 repeats of one host pair on
one lab switch, is thin for fitting ten parameters and thinner for validating the fit. The pattern-level (not
run-level) split used here is a real defense against the worst form of leakage — training and "validating" on
near-duplicate repeats of the same workload — but it still means the held-out set covers only 4 of 12 benign shapes.
**A one-run swing changes a held-out group's rate by 33-50%** (groups here are mostly 2 or 3 runs); none of the
numbers above should be read as a stable rate in the way a hundred-run benchmark's would be. The honest
characterization of this result is "on this one small lab rig, with this specific traffic, a benign-only fit of the
existing ten weights did not beat the current hardcoded constants" — not "training doesn't work" or "the hardcoded
weights are secretly good," either of which would overclaim past what 45 short runs on one switch can support.

## What was and was not changed in the live system

`load_cuda_model_weights()` in `src/gpu/gpu_anomaly_kernel.cu` was already implemented (it is not new code and was
not changed here) but was never called from anywhere — this is now fixed: `scripts/gpu-sdn-anomaly-sentinel.py`
accepts an explicit, opt-in `--weights-file` argument (or `GPU_SENTINEL_WEIGHTS_FILE` environment variable) that
loads a JSON file of ten floats into the CUDA engine via that function. **With neither flag nor environment variable
set — the only mode the live `gpu-sdn-sentinel.service` unit on the Jetson uses today — nothing changes**: the engine
keeps running the compiled-in hardcoded constants exactly as it does right now. This PR does not modify the systemd
unit and does not deploy `trained-weights-2026-10-23.json` anywhere; given the result above, **this specific weight
file is not recommended as a replacement for the hardcoded defaults** — it is committed as the measured, reproducible
artifact of this exercise and as a concrete example of the opt-in loading path, not as a suggested upgrade. If a
future fit (a different objective, more data, or a deliberate choice of the precision/recall point this one lands
on) is adopted, this mechanism is how it would be loaded, with an operator's explicit flag, never silently.

## Caveats

- The PyTorch fallback path in `scripts/gpu-sdn-anomaly-sentinel.py` (used when no native CUDA `.so` is present) is a
  separate, randomly-initialized convolutional network, not this ten-scalar structure. This work does not touch it;
  it remains untrained, as disclosed in `docs/benchmarks/results/sentinel-detection/README.md`.
- The `--weights-file` fail-closed validation path (rejecting a malformed weights file and exiting non-zero rather
  than running default or partial weights) was exercised in a CUDA-less dev environment, where it correctly took the
  "no CUDA engine active" branch instead; it was not exercised against the real compiled `libgpu_anomaly.so` and
  `load_cuda_model_weights()`'s actual return codes, since that needs the Jetson's hardware and this work did not
  touch the live box. The code path mirrors the already-tested `init_cuda_engine()`/`run_gpu_inference()` ctypes
  calling convention in the same file.
- Timing, window extraction and the Adaptive EMA controller are exactly `scripts/sentinel-replay.py`'s and
  `scripts/score-labelled-runs.py`'s own code, reused (not reimplemented) by this script; the only new arithmetic
  introduced is the vectorized batch form of `kernel_loss`, checked at every run against the real `kernel_loss()` on
  a live window before any fitting happens (the script aborts rather than fitting against a possibly-drifted copy of
  the formula).
