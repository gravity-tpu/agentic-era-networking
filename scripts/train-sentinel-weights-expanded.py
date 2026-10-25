#!/usr/bin/env python3
"""
scripts/train-sentinel-weights-expanded.py
============================================
Batch 4 of the sentinel-training-two-anchor workstream: tests whether the three-way conflict batches 1-3 measured
(low lab-benign loss + low CIC-benign loss + a wide lab-attack margin, all at once) is a genuine capacity ceiling of
the deployed architecture's ten heavily weight-tied scalars, by un-tying stage 1 of the reconstruction formula per
the window's own existing 16-group structure (85 parameters total). Exact architecture, objective, bounds, optimizer
budget, self-check discipline, and the success criterion for this sanity check are fixed in
docs/benchmarks/results/sentinel-training-two-anchor/PREREGISTRATION.md (the batch 4 addendum), written before this
script was run or any number from it was looked at.

THIS IS A PARALLEL, OFFLINE-ONLY EXPERIMENT. It does not modify, and must never be confused with:
  - src/gpu/gpu_anomaly_kernel.cu (the native CUDA kernel the live gpu-sdn-sentinel.service actually runs), or
  - scripts/sentinel-replay.py's kernel_loss/Extractor/Adaptive (the pinned offline replica of that exact deployed
    10-parameter formula, checked by test/invariants/sentinel-replay.test.ts), or
  - scripts/gpu-sdn-anomaly-sentinel.py's default (no --weights-file / GPU_SENTINEL_WEIGHTS_FILE) behavior, or
  - scripts/score-labelled-runs.py (the shared lab-run scoring harness several other things in this repo rely on).
load_cuda_model_weights() / --weights-file expects exactly the existing 10-scalar shape; nothing produced by this
script can be loaded by the live daemon, and nothing here is proposed as something that could be, without a separate,
much larger follow-on project (a new kernel variant, hardware rebuild, re-validation of the fail-closed loader for a
new shape). This script's own lab-held-out scoring is therefore a small amount of deliberately-duplicated-not-reused
logic (lab_run_alerts_expanded/score_lab_run_expanded below) rather than a modification to score-labelled-runs.py's
sentinel_alerts()/score(), specifically so that shared, already-tested file is never touched by this experiment.

Usage:
  python3 scripts/train-sentinel-weights-expanded.py docs/benchmarks/results/labelled-runs \\
      --wednesday-npz /tmp/cic-flood-margin-cache/wednesday.npz --friday-npz /tmp/cic-flood-margin-cache/friday.npz \\
      --cic-benign-anchor-cap 2000 --cic-attack-train-cap 2000 \\
      --out-weights docs/benchmarks/results/sentinel-training-two-anchor/trained-weights-expanded-batch4-<date>.json

Needs numpy and scipy, same as the rest of this workstream.
"""
import argparse
import importlib.util
import json
import os
import time

import numpy as np
from scipy.optimize import differential_evolution, minimize

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


tw = _load('train_sentinel_weights', os.path.join(HERE, 'train-sentinel-weights.py'))
tc = _load('train_sentinel_weights_cic', os.path.join(HERE, 'train-sentinel-weights-cic.py'))
sr = tw.sr   # the single shared sentinel-replay module instance; NOT modified by this script (see module docstring)
slr = tw.slr

# --- Fixed by docs/benchmarks/results/sentinel-training-two-anchor/PREREGISTRATION.md (batch 4 addendum). Do not
# tune against results.
N_GROUPS = 16             # the window's own existing 16-group structure (h.reshape(16,4) in the original formula)
PACKETS_PER_GROUP = 4     # 64 packets / 16 groups
STAGE1_PARAMS_PER_GROUP = 5   # 4 encoder weights + 1 bias, per group
NUM_WEIGHTS_EXPANDED = N_GROUPS * STAGE1_PARAMS_PER_GROUP + 5   # 80 + 5 shared (w5..w9) = 85
BOUNDS_EXPANDED = [(-3.0, 5.0)] * NUM_WEIGHTS_EXPANDED   # same box as the original 10-parameter formula, unchanged
BETA_CIC_BENIGN = 1.0     # the hardest test of the conflict (batches 1-2's primary point), not batch 3's 0.25
DE_POPSIZE = 6            # scipy's popsize is a multiplier on ndim; population = 6*85=510, chosen so the TOTAL
DE_MAXITER = 60           # search budget (population*(maxiter+1)) lands close to batch 1's own nfev (30,211), a
POLISH_MAXITER = 2000     # comparable total budget to batch 1, not a comparable per-dimension budget - see
# PREREGISTRATION.md's "Optimizer budget, deliberately reduced" section for why this is disclosed as a real limit.
BOUND_PIN_EPS = 0.01      # same threshold as every prior batch in this workstream

# Success criterion, decided before running (PREREGISTRATION.md): lab recall >= 6/13 AND CIC-benign FP <= 2% on both
# days AND CIC-margin recall >= 20% on BOTH training classes (Hulk and GoldenEye), not just one.
SUCCESS_LAB_RECALL_MIN = 6
SUCCESS_CIC_BENIGN_FP_MAX_PCT = 2.0
SUCCESS_CIC_MARGIN_RECALL_MIN_PCT = 20.0


# --------------------------------------------------------------------------------------------------------------
# The new 85-parameter kernel formula: stage 1 (encoder) un-tied per the window's existing 16 groups; stages 2-4
# (bottleneck, broadcast-decode, final decode) unchanged and still globally shared, exactly as in kernel_loss.
# --------------------------------------------------------------------------------------------------------------

def kernel_loss_scalar_expanded(window, W):
    """Independent, deliberately un-vectorized, loop-based reference implementation of the SAME intended formula as
    kernel_loss_batch_expanded below, for ONE window. No pre-existing oracle exists for this new shape (unlike the
    original 10-parameter formula, which is checked against the real compiled kernel); this is this batch's own
    from-scratch cross-check that two independent codings of the new formula agree, the same discipline
    scripts/train-sentinel-weights.py's self_check() uses for the existing formula, applied to new code instead of
    old. window: (64,4) array-like, packet-major (same layout as sr.kernel_loss's input)."""
    x = np.asarray(window, dtype=np.float64).reshape(64, 4)
    W = np.asarray(W, dtype=np.float64)
    group_params = W[:80].reshape(N_GROUPS, STAGE1_PARAMS_PER_GROUP)
    w5, w6, w7, w8, w9 = W[80], W[81], W[82], W[83], W[84]
    h = np.zeros(64)
    for p in range(64):
        g = p // PACKETS_PER_GROUP
        enc_w = group_params[g, :4]
        enc_b = group_params[g, 4]
        s = 0.0
        for f in range(4):
            s += x[p, f] * enc_w[f]
        h[p] = max(0.0, s - enc_b)
    lat = np.zeros(N_GROUPS)
    for g in range(N_GROUPS):
        group_sum = sum(h[g * PACKETS_PER_GROUP + i] for i in range(PACKETS_PER_GROUP))
        lat[g] = max(0.0, group_sum * w5 - w6)
    rh = np.zeros(64)
    for p in range(64):
        rh[p] = max(0.0, lat[p % N_GROUPS] * w7)
    rec = np.zeros(256)
    for j in range(256):
        v = rh[j % 64] * w8 - w9
        # Same saturating-sigmoid tolerance as kernel_loss_batch_expanded; harmless overflow at BOUNDS corners.
        rec[j] = 1.0 / (1.0 + np.exp(-v)) if abs(v) < 700 else (1.0 if v > 0 else 0.0)
    xflat = x.reshape(256)
    return float(np.mean((xflat - rec) ** 2))


def kernel_loss_batch_expanded(X, W):
    """Vectorized form of kernel_loss_scalar_expanded over N windows at once, mirroring
    scripts/train-sentinel-weights.py's kernel_loss_batch's own vectorization style. X: (N,256) float32, packet-major
    (same layout every other function in this workstream uses). W: (85,) - 16 groups of (4 encoder weights + 1 bias)
    followed by the 5 shared scalars w5..w9 (same roles as the original formula's W[5]..W[9])."""
    X = np.asarray(X, dtype=np.float32)
    N = X.shape[0]
    Xr = X.reshape(N, 64, 4)
    W = np.asarray(W, dtype=np.float32)
    group_params = W[:80].reshape(N_GROUPS, STAGE1_PARAMS_PER_GROUP)
    enc_w = np.repeat(group_params[:, :4], PACKETS_PER_GROUP, axis=0)   # (64,4): group g's weights, 4 packets each
    enc_b = np.repeat(group_params[:, 4], PACKETS_PER_GROUP, axis=0)    # (64,)
    w5, w6, w7, w8, w9 = W[80], W[81], W[82], W[83], W[84]
    h = np.maximum(0.0, (Xr * enc_w[None, :, :]).sum(axis=2) - enc_b[None, :])          # (N,64)
    lat = np.maximum(0.0, h.reshape(N, N_GROUPS, PACKETS_PER_GROUP).sum(axis=2) * w5 - w6)   # (N,16)
    idx16 = np.arange(64) % N_GROUPS
    rh = np.maximum(0.0, lat[:, idx16] * w7)         # (N,64)
    idx64 = np.arange(256) % 64
    with np.errstate(over='ignore'):
        rec = 1.0 / (1.0 + np.exp(-(rh[:, idx64] * w8 - w9)))   # (N,256)
    return np.mean((X - rec) ** 2, axis=1)


def self_check_expanded(sample_window, seed=11):
    """Fails loudly if kernel_loss_batch_expanded ever drifts from the independent loop-based reference above, at
    the same kind of candidate set tw.self_check() uses for the original formula: zeros, both BOUNDS corners (the
    saturating-sigmoid regime), and several random interior points, on a real window."""
    rng = np.random.default_rng(seed)
    lo = np.array([b[0] for b in BOUNDS_EXPANDED])
    hi = np.array([b[1] for b in BOUNDS_EXPANDED])
    zeros = np.zeros(NUM_WEIGHTS_EXPANDED)
    candidates = [zeros, lo, hi] + [rng.uniform(lo, hi) for _ in range(5)]
    window_flat = np.asarray(sample_window, dtype=np.float32).reshape(1, 256)
    for W in candidates:
        want = kernel_loss_scalar_expanded(sample_window, W)
        got = float(kernel_loss_batch_expanded(window_flat, W)[0])
        agree_on_finiteness = (np.isfinite(want) and np.isfinite(got)) or (np.isnan(want) and np.isnan(got))
        if not agree_on_finiteness:
            raise SystemExit(f'FATAL: kernel_loss_batch_expanded and kernel_loss_scalar_expanded disagree on '
                              f'finiteness at W={W} ({got} vs {want}).')
        if abs(want - got) > 1e-4:
            raise SystemExit(f'FATAL: kernel_loss_batch_expanded disagrees with the independent scalar reference at '
                              f'W={W} ({got} vs {want}); refusing to fit against a possibly-drifted vectorization.')


# --------------------------------------------------------------------------------------------------------------
# Objective: the two-anchor formula, unchanged in shape, with the new kernel plugged in.
# --------------------------------------------------------------------------------------------------------------

def make_two_anchor_objective_expanded(train_groups_lab, cic_benign_anchor, attack_train_groups_cic,
                                        margin=tw.MARGIN, sigma=tw.SIGMA, lam=tw.LAMBDA, beta_cic_benign=BETA_CIC_BENIGN):
    """Identical formula to scripts/train-sentinel-weights-cic.py's make_two_anchor_objective, with
    kernel_loss_batch_expanded in place of tw.kernel_loss_batch throughout. See that function's docstring for the
    formula itself; not re-derived here beyond the one substitution."""
    def objective(w):
        W = np.asarray(w, dtype=np.float32)
        benign_pattern_means = []
        benign_pooled = []
        for _pattern, runs in train_groups_lab.items():
            run_losses = [kernel_loss_batch_expanded(windows, W) for _rid, windows in runs if len(windows)]
            if run_losses:
                benign_pattern_means.append(sum(float(np.mean(l)) for l in run_losses) / len(run_losses))
                benign_pooled.extend(run_losses)
        l_benign_lab = sum(benign_pattern_means) / len(benign_pattern_means)
        pooled = np.concatenate(benign_pooled)
        target = float(np.mean(pooled)) + sigma * float(np.std(pooled)) + margin

        day_means = [float(np.mean(kernel_loss_batch_expanded(windows, W)))
                     for windows in cic_benign_anchor.values() if len(windows)]
        l_benign_cic = sum(day_means) / len(day_means) if day_means else 0.0

        attack_pattern_means = []
        for _label, runs in attack_train_groups_cic.items():
            run_means = []
            for _rid, windows in runs:
                if len(windows) == 0:
                    continue
                hinge = np.maximum(0.0, target - kernel_loss_batch_expanded(windows, W))
                run_means.append(float(np.mean(hinge)))
            if run_means:
                attack_pattern_means.append(sum(run_means) / len(run_means))
        l_margin = sum(attack_pattern_means) / len(attack_pattern_means) if attack_pattern_means else 0.0

        return l_benign_lab + beta_cic_benign * l_benign_cic + lam * l_margin
    return objective


def components_expanded(train_groups_lab, cic_benign_anchor, attack_train_groups_cic, W, margin=tw.MARGIN, sigma=tw.SIGMA):
    """Per-term values, never blended - mirrors scripts/train-sentinel-weights-cic.py's two_anchor_components."""
    W = np.asarray(W, dtype=np.float32)
    pattern_means = []
    for _pattern, runs in train_groups_lab.items():
        run_losses = [kernel_loss_batch_expanded(windows, W) for _rid, windows in runs if len(windows)]
        if run_losses:
            pattern_means.append(sum(float(np.mean(l)) for l in run_losses) / len(run_losses))
    l_benign_lab = sum(pattern_means) / len(pattern_means)
    pooled = pooled_losses_expanded(train_groups_lab, W)
    target = float(np.mean(pooled)) + sigma * float(np.std(pooled)) + margin
    day_means = [float(np.mean(kernel_loss_batch_expanded(windows, W)))
                 for windows in cic_benign_anchor.values() if len(windows)]
    l_benign_cic = sum(day_means) / len(day_means) if day_means else 0.0
    attack_pattern_means = []
    for _label, runs in attack_train_groups_cic.items():
        run_means = []
        for _rid, windows in runs:
            if len(windows) == 0:
                continue
            hinge = np.maximum(0.0, target - kernel_loss_batch_expanded(windows, W))
            run_means.append(float(np.mean(hinge)))
        if run_means:
            attack_pattern_means.append(sum(run_means) / len(run_means))
    l_margin = sum(attack_pattern_means) / len(attack_pattern_means) if attack_pattern_means else 0.0
    return l_benign_lab, l_benign_cic, l_margin


def pooled_losses_expanded(train_groups_lab, W):
    pooled = []
    for _pattern, runs in train_groups_lab.items():
        for _rid, windows in runs:
            if len(windows):
                pooled.append(kernel_loss_batch_expanded(windows, W))
    return np.concatenate(pooled) if pooled else np.zeros((0,), dtype=np.float32)


def report_bound_proximity_expanded(W, eps=BOUND_PIN_EPS):
    pinned = []
    for i, (w, (lo, hi)) in enumerate(zip(W, BOUNDS_EXPANDED)):
        if abs(float(w) - lo) < eps or abs(float(w) - hi) < eps:
            pinned.append((i, float(w), lo, hi))
    return pinned


# --------------------------------------------------------------------------------------------------------------
# Lab held-out scoring under the new kernel: a small, DELIBERATELY SEPARATE re-implementation of
# scripts/score-labelled-runs.py's sentinel_alerts()/score() core logic (Extractor windowing, Adaptive controller,
# majority-sender attribution), calling kernel_loss_batch_expanded instead of sr.kernel_loss. Not a modification of
# that shared file - see this module's own docstring for why.
# --------------------------------------------------------------------------------------------------------------

def lab_run_alerts_expanded(frames, W, base_tau):
    """Same semantics and return shape as scripts/score-labelled-runs.py's sentinel_alerts(): one entry per
    anomalous 64-packet window, (t_ns, predominant_src, loss), using sr.Extractor and sr.Adaptive UNCHANGED (neither
    depends on the kernel's parameter count) but kernel_loss_batch_expanded instead of sr.kernel_loss."""
    import collections
    ex, ad = sr.Extractor(), sr.Adaptive(tau=base_tau)
    srcs = collections.deque()
    out = []
    for t_us, flen, proto, flags, sp, dp, src, t_ns in frames:
        srcs.append(src or 'unknown')
        if len(srcs) > sr.WIN:
            srcs.popleft()
        w = ex.feed(t_us, flen, proto, flags, sp, dp)
        if w is None:
            continue
        loss = float(kernel_loss_batch_expanded(np.asarray(w, dtype=np.float32).reshape(1, 256), W)[0])
        is_anom, _tau = ad.check(loss)
        if is_anom:
            known = collections.Counter(s for s in srcs if s != 'unknown')
            out.append((t_ns, known.most_common(1)[0][0] if known else 'unknown', loss))
    return out


def score_lab_run_expanded(label, frames, W, base_tau):
    """Same semantics as scripts/score-labelled-runs.py's score(), restricted to the sentinel detector only (the
    rate rule is untouched by this experiment and not relevant to it). label/frames are assumed already valid (every
    row in holdout_lab, built by tw.load_and_split, has already passed that check once during the baseline scoring
    pass that built the split - not re-checked here)."""
    sender = label['senderIp']
    alerts = lab_run_alerts_expanded(frames, W, base_tau)
    named_sender = [a for a in alerts if a[1] == sender]
    other = [a for a in alerts if a[1] != sender]
    return {'alerts': len(alerts), 'namedSender': len(named_sender), 'namedOthers': sorted({a[1] for a in other})}


def score_lab_holdout_expanded(holdout_lab, W, base_tau, label_text):
    rows = []
    for item in holdout_lab:
        res = score_lab_run_expanded(item['label'], item['frames'], W, base_tau)
        rows.append({'class': item['class'], 'pattern': item['pattern'], 'sentinel': res})
    attacks = [r for r in rows if r['class'] == 'attack']
    benign = [r for r in rows if r['class'] == 'benign']
    det = sum(1 for r in attacks if r['sentinel']['namedSender'])
    fp = sum(1 for r in benign if r['sentinel']['alerts'] > 0)
    print(f"{label_text:12s} tau={base_tau:.4f}  attack detected (right sender): {det}/{len(attacks)}   "
          f"benign false positives: {fp}/{len(benign)}")
    by_pattern = {}
    for r in rows:
        by_pattern.setdefault(r['pattern'], []).append(r)
    for pattern in sorted(by_pattern):
        group = by_pattern[pattern]
        cls = group[0]['class']
        if cls == 'attack':
            hit = sum(1 for r in group if r['sentinel']['namedSender'])
            print(f'    {pattern:34s} attack-detected {hit}/{len(group)}')
        else:
            hit = sum(1 for r in group if r['sentinel']['alerts'] > 0)
            print(f'    {pattern:34s} false-positive  {hit}/{len(group)}')
    return {'detected': det, 'attacks': len(attacks), 'falsePositives': fp, 'benign': len(benign)}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('datadir', help="docs/benchmarks/results/labelled-runs (the lab's own captures)")
    ap.add_argument('--wednesday-npz', required=True)
    ap.add_argument('--friday-npz', required=True)
    ap.add_argument('--cic-benign-anchor-cap', type=int, required=True, dest='cic_benign_anchor_cap')
    ap.add_argument('--cic-attack-train-cap', type=int, required=True, dest='cic_attack_train_cap')
    ap.add_argument('--beta-cic-benign', type=float, default=BETA_CIC_BENIGN, dest='beta_cic_benign')
    ap.add_argument('--margin', type=float, default=tw.MARGIN)
    ap.add_argument('--lambda-weight', type=float, default=tw.LAMBDA, dest='lambda_weight')
    ap.add_argument('--seed', type=int, default=tw.DE_SEED)
    ap.add_argument('--out-weights', default=None)
    args = ap.parse_args()

    print(f'== architecture: stage-1 encoder un-tied per {N_GROUPS} groups ({NUM_WEIGHTS_EXPANDED} parameters '
          f'total; stages 2-4 unchanged, 5 shared scalars) ==')
    print(f'== objective: two-anchor-expanded (BETA_cic_benign={args.beta_cic_benign}) ==\n')

    train_groups_lab, _attack_lab, _attack_lab_report, holdout_lab = tw.load_and_split(args.datadir, objective='margin')
    n_train_runs = sum(len(v) for v in train_groups_lab.values())
    n_train_windows = sum(len(w) for runs in train_groups_lab.values() for _rid, w in runs)
    print('== lab benign training pool (unchanged from the rest of this workstream) ==')
    print(f'{len(train_groups_lab)} patterns, {n_train_runs} runs, {n_train_windows} windows')
    n_holdout_benign = sum(1 for h in holdout_lab if h['class'] == 'benign')
    n_holdout_attack = sum(1 for h in holdout_lab if h['class'] == 'attack')
    print(f'lab held-out split (informal peek only): {n_holdout_benign} benign runs, {n_holdout_attack} attack runs\n')

    print('== CIC benign anchor (2,000/day, batch-1 scale) ==')
    cic_benign_anchor = {}
    cic_benign_peek = {}
    for day, npz_path in (('Wednesday', args.wednesday_npz), ('Friday', args.friday_npz)):
        anchor, peek, peek_src = tc.load_npz_benign_split(npz_path, args.cic_benign_anchor_cap, args.cic_benign_anchor_cap)
        cic_benign_anchor[day] = anchor
        cic_benign_peek[day] = (peek, peek_src)
        print(f'  {day:10s} anchor(train)={len(anchor)} windows   peek(informal only)={len(peek)} windows')

    print('\n== CIC attack margin-training pool (batch-1 scale, bounded subsample of round 3\'s cached buckets) ==')
    attack_train_groups_cic = {}
    cic_train_src_ips = {}
    for label in tc.CIC_TRAIN_LABELS:
        capped = tc.capped_attack_bucket(args.wednesday_npz, label, args.cic_attack_train_cap)
        _feats, _epochs, src_ips = tc.load_npz_bucket(args.wednesday_npz, label)
        attack_train_groups_cic[label] = [(f'cic-wed-{label.replace(" ", "-").lower()}-sanity', capped)]
        cic_train_src_ips[label] = src_ips[:args.cic_attack_train_cap]
        print(f'  {label:20s} {len(capped)} windows')

    lab_sample_window = next(w[0] for runs in train_groups_lab.values() for _rid, w in runs if len(w))
    cic_sample_window = attack_train_groups_cic[tc.CIC_TRAIN_LABELS[0]][0][1][0]
    self_check_expanded(lab_sample_window)
    self_check_expanded(cic_sample_window)
    print('\nself-check: kernel_loss_batch_expanded matches the independent loop-based reference on a real lab '
          'window and a real CIC window (ok)')

    objective = make_two_anchor_objective_expanded(train_groups_lab, cic_benign_anchor, attack_train_groups_cic,
                                                    margin=args.margin, sigma=tw.SIGMA, lam=args.lambda_weight,
                                                    beta_cic_benign=args.beta_cic_benign)
    baseline_W = np.zeros(NUM_WEIGHTS_EXPANDED, dtype=np.float32)   # no hardcoded prior for 85 params; an all-zero
    # starting point is a neutral reference for "what does the baseline objective value even look like at this
    # shape" - NOT a claim that zero is a sensible deployed default the way the original 10 hardcoded constants are.
    print(f'\n== fitting ({NUM_WEIGHTS_EXPANDED} params, bounds {BOUNDS_EXPANDED[0]} for all, '
          f'popsize={DE_POPSIZE} (population {DE_POPSIZE * NUM_WEIGHTS_EXPANDED}), maxiter={DE_MAXITER}) ==')
    print(f'hyperparameters: margin={args.margin} sigma={tw.SIGMA} lambda={args.lambda_weight} '
          f'beta_cic_benign={args.beta_cic_benign}')

    bl_lab, bl_cic, bl_margin = components_expanded(train_groups_lab, cic_benign_anchor, attack_train_groups_cic,
                                                     baseline_W, margin=args.margin, sigma=tw.SIGMA)
    baseline_obj = objective(baseline_W)
    print(f'all-zero-weights reference -- L_benign_lab={bl_lab:.6f}  L_benign_cic={bl_cic:.6f}  '
          f'L_margin(raw hinge)={bl_margin:.6f}  total={baseline_obj:.6f}')
    if not np.isfinite(baseline_obj):
        raise SystemExit(f'FATAL: all-zero-weights reference objective value is not finite ({baseline_obj}).')

    t0 = time.monotonic()
    de = differential_evolution(objective, BOUNDS_EXPANDED, seed=args.seed, popsize=DE_POPSIZE, maxiter=DE_MAXITER,
                                 tol=1e-10, polish=True, updating='deferred', workers=1)
    polished = minimize(objective, de.x, method='Nelder-Mead', bounds=BOUNDS_EXPANDED,
                         options={'xatol': 1e-8, 'fatol': 1e-12, 'maxiter': POLISH_MAXITER, 'maxfev': POLISH_MAXITER})
    elapsed = time.monotonic() - t0
    trained_W = polished.x if polished.fun <= de.fun else de.x
    trained_loss = min(polished.fun, de.fun)
    print(f'differential_evolution: nfev={de.nfev} objective={de.fun:.6f}')
    print(f'Nelder-Mead polish:     nfev={polished.nfev} objective={polished.fun:.6f}')
    print(f'fitted in {elapsed:.1f}s')
    print(f'trained training-objective value: {trained_loss:.6f}  (all-zero reference was {baseline_obj:.6f})')

    print('\n== sanity check 1: finite? ==')
    all_finite = np.isfinite(trained_loss) and np.all(np.isfinite(trained_W)) and np.isfinite(de.fun) and np.isfinite(polished.fun)
    print(f'all finite: {all_finite}')
    if not all_finite:
        raise SystemExit('FATAL: non-finite value in the fitted result (NaN/Inf) -- sanity check FAILED on check 1.')

    print(f'\n== sanity check 2: fitted weights pinned to a bound (within {BOUND_PIN_EPS})? ==')
    pinned = report_bound_proximity_expanded(trained_W)
    print(f'{len(pinned)}/{NUM_WEIGHTS_EXPANDED} pinned' + (':' if pinned else ' (none)'))
    for i, w, lo, hi in pinned:
        edge = 'lower' if abs(w - lo) < abs(w - hi) else 'upper'
        print(f'  w{i} = {w:.6f}  ({edge} bound, distance {min(abs(w - lo), abs(w - hi)):.6f})')

    tr_lab, tr_cic, tr_margin = components_expanded(train_groups_lab, cic_benign_anchor, attack_train_groups_cic,
                                                     trained_W, margin=args.margin, sigma=tw.SIGMA)
    print('\n== sanity check 3: per-term values at the trained weights (never blended) ==')
    print(f'trained weights -- L_benign_lab={tr_lab:.6f}  L_benign_cic={tr_cic:.6f}  L_margin(raw hinge)={tr_margin:.6f}')
    print(f'(all-zero reference was L_benign_lab={bl_lab:.6f}  L_benign_cic={bl_cic:.6f}  L_margin(raw hinge)={bl_margin:.6f})')

    train_losses_trained_W = pooled_losses_expanded(train_groups_lab, trained_W)
    trained_tau = float(np.mean(train_losses_trained_W) + tw.SIGMA * np.std(train_losses_trained_W))
    print(f'\ncalibrated tau for trained weights: mean={np.mean(train_losses_trained_W):.4f} '
          f'std={np.std(train_losses_trained_W):.4f} -> base_tau={trained_tau:.4f} '
          f'(pooled over {len(train_losses_trained_W)} LAB training-benign windows only, never CIC benign)')

    print('\n== CIC margin-training classes (Hulk, GoldenEye), own-data window-level recall (training performance, NOT held out) ==')
    cic_margin_recall = {}
    for label in tc.CIC_TRAIN_LABELS:
        feats = attack_train_groups_cic[label][0][1]
        src_ips_f = cic_train_src_ips[label]
        res = tc.score_cic_block(feats, src_ips_f, trained_W, trained_tau, known_attacker_ip=tc.KNOWN_ATTACKER_IP,
                                  kernel_loss_fn=kernel_loss_batch_expanded)
        recall_pct = 100 * res['alerts'] / res['n'] if res['n'] else 0.0
        cic_margin_recall[label] = recall_pct
        print(f"  {label:20s} n={res['n']}  two-anchor-expanded recall {tc.pct(res['alerts'], res['n'])}")

    print('\n== sanity check 4: informal peek (NOT a held-out result, same caveat as every prior batch) ==')
    print('-- lab held-out split (informal peek), two-anchor-expanded --')
    lab_result = score_lab_holdout_expanded(holdout_lab, trained_W, trained_tau, 'expanded')

    print('-- CIC-benign peek slice (disjoint from the training anchor), false-positive rate only --')
    cic_benign_fp_pct = {}
    for day, (peek_feats, peek_src) in cic_benign_peek.items():
        res = tc.score_cic_block(peek_feats, peek_src, trained_W, trained_tau, kernel_loss_fn=kernel_loss_batch_expanded)
        fp_pct = 100 * res['alerts'] / res['n'] if res['n'] else 0.0
        cic_benign_fp_pct[day] = fp_pct
        print(f"  {day:10s} n={res['n']}  two-anchor-expanded FP rate {tc.pct(res['alerts'], res['n'])}")

    print('\n== success criterion (PREREGISTRATION.md, decided before this run) ==')
    crit_recall = lab_result['detected'] >= SUCCESS_LAB_RECALL_MIN
    crit_fp = all(v <= SUCCESS_CIC_BENIGN_FP_MAX_PCT for v in cic_benign_fp_pct.values())
    crit_margin = all(v >= SUCCESS_CIC_MARGIN_RECALL_MIN_PCT for v in cic_margin_recall.values())
    print(f"lab recall >= {SUCCESS_LAB_RECALL_MIN}/13: {lab_result['detected']}/13 -> {'PASS' if crit_recall else 'FAIL'}")
    print(f'CIC-benign FP <= {SUCCESS_CIC_BENIGN_FP_MAX_PCT}% both days: ' +
          ', '.join(f'{d}={v:.2f}%' for d, v in cic_benign_fp_pct.items()) + f" -> {'PASS' if crit_fp else 'FAIL'}")
    print(f'CIC-margin recall >= {SUCCESS_CIC_MARGIN_RECALL_MIN_PCT}% both classes: ' +
          ', '.join(f'{l}={v:.2f}%' for l, v in cic_margin_recall.items()) + f" -> {'PASS' if crit_margin else 'FAIL'}")
    n_pass = sum([crit_recall, crit_fp, crit_margin])
    print(f'\nOVERALL: {n_pass}/3 criteria met -- '
          f"{'capacity appears to resolve the conflict at this scale' if n_pass == 3 else 'capacity does NOT fully resolve the conflict at this scale/search budget' if n_pass == 0 else 'partial - reported as exactly that, not rounded either way'}")

    if args.out_weights:
        payload = {
            'weights': [float(x) for x in trained_W],
            'tau': trained_tau,
            'objective': 'two-anchor-expanded',
            'batch': 'sentinel-training-two-anchor batch 4 (sanity check, NOT a validated or recommended result, '
                     'NOT loadable by the live sentinel -- different parameter shape)',
            'architecture': {'num_weights': NUM_WEIGHTS_EXPANDED, 'n_groups': N_GROUPS,
                              'stage1_params_per_group': STAGE1_PARAMS_PER_GROUP,
                              'note': 'weights[0:80] = 16 groups of (w0,w1,w2,w3,bias); weights[80:85] = w5..w9 '
                                      '(shared bottleneck/broadcast/decode, same roles as the original 10-param formula)'},
            'beta_cic_benign': args.beta_cic_benign,
            'margin_hyperparameters': {'margin': args.margin, 'sigma': tw.SIGMA, 'lambda': args.lambda_weight},
            'optimizer': {'popsize': DE_POPSIZE, 'maxiter': DE_MAXITER, 'polish_maxiter': POLISH_MAXITER,
                          'note': 'deliberately reduced from the rest of this workstream\'s popsize=20/maxiter=150 '
                                  'to keep total search budget comparable given DE population scales with ndim; '
                                  'see PREREGISTRATION.md'},
            'sample_sizes': {'lab_benign_training_windows': n_train_windows,
                              'cic_benign_anchor_windows_per_day': args.cic_benign_anchor_cap,
                              'cic_attack_margin_windows_per_class': args.cic_attack_train_cap},
            'training_objective_value': float(trained_loss),
            'training_objective_components': {'L_benign_lab': tr_lab, 'L_benign_cic': tr_cic, 'L_margin_raw': tr_margin},
            'bound_pinned_weights': [{'index': i, 'value': w, 'lower': lo, 'upper': hi} for i, w, lo, hi in pinned],
            'informal_peek': {'lab_holdout_detected': lab_result['detected'], 'lab_holdout_attacks': lab_result['attacks'],
                               'lab_holdout_fp': lab_result['falsePositives'], 'lab_holdout_benign': lab_result['benign'],
                               'cic_benign_fp_pct': cic_benign_fp_pct, 'cic_margin_recall_pct': cic_margin_recall},
            'success_criterion': {'lab_recall_min': SUCCESS_LAB_RECALL_MIN,
                                   'cic_benign_fp_max_pct': SUCCESS_CIC_BENIGN_FP_MAX_PCT,
                                   'cic_margin_recall_min_pct': SUCCESS_CIC_MARGIN_RECALL_MIN_PCT,
                                   'criteria_met': n_pass},
            'seed': args.seed,
            'note': 'Fitted by scripts/train-sentinel-weights-expanded.py; see '
                    'docs/benchmarks/results/sentinel-training-two-anchor/PREREGISTRATION.md (batch 4 addendum). '
                    'This is an offline-only sanity check on a small bounded sample, a different parameter shape '
                    'than the deployed kernel, and is NEVER to be loaded via --weights-file / '
                    'GPU_SENTINEL_WEIGHTS_FILE (shape mismatch; the live loader expects exactly 10 weights).',
        }
        with open(args.out_weights, 'w') as fh:
            json.dump(payload, fh, indent=2)
            fh.write('\n')
        print(f'\nwrote {args.out_weights}')


if __name__ == '__main__':
    main()
