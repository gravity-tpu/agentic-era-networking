#!/usr/bin/env python3
"""
scripts/train-sentinel-weights-cic.py
=======================================
This round's margin training: the same hinge/margin objective PR #106 introduced
(scripts/train-sentinel-weights.py --objective margin), refit with CIC-IDS2017 flood-attack windows
(scripts/cic-flood-margin-sampler.py's output) instead of this lab's own 8-run flood set, while keeping the benign
side of the objective anchored to this lab's own traffic, unchanged. Exact scope, split, sample caps and the
improvement rule are fixed in docs/benchmarks/results/sentinel-training-margin-cic/PREREGISTRATION.md, written
before this script was run or any held-out/CIC number was looked at.

Does not reimplement anything it can reuse:
  - scripts/train-sentinel-weights.py: load_and_split (lab benign/held-out split), make_margin_objective,
    kernel_loss_batch, pooled_training_losses, margin_target, self_check, score_holdout, validate_weights_payload,
    BOUNDS/SIGMA/DE_* hyperparameters - imported as a module, not copied.
  - scripts/cic-flood-margin-sampler.py's .npz output (raw per-window features + epoch + majority source IP for
    each capped CIC bucket).
  - scripts/sentinel-replay.py's Adaptive controller, for the CIC-block evaluation (axis b/c below).

Usage:
  python3 scripts/train-sentinel-weights-cic.py docs/benchmarks/results/labelled-runs \\
      --wednesday-npz /tmp/cic-flood-margin-cache/wednesday.npz --friday-npz /tmp/cic-flood-margin-cache/friday.npz \\
      --pr105-weights docs/benchmarks/results/sentinel-training/trained-weights-2026-10-23.json \\
      --pr106-weights docs/benchmarks/results/sentinel-training-margin/trained-weights-margin-2026-10-23.json \\
      --out-weights docs/benchmarks/results/sentinel-training-margin-cic/trained-weights-margin-cic-<date>.json

Needs numpy and scipy, same as scripts/train-sentinel-weights.py.
"""
import argparse
import importlib.util
import json
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


tw = _load('train_sentinel_weights', os.path.join(HERE, 'train-sentinel-weights.py'))
sr = tw.sr          # the single shared sentinel-replay module instance tw/slr/score_holdout all close over
slr = tw.slr

# --- Fixed by docs/benchmarks/results/sentinel-training-margin-cic/PREREGISTRATION.md: do not tune against results.
CIC_TRAIN_LABELS = ('DoS Hulk', 'DoS GoldenEye')                           # Wednesday, margin-training attack side
CIC_HOLDOUT_WED_LABELS = ('DoS Slowhttptest', 'DoS slowloris')            # Wednesday, held-out (different mechanism)
CIC_HOLDOUT_FRI_LABELS = ('DDoS',)                                        # Friday, held-out (different day/tool)
KNOWN_ATTACKER_IP = '172.16.0.1'  # every in-scope CIC DoS/DDoS class; verified in cic-ids2017-adapter/README.md
TRAIN_CAP_PER_CLASS = 20_000  # must match the --bucket caps scripts/cic-flood-margin-sampler.py was run with for
# CIC_TRAIN_LABELS (PREREGISTRATION.md's "Sample-size caps" section); checked below, not just assumed, since a
# silently under-filled margin-training bucket would change the objective's sample size without any error.
EXPECTED_LAB_HOLDOUT_BENIGN_RUNS = 9   # PR #106's own published reduced holdout, reused unchanged for axis (a)
EXPECTED_LAB_HOLDOUT_ATTACK_RUNS = 13  # continuity (4 port-scan patterns/10 runs + attack-synflood-1000pps/3 runs)
WINDOW_FEATURES = sr.WIN * 4  # one flattened window: WIN=64 packets x 4 features each; derived, not re-literalized,
# so a future change to the window size or feature count can't silently desync this script's array shapes from
# scripts/sentinel-replay.py's own Extractor.


def load_npz_bucket(npz_path, label):
    """Returns (features (N,WINDOW_FEATURES) float32, epochs (N,) float64, src_ips (N,) str) for one bucket in a
    cic-flood-margin-sampler.py .npz file, or all-empty arrays if that label was never requested/collected."""
    with np.load(npz_path, allow_pickle=True) as z:
        key = label.replace(' ', '_')
        if f'{key}__features' not in z:
            return (np.zeros((0, WINDOW_FEATURES), dtype=np.float32), np.zeros((0,), dtype=np.float64),
                    np.zeros((0,), dtype=object))
        feats = z[f'{key}__features'].astype(np.float32)
        epochs = z[f'{key}__epochs'].astype(np.float64)
        src_ips = z[f'{key}__src_ips']
        order = np.argsort(epochs, kind='stable')  # stable: preserves the sampler's own time-order on any tied
        # epochs (two windows ending in the same wall-clock second), rather than letting an unstable sort silently
        # reorder them and perturb the Adaptive EMA trajectory below, which depends on processing order.
        return feats[order], epochs[order], src_ips[order]


def pct(numerator, denominator):
    """Formats numerator/denominator as a percentage string for display only. Never called on a value that feeds
    back into a decision (the Adaptive threshold check, the weak-Pareto verdict, or anything written to the fitted
    weights JSON) - every one of those reads the integer numerator/denominator pair directly. This keeps the
    float-division Invariant 2 is about (packet accounting, byte rates, SLA tracking) out of this reporting path:
    the counters themselves (alerts, n, named_correct) are plain Python/numpy ints end to end; only this print-time
    string ever divides them."""
    return 'n/a (0 windows)' if denominator == 0 else f'{100 * numerator / denominator:.2f}%'


def score_cic_block(features, src_ips, W, base_tau, known_attacker_ip=None):
    """Axis (b)/(c) scorer: feeds `features` (one capped CIC bucket, already time-ordered) through
    kernel_loss_batch(_, W) then a FRESH sr.Adaptive(tau=base_tau), in order - the same per-capture-reset semantics
    scripts/score-labelled-runs.py's sentinel_alerts() already uses per lab run (a lab run is itself a short,
    independently-reset capture, not a sample of one always-on stream; treating a CIC block the same way is the same
    semantics, not a new one - see PREREGISTRATION.md). Returns integer counts only - n, alerts, and (if
    known_attacker_ip is given) named_correct (of the alerting windows, how many had that majority source IP); rates
    are never stored here, only ever computed from these counts at print time via pct() above."""
    n = len(features)
    if n == 0:
        return {'n': 0, 'alerts': 0, 'named_correct': None}
    losses = tw.kernel_loss_batch(features, np.asarray(W, dtype=np.float32))
    ad = sr.Adaptive(tau=base_tau)
    alert_flags = np.array([ad.check(float(loss))[0] for loss in losses], dtype=bool)
    alerts = int(alert_flags.sum())
    result = {'n': n, 'alerts': alerts}
    if known_attacker_ip is not None:
        result['named_correct'] = int(np.sum(src_ips[alert_flags] == known_attacker_ip)) if alerts else 0
    return result


def print_cic_row(label, label_text, result, is_attack):
    if result['n'] == 0:
        print(f'  {label_text:34s} {label:10s} (0 windows collected - skipped)')
        return
    if is_attack:
        named_correct = result.get('named_correct')
        extra = '' if named_correct is None or result['alerts'] == 0 else \
            f"  attacker-IP agreement (of alerts) {named_correct}/{result['alerts']} ({pct(named_correct, result['alerts'])})"
        print(f"  {label_text:34s} {label:10s} n={result['n']:6d}  window-level recall (alert rate) "
              f"{result['alerts']}/{result['n']} ({pct(result['alerts'], result['n'])}){extra}")
    else:
        print(f"  {label_text:34s} {label:10s} n={result['n']:6d}  window-level false-positive rate "
              f"{result['alerts']}/{result['n']} ({pct(result['alerts'], result['n'])})")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('datadir', help='docs/benchmarks/results/labelled-runs (the lab\'s own captures)')
    ap.add_argument('--wednesday-npz', required=True, help='scripts/cic-flood-margin-sampler.py output for Wednesday')
    ap.add_argument('--friday-npz', required=True, help='scripts/cic-flood-margin-sampler.py output for Friday')
    ap.add_argument('--pr105-weights', required=True, help='docs/benchmarks/results/sentinel-training/trained-weights-*.json')
    ap.add_argument('--pr106-weights', required=True, help='docs/benchmarks/results/sentinel-training-margin/trained-weights-margin-*.json')
    ap.add_argument('--margin', type=float, default=tw.MARGIN)
    ap.add_argument('--lambda-weight', type=float, default=tw.LAMBDA, dest='lambda_weight')
    ap.add_argument('--seed', type=int, default=tw.DE_SEED)
    ap.add_argument('--out-weights', default=None)
    args = ap.parse_args()

    # --- Lab side: benign training pool and the identical reduced held-out split PR #106 published against, reused
    # unchanged via load_and_split(objective="margin"). attack_train_groups_lab/attack_train_report_lab here are the
    # lab's OWN flood runs (attack-synflood-200pps, attack-udpflood-500pps-1400b) - this round does NOT train on them
    # (see PREREGISTRATION.md: CIC data replaces them for the margin term). They are not read again after the shape
    # assertion just below; what WAS PR #106's training set is, for this round, simply part of the untouched lab-side
    # ecosystem this script does not otherwise touch.
    train_groups_lab, attack_train_groups_lab, attack_train_report_lab, holdout_lab = \
        tw.load_and_split(args.datadir, objective='margin')
    n_train_runs = sum(len(v) for v in train_groups_lab.values())
    n_train_windows = sum(len(w) for runs in train_groups_lab.values() for _rid, w in runs)
    print('== lab benign training pool (unchanged from PR #105/#106) ==')
    print(f'{len(train_groups_lab)} patterns, {n_train_runs} runs, {n_train_windows} windows')
    # Actually confirm holdout_lab has PR #106's own published reduced-holdout shape (not just claim to without
    # checking): this is what axis (a)'s "continuity with PR #106" claim depends on, and a catalog drift (a label
    # added/removed from docs/benchmarks/results/labelled-runs since PR #106 ran) would otherwise silently change
    # axis (a)'s denominator without any error.
    n_holdout_benign = sum(1 for h in holdout_lab if h['class'] == 'benign')
    n_holdout_attack = sum(1 for h in holdout_lab if h['class'] == 'attack')
    if (n_holdout_benign, n_holdout_attack) != (EXPECTED_LAB_HOLDOUT_BENIGN_RUNS, EXPECTED_LAB_HOLDOUT_ATTACK_RUNS):
        raise SystemExit(f'FATAL: lab held-out split is {n_holdout_benign} benign / {n_holdout_attack} attack runs, '
                          f'expected {EXPECTED_LAB_HOLDOUT_BENIGN_RUNS}/{EXPECTED_LAB_HOLDOUT_ATTACK_RUNS} (PR #106\'s '
                          f'own published split) - the labelled-runs catalog has drifted since PR #106 ran, so axis '
                          f'(a)\'s "continuity" claim no longer holds against the same denominator. Fix the expected '
                          f'counts (and re-check continuity with PR #106\'s own numbers) rather than ignore this.')
    assert len(attack_train_groups_lab) == 2 and len(attack_train_report_lab) == 5, \
        'lab flood-attack catalog (attack-synflood-200pps, attack-udpflood-500pps-1400b) has drifted from what ' \
        'PR #106 trained on; this round deliberately does not use it, but a silent catalog change here would mean ' \
        'the untouched lab-side ecosystem this comment claims is untouched, isn\'t.'

    # --- CIC side: load the sampler's capped buckets.
    print('\n== CIC attack-training pool (margin term; replaces the lab\'s flood runs for this round) ==')
    attack_train_groups_cic = {}
    cic_train_src_ips = {}
    for label in CIC_TRAIN_LABELS:
        feats, epochs, src_ips = load_npz_bucket(args.wednesday_npz, label)
        attack_train_groups_cic[label] = [(f'cic-wed-{label.replace(" ", "-").lower()}', feats)]
        cic_train_src_ips[label] = src_ips
        print(f'  {label:20s} {len(feats)} windows (cap was {TRAIN_CAP_PER_CLASS})')
    missing = [l for l in CIC_TRAIN_LABELS if len(attack_train_groups_cic[l][0][1]) == 0]
    if missing:
        raise SystemExit(f'FATAL: expected CIC margin-training labels not found or empty: {missing}')
    under_cap = {l: len(attack_train_groups_cic[l][0][1]) for l in CIC_TRAIN_LABELS
                 if len(attack_train_groups_cic[l][0][1]) < TRAIN_CAP_PER_CLASS}
    if under_cap:
        # Unlike a held-out bucket (where under-filling is an expected, disclosed outcome for a rare class - see
        # PREREGISTRATION.md and scripts/cic-flood-margin-sampler.py's own under-cap warning), a margin-TRAINING
        # bucket coming back under its pre-registered cap silently shrinks the objective's sample size - fail loudly
        # rather than fit on fewer windows than this round's own pre-registration specifies without saying so.
        raise SystemExit(f'FATAL: CIC margin-training bucket(s) under the pre-registered cap of '
                          f'{TRAIN_CAP_PER_CLASS}: {under_cap}. Re-run scripts/cic-flood-margin-sampler.py (these '
                          f'classes have far more natural availability than the cap - see PREREGISTRATION.md - so '
                          f'this means the sampler was mis-run, not that the class is naturally this small).')

    print('\n== CIC held-out pools (never read by training or threshold calibration) ==')
    cic_holdout_blocks = {}  # label -> (features, epochs, src_ips, is_attack)
    for label in CIC_HOLDOUT_WED_LABELS:
        cic_holdout_blocks[label] = load_npz_bucket(args.wednesday_npz, label) + (True,)
    for label in CIC_HOLDOUT_FRI_LABELS:
        cic_holdout_blocks[label] = load_npz_bucket(args.friday_npz, label) + (True,)
    cic_holdout_blocks['CIC-Wed-Benign'] = load_npz_bucket(args.wednesday_npz, 'BENIGN') + (False,)
    cic_holdout_blocks['CIC-Fri-Benign'] = load_npz_bucket(args.friday_npz, 'BENIGN') + (False,)
    for label, (feats, _ep, _src, is_attack) in cic_holdout_blocks.items():
        kind = 'attack' if is_attack else 'benign (generalization check)'
        print(f'  {label:20s} {kind:32s} {len(feats)} windows')

    # self_check (reused unmodified from scripts/train-sentinel-weights.py) already checks kernel_loss_batch against
    # sr.kernel_loss at 8 points in weight-space (the compiled-in default, both BOUNDS corners, 5 random interior
    # points) for whichever single window it is given - run it once against a real LAB window (as PR #105/#106 did)
    # and once against a real CIC window, since this round is the first to ever feed CIC-sourced feature vectors
    # through kernel_loss_batch and a batch-axis/broadcasting bug specific to that data's value distribution would
    # not be caught by a lab-only sample.
    lab_sample_window = next(w[0] for runs in train_groups_lab.values() for _rid, w in runs
                             if len(w)).reshape(sr.WIN, 4)
    tw.self_check(lab_sample_window)
    cic_sample_window = attack_train_groups_cic[CIC_TRAIN_LABELS[0]][0][1][0].reshape(sr.WIN, 4)
    tw.self_check(cic_sample_window)
    print('\nself-check: kernel_loss_batch matches sr.kernel_loss on a real lab window and a real CIC window (ok)')

    objective = tw.make_margin_objective(train_groups_lab, attack_train_groups_cic,
                                          margin=args.margin, sigma=tw.SIGMA, lam=args.lambda_weight)
    baseline_W = np.array(sr.W, dtype=np.float32, copy=True)
    baseline_target = tw.margin_target(train_groups_lab, baseline_W, margin=args.margin, sigma=tw.SIGMA)
    print(f'\n== fitting ({len(tw.BOUNDS)} params, bounds {tw.BOUNDS[0]} for all) ==')
    print(f'margin hyperparameters: margin={args.margin} sigma={tw.SIGMA} lambda={args.lambda_weight}')
    print(f'baseline hardcoded weights\' hinge target: {baseline_target:.4f}')
    baseline_train_loss = objective(baseline_W)
    print(f'baseline hardcoded weights\' training-objective value: {baseline_train_loss:.6f}')

    t0 = time.monotonic()
    de = tw.differential_evolution(objective, tw.BOUNDS, seed=args.seed, popsize=tw.DE_POPSIZE, maxiter=tw.DE_MAXITER,
                                    tol=tw.DE_TOL, polish=True, updating='deferred', workers=1)
    polished = tw.minimize(objective, de.x, method='Nelder-Mead', bounds=tw.BOUNDS,
                            options={'xatol': 1e-8, 'fatol': 1e-12, 'maxiter': tw.POLISH_MAXITER,
                                     'maxfev': tw.POLISH_MAXITER})
    elapsed = time.monotonic() - t0
    trained_W = polished.x if polished.fun <= de.fun else de.x
    trained_loss = min(polished.fun, de.fun)
    print(f'differential_evolution: nfev={de.nfev} objective={de.fun:.6f}')
    print(f'Nelder-Mead polish:     nfev={polished.nfev} objective={polished.fun:.6f}')
    print(f'fitted in {elapsed:.1f}s')
    print(f'trained weights: {[round(float(x), 6) for x in trained_W]}')
    print(f'trained training-objective value: {trained_loss:.6f}  (baseline was {baseline_train_loss:.6f})')

    train_losses_trained_W = tw.pooled_training_losses(train_groups_lab, trained_W)
    trained_tau = float(np.mean(train_losses_trained_W) + tw.SIGMA * np.std(train_losses_trained_W))
    print(f'calibrated tau for trained weights: mean={np.mean(train_losses_trained_W):.4f} '
          f'std={np.std(train_losses_trained_W):.4f} -> base_tau={trained_tau:.4f} '
          f'(pooled over {len(train_losses_trained_W)} LAB training-benign windows only, never CIC benign)')

    with open(args.pr105_weights) as fh:
        pr105_W, pr105_tau = tw.validate_weights_payload(json.load(fh), args.pr105_weights)
    with open(args.pr106_weights) as fh:
        pr106_W, pr106_tau = tw.validate_weights_payload(json.load(fh), args.pr106_weights)

    conditions = [
        ('baseline', baseline_W, sr.BASE_TAU),
        ('PR105 (benign-only)', pr105_W, pr105_tau),
        ('PR106 (lab-margin)', pr106_W, pr106_tau),
        ('this round (CIC-margin)', trained_W, trained_tau),
    ]

    print('\n== axis (a): lab held-out split (identical to PR #106\'s own 9-benign/13-attack reduced holdout) ==')
    lab_results = {}
    try:
        for label, W, tau in conditions:
            sr.W = np.asarray(W, dtype=np.float32)
            lab_results[label] = tw.score_holdout(holdout_lab, W, tau, label)
    finally:
        sr.W = baseline_W

    print('\n== axis (b): CIC held-out flood windows (window-level recall; different granularity than axis (a), not merged into it) ==')
    cic_attack_results = {}  # condition_label -> {cic_label: result}
    for label, W, tau in conditions:
        cic_attack_results[label] = {}
        print(f'-- {label} (tau={tau:.4f}) --')
        for cic_label in (*CIC_HOLDOUT_WED_LABELS, *CIC_HOLDOUT_FRI_LABELS):
            feats, _ep, src_ips, _is_attack = cic_holdout_blocks[cic_label]
            res = score_cic_block(feats, src_ips, W, tau, known_attacker_ip=KNOWN_ATTACKER_IP)
            cic_attack_results[label][cic_label] = res
            print_cic_row(cic_label, 'held-out attack', res, is_attack=True)

    print('\n== axis (b), training-performance context: the 2 CIC classes the margin term DID train on (NOT held out; reported for transparency, not the headline) ==')
    cic_train_perf = {}
    for label, W, tau in conditions:
        cic_train_perf[label] = {}
        print(f'-- {label} (tau={tau:.4f}) --')
        for cic_label in CIC_TRAIN_LABELS:
            feats_arr = attack_train_groups_cic[cic_label][0][1]
            src_ips_f = cic_train_src_ips[cic_label]
            res = score_cic_block(feats_arr, src_ips_f, W, tau, known_attacker_ip=KNOWN_ATTACKER_IP)
            cic_train_perf[label][cic_label] = res
            print_cic_row(cic_label, 'margin-training (not held out)', res, is_attack=True)

    print('\n== axis (c): CIC-benign generalization check (false-positive rate on a different organization\'s ordinary traffic; never trained on or used for tau calibration) ==')
    cic_benign_results = {}
    for label, W, tau in conditions:
        cic_benign_results[label] = {}
        print(f'-- {label} (tau={tau:.4f}) --')
        for cic_label in ('CIC-Wed-Benign', 'CIC-Fri-Benign'):
            feats, _ep, src_ips, _is_attack = cic_holdout_blocks[cic_label]
            res = score_cic_block(feats, src_ips, W, tau, known_attacker_ip=None)
            cic_benign_results[label][cic_label] = res
            print_cic_row(cic_label, 'CIC-benign generalization', res, is_attack=False)

    print('\n== head-to-head summaries ==')
    print('-- axis (a), lab held-out (run-level) --')
    for label, _W, _tau in conditions:
        r = lab_results[label]
        print(f"  {label:26s} {r['detected']}/{r['attacks']} attacks detected, {r['falsePositives']}/{r['benign']} benign false positives")

    def verdict(trained_r, ref_r, trained_label, ref_label, axis):
        hit_ok = trained_r['detected'] >= ref_r['detected']
        fp_ok = trained_r['falsePositives'] <= ref_r['falsePositives']
        strict = trained_r['detected'] > ref_r['detected'] or trained_r['falsePositives'] < ref_r['falsePositives']
        v = 'IMPROVEMENT (weak Pareto)' if (hit_ok and fp_ok and strict) else 'NOT a clear improvement'
        print(f'  [{axis}] this round vs. {ref_label}: {v}')

    for ref_label in ('baseline', 'PR105 (benign-only)', 'PR106 (lab-margin)'):
        verdict(lab_results['this round (CIC-margin)'], lab_results[ref_label], 'this round', ref_label, 'axis a')

    print('\n-- axis (b)+(c) pairing: CIC held-out recall vs. CIC-benign false-positive rate --')
    for cic_label in (*CIC_HOLDOUT_WED_LABELS, *CIC_HOLDOUT_FRI_LABELS):
        print(f'  {cic_label}:')
        for label, _W, _tau in conditions:
            res = cic_attack_results[label][cic_label]
            print(f"    {label:26s} recall {pct(res['alerts'], res['n'])}")
    for cic_label in ('CIC-Wed-Benign', 'CIC-Fri-Benign'):
        print(f'  {cic_label} (false-positive rate):')
        for label, _W, _tau in conditions:
            res = cic_benign_results[label][cic_label]
            print(f"    {label:26s} FP rate {pct(res['alerts'], res['n'])}")

    if args.out_weights:
        payload = {
            'weights': [float(x) for x in trained_W],
            'tau': trained_tau,
            'objective': 'margin-cic',
            'trained_on_patterns': {
                'benign': sorted(tw.TRAIN_BENIGN_PATTERNS),
                'attack_cic_margin_term': {label: len(attack_train_groups_cic[label][0][1]) for label in CIC_TRAIN_LABELS},
            },
            'held_out_patterns': {
                'benign_lab': sorted(tw.HOLDOUT_BENIGN_PATTERNS),
                'attack_lab': sorted({h['pattern'] for h in holdout_lab if h['class'] == 'attack'}),
                'attack_cic': {label: len(cic_holdout_blocks[label][0]) for label in (*CIC_HOLDOUT_WED_LABELS, *CIC_HOLDOUT_FRI_LABELS)},
                'benign_cic_generalization_check': {label: len(cic_holdout_blocks[label][0]) for label in ('CIC-Wed-Benign', 'CIC-Fri-Benign')},
            },
            'seed': args.seed,
            'training_objective_value': trained_loss,
            'margin_hyperparameters': {'margin': args.margin, 'sigma': tw.SIGMA, 'lambda': args.lambda_weight},
            'note': 'Fitted by scripts/train-sentinel-weights-cic.py; see '
                    'docs/benchmarks/results/sentinel-training-margin-cic/ for methodology and held-out validation '
                    'before using this in gpu-sdn-anomaly-sentinel.py (--weights-file / GPU_SENTINEL_WEIGHTS_FILE, '
                    'opt-in only).',
        }
        with open(args.out_weights, 'w') as fh:
            json.dump(payload, fh, indent=2)
            fh.write('\n')
        print(f'\nwrote {args.out_weights}')


if __name__ == '__main__':
    main()
