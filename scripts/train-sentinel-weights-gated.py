#!/usr/bin/env python3
"""
scripts/train-sentinel-weights-gated.py
========================================
Two-anchor workstream, batch 15 (docs/benchmarks/results/sentinel-training-two-anchor/PREREGISTRATION.md).
Option 3 (owner-approved order: option 2 first, done in batches 13-14; this is the first option-3 attempt).

WHY THIS SHAPE, NOT JUST "MORE PARAMETERS" (batch 4 already showed that fails): batch 13's working fix was an
ensemble of two INDEPENDENTLY-FITTED 10-parameter kernels (Model A, CIC-shaped; Model B, the original lab-shaped
baseline), OR-combined on two independently-calibrated thresholds -- no joint training, no learned interaction, no
per-window context. Comparing the already-committed weight vectors from batches 9-12 against the original baseline
(see PREREGISTRATION.md's batch 15 addendum for the full table) shows the CIC-anchored fits (batches 10, 11,
12-lambda0.5) all converge w1 (the window's own per-packet encoder weight on "ln", normalized frame length) to a
strongly NEGATIVE value pinned near the lower bound (-2.6 to -3.0), the opposite sign from the baseline's +0.30 --
and this holds even in the two fits (batch 11, batch 12-lambda0.5) that recover lab held-out recall from 2/13 to
4/13, via a DIFFERENT weight (w3, the "pe"/port-entropy feature weight, which jumps from ~0.7 to ~4-4.7 in those
two fits). This is direct, measured evidence that the capacity conflict lives in the kernel's single SHARED 4-feature
linear encoder (w0..w4): CIC-shaped and lab-shaped data pull on more than one of its weights in ways a single shared
projection cannot simultaneously satisfy -- not a single pairwise sign flip fixable by one new interaction term, and
not relieved by adding width in a DIFFERENT place (batch 4 un-tied the encoder's packet-position tying, 10->85
params, and the conflict did not move).

THIS BATCH'S ARCHITECTURE: a cheap, JOINTLY-fit gate over TWO existing 10-parameter sub-kernels (direction (a) from
the batch 15 task), combining their SCALAR reconstruction losses, not their reconstruction vectors or two
independent Adaptive controllers:

  gate(window)   = sigmoid(wg0 * mean_ln(window) + wg1 * mean_pe(window) + wg2)
  loss(window)   = gate(window) * kernel_loss(window; W_A) + (1 - gate(window)) * kernel_loss(window; W_B)

mean_ln/mean_pe are the window-level means of the two raw features (already extracted by sr.Extractor, columns 1
and 3 of the existing 4) the weight-vector comparison above flags as most conflicted -- no new feature engineering,
reusing exactly what sr.Extractor already computes. W_A and W_B are each a full, unconstrained 10-parameter
sr.kernel_loss-shaped vector (same formula, same BOUNDS), and (wg0, wg1, wg2) are 3 more scalars -- 23 parameters
total, ONE unified detector with ONE calibrated tau over the single blended loss stream (not two models, two
thresholds, and an external OR rule). Unlike batch 13's ensemble, the gate and both sub-kernels are optimized
TOGETHER, in one differential_evolution + Nelder-Mead search over all 23 dimensions at once, under one combined
objective -- there is no "fit A, fit B, then combine" step.

Compute budget: docs/SENTINEL-ROADMAP.md's own measured number (174 live inferences on the Jetson GPU) is 0.271 ms/
window average for the EXISTING 10-parameter kernel, against a stated <1.0 ms design budget (Dean latency invariant)
and ~369x headroom over the rate a 100 ms detection window actually needs (10 windows/s). Running TWO 10-parameter
kernels plus a 3-parameter gate roughly doubles the arithmetic (two kernel_loss evaluations instead of one, plus a
handful of extra multiply-adds for the gate) -- comfortably inside the measured budget on this evidence, so the
budget is not what ruled out a unified detector; the capacity conflict is. (This is cited for proportionality, not
re-measured by this script: this is an offline Python/numpy fitting tool, not a Jetson/CUDA benchmark, and makes no
claim about the native kernel's actual latency with this shape -- see PREREGISTRATION.md's batch 15 addendum for the
full disclosure and what would be needed to measure it for real.)

Scope boundary, same as every batch in this workstream: this is an OFFLINE, PYTHON-ONLY fitting exercise.
src/gpu/gpu_anomaly_kernel.cu, scripts/sentinel-replay.py's kernel_loss/Extractor/Adaptive, and
scripts/gpu-sdn-anomaly-sentinel.py are NOT modified. load_cuda_model_weights()/--weights-file expects the existing
10-scalar shape; a 23-parameter model cannot be loaded by the live daemon without a new kernel variant, a hardware
rebuild, and re-validation of the fail-closed loader for a new shape -- out of scope here, same as batch 4's own
disclosed boundary for its 85-parameter experiment.

Usage:
  python3 scripts/train-sentinel-weights-gated.py docs/benchmarks/results/labelled-runs \\
      --wednesday-npz /tmp/cic-flood-margin-cache/wednesday.npz --friday-npz /tmp/cic-flood-margin-cache/friday.npz \\
      [--out-weights PATH] [--out-json PATH] [--seed 42]

Needs numpy and scipy (through scripts/train-sentinel-weights-cic.py / scripts/train-sentinel-weights.py).
"""
import argparse
import collections
import importlib.util
import json
import os
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# Reuses scripts/train-sentinel-weights-cic.py as a library ONLY (its main() is guarded by
# `if __name__ == '__main__':`, same as every other script in this family) -- its tw/sr/slr instances, data-loading
# helpers (load_npz_bucket, load_npz_benign_split, capped_attack_bucket), score_cic_block (already accepts a
# `kernel_loss_fn` parameter -- added in batch 4 for exactly this situation, a different-shaped kernel), and its
# pre-registered scope constants (CIC_TRAIN_LABELS, CIC_HOLDOUT_*_LABELS, KNOWN_ATTACKER_IP) are reused unmodified.
# No change to that file's or scripts/train-sentinel-weights.py's fitting/objective code path.
tsc = _load('train_sentinel_weights_cic', os.path.join(HERE, 'train-sentinel-weights-cic.py'))
tw = tsc.tw
sr = tsc.sr
slr = tsc.slr

NUM_SUB_WEIGHTS = 10          # each sub-kernel is exactly sr.kernel_loss's existing shape, unchanged.
NUM_GATE_WEIGHTS = 3          # wg0 (mean_ln coefficient), wg1 (mean_pe coefficient), wg2 (bias).
NUM_GATED_WEIGHTS = 2 * NUM_SUB_WEIGHTS + NUM_GATE_WEIGHTS   # 23

# Gate bounds, deliberately wider than the sub-kernels' own [-3, 5] (Invariant 5: bounded, not unbounded, and
# disclosed why): mean_ln and mean_pe are themselves already normalized to roughly [0, 1] by sr.Extractor, so a
# logistic gate needs an argument of magnitude roughly >= 6 to approach a near-hard 0/1 decision (sigmoid(6) =
# 0.9975); +-20 on the two feature coefficients and +-10 on the bias comfortably covers "can be as sharp as a hard
# switch if the data wants that" while still being a fixed, bounded box the optimizer cannot escape, not a new
# unconfigurable magic number.
GATE_BOUNDS = [(-20.0, 20.0), (-20.0, 20.0), (-10.0, 10.0)]
BOUNDS_GATED = list(tw.BOUNDS) + list(tw.BOUNDS) + GATE_BOUNDS
assert len(BOUNDS_GATED) == NUM_GATED_WEIGHTS


def _stable_sigmoid(x):
    """Numerically stable logistic, avoiding overflow in exp() for large |x| without suppressing the (harmless,
    expected-at-BOUNDS-corners) overflow warning kernel_loss_batch's own comment already documents the same
    reasoning for."""
    out = np.empty_like(x, dtype=np.float64)
    pos = x >= 0
    with np.errstate(over='ignore'):
        out[pos] = 1.0 / (1.0 + np.exp(-x[pos]))
        ex = np.exp(x[~pos])
        out[~pos] = ex / (1.0 + ex)
    return out


def gate_values(X, wg):
    """g(window) in [0, 1] for each row of X (N, 256), from the window's own mean "ln" (column 1 of the existing
    4 per-packet features) and mean "pe" (column 3) -- no new feature engineering, reusing exactly what
    sr.Extractor already computes per packet. wg: (3,) = (wg0, wg1, wg2)."""
    X = np.asarray(X, dtype=np.float64)
    Xr = X.reshape(-1, 64, 4)
    mean_ln = Xr[:, :, 1].mean(axis=1)
    mean_pe = Xr[:, :, 3].mean(axis=1)
    logit = wg[0] * mean_ln + wg[1] * mean_pe + wg[2]
    return _stable_sigmoid(logit)


def gated_kernel_loss_batch(X, W):
    """The one new piece of arithmetic this batch adds: a convex (per-window, data-dependent weight) combination of
    TWO existing, unmodified tw.kernel_loss_batch evaluations. W: (23,) = W_A (10) ++ W_B (10) ++ (wg0, wg1, wg2).
    Same call signature as tw.kernel_loss_batch (and the `kernel_loss_fn` parameter tsc.score_cic_block already
    accepts), so this is a drop-in kernel_loss_fn for that function with no changes to score_cic_block itself."""
    W = np.asarray(W, dtype=np.float32)
    if len(W) != NUM_GATED_WEIGHTS:
        raise SystemExit(f'FATAL: gated_kernel_loss_batch expects a {NUM_GATED_WEIGHTS}-element W, got {len(W)}.')
    w_a, w_b, wg = W[:10], W[10:20], W[20:23]
    loss_a = tw.kernel_loss_batch(X, w_a)
    loss_b = tw.kernel_loss_batch(X, w_b)
    g = gate_values(X, wg)
    return g * loss_a + (1.0 - g) * loss_b


def self_check_gate_math(sample_window, seed=11):
    """Fail loudly (Invariant 1) if gate_values ever drifts from an independently-written, loop-based reference of
    the SAME intended formula (same discipline scripts/train-sentinel-weights-expanded.py's batch-4 self-check used
    for its own new arithmetic: an un-vectorized scalar loop, not a second copy-pasted vectorized version, checked
    at a handful of interior points and both GATE_BOUNDS corners)."""
    rng = np.random.default_rng(seed)
    lo = np.array([b[0] for b in GATE_BOUNDS])
    hi = np.array([b[1] for b in GATE_BOUNDS])
    candidates = [np.array([0.0, 0.0, 0.0]), lo, hi] + [rng.uniform(lo, hi) for _ in range(5)]
    w = np.asarray(sample_window, dtype=np.float64).reshape(64, 4)
    mean_ln_loop = sum(row[1] for row in w) / 64.0
    mean_pe_loop = sum(row[3] for row in w) / 64.0
    x_batch = np.asarray(sample_window, dtype=np.float32).reshape(1, 256)
    for wg in candidates:
        logit_loop = wg[0] * mean_ln_loop + wg[1] * mean_pe_loop + wg[2]
        want = 1.0 / (1.0 + np.exp(-logit_loop)) if logit_loop >= 0 else np.exp(logit_loop) / (1.0 + np.exp(logit_loop))
        got = float(gate_values(x_batch, wg)[0])
        if abs(want - got) > 1e-9:
            raise SystemExit(f'FATAL: gate_values disagrees with an independent loop-based reference at wg={wg} '
                              f'({got} vs {want}) -- refusing to fit against a gate formula that may have drifted.')


def self_check_gated_degenerate(sample_window, seed=17):
    """Fail loudly if gated_kernel_loss_batch disagrees with the plain tw.kernel_loss_batch it must reduce to when
    W_A == W_B: for ANY gate parameters, g*L + (1-g)*L == L exactly. This checks the blend arithmetic itself
    (independent of whatever gate_values computes) at the compiled-in default weights, both GATE_BOUNDS corners, and
    random interior points -- the same "does the new combination logic do what it claims" discipline as every other
    self-check in this file family."""
    rng = np.random.default_rng(seed)
    lo_g = np.array([b[0] for b in GATE_BOUNDS])
    hi_g = np.array([b[1] for b in GATE_BOUNDS])
    x_batch = np.asarray(sample_window, dtype=np.float32).reshape(1, 256)
    w10 = np.asarray(sr.W, dtype=np.float32, copy=True)
    want = float(tw.kernel_loss_batch(x_batch, w10)[0])
    for wg in [np.zeros(3), lo_g, hi_g] + [rng.uniform(lo_g, hi_g) for _ in range(5)]:
        w23 = np.concatenate([w10, w10, wg]).astype(np.float32)
        got = float(gated_kernel_loss_batch(x_batch, w23)[0])
        if abs(want - got) > 1e-4:
            raise SystemExit(f'FATAL: gated_kernel_loss_batch does not reduce to tw.kernel_loss_batch when '
                              f'W_A==W_B at wg={wg} ({got} vs {want}) -- the blend formula itself is wrong.')


def make_two_anchor_objective_gated(train_groups_lab, cic_benign_anchor, attack_train_groups_cic,
                                     margin=None, sigma=None, lam=None,
                                     beta_cic_benign=tsc.BETA_CIC_BENIGN_DEFAULT, margin_combine='mean'):
    """Exactly tsc.make_two_anchor_objective's formula (batches 1-6's static-hinge two-anchor objective: L(W) =
    L_benign_lab(W) + beta_cic_benign * L_benign_cic(W) + lam * L_margin(W)) with every `tw.kernel_loss_batch(...)`
    call replaced by `gated_kernel_loss_batch(...)`, and W now a 23-element vector instead of 10.

    Deliberately the SIMPLER static-hinge objective (batches 1-6), not batch 9/10's sequence-level Adaptive-replay
    surrogate: re-deriving the sequence surrogate (_replay_class_soft_alerts) for a new, non-sr.kernel_loss-shaped
    loss function would need new Adaptive-replay-aware scoring machinery for TRAINING, which this batch's own
    pre-registered scope rule says to avoid forcing ("if it needs ... non-trivial new scoring machinery, do NOT
    force it"). This is a real, disclosed limitation: this prototype tests whether the GATED ARCHITECTURE, under
    the workstream's ORIGINAL (not its best-ever) objective, can reach a materially different operating point than
    any single 10-parameter kernel did under the same objective -- not a claim that it was trained with the single
    best objective this workstream has found. See PREREGISTRATION.md's batch 15 addendum.
    """
    margin = tw.MARGIN if margin is None else margin
    sigma = tw.SIGMA if sigma is None else sigma
    lam = tw.LAMBDA if lam is None else lam

    def objective(w):
        W = np.asarray(w, dtype=np.float32)
        benign_pattern_means = []
        benign_pooled = []
        for _pattern, runs in train_groups_lab.items():
            run_losses = [gated_kernel_loss_batch(windows, W) for _rid, windows in runs if len(windows)]
            if run_losses:
                benign_pattern_means.append(sum(float(np.mean(l)) for l in run_losses) / len(run_losses))
                benign_pooled.extend(run_losses)
        l_benign_lab = sum(benign_pattern_means) / len(benign_pattern_means)
        pooled = np.concatenate(benign_pooled)
        target = float(np.mean(pooled)) + sigma * float(np.std(pooled)) + margin

        day_means = [float(np.mean(gated_kernel_loss_batch(windows, W)))
                     for windows in cic_benign_anchor.values() if len(windows)]
        l_benign_cic = sum(day_means) / len(day_means) if day_means else 0.0

        attack_pattern_means = []
        for _label, runs in attack_train_groups_cic.items():
            run_means = []
            for _rid, windows in runs:
                if len(windows) == 0:
                    continue
                hinge = np.maximum(0.0, target - gated_kernel_loss_batch(windows, W))
                run_means.append(float(np.mean(hinge)))
            if run_means:
                attack_pattern_means.append(sum(run_means) / len(run_means))
        if not attack_pattern_means:
            l_margin = 0.0
        elif margin_combine == 'max':
            l_margin = max(attack_pattern_means)
        elif margin_combine == 'mean':
            l_margin = sum(attack_pattern_means) / len(attack_pattern_means)
        else:
            raise ValueError(f"margin_combine must be 'mean' or 'max', got {margin_combine!r}")

        return l_benign_lab + beta_cic_benign * l_benign_cic + lam * l_margin
    return objective


def two_anchor_components_gated(train_groups_lab, cic_benign_anchor, attack_train_groups_cic, W,
                                 margin=None, sigma=None):
    """Returns (l_benign_lab, l_benign_cic, l_margin_raw) at W, never blended -- the gated analogue of
    tsc.two_anchor_components, for diagnostic printing only."""
    margin = tw.MARGIN if margin is None else margin
    sigma = tw.SIGMA if sigma is None else sigma
    W = np.asarray(W, dtype=np.float32)
    benign_pattern_means = []
    benign_pooled = []
    for _pattern, runs in train_groups_lab.items():
        run_losses = [gated_kernel_loss_batch(windows, W) for _rid, windows in runs if len(windows)]
        if run_losses:
            benign_pattern_means.append(sum(float(np.mean(l)) for l in run_losses) / len(run_losses))
            benign_pooled.extend(run_losses)
    l_benign_lab = sum(benign_pattern_means) / len(benign_pattern_means)
    pooled = np.concatenate(benign_pooled)
    target = float(np.mean(pooled)) + sigma * float(np.std(pooled)) + margin
    day_means = [float(np.mean(gated_kernel_loss_batch(windows, W)))
                 for windows in cic_benign_anchor.values() if len(windows)]
    l_benign_cic = sum(day_means) / len(day_means) if day_means else 0.0
    attack_pattern_means = []
    for _label, runs in attack_train_groups_cic.items():
        run_means = []
        for _rid, windows in runs:
            if len(windows) == 0:
                continue
            hinge = np.maximum(0.0, target - gated_kernel_loss_batch(windows, W))
            run_means.append(float(np.mean(hinge)))
        if run_means:
            attack_pattern_means.append(sum(run_means) / len(run_means))
    l_margin = sum(attack_pattern_means) / len(attack_pattern_means) if attack_pattern_means else 0.0
    return l_benign_lab, l_benign_cic, l_margin


# --- Lab held-out replay (same discipline as scripts/eval-sentinel-ensemble.py's ensemble_sentinel_alerts): mirrors
# slr.sentinel_alerts's internals but uses gated_kernel_loss_batch and ONE sr.Adaptive controller (one threshold,
# one model, matching this batch's whole point -- a single unified detector, not two ORed ones). ---

def gated_sentinel_alerts(frames, W, base_tau):
    extractor = sr.Extractor()
    ad = sr.Adaptive(tau=base_tau)
    W = np.asarray(W, dtype=np.float32)
    srcs = collections.deque()
    out = []
    for t_us, flen, proto, flags, sp, dp, src, t_ns in frames:
        srcs.append(src or 'unknown')
        if len(srcs) > sr.WIN:
            srcs.popleft()
        w = extractor.feed(t_us, flen, proto, flags, sp, dp)
        if w is None:
            continue
        x = np.asarray(w, dtype=np.float32).reshape(1, -1)
        loss = float(gated_kernel_loss_batch(x, W)[0])
        is_anom, _tau = ad.check(loss)
        if is_anom:
            known = collections.Counter(s for s in srcs if s != 'unknown')
            out.append((t_ns, known.most_common(1)[0][0] if known else 'unknown', loss))
    return out


def self_check_gated_lab(frames, w10, tau):
    """Fail loudly if gated_sentinel_alerts disagrees with the real slr.sentinel_alerts in the degenerate
    W_A==W_B==w10 case (any gate value), for a real lab run's own frames."""
    original_w = np.array(sr.W, dtype=np.float32, copy=True)
    try:
        sr.W = np.asarray(w10, dtype=np.float32)
        real = [(t, s) for t, s, _loss in slr.sentinel_alerts(frames, base_tau=tau)]
    finally:
        sr.W = original_w
    w23 = np.concatenate([w10, w10, [1.23, -4.56, 0.78]]).astype(np.float32)   # arbitrary, non-zero gate params
    mine = [(t, s) for t, s, _loss in gated_sentinel_alerts(frames, w23, tau)]
    if mine != real:
        raise SystemExit(f'FATAL: gated_sentinel_alerts disagrees with the real slr.sentinel_alerts in the '
                          f'degenerate W_A==W_B case ({len(mine)} vs {len(real)} alert windows) -- refusing to '
                          f'report lab held-out numbers built on a function that may have drifted from the real '
                          f'scorer.')


def gated_score_holdout(holdout, W, base_tau, label_text):
    """Gated analogue of tw.score_holdout: identical aggregation arithmetic, applied to gated_sentinel_alerts's
    per-run output instead of slr.sentinel_alerts's."""
    rows = []
    for item in holdout:
        label = item['label']
        sender = label['senderIp']
        alerts = gated_sentinel_alerts(item['frames'], W, base_tau)
        named_sender = [a for a in alerts if a[1] == sender]
        other = [a for a in alerts if a[1] != sender]
        rows.append({'id': label['id'], 'class': item['class'], 'pattern': item['pattern'],
                      'sentinel': {'alerts': len(alerts), 'namedSender': len(named_sender),
                                   'namedOthers': sorted({a[1] for a in other})}})
    attacks = [r for r in rows if r['class'] == 'attack']
    benign = [r for r in rows if r['class'] == 'benign']
    det = sum(1 for r in attacks if r['sentinel']['namedSender'])
    fp = sum(1 for r in benign if r['sentinel']['alerts'] > 0)
    mis = sum(1 for r in rows if r['sentinel']['namedOthers'])
    print(f"{label_text:22s} attack detected (right sender): {det}/{len(attacks)}   "
          f"benign false positives: {fp}/{len(benign)}   misattributions: {mis}/{len(rows)}")
    by_pattern = {}
    for r in rows:
        by_pattern.setdefault(r['pattern'], []).append(r)
    for pattern in sorted(by_pattern):
        group = by_pattern[pattern]
        cls = group[0]['class']
        if cls == 'attack':
            hit = sum(1 for r in group if r['sentinel']['namedSender'])
            print(f"    {pattern:34s} attack-detected {hit}/{len(group)}")
        else:
            hit = sum(1 for r in group if r['sentinel']['alerts'] > 0)
            print(f"    {pattern:34s} false-positive  {hit}/{len(group)}")
    return {'detected': det, 'attacks': len(attacks), 'falsePositives': fp, 'benign': len(benign),
            'misattributions': mis}


def gate_stats(features, wg, label_text):
    """Mean gate value on a block of windows -- diagnostic only (does g actually move between CIC-shaped and
    lab-shaped traffic, the mechanism this whole architecture is betting on?). g near 1 means "mostly using W_A"; g
    near 0 means "mostly using W_B"."""
    if len(features) == 0:
        return None
    g = gate_values(features, wg)
    mean_g = float(np.mean(g))
    print(f'  {label_text:34s} n={len(features):6d}  mean gate value (1=favors W_A, 0=favors W_B) = {mean_g:.4f}  '
          f'(std {float(np.std(g)):.4f})')
    return mean_g


# --- Pre-registered bar: must meet or beat batch 13's ensemble, AS A SINGLE UNIFIED MODEL, to be a genuine
# option-3 candidate (decided before this script was run against real data; see PREREGISTRATION.md's batch 15
# addendum). ---
LAB_HOLDOUT_DETECTED_BAR = 8
CIC_RECALL_BAR_PCT = 90.0
CIC_BENIGN_FP_BAR_PCT = 2.0

# Batch 13's own committed ensemble numbers, for direct side-by-side comparison in this script's own output (not
# re-derived here -- see docs/benchmarks/results/sentinel-training-two-anchor/ensemble-eval-batch13-2026-10-26.json).
BATCH13_ENSEMBLE = {
    'lab_holdout_detected': 10, 'lab_holdout_attacks': 13, 'lab_holdout_fp': 5, 'lab_holdout_benign': 9,
    'cic_recall_pct': {'DoS Hulk': 100.0, 'DoS GoldenEye': 100.0},
    'cic_benign_fp_pct': {'Wednesday': 0.0, 'Friday': 0.25},
}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('datadir', help="docs/benchmarks/results/labelled-runs (the lab's own captures)")
    ap.add_argument('--wednesday-npz', required=True, dest='wednesday_npz')
    ap.add_argument('--friday-npz', required=True, dest='friday_npz')
    ap.add_argument('--cic-benign-anchor-cap', type=int, default=2000, dest='cic_benign_anchor_cap')
    ap.add_argument('--cic-benign-peek-cap', type=int, default=2000, dest='cic_benign_peek_cap')
    ap.add_argument('--cic-attack-train-cap', type=int, default=2000, dest='cic_attack_train_cap')
    ap.add_argument('--margin', type=float, default=tw.MARGIN)
    ap.add_argument('--lambda-weight', type=float, default=tw.LAMBDA, dest='lambda_weight')
    ap.add_argument('--beta-cic-benign', type=float, default=tsc.BETA_CIC_BENIGN_DEFAULT, dest='beta_cic_benign')
    ap.add_argument('--seed', type=int, default=42)
    ap.add_argument('--de-popsize', type=int, default=tw.DE_POPSIZE, dest='de_popsize')
    ap.add_argument('--de-maxiter', type=int, default=tw.DE_MAXITER, dest='de_maxiter')
    ap.add_argument('--out-weights', default=None, dest='out_weights')
    ap.add_argument('--out-json', default=None, dest='out_json')
    args = ap.parse_args()

    print('== batch 15 (option 3): jointly-fit gated two-sub-kernel detector, ONE unified model/threshold ==')
    print(f'architecture: {NUM_GATED_WEIGHTS} params (2x10 sub-kernel + {NUM_GATE_WEIGHTS} gate), bounds '
          f'{tw.BOUNDS[0]} (sub-kernels) / {GATE_BOUNDS} (gate)')
    print(f'pre-registered bar (must beat batch 13\'s ensemble AS A SINGLE MODEL): lab held-out detected >= '
          f'{LAB_HOLDOUT_DETECTED_BAR}/13 AND CIC Hulk/GoldenEye recall >= {CIC_RECALL_BAR_PCT:.0f}% each AND '
          f'CIC-benign FP <= {CIC_BENIGN_FP_BAR_PCT:.0f}% both days\n')

    # --- Load lab held-out + training split (identical to every prior batch).
    train_groups_lab, _attack_train_groups_lab, _attack_train_report_lab, holdout_lab = \
        tw.load_and_split(args.datadir, objective='margin')
    n_holdout_benign = sum(1 for h in holdout_lab if h['class'] == 'benign')
    n_holdout_attack = sum(1 for h in holdout_lab if h['class'] == 'attack')
    if (n_holdout_benign, n_holdout_attack) != (tsc.EXPECTED_LAB_HOLDOUT_BENIGN_RUNS, tsc.EXPECTED_LAB_HOLDOUT_ATTACK_RUNS):
        raise SystemExit(f'FATAL: lab held-out split is {n_holdout_benign} benign / {n_holdout_attack} attack runs, '
                          f'expected {tsc.EXPECTED_LAB_HOLDOUT_BENIGN_RUNS}/{tsc.EXPECTED_LAB_HOLDOUT_ATTACK_RUNS}.')
    print(f'lab held-out split: {n_holdout_benign} benign runs, {n_holdout_attack} attack runs\n')

    # --- CIC benign anchor + attack margin-training pool (same caps as batch 9/10, for direct comparability).
    print('== CIC benign anchor ==')
    cic_benign_anchor = {}
    cic_benign_peek = {}
    for day, npz_path in (('Wednesday', args.wednesday_npz), ('Friday', args.friday_npz)):
        anchor, peek, peek_src = tsc.load_npz_benign_split(npz_path, args.cic_benign_anchor_cap, args.cic_benign_peek_cap)
        cic_benign_anchor[day] = anchor
        cic_benign_peek[day] = (peek, peek_src)
        print(f'  {day:10s} anchor(train)={len(anchor)} windows   peek={len(peek)} windows')

    print('\n== CIC attack margin-training pool ==')
    attack_train_groups_cic = {}
    cic_train_src_ips = {}
    for label in tsc.CIC_TRAIN_LABELS:
        capped = tsc.capped_attack_bucket(args.wednesday_npz, label, args.cic_attack_train_cap)
        _f, _ep, src_ips = tsc.load_npz_bucket(args.wednesday_npz, label)
        attack_train_groups_cic[label] = [(f'cic-wed-{label.replace(" ", "-").lower()}-gated', capped)]
        cic_train_src_ips[label] = src_ips[:args.cic_attack_train_cap]
        print(f'  {label:20s} {len(capped)} windows')

    # --- Self-checks: fail loudly before fitting anything if this batch's own new arithmetic (gate_values,
    # gated_kernel_loss_batch, gated_sentinel_alerts) has drifted from either an independent reference or the real
    # scorer it must reduce to in the degenerate W_A==W_B case.
    print('\n== self-check: new arithmetic (gate_values, gated_kernel_loss_batch, gated_sentinel_alerts) ==')
    lab_sample_window = next(w[0] for runs in train_groups_lab.values() for _rid, w in runs if len(w))
    cic_sample_window = attack_train_groups_cic[tsc.CIC_TRAIN_LABELS[0]][0][1][0]
    tw.self_check(lab_sample_window.reshape(sr.WIN, 4))
    tw.self_check(cic_sample_window.reshape(sr.WIN, 4))
    self_check_gate_math(lab_sample_window)
    self_check_gate_math(cic_sample_window)
    self_check_gated_degenerate(lab_sample_window)
    self_check_gated_degenerate(cic_sample_window)
    baseline_w10 = np.array(sr.W, dtype=np.float32, copy=True)
    some_attack_frames = next(h['frames'] for h in holdout_lab if h['class'] == 'attack')
    self_check_gated_lab(some_attack_frames, baseline_w10, sr.BASE_TAU)
    # End-to-end degenerate-case self-check through the REAL tsc.score_cic_block (its own `kernel_loss_fn` hook,
    # added in batch 4, is exercised here for the first time with a genuinely different-shaped kernel).
    sample_feats, sample_src = attack_train_groups_cic[tsc.CIC_TRAIN_LABELS[0]][0][1], \
        cic_train_src_ips[tsc.CIC_TRAIN_LABELS[0]]
    w23_degenerate = np.concatenate([baseline_w10, baseline_w10, [2.0, -3.0, 0.5]]).astype(np.float32)
    real_cic = tsc.score_cic_block(sample_feats, sample_src, baseline_w10, sr.BASE_TAU,
                                    known_attacker_ip=tsc.KNOWN_ATTACKER_IP)
    gated_cic_degenerate = tsc.score_cic_block(sample_feats, sample_src, w23_degenerate, sr.BASE_TAU,
                                                known_attacker_ip=tsc.KNOWN_ATTACKER_IP,
                                                kernel_loss_fn=gated_kernel_loss_batch)
    if real_cic['alerts'] != gated_cic_degenerate['alerts']:
        raise SystemExit(f"FATAL: tsc.score_cic_block(kernel_loss_fn=gated_kernel_loss_batch) disagrees with the "
                          f"real score_cic_block in the degenerate W_A==W_B case ({gated_cic_degenerate['alerts']} "
                          f"vs {real_cic['alerts']} alerts).")
    print('ok: gate_values matches an independent loop-based reference; gated_kernel_loss_batch reduces to '
          'tw.kernel_loss_batch when W_A==W_B; gated_sentinel_alerts matches slr.sentinel_alerts and '
          'tsc.score_cic_block(kernel_loss_fn=...) matches the real score_cic_block in that same degenerate case\n')

    # --- Baseline reference point (both sub-kernels = the original hardcoded baseline, arbitrary gate) for an
    # objective-value sanity floor, same convention as every prior batch's "baseline hardcoded weights" print.
    objective = make_two_anchor_objective_gated(train_groups_lab, cic_benign_anchor, attack_train_groups_cic,
                                                 margin=args.margin, sigma=tw.SIGMA, lam=args.lambda_weight,
                                                 beta_cic_benign=args.beta_cic_benign)
    baseline_w23 = w23_degenerate
    baseline_train_loss = objective(baseline_w23)
    print(f'baseline (W_A=W_B=hardcoded, arbitrary gate) total objective value: {baseline_train_loss:.6f}')
    if not np.isfinite(baseline_train_loss):
        raise SystemExit(f'FATAL: baseline objective value is not finite ({baseline_train_loss}).')

    print(f'\n== fitting ({NUM_GATED_WEIGHTS} params) ==')
    print(f'hyperparameters: margin={args.margin} sigma={tw.SIGMA} lambda={args.lambda_weight} '
          f'beta_cic_benign={args.beta_cic_benign} de_popsize={args.de_popsize} de_maxiter={args.de_maxiter} '
          f'seed={args.seed}')
    t0 = time.monotonic()
    de = tw.differential_evolution(objective, BOUNDS_GATED, seed=args.seed, popsize=args.de_popsize,
                                    maxiter=args.de_maxiter, tol=tw.DE_TOL, polish=True, updating='deferred',
                                    workers=1)
    polished = tw.minimize(objective, de.x, method='Nelder-Mead', bounds=BOUNDS_GATED,
                            options={'xatol': 1e-8, 'fatol': 1e-12, 'maxiter': tw.POLISH_MAXITER,
                                     'maxfev': tw.POLISH_MAXITER})
    elapsed = time.monotonic() - t0
    trained_W = polished.x if polished.fun <= de.fun else de.x
    trained_loss = min(polished.fun, de.fun)
    print(f'differential_evolution: nfev={de.nfev} objective={de.fun:.6f}')
    print(f'Nelder-Mead polish:     nfev={polished.nfev} objective={polished.fun:.6f}')
    print(f'fitted in {elapsed:.1f}s')
    w_a, w_b, wg = trained_W[:10], trained_W[10:20], trained_W[20:23]
    print(f'trained W_A: {[round(float(x), 6) for x in w_a]}')
    print(f'trained W_B: {[round(float(x), 6) for x in w_b]}')
    print(f'trained gate (wg0_ln, wg1_pe, bias): {[round(float(x), 6) for x in wg]}')
    print(f'trained objective value: {trained_loss:.6f}  (baseline reference was {baseline_train_loss:.6f})')

    print('\n== sanity check 1: finite? ==')
    all_finite = np.isfinite(trained_loss) and np.all(np.isfinite(trained_W))
    print(f'all finite: {all_finite}')
    if not all_finite:
        raise SystemExit('FATAL: non-finite value in the fitted result.')

    print(f'\n== sanity check 2: any fitted weight pinned to its bound (within {tsc.BOUND_PIN_EPS}) ==')
    pinned = tsc.report_bound_proximity(trained_W, BOUNDS_GATED, eps=tsc.BOUND_PIN_EPS)
    if pinned:
        print(f'PINNED ({len(pinned)}/{NUM_GATED_WEIGHTS} weights):')
        for i, w, lo, hi in pinned:
            edge = 'lower' if abs(w - lo) < abs(w - hi) else 'upper'
            slot = 'W_A' if i < 10 else ('W_B' if i < 20 else 'gate')
            print(f'  index {i} ({slot}) = {w:.6f}  ({edge} bound, distance {min(abs(w - lo), abs(w - hi)):.6f})')
    else:
        print('none pinned')

    tr_lab, tr_cic, tr_margin = two_anchor_components_gated(train_groups_lab, cic_benign_anchor,
                                                             attack_train_groups_cic, trained_W,
                                                             margin=args.margin, sigma=tw.SIGMA)
    print('\n== sanity check 3: per-term values at the trained weights (never blended) ==')
    print(f'L_benign_lab={tr_lab:.6f}  L_benign_cic={tr_cic:.6f}  L_margin(raw hinge)={tr_margin:.6f}')

    train_losses_trained_W = []
    for _pattern, runs in train_groups_lab.items():
        for _rid, windows in runs:
            if len(windows):
                train_losses_trained_W.append(gated_kernel_loss_batch(windows, trained_W))
    train_losses_trained_W = np.concatenate(train_losses_trained_W)
    trained_tau = float(np.mean(train_losses_trained_W) + tw.SIGMA * np.std(train_losses_trained_W))
    print(f'\ncalibrated tau: mean={np.mean(train_losses_trained_W):.4f} std={np.std(train_losses_trained_W):.4f} '
          f'-> base_tau={trained_tau:.4f} (pooled over {len(train_losses_trained_W)} LAB training-benign windows)')

    # --- Gate diagnostics: does g actually differentiate CIC-shaped from lab-shaped windows? This is the mechanism
    # this whole architecture is betting on (a cheap, learned per-window context signal), reported honestly either
    # way -- a gate that never moves (always near 0 or always near 1) would mean the fit degenerated to using only
    # one sub-kernel, no better than a single 10-parameter kernel at double the cost.
    print('\n== gate behavior (diagnostic: does the gate differentiate CIC-shaped vs lab-shaped windows?) ==')
    lab_benign_pool = np.concatenate(
        [windows for runs in train_groups_lab.values() for _rid, windows in runs if len(windows)])
    gate_stats(lab_benign_pool, wg, 'lab-benign training pool')
    for label in tsc.CIC_TRAIN_LABELS:
        gate_stats(attack_train_groups_cic[label][0][1], wg, f'CIC {label} (training)')
    for day, anchor in cic_benign_anchor.items():
        gate_stats(anchor, wg, f'CIC-benign anchor ({day})')

    # --- Evaluation against the three core anchors (same sample bases as batch 10/13 for comparability) plus
    # batch 14's three out-of-sample CIC classes, for continuity.
    print('\n== EVALUATION: the three core anchors, this one unified model, ONE threshold ==')
    cic_recall = {}
    for label in tsc.CIC_TRAIN_LABELS:
        feats = attack_train_groups_cic[label][0][1]
        src_ips_f = cic_train_src_ips[label]
        res = tsc.score_cic_block(feats, src_ips_f, trained_W, trained_tau, known_attacker_ip=tsc.KNOWN_ATTACKER_IP,
                                   kernel_loss_fn=gated_kernel_loss_batch)
        recall_pct = 100 * res['alerts'] / res['n'] if res['n'] else 0.0
        cic_recall[label] = recall_pct
        print(f'  {label:20s} recall {tsc.pct(res["alerts"], res["n"])}')

    cic_fp = {}
    for day, (peek_feats, peek_src) in cic_benign_peek.items():
        res = tsc.score_cic_block(peek_feats, peek_src, trained_W, trained_tau,
                                   kernel_loss_fn=gated_kernel_loss_batch)
        fp_pct = 100 * res['alerts'] / res['n'] if res['n'] else 0.0
        cic_fp[day] = fp_pct
        print(f'  {day:10s} CIC-benign FP {tsc.pct(res["alerts"], res["n"])}')

    print('\n-- lab held-out (run-level) --')
    lab_result = gated_score_holdout(holdout_lab, trained_W, trained_tau, 'gated (single model)')

    print('\n== PRE-REGISTERED VERDICT (must beat batch 13\'s ensemble AS A SINGLE MODEL) ==')
    lab_ok = lab_result['detected'] >= LAB_HOLDOUT_DETECTED_BAR
    recall_ok = all(cic_recall[label] >= CIC_RECALL_BAR_PCT for label in tsc.CIC_TRAIN_LABELS)
    fp_ok = all(cic_fp[day] <= CIC_BENIGN_FP_BAR_PCT for day in cic_fp)
    print(f"  lab held-out detected: {lab_result['detected']}/13 "
          f"({'PASS' if lab_ok else 'FAIL'} >= {LAB_HOLDOUT_DETECTED_BAR}/13)  "
          f"[batch 13 ensemble: {BATCH13_ENSEMBLE['lab_holdout_detected']}/13]")
    for label in tsc.CIC_TRAIN_LABELS:
        print(f"  {label} recall: {cic_recall[label]:.2f}% "
              f"({'PASS' if cic_recall[label] >= CIC_RECALL_BAR_PCT else 'FAIL'} >= {CIC_RECALL_BAR_PCT:.0f}%)  "
              f"[batch 13 ensemble: {BATCH13_ENSEMBLE['cic_recall_pct'][label]:.2f}%]")
    for day in cic_fp:
        print(f"  {day} CIC-benign FP: {cic_fp[day]:.2f}% "
              f"({'PASS' if cic_fp[day] <= CIC_BENIGN_FP_BAR_PCT else 'FAIL'} <= {CIC_BENIGN_FP_BAR_PCT:.0f}%)  "
              f"[batch 13 ensemble: {BATCH13_ENSEMBLE['cic_benign_fp_pct'][day]:.2f}%]")
    overall = lab_ok and recall_ok and fp_ok
    print(f"\nOVERALL: {'GENUINE OPTION-3 CANDIDATE (beats batch 13 ensemble bar, as one model)' if overall else 'does NOT beat batch 13 ensemble bar as a single model'}")

    print('\n== BATCH 14 continuity: out-of-sample CIC classes (never in CIC_TRAIN_LABELS) ==')
    oos_sources = [(label, args.wednesday_npz) for label in tsc.CIC_HOLDOUT_WED_LABELS] + \
                  [(label, args.friday_npz) for label in tsc.CIC_HOLDOUT_FRI_LABELS]
    oos_results = {}
    for label, npz_path in oos_sources:
        feats, _epochs, src_ips = tsc.load_npz_bucket(npz_path, label)
        if len(feats) == 0:
            raise SystemExit(f"FATAL: out-of-sample bucket {label!r} in {npz_path} is empty.")
        res = tsc.score_cic_block(feats, src_ips, trained_W, trained_tau, known_attacker_ip=tsc.KNOWN_ATTACKER_IP,
                                   kernel_loss_fn=gated_kernel_loss_batch)
        pct_val = 100 * res['alerts'] / res['n']
        oos_results[label] = pct_val
        print(f'  {label:20s} n={res["n"]:6d}  recall {tsc.pct(res["alerts"], res["n"])}')

    if args.out_weights:
        payload = {
            'weights_shape': '23 = W_A(10) ++ W_B(10) ++ gate(wg0_ln, wg1_pe, bias)',
            'weights': [float(x) for x in trained_W],
            'tau': trained_tau,
            'objective': 'two-anchor-gated (batch 15, static hinge, same formula as batches 1-6, two sub-kernels '
                          'blended by a jointly-fit gate instead of one 10-parameter kernel)',
            'batch': 'sentinel-training-two-anchor batch 15 (option 3 prototype; NOT a validated or recommended '
                     'result)',
            'beta_cic_benign': args.beta_cic_benign,
            'margin_hyperparameters': {'margin': args.margin, 'sigma': tw.SIGMA, 'lambda': args.lambda_weight},
            'training_objective_value': float(trained_loss),
            'training_objective_components': {'L_benign_lab': tr_lab, 'L_benign_cic': tr_cic, 'L_margin_raw': tr_margin},
            'bound_pinned_weights': [{'index': i, 'value': w, 'lower': lo, 'upper': hi} for i, w, lo, hi in pinned],
            'seed': args.seed,
            'note': 'Fitted by scripts/train-sentinel-weights-gated.py. This is a batch-15 DESIGN-BATCH PROTOTYPE '
                    'on the batch-1 sanity-check data scale, not a held-out-validated result; not recommended for '
                    'gpu-sdn-anomaly-sentinel.py --weights-file / GPU_SENTINEL_WEIGHTS_FILE under any circumstance '
                    '(that script expects a 10-element weights shape and would reject this file outright).',
        }
        with open(args.out_weights, 'w') as fh:
            json.dump(payload, fh, indent=2)
            fh.write('\n')
        print(f'\nwrote {args.out_weights}')

    if args.out_json:
        payload = {
            'batch': 15,
            'architecture': '23-param jointly-fit gated two-sub-kernel detector (one model, one threshold)',
            'pre_registered_bar': {'lab_holdout_detected_gte': LAB_HOLDOUT_DETECTED_BAR,
                                    'cic_recall_gte_pct': CIC_RECALL_BAR_PCT,
                                    'cic_benign_fp_lte_pct': CIC_BENIGN_FP_BAR_PCT},
            'batch13_ensemble_for_comparison': BATCH13_ENSEMBLE,
            'result': {'lab_holdout': lab_result, 'cic_recall_pct': cic_recall, 'cic_benign_fp_pct': cic_fp},
            'verdict': {'lab_ok': lab_ok, 'recall_ok': recall_ok, 'fp_ok': fp_ok,
                        'beats_batch13_ensemble_as_single_model': overall},
            'out_of_sample_recall_pct': oos_results,
            'bound_pinned_weights': len(pinned),
        }
        with open(args.out_json, 'w') as fh:
            json.dump(payload, fh, indent=2)
            fh.write('\n')
        print(f'\nwrote {args.out_json}')


if __name__ == '__main__':
    main()
