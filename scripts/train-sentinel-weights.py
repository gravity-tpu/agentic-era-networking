#!/usr/bin/env python3
"""
scripts/train-sentinel-weights.py
==================================
Fits the GPU sentinel's ten scalar weights (the arithmetic in scripts/sentinel-replay.py's kernel_loss(), identical
by construction to src/gpu/gpu_anomaly_kernel.cu, pinned by test/invariants/sentinel-replay.test.ts) against real
benign-labelled traffic, then validates the fit against a held-out split using scripts/score-labelled-runs.py's own
methodology, unmodified in substance (that script was extended with two optional parameters so this script reuses it
rather than re-implementing scoring).

Method, split, bounds, optimizer and the threshold-calibration rule are all fixed in
docs/benchmarks/results/sentinel-training/PREREGISTRATION.md, written before this script was run. Read that file
before trusting any number this script prints: it also states the data-sufficiency limits of the 51-run dataset this
draws from.

Usage: python3 scripts/train-sentinel-weights.py docs/benchmarks/results/labelled-runs [--out-weights PATH] [--seed 42]
Needs numpy and scipy (scipy is not a dependency of anything else in this repo; it is used only by this offline,
one-off fitting script, not by any live or test path).

Only reuses existing code: scripts/sentinel-replay.py (frame parsing, feature extraction, the kernel formula itself,
via the single module instance scripts/score-labelled-runs.py already loads) and scripts/score-labelled-runs.py
(run loading, validity rule, pattern naming, and the sentinel scoring/attribution logic).
"""
import argparse
import importlib.util
import json
import os
import sys
import time

import numpy as np
from scipy.optimize import differential_evolution, minimize

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# score-labelled-runs.py loads its own single instance of sentinel-replay.py as module-level name `sr`; reusing that
# exact object (not a second, independent import) is required so that mutating its W global here is the same W that
# slr.sentinel_alerts()/sr.kernel_loss() read when this script asks slr to score a run with fitted weights.
slr = _load("score_labelled_runs", os.path.join(HERE, "score-labelled-runs.py"))
sr = slr.sr

# --- Fixed by PREREGISTRATION.md: do not tune these against held-out results. ---
TRAIN_BENIGN_PATTERNS = frozenset({
    "benign-ping-5pps", "benign-ping-5pps-node01", "benign-idle-60s", "benign-interactive-8eps",
    "benign-http-5rps", "benign-http-20rps", "benign-udp-small-10pps", "benign-udp-burst-tailscale-like",
})
HOLDOUT_BENIGN_PATTERNS = frozenset({
    "benign-ping-20pps", "benign-udp-small-50pps", "benign-http-burst-8conns", "benign-bulk-tcp-2mbit",
})
BOUNDS = [(-3.0, 5.0)] * 10
SIGMA = 2.5  # matches Adaptive's and AdaptiveThresholdController's own sensitivity_sigmas
DE_SEED = 42
DE_POPSIZE = 20
DE_MAXITER = 150
DE_TOL = 1e-10
POLISH_MAXITER = 5000


def kernel_loss_batch(X, W):
    """Vectorized form of sr.kernel_loss over N windows at once. X: (N, 256) float32. Must stay row-for-row identical
    to sr.kernel_loss(window); checked at runtime by self_check() below rather than trusted by inspection alone."""
    X = np.asarray(X, dtype=np.float32)
    Xr = X.reshape(-1, 64, 4)
    h = np.maximum(0.0, (Xr * W[:4]).sum(axis=2) - W[4])                     # (N,64)
    lat = np.maximum(0.0, h.reshape(-1, 16, 4).sum(axis=2) * W[5] - W[6])    # (N,16)
    idx16 = np.arange(64) % 16
    rh = np.maximum(0.0, lat[:, idx16] * W[7])                               # (N,64)
    idx64 = np.arange(256) % 64
    # The optimizer explores weight combinations near the edges of BOUNDS where the sigmoid's argument can be large
    # enough that exp() overflows; the sigmoid itself is still mathematically well-defined there (saturates to 0 or
    # 1), so this is an expected, harmless numerical event during search, not a masked error (Invariant 1 is about
    # not swallowing real exceptions/type errors, not about suppressing a warning for a function that is correct at
    # its numerical limits).
    with np.errstate(over="ignore"):
        rec = 1.0 / (1.0 + np.exp(-(rh[:, idx64] * W[8] - W[9])))           # (N,256)
    return np.mean((X - rec) ** 2, axis=1)


def self_check(sample_window, seed=7):
    """Fail loudly (Invariant 1: no suppression) if the vectorized loss ever drifts from the real kernel_loss().

    Checks more than the one point this would otherwise cover: the compiled-in default weights (the common case,
    where a drift would be most visible), both corners of BOUNDS (the saturating-sigmoid regime the optimizer
    explores and np.errstate(over="ignore") deliberately tolerates in kernel_loss_batch — exactly where a scalar/
    vectorized divergence would be most plausible, not least), and a few random interior points, so the "checked at
    runtime" claim covers the search space the optimizer actually visits, not just the one weight set most runs
    start from."""
    rng = np.random.default_rng(seed)
    lo = np.array([b[0] for b in BOUNDS], dtype=np.float32)
    hi = np.array([b[1] for b in BOUNDS], dtype=np.float32)
    candidates = [np.array(sr.W, dtype=np.float32, copy=True), lo, hi] + \
        [rng.uniform(lo, hi).astype(np.float32) for _ in range(5)]
    original_W = np.array(sr.W, dtype=np.float32, copy=True)
    try:
        for W in candidates:
            sr.W = W
            want = sr.kernel_loss(sample_window)
            got = float(kernel_loss_batch(np.asarray(sample_window, dtype=np.float32).reshape(1, 256), W)[0])
            if not (np.isfinite(want) and np.isfinite(got)) and not (np.isnan(want) and np.isnan(got)):
                # Not expected to ever trip given the formula, but a NaN appearing on only one side would be exactly
                # the kind of silent divergence this check exists to catch (see np.errstate's own comment above).
                raise SystemExit(f"FATAL: kernel_loss_batch and sr.kernel_loss disagree on finiteness at W={W} "
                                  f"({got} vs {want}).")
            if abs(want - got) > 1e-4:
                raise SystemExit(f"FATAL: kernel_loss_batch disagrees with sr.kernel_loss at W={W} ({got} vs "
                                  f"{want}); refusing to fit against a formula that may have drifted from the real "
                                  f"kernel.")
    finally:
        sr.W = original_W


def windows_for_run(frames):
    """frames: the with_src tuples from sr.parse_pcap. Returns an (N, 256) float32 array, one row per 64-packet window,
    using the exact same sr.Extractor a live run or sentinel_alerts() would use."""
    ex = sr.Extractor()
    out = []
    for t_us, flen, proto, flags, sp, dp, *_rest in frames:
        w = ex.feed(t_us, flen, proto, flags, sp, dp)
        if w is not None:
            out.append(np.asarray(w, dtype=np.float32).reshape(-1))
    return np.stack(out).astype(np.float32) if out else np.zeros((0, 256), dtype=np.float32)


def load_and_split(datadir):
    runs = slr.load_runs(datadir)
    train_groups = {}   # pattern -> list of (run_id, windows array)
    holdout = []         # list of dict: id, class, pattern, label, frames
    for label, frames in runs:
        scored = slr.score(label, frames)  # baseline scoring call; also gives us valid/class/pattern/sender for free
        if not scored["valid"]:
            continue
        pattern = scored["pattern"]
        cls = scored["class"]
        if cls == "benign" and pattern in TRAIN_BENIGN_PATTERNS:
            train_groups.setdefault(pattern, []).append((label["id"], windows_for_run(frames)))
        elif cls == "attack" or (cls == "benign" and pattern in HOLDOUT_BENIGN_PATTERNS):
            holdout.append({"label": label, "frames": frames, "pattern": pattern, "class": cls, "baseline": scored})
        else:
            raise SystemExit(f"FATAL: run {label['id']!r} (pattern {pattern!r}, class {cls!r}) matches neither the "
                              f"training nor the held-out pattern lists in PREREGISTRATION.md; the catalog has "
                              f"drifted from what this script was written against. Fix the pattern lists, don't skip.")
    missing_train = TRAIN_BENIGN_PATTERNS - set(train_groups)
    if missing_train:
        raise SystemExit(f"FATAL: expected training patterns not found or all invalid: {sorted(missing_train)}")
    return train_groups, holdout


def make_objective(train_groups):
    """Nested mean: mean over patterns of (mean over runs of (mean over windows)). Precomputes nothing beyond the
    per-run window arrays already extracted, since kernel_loss_batch is cheap and vectorized."""
    def objective(w):
        W = np.asarray(w, dtype=np.float32)
        pattern_means = []
        for pattern, runs in train_groups.items():
            run_means = [float(np.mean(kernel_loss_batch(windows, W))) for _rid, windows in runs if len(windows)]
            if run_means:
                pattern_means.append(sum(run_means) / len(run_means))
        return sum(pattern_means) / len(pattern_means)
    return objective


def pooled_training_losses(train_groups, W):
    pooled = []
    for _pattern, runs in train_groups.items():
        for _rid, windows in runs:
            if len(windows):
                pooled.append(kernel_loss_batch(windows, W))
    return np.concatenate(pooled) if pooled else np.zeros((0,), dtype=np.float32)


def score_holdout(holdout, W, base_tau, label_text):
    """Scores every held-out run under the given weights/tau using slr.score() unmodified (sr.W is set by the caller
    before this runs); returns the same aggregate shape score-labelled-runs.py's own CLI prints, for the sentinel
    detector only, restricted to the held-out runs."""
    rows = []
    for item in holdout:
        res = slr.score(item["label"], item["frames"], sentinel_base_tau=base_tau)
        rows.append(res)
    attacks = [r for r in rows if r["class"] == "attack"]
    benign = [r for r in rows if r["class"] == "benign"]
    det = sum(1 for r in attacks if r["sentinel"]["namedSender"])
    fp = sum(1 for r in benign if r["sentinel"]["alerts"] > 0)
    mis = sum(1 for r in rows if r["sentinel"]["namedOthers"])
    print(f"{label_text:10s} tau={base_tau:.4f}  attack detected (right sender): {det}/{len(attacks)}   "
          f"benign false positives: {fp}/{len(benign)}   misattributions: {mis}/{len(rows)}")
    by_pattern = {}
    for r in rows:
        by_pattern.setdefault(r["pattern"], []).append(r)
    for pattern in sorted(by_pattern):
        group = by_pattern[pattern]
        cls = group[0]["class"]
        if cls == "attack":
            hit = sum(1 for r in group if r["sentinel"]["namedSender"])
            print(f"    {pattern:34s} attack-detected {hit}/{len(group)}")
        else:
            hit = sum(1 for r in group if r["sentinel"]["alerts"] > 0)
            print(f"    {pattern:34s} false-positive  {hit}/{len(group)}")
    return {"detected": det, "attacks": len(attacks), "falsePositives": fp, "benign": len(benign),
            "misattributions": mis, "rows": rows}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("datadir")
    ap.add_argument("--out-weights", default=None, help="Write fitted weights + metadata as JSON to this path")
    ap.add_argument("--seed", type=int, default=DE_SEED)
    args = ap.parse_args()

    train_groups, holdout = load_and_split(args.datadir)
    n_train_runs = sum(len(v) for v in train_groups.values())
    n_train_windows = sum(len(w) for runs in train_groups.values() for _rid, w in runs)
    n_holdout_benign = sum(1 for h in holdout if h["class"] == "benign")
    n_holdout_attack = sum(1 for h in holdout if h["class"] == "attack")
    print("== split ==")
    print(f"training:  {len(train_groups)} patterns, {n_train_runs} runs, {n_train_windows} windows")
    print(f"held-out:  {n_holdout_benign} benign runs, {n_holdout_attack} attack runs")
    for pattern in sorted(train_groups):
        ids = [rid for rid, _w in train_groups[pattern]]
        print(f"  train   {pattern:34s} {ids}")
    for pattern in sorted(HOLDOUT_BENIGN_PATTERNS):
        ids = [h["label"]["id"] for h in holdout if h["pattern"] == pattern]
        print(f"  holdout {pattern:34s} {ids}")
    print()

    sample_window = next(w[0] for runs in train_groups.values() for _rid, w in runs if len(w)).reshape(64, 4)
    self_check(sample_window)
    print("self-check: kernel_loss_batch matches sr.kernel_loss on a real window (ok)\n")

    objective = make_objective(train_groups)
    baseline_W = np.array(sr.W, dtype=np.float32, copy=True)
    baseline_train_loss = objective(baseline_W)
    print(f"== fitting ({len(BOUNDS)} params, bounds {BOUNDS[0]} for all) ==")
    print(f"baseline hardcoded weights' training-objective value: {baseline_train_loss:.6f}")

    t0 = time.monotonic()
    de = differential_evolution(objective, BOUNDS, seed=args.seed, popsize=DE_POPSIZE, maxiter=DE_MAXITER,
                                 tol=DE_TOL, polish=True, updating="deferred", workers=1)
    polished = minimize(objective, de.x, method="Nelder-Mead",
                         options={"xatol": 1e-8, "fatol": 1e-12, "maxiter": POLISH_MAXITER, "maxfev": POLISH_MAXITER})
    elapsed = time.monotonic() - t0
    trained_W = polished.x if polished.fun <= de.fun else de.x
    trained_loss = min(polished.fun, de.fun)
    print(f"differential_evolution: nfev={de.nfev} objective={de.fun:.6f}")
    print(f"Nelder-Mead polish:     nfev={polished.nfev} objective={polished.fun:.6f}")
    print(f"fitted in {elapsed:.1f}s")
    print(f"trained weights: {[round(float(x), 6) for x in trained_W]}")
    print(f"trained training-objective value: {trained_loss:.6f}  (baseline was {baseline_train_loss:.6f})\n")

    # Threshold calibration: strictly from training data, per PREREGISTRATION.md, before any held-out scoring.
    train_losses_trained_W = pooled_training_losses(train_groups, trained_W)
    trained_tau = float(np.mean(train_losses_trained_W) + SIGMA * np.std(train_losses_trained_W))
    print(f"calibrated tau for trained weights: mean={np.mean(train_losses_trained_W):.4f} "
          f"std={np.std(train_losses_trained_W):.4f} -> base_tau={trained_tau:.4f} "
          f"(pooled over {len(train_losses_trained_W)} training windows)\n")

    print("== held-out validation (never used for fitting or threshold calibration) ==")
    # sr.W is a shared mutable module global that sr.kernel_loss()/slr.sentinel_alerts() close over; restore it even
    # if scoring raises, so a caller importing this module (rather than running it as __main__) never inherits a
    # mutated weight set from a failed run.
    try:
        sr.W = baseline_W
        baseline_result = score_holdout(holdout, baseline_W, sr.BASE_TAU, "baseline")
        sr.W = np.asarray(trained_W, dtype=np.float32)
        trained_result = score_holdout(holdout, trained_W, trained_tau, "trained")
    finally:
        sr.W = baseline_W

    print("\n== head to head on the held-out split ==")
    print(f"baseline: {baseline_result['detected']}/{baseline_result['attacks']} attacks detected, "
          f"{baseline_result['falsePositives']}/{baseline_result['benign']} benign false positives")
    print(f"trained:  {trained_result['detected']}/{trained_result['attacks']} attacks detected, "
          f"{trained_result['falsePositives']}/{trained_result['benign']} benign false positives")
    better_or_equal_hit = trained_result["detected"] >= baseline_result["detected"]
    better_or_equal_fp = trained_result["falsePositives"] <= baseline_result["falsePositives"]
    strictly_better = trained_result["detected"] > baseline_result["detected"] or \
        trained_result["falsePositives"] < baseline_result["falsePositives"]
    verdict = "IMPROVEMENT (weak Pareto, per PREREGISTRATION.md's rule)" if (better_or_equal_hit and better_or_equal_fp and strictly_better) \
        else "NOT a clear improvement"
    print(f"verdict per the pre-registered rule: {verdict}")

    if args.out_weights:
        payload = {
            "weights": [float(x) for x in trained_W],
            "tau": trained_tau,
            "trained_on_patterns": sorted(TRAIN_BENIGN_PATTERNS),
            "held_out_patterns": {"benign": sorted(HOLDOUT_BENIGN_PATTERNS), "attack": "all 7 attack patterns"},
            "seed": args.seed,
            "training_objective_value": trained_loss,
            "note": "Fitted by scripts/train-sentinel-weights.py; see docs/benchmarks/results/sentinel-training/ "
                    "for methodology and held-out validation before using this in gpu-sdn-anomaly-sentinel.py "
                    "(--weights-file / GPU_SENTINEL_WEIGHTS_FILE, opt-in only).",
        }
        with open(args.out_weights, "w") as fh:
            json.dump(payload, fh, indent=2)
            fh.write("\n")
        print(f"\nwrote {args.out_weights}")


if __name__ == "__main__":
    main()
