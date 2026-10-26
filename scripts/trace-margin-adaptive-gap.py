#!/usr/bin/env python3
"""
scripts/trace-margin-adaptive-gap.py
======================================
The sentinel-training-two-anchor workstream's batch 6 addendum (docs/benchmarks/results/sentinel-training-two-anchor/
PREREGISTRATION.md) asked for ONE concrete, traced example of the gap that has shown up in batches 2, 3, and 5:
a training-time hinge of (near) zero -- "this attack window's loss comfortably clears target(W)" -- does not reliably
predict that the deployed-style Adaptive controller actually flags the window as anomalous. This is not an aggregate
table; it replays one CIC attack-training bucket's losses through a fresh sr.Adaptive(tau=...), in time order,
exactly as scripts/train-sentinel-weights-cic.py's score_cic_block does, and prints the controller's internal state
(running mean m, running std, the resulting ratcheted threshold) around the first window where the hinge is exactly
zero (loss > target(W)) but the Adaptive controller does not alert -- so the mechanism is visible, not just named.

Read-only: loads an existing, already-committed trained-weights JSON and an existing cached .npz bucket; does not
fit anything, does not modify any shared file.

Usage:
  python3 scripts/trace-margin-adaptive-gap.py \\
      docs/benchmarks/results/labelled-runs \\
      docs/benchmarks/results/sentinel-training-two-anchor/trained-weights-two-anchor-batch3-2026-10-24.json \\
      /tmp/cic-flood-margin-cache/wednesday.npz "DoS GoldenEye"
"""
import importlib.util
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


tw = _load('train_sentinel_weights', os.path.join(HERE, 'train-sentinel-weights.py'))
tc = _load('train_sentinel_weights_cic', os.path.join(HERE, 'train-sentinel-weights-cic.py'))
sr = tw.sr


def main():
    datadir, weights_path, npz_path, label = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    with open(weights_path) as fh:
        payload = json.load(fh)
    W, base_tau = tw.validate_weights_payload(payload, weights_path)
    print(f'Loaded {weights_path}: tau={base_tau:.6f}')

    train_groups_lab, _a, _r, _h = tw.load_and_split(datadir, objective='margin')
    pooled = tw.pooled_training_losses(train_groups_lab, W)
    margin = payload.get('margin_hyperparameters', {}).get('margin', tw.MARGIN)
    sigma = payload.get('margin_hyperparameters', {}).get('sigma', tw.SIGMA)
    benign_mean, benign_std = float(np.mean(pooled)), float(np.std(pooled))
    target = benign_mean + sigma * benign_std + margin
    print(f'Lab-benign pool under these weights: mean={benign_mean:.6f} std={benign_std:.6f}')
    print(f'target(W) = benign_mean + {sigma}*std + {margin} = {target:.6f}  '
          f'(a window with loss >= this has hinge=0, i.e. the TRAINING objective considers it well-separated)\n')

    feats, epochs, src_ips = tc.load_npz_bucket(npz_path, label)
    losses = tw.kernel_loss_batch(feats, W)
    print(f'{label}: {len(losses)} windows, time-ordered. loss min/mean/max = '
          f'{losses.min():.6f}/{losses.mean():.6f}/{losses.max():.6f}')
    n_clears_target = int(np.sum(losses >= target))
    print(f'{n_clears_target}/{len(losses)} windows clear target(W) (hinge=0) -- '
          f'{100*n_clears_target/len(losses):.2f}% "training says separated"\n')

    # Replay through a FRESH Adaptive, in time order, exactly as score_cic_block does, but keeping the full
    # per-window internal state (m, std, threshold, alert) instead of only the final alert count.
    ad = sr.Adaptive(tau=base_tau)
    trace = []
    for i, loss in enumerate(losses):
        m_before, v_before = ad.m, ad.v
        std_before = (max(1e-6, v_before)) ** 0.5
        threshold_before = max(ad.base, m_before + ad.s * std_before)
        is_anom, tau_used = ad.check(float(loss))
        trace.append({'i': i, 'loss': float(loss), 'm_before': m_before, 'std_before': std_before,
                      'threshold': threshold_before, 'alert': is_anom, 'clears_target': float(loss) >= target})

    n_alerts = sum(1 for t in trace if t['alert'])
    print(f'Adaptive(tau={base_tau:.4f}) window-level recall over this block: {n_alerts}/{len(trace)} '
          f'({100*n_alerts/len(trace):.2f}%) -- this matches score_cic_block\'s own number for this condition\n')

    # Find the gap: a window that clears target(W) (hinge=0) but the Adaptive controller does NOT alert on.
    gap = next((t for t in trace if t['clears_target'] and not t['alert']), None)
    if gap is None:
        print('No gap window found in this block (every window that cleared target(W) also alerted) -- '
              'try a different label/weights file.')
        return

    print(f"== Traced example: window #{gap['i']} ==")
    print(f"  loss = {gap['loss']:.6f}  (target(W) = {target:.6f} -- this window DOES clear target: "
          f"training-time hinge = {max(0.0, target - gap['loss']):.6f}, i.e. 0, 'well-separated')")
    print(f"  Adaptive's running threshold AT THIS WINDOW = {gap['threshold']:.6f} "
          f"(base_tau={base_tau:.6f}, running mean m={gap['m_before']:.6f}, running std={gap['std_before']:.6f}, "
          f"threshold = max(base_tau, m + {sigma}*std))")
    print(f"  {gap['loss']:.6f} < {gap['threshold']:.6f}  ->  Adaptive does NOT alert on this window, despite it "
          f"clearing the static training-time target by {gap['loss'] - target:.6f}.")
    print(f"  Mechanism: the running threshold ({gap['threshold']:.6f}) is HIGHER than the static target(W) "
          f"({target:.6f}) by {gap['threshold'] - target:.6f} at this point in the sequence -- it ratcheted up from "
          f"earlier windows in this same block, not from this window itself.\n")

    print('Last 10 windows before the traced example (showing the ratchet building up):')
    start = max(0, gap['i'] - 10)
    for t in trace[start:gap['i'] + 1]:
        marker = ' <== traced example' if t['i'] == gap['i'] else ''
        print(f"  #{t['i']:5d}  loss={t['loss']:.6f}  clears_target={t['clears_target']!s:5s}  "
              f"running_threshold_before={t['threshold']:.6f}  alert={t['alert']!s:5s}{marker}")

    print('\nFor context, the very first 5 windows of this block (showing the Adaptive controller\'s starting state):')
    for t in trace[:5]:
        print(f"  #{t['i']:5d}  loss={t['loss']:.6f}  clears_target={t['clears_target']!s:5s}  "
              f"running_threshold_before={t['threshold']:.6f}  alert={t['alert']!s:5s}")


if __name__ == '__main__':
    main()
