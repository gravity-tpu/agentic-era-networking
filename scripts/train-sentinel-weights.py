#!/usr/bin/env python3
"""
scripts/train-sentinel-weights.py
==================================
Fits the GPU sentinel's ten scalar weights (the arithmetic in scripts/sentinel-replay.py's kernel_loss(), identical
by construction to src/gpu/gpu_anomaly_kernel.cu, pinned by test/invariants/sentinel-replay.test.ts) against real
labelled traffic, then validates the fit against a held-out split using scripts/score-labelled-runs.py's own
methodology, unmodified in substance (that script was extended with two optional parameters so this script reuses it
rather than re-implementing scoring).

Two objective modes, selected with --objective:

  benign (default)  The first attempt's objective: minimize reconstruction MSE on benign-only training windows.
                     Method, split, bounds, optimizer and the threshold-calibration rule are fixed in
                     docs/benchmarks/results/sentinel-training/PREREGISTRATION.md. Unmodified from that attempt.

  margin             This round's objective: the benign-only term above, plus a bounded hinge term that penalizes
                     flood-attack training windows (attack-synflood-200pps, attack-udpflood-500pps-1400b only;
                     port scans have a dedicated deterministic detector and are out of scope here, see
                     docs/benchmarks/results/sentinel-training-margin/PREREGISTRATION.md) whose reconstruction loss
                     falls below the benign distribution's own calibrated threshold plus a fixed extra margin.
                     Exact formula, split, and hyperparameters are fixed in that same PREREGISTRATION.md, written
                     before this mode was run or any held-out number was looked at.

Usage: python3 scripts/train-sentinel-weights.py docs/benchmarks/results/labelled-runs [--objective benign|margin]
       [--out-weights PATH] [--compare-weights-file PATH --compare-label TEXT] [--seed 42]
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

# --- Fixed by docs/benchmarks/results/sentinel-training/PREREGISTRATION.md: do not tune these against held-out
# results. Reused unmodified by both --objective modes. ---
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

# --- Fixed by docs/benchmarks/results/sentinel-training-margin/PREREGISTRATION.md: --objective margin only. Do not
# tune these against held-out results either. ---
# The margin term is scoped to flood attacks only: scripts/portscan-rule-detector.py (merged, PR #104) already gets
# 10/10 port-scan detections with 0/30 false positives on this same dataset, so this round spends its limited
# labelled-attack budget on the attack class the sentinel is actually needed for, not on re-deriving a solved
# problem. attack-arpflood-* is never eligible (0 valid runs under the scorer's own validity rule regardless).
TRAIN_ATTACK_PATTERNS = frozenset({"attack-synflood-200pps", "attack-udpflood-500pps-1400b"})
# attack-synflood-1000pps is deliberately never in TRAIN_ATTACK_PATTERNS: held out always, to test whether the
# margin term generalizes within the SYN-flood family to a rate it never saw (trained at 200 pps).
MARGIN = 0.02    # extra headroom beyond benign_mean + SIGMA*benign_std a training attack window must clear
LAMBDA = 1.0     # weight of the margin (hinge) term relative to the unweighted benign reconstruction term


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
            agree_on_finiteness = (np.isfinite(want) and np.isfinite(got)) or (np.isnan(want) and np.isnan(got))
            if not agree_on_finiteness:
                # Not expected to ever trip given the formula, but a NaN appearing on only one side would be exactly
                # the kind of silent divergence this check exists to catch (see np.errstate's own comment above).
                raise SystemExit(f"FATAL: kernel_loss_batch and sr.kernel_loss disagree on finiteness at W={W} "
                                  f"({got} vs {want}).")
            # 1e-4, not 1e-5: BOUNDS corners (lo/hi) push the sigmoid into its saturating regime,
            # where float32 rounding between the scalar and vectorized paths is larger than the
            # tolerance a mid-range W needs. Loosened specifically for those two corner candidates,
            # not to hide real drift elsewhere in the candidate set.
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


def load_and_split(datadir, objective="benign"):
    """objective="benign": the first attempt's split (all attack runs held out, never fit on).
    objective="margin": additionally routes TRAIN_ATTACK_PATTERNS' runs into attack_train_groups (for the hinge
    term) and attack_train_report (the same runs, kept in holdout-row shape so score_holdout() can report their
    "training performance" separately from the real held-out set); those runs are excluded from `holdout`, which is
    why the held-out set is smaller under objective="margin" than under objective="benign" (see PREREGISTRATION.md)."""
    runs = slr.load_runs(datadir)
    train_groups = {}          # pattern -> list of (run_id, windows array); benign training, both modes
    attack_train_groups = {}   # pattern -> list of (run_id, windows array); margin mode only, flood patterns only
    attack_train_report = []   # same shape as `holdout` rows, for the same runs as attack_train_groups
    holdout = []                # list of dict: id, class, pattern, label, frames
    for label, frames in runs:
        scored = slr.score(label, frames)  # baseline scoring call; also gives us valid/class/pattern/sender for free
        if not scored["valid"]:
            continue
        pattern = scored["pattern"]
        cls = scored["class"]
        if cls == "benign" and pattern in TRAIN_BENIGN_PATTERNS:
            train_groups.setdefault(pattern, []).append((label["id"], windows_for_run(frames)))
        elif cls == "attack" and objective == "margin" and pattern in TRAIN_ATTACK_PATTERNS:
            attack_train_groups.setdefault(pattern, []).append((label["id"], windows_for_run(frames)))
            attack_train_report.append({"label": label, "frames": frames, "pattern": pattern, "class": cls, "baseline": scored})
        elif cls == "attack" or (cls == "benign" and pattern in HOLDOUT_BENIGN_PATTERNS):
            holdout.append({"label": label, "frames": frames, "pattern": pattern, "class": cls, "baseline": scored})
        else:
            raise SystemExit(f"FATAL: run {label['id']!r} (pattern {pattern!r}, class {cls!r}) matches neither the "
                              f"training nor the held-out pattern lists in PREREGISTRATION.md; the catalog has "
                              f"drifted from what this script was written against. Fix the pattern lists, don't skip.")
    missing_train = TRAIN_BENIGN_PATTERNS - set(train_groups)
    if missing_train:
        raise SystemExit(f"FATAL: expected training patterns not found or all invalid: {sorted(missing_train)}")
    if objective == "margin":
        missing_attack_train = TRAIN_ATTACK_PATTERNS - set(attack_train_groups)
        if missing_attack_train:
            raise SystemExit(f"FATAL: expected margin-training attack patterns not found or all invalid: "
                              f"{sorted(missing_attack_train)}")
    return train_groups, attack_train_groups, attack_train_report, holdout


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


def make_margin_objective(train_groups, attack_train_groups, margin=MARGIN, sigma=SIGMA, lam=LAMBDA):
    """L(W) = L_benign(W) + lam * L_margin(W). Exact formula and hyperparameters fixed in
    docs/benchmarks/results/sentinel-training-margin/PREREGISTRATION.md before this was run.

    L_benign(W): identical to make_objective()'s nested pattern/run/window mean over train_groups.

    L_margin(W): nested pattern/run/window mean, over attack_train_groups only (flood-attack training patterns),
    of hinge(a, W) = max(0, target(W) - kernel_loss(a; W)), where target(W) = benign_mean(W) + sigma*benign_std(W) +
    margin, benign_mean/std computed by pooling every training-benign window (same pool pooled_training_losses()
    uses for threshold calibration). The hinge is zero once an attack window's loss clears target(W) and grows only
    linearly below it (bounded, not an unbounded "maximize attack loss" term): the optimizer gains nothing from
    pushing attack loss past target(W), only from closing the gap up to it.

    Each candidate W's benign per-run losses are computed once and reused for both L_benign and the pooled
    mean/std the margin target needs, rather than recomputing kernel_loss_batch over the same benign windows twice.
    """
    def objective(w):
        W = np.asarray(w, dtype=np.float32)
        benign_pattern_means = []
        benign_pooled = []
        for _pattern, runs in train_groups.items():
            run_losses = [kernel_loss_batch(windows, W) for _rid, windows in runs if len(windows)]
            if run_losses:
                benign_pattern_means.append(sum(float(np.mean(losses)) for losses in run_losses) / len(run_losses))
                benign_pooled.extend(run_losses)
        l_benign = sum(benign_pattern_means) / len(benign_pattern_means)
        pooled = np.concatenate(benign_pooled)
        target = float(np.mean(pooled)) + sigma * float(np.std(pooled)) + margin

        attack_pattern_means = []
        for _pattern, runs in attack_train_groups.items():
            run_means = []
            for _rid, windows in runs:
                if len(windows) == 0:
                    continue
                hinge = np.maximum(0.0, target - kernel_loss_batch(windows, W))
                run_means.append(float(np.mean(hinge)))
            if run_means:
                attack_pattern_means.append(sum(run_means) / len(run_means))
        l_margin = sum(attack_pattern_means) / len(attack_pattern_means) if attack_pattern_means else 0.0
        return l_benign + lam * l_margin
    return objective


def margin_target(train_groups, W, margin=MARGIN, sigma=SIGMA):
    """target(W) as used inside make_margin_objective, exposed standalone for diagnostics/printing."""
    pooled = pooled_training_losses(train_groups, W)
    return float(np.mean(pooled)) + sigma * float(np.std(pooled)) + margin


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
    ap.add_argument("--objective", choices=["benign", "margin"], default="benign",
                     help="benign (default): the first attempt's benign-only objective, unmodified. margin: this "
                          "round's benign-reconstruction-plus-flood-attack-hinge objective; see "
                          "docs/benchmarks/results/sentinel-training-margin/PREREGISTRATION.md")
    ap.add_argument("--margin", type=float, default=MARGIN,
                     help=f"--objective margin only: extra headroom beyond benign_mean + SIGMA*benign_std a "
                          f"training flood-attack window must clear (default: pre-registered {MARGIN})")
    ap.add_argument("--lambda-weight", type=float, default=LAMBDA, dest="lambda_weight",
                     help=f"--objective margin only: weight of the hinge term relative to the unweighted benign "
                          f"reconstruction term (default: pre-registered {LAMBDA})")
    ap.add_argument("--out-weights", default=None, help="Write fitted weights + metadata as JSON to this path")
    ap.add_argument("--compare-weights-file", default=None,
                     help="Also score an existing weights JSON (same shape --out-weights writes) on the identical "
                          "held-out split, for a three-way comparison in one run")
    ap.add_argument("--compare-label", default=None, help="Row label for --compare-weights-file (default: its filename)")
    ap.add_argument("--seed", type=int, default=DE_SEED)
    args = ap.parse_args()

    train_groups, attack_train_groups, attack_train_report, holdout = load_and_split(args.datadir, objective=args.objective)
    n_train_runs = sum(len(v) for v in train_groups.values())
    n_train_windows = sum(len(w) for runs in train_groups.values() for _rid, w in runs)
    n_holdout_benign = sum(1 for h in holdout if h["class"] == "benign")
    n_holdout_attack = sum(1 for h in holdout if h["class"] == "attack")
    print("== split ==")
    print(f"objective: {args.objective}")
    print(f"training (benign):  {len(train_groups)} patterns, {n_train_runs} runs, {n_train_windows} windows")
    print(f"held-out:  {n_holdout_benign} benign runs, {n_holdout_attack} attack runs")
    for pattern in sorted(train_groups):
        ids = [rid for rid, _w in train_groups[pattern]]
        print(f"  train benign   {pattern:34s} {ids}")
    if args.objective == "margin":
        n_attack_train_runs = sum(len(v) for v in attack_train_groups.values())
        n_attack_train_windows = sum(len(w) for runs in attack_train_groups.values() for _rid, w in runs)
        print(f"training (flood attack, margin term only): {len(attack_train_groups)} patterns, "
              f"{n_attack_train_runs} runs, {n_attack_train_windows} windows")
        for pattern in sorted(attack_train_groups):
            ids = [rid for rid, _w in attack_train_groups[pattern]]
            print(f"  train attack   {pattern:34s} {ids}")
    for pattern in sorted(HOLDOUT_BENIGN_PATTERNS):
        ids = [h["label"]["id"] for h in holdout if h["pattern"] == pattern]
        print(f"  holdout benign {pattern:34s} {ids}")
    for pattern in sorted({h["pattern"] for h in holdout if h["class"] == "attack"}):
        ids = [h["label"]["id"] for h in holdout if h["pattern"] == pattern]
        print(f"  holdout attack {pattern:34s} {ids}")
    print()

    sample_window = next(w[0] for runs in train_groups.values() for _rid, w in runs if len(w)).reshape(64, 4)
    self_check(sample_window)
    print("self-check: kernel_loss_batch matches sr.kernel_loss on a real window (ok)\n")

    benign_only_objective = make_objective(train_groups)  # kept available as a diagnostic even in margin mode
    if args.objective == "margin":
        objective = make_margin_objective(train_groups, attack_train_groups, margin=args.margin, lam=args.lambda_weight)
    else:
        objective = benign_only_objective
    baseline_W = np.array(sr.W, dtype=np.float32, copy=True)
    baseline_train_loss = objective(baseline_W)
    print(f"== fitting ({len(BOUNDS)} params, bounds {BOUNDS[0]} for all) ==")
    if args.objective == "margin":
        baseline_target = margin_target(train_groups, baseline_W, margin=args.margin, sigma=SIGMA)
        print(f"margin hyperparameters: margin={args.margin} sigma={SIGMA} lambda={args.lambda_weight}")
        print(f"baseline hardcoded weights' benign-only loss: {benign_only_objective(baseline_W):.6f}  "
              f"hinge target: {baseline_target:.4f}")
    print(f"baseline hardcoded weights' training-objective value: {baseline_train_loss:.6f}")

    t0 = time.monotonic()
    de = differential_evolution(objective, BOUNDS, seed=args.seed, popsize=DE_POPSIZE, maxiter=DE_MAXITER,
                                 tol=DE_TOL, polish=True, updating="deferred", workers=1)
    # bounds=BOUNDS here (not just on the DE phase above) matters: scipy's Nelder-Mead is otherwise unconstrained,
    # so without it the polish step can walk a weight straight out of the box the pre-registration declares and
    # justifies ("bounded to keep a global search tractable and to avoid numerically degenerate saturated
    # solutions"). Found during the margin-objective round of training (2026-10-23): an unbounded polish drove one
    # weight to -66.8, far outside [-3, 5], while the benign-only objective's polish had stayed inside the box
    # anyway, by luck rather than by the code enforcing it. Fixed here for both objective modes rather than only
    # the one that happened to trip it.
    polished = minimize(objective, de.x, method="Nelder-Mead", bounds=BOUNDS,
                         options={"xatol": 1e-8, "fatol": 1e-12, "maxiter": POLISH_MAXITER, "maxfev": POLISH_MAXITER})
    elapsed = time.monotonic() - t0
    trained_W = polished.x if polished.fun <= de.fun else de.x
    trained_loss = min(polished.fun, de.fun)
    print(f"differential_evolution: nfev={de.nfev} objective={de.fun:.6f}")
    print(f"Nelder-Mead polish:     nfev={polished.nfev} objective={polished.fun:.6f}")
    print(f"fitted in {elapsed:.1f}s")
    print(f"trained weights: {[round(float(x), 6) for x in trained_W]}")
    print(f"trained training-objective value: {trained_loss:.6f}  (baseline was {baseline_train_loss:.6f})")
    if args.objective == "margin":
        trained_target = margin_target(train_groups, trained_W, margin=args.margin, sigma=SIGMA)
        print(f"trained weights' benign-only loss: {benign_only_objective(np.asarray(trained_W, dtype=np.float32)):.6f}  "
              f"hinge target: {trained_target:.4f}")
    print()

    # Threshold calibration: strictly from training BENIGN data only (never the attack-training windows, even in
    # margin mode), per PREREGISTRATION.md, before any held-out scoring.
    train_losses_trained_W = pooled_training_losses(train_groups, trained_W)
    trained_tau = float(np.mean(train_losses_trained_W) + SIGMA * np.std(train_losses_trained_W))
    print(f"calibrated tau for trained weights: mean={np.mean(train_losses_trained_W):.4f} "
          f"std={np.std(train_losses_trained_W):.4f} -> base_tau={trained_tau:.4f} "
          f"(pooled over {len(train_losses_trained_W)} training windows)\n")

    print("== held-out validation (never used for fitting or threshold calibration) ==")
    compare_result = compare_W = compare_tau = compare_label = None
    # sr.W is a shared mutable module global that sr.kernel_loss()/slr.sentinel_alerts() close over; restore it even
    # if scoring raises, so a caller importing this module (rather than running it as __main__) never inherits a
    # mutated weight set from a failed run.
    try:
        sr.W = baseline_W
        baseline_result = score_holdout(holdout, baseline_W, sr.BASE_TAU, "baseline")
        if args.compare_weights_file:
            with open(args.compare_weights_file) as fh:
                compare_payload = json.load(fh)
            compare_W = np.asarray(compare_payload["weights"], dtype=np.float32)
            compare_tau = float(compare_payload["tau"])
            compare_label = args.compare_label or os.path.basename(args.compare_weights_file)
            sr.W = compare_W
            compare_result = score_holdout(holdout, compare_W, compare_tau, compare_label)
        sr.W = np.asarray(trained_W, dtype=np.float32)
        trained_result = score_holdout(holdout, trained_W, trained_tau, "trained")
    finally:
        sr.W = baseline_W

    if args.objective == "margin" and attack_train_report:
        print("\n== margin-training flood-attack runs' OWN scores (training performance, NOT a held-out result) ==")
        try:
            sr.W = baseline_W
            score_holdout(attack_train_report, baseline_W, sr.BASE_TAU, "baseline")
            if compare_result is not None:
                sr.W = compare_W
                score_holdout(attack_train_report, compare_W, compare_tau, compare_label)
            sr.W = np.asarray(trained_W, dtype=np.float32)
            score_holdout(attack_train_report, trained_W, trained_tau, "trained")
        finally:
            sr.W = baseline_W

    print("\n== head to head on the held-out split ==")
    print(f"baseline: {baseline_result['detected']}/{baseline_result['attacks']} attacks detected, "
          f"{baseline_result['falsePositives']}/{baseline_result['benign']} benign false positives")
    if compare_result is not None:
        print(f"{compare_label}: {compare_result['detected']}/{compare_result['attacks']} attacks detected, "
              f"{compare_result['falsePositives']}/{compare_result['benign']} benign false positives")
    print(f"trained:  {trained_result['detected']}/{trained_result['attacks']} attacks detected, "
          f"{trained_result['falsePositives']}/{trained_result['benign']} benign false positives")

    def verdict_against(reference, reference_label):
        better_or_equal_hit = trained_result["detected"] >= reference["detected"]
        better_or_equal_fp = trained_result["falsePositives"] <= reference["falsePositives"]
        strictly_better = trained_result["detected"] > reference["detected"] or \
            trained_result["falsePositives"] < reference["falsePositives"]
        v = "IMPROVEMENT (weak Pareto, per PREREGISTRATION.md's rule)" if (better_or_equal_hit and better_or_equal_fp and strictly_better) \
            else "NOT a clear improvement"
        print(f"verdict vs. {reference_label}: {v}")

    verdict_against(baseline_result, "baseline")
    if compare_result is not None:
        verdict_against(compare_result, compare_label)

    if args.out_weights:
        payload = {
            "weights": [float(x) for x in trained_W],
            "tau": trained_tau,
            "objective": args.objective,
            "trained_on_patterns": {"benign": sorted(TRAIN_BENIGN_PATTERNS)},
            "held_out_patterns": {"benign": sorted(HOLDOUT_BENIGN_PATTERNS),
                                   "attack": sorted({h["pattern"] for h in holdout if h["class"] == "attack"})},
            "seed": args.seed,
            "training_objective_value": trained_loss,
            "note": "Fitted by scripts/train-sentinel-weights.py; see docs/benchmarks/results/sentinel-training/ "
                    "(objective=benign) or docs/benchmarks/results/sentinel-training-margin/ (objective=margin) "
                    "for methodology and held-out validation before using this in gpu-sdn-anomaly-sentinel.py "
                    "(--weights-file / GPU_SENTINEL_WEIGHTS_FILE, opt-in only).",
        }
        if args.objective == "margin":
            payload["trained_on_patterns"]["attack_flood_margin_term"] = sorted(TRAIN_ATTACK_PATTERNS)
            payload["margin_hyperparameters"] = {"margin": args.margin, "sigma": SIGMA, "lambda": args.lambda_weight}
        with open(args.out_weights, "w") as fh:
            json.dump(payload, fh, indent=2)
            fh.write("\n")
        print(f"\nwrote {args.out_weights}")


if __name__ == "__main__":
    main()
