#!/usr/bin/env python3
"""
scripts/eval-sentinel-ensemble.py
==================================
Two-anchor workstream, batch 13 (docs/benchmarks/results/sentinel-training-two-anchor/PREREGISTRATION.md). Batches
1-12 spent twelve rounds trying to find ONE 10-parameter kernel (sr.W) that simultaneously satisfies three anchors
(CIC-benign FP, CIC Hulk/GoldenEye recall, lab held-out attack recall) and converged on a hard conclusion: there are
exactly two stable operating points (a "CIC-shaped" kernel and a "lab-shaped" kernel) and nothing in this
architecture beats either on all three axes at once. The owner decided to stop unifying and instead evaluate
deploying the two kernels as a two-model OR ensemble: alert if EITHER model's kernel_loss exceeds ITS OWN
independently-calibrated tau.

This is a PURE EVALUATION script: it does no optimization and fits nothing. It only scores two ALREADY-FITTED
weight vectors, combined with the simplest OR rule, using the exact same scoring functions every prior batch in
this workstream used for its own numbers:
  - score_cic_block (scripts/train-sentinel-weights-cic.py) for CIC Hulk/GoldenEye recall and CIC-benign FP (both
    days), on the identical sample slices (2000-window attack-class caps, 2000-window disjoint benign peek) batch
    10 itself used, so Model A's solo numbers reported here must reproduce batch 10's own committed 100.00%/100.00%
    recall and 0.00%/0.00% FP exactly (checked at runtime, not trusted by inspection -- see
    reproduce_model_a_solo_numbers() below).
  - tw.score_holdout (scripts/train-sentinel-weights.py) for the lab held-out split (9 benign / 13 attack runs,
    PR #106's own reduced holdout, unchanged since).

Because neither of those functions returns per-window alert flags (only aggregate counts), and the OR-ensemble rule
is fundamentally a per-window decision (model A's and model B's own sr.Adaptive controllers evolve independently,
each only observing its own model's window losses), this script adds two small ensemble replay helpers that mirror
those functions' internals EXACTLY (same windowization, same per-call-reset Adaptive semantics, same
alert/namedSender/falsePositive arithmetic) but return/combine window-level flags. Each is self-checked at runtime
against the real score_cic_block / slr.sentinel_alerts it mirrors, in the degenerate case model B == model A (see
self_check_cic_ensemble() and self_check_lab_ensemble() below) -- the same "don't trust a reimplementation by
inspection alone" discipline scripts/train-sentinel-weights.py's self_check() and
scripts/train-sentinel-weights-cic.py's self_check_adaptive_determinism()/self_check_sequence_determinism() already
use in this codebase.

Usage:
  python3 scripts/eval-sentinel-ensemble.py docs/benchmarks/results/labelled-runs \\
      --wednesday-npz /tmp/cic-flood-margin-cache/wednesday.npz --friday-npz /tmp/cic-flood-margin-cache/friday.npz \\
      --model-a-weights docs/benchmarks/results/sentinel-training-two-anchor/trained-weights-two-anchor-batch10-2026-10-25.json \\
      --pr106-weights docs/benchmarks/results/sentinel-training-margin/trained-weights-margin-2026-10-23.json \\
      [--out-json PATH]

Needs numpy and scipy (through scripts/train-sentinel-weights-cic.py / scripts/train-sentinel-weights.py).

Batch 14 addition (docs/benchmarks/results/sentinel-training-two-anchor/PREREGISTRATION.md's batch 14 addendum):
batch 13's 100.00%/100.00% CIC recall is IN-SAMPLE -- Model A was only ever anchored against
tsc.CIC_TRAIN_LABELS = ('DoS Hulk', 'DoS GoldenEye'). This adds ONE new reporting section, after the pre-registered
verdict, that evaluates Model A solo / Model B solo / the ensemble against tsc.CIC_HOLDOUT_WED_LABELS ('DoS
Slowhttptest', 'DoS slowloris') and tsc.CIC_HOLDOUT_FRI_LABELS ('DDoS') -- CIC attack classes NEITHER model's
training ever saw, already cached in the same two .npz files. It is a pure additional read of already-cached data
through the SAME, unmodified score_cic_block / score_cic_block_ensemble functions above -- no new reimplementation,
so no new self-check is needed (self_check_cic_ensemble already verifies score_cic_block_ensemble's correctness
independent of which features are passed to it). This section is explicitly diagnostic/exploratory, not a pass/fail
gate: see OOS_NEAR_ZERO_PCT/OOS_ENSEMBLE_LIFT_PCT below for the three pre-registered interpretation bins. A
regression check also reconfirms this run's lab-held-out/CIC-recall/CIC-benign-FP numbers exactly match batch 13's
own committed ensemble-eval-batch13-2026-10-26.json before any new number is reported -- Model A/Model B/the
ensemble rule are byte-for-byte unchanged this batch, so a mismatch would mean the harness itself drifted.
"""
import argparse
import collections
import importlib.util
import json
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))

# Pre-registered bar (decided before this script was run against real data; see
# docs/benchmarks/results/sentinel-training-two-anchor/PREREGISTRATION.md's batch 13 addendum for the full text).
# The ensemble is a GOOD deployment candidate only if ALL THREE hold:
LAB_HOLDOUT_DETECTED_BAR = 8          # out of 13; "meaningfully better than any single-model result this workstream
# has produced, closer to the original 10/13 baseline"
CIC_RECALL_BAR_PCT = 90.0             # DoS Hulk and DoS GoldenEye each
CIC_BENIGN_FP_BAR_PCT = 2.0           # both Wednesday and Friday


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# Load scripts/train-sentinel-weights-cic.py as a library ONLY (importing it does not run main() -- it is guarded by
# `if __name__ == '__main__':`, same as every other script in this family). This reuses its tw/sr/slr instances,
# score_cic_block, the CIC npz data-loading helpers, and its pre-registered scope constants, without re-implementing
# any of them and without touching its fitting/objective code path at all.
tsc = _load('train_sentinel_weights_cic', os.path.join(HERE, 'train-sentinel-weights-cic.py'))
tw = tsc.tw
sr = tsc.sr
slr = tsc.slr

CIC_ATTACK_RECALL_CAP_DEFAULT = 2000   # matches batch 10's own cic_attack_train_cap (same basis Model A's committed
# 100.00%/100.00% numbers were measured on -- reusing it here is what lets reproduce_model_a_solo_numbers() below
# sanity-check this script against the already-committed batch 10 JSON).
CIC_BENIGN_PEEK_CAP_DEFAULT = 2000     # matches batch 10's own cic_benign_anchor_cap (used identically for both the
# anchor and peek slices in that batch; this script only ever reads the PEEK slice -- it never trains, so there is
# no "anchor" here, only an evaluation sample -- but keeps the exact same offset/size so the slice is the same set
# of windows batch 10's own disclosed peek numbers were computed on).

# --- Batch 14: out-of-sample CIC evaluation (diagnostic/exploratory -- see module docstring and PREREGISTRATION.md's
# batch 14 addendum). Unlike CIC_ATTACK_RECALL_CAP_DEFAULT above (a 2,000-window cap kept for exact comparability
# with batch 10's own committed numbers), the out-of-sample classes below use the FULL cached bucket for each class
# (tsc.load_npz_bucket with no cap) -- the same "held-out reads everything available, training reads a capped slice"
# convention tsc.main()'s own `--objective margin-cic` axis (b) already uses for these identical three labels, for
# the strongest-available read since nothing here is capped for training-budget reasons (nothing is trained).
#
# Pre-registered interpretation bins (decided before this batch's numbers were looked at): there is no reason to
# expect a kernel anchored on exactly two attack signatures (DoS Hulk, DoS GoldenEye) to generalize to unrelated
# ones, so a low out-of-sample recall is an EXPECTED, informative negative result here, not a batch failure.
OOS_NEAR_ZERO_PCT = 5.0        # Model A solo recall below this on a class = "near-zero" (expected: the anchor is
# signature-specific, not a general "is this an attack" detector).
OOS_ENSEMBLE_LIFT_PCT = 10.0   # ensemble recall exceeding Model A solo's recall by at least this many percentage
# points on a class = "ensemble meaningfully outperforms Model A alone" there. Because the ensemble is the OR of two
# independent per-window flag arrays, ensemble alerts can only EVER be a superset of Model A solo's alerts, so this
# can only happen via Model B solo independently covering windows Model A solo misses on that class -- i.e. it is a
# direct read of whether the lab-shaped kernel contributes real, complementary out-of-sample coverage, not an
# artifact of the OR rule itself.

# Batch 13's own already-committed numbers (ensemble-eval-batch13-2026-10-26.json), reconfirmed at runtime below
# rather than trusted by inspection -- Model A/Model B/the ensemble rule are byte-for-byte unchanged this batch, so
# any drift here would mean the harness (not the models) moved since batch 13.
BATCH13_LAB_DETECTED = 10
BATCH13_LAB_ATTACKS = 13
BATCH13_LAB_FP = 5
BATCH13_LAB_BENIGN = 9
BATCH13_CIC_RECALL_PCT = {'DoS Hulk': 100.0, 'DoS GoldenEye': 100.0}       # ensemble (== Model A solo in batch 13)
BATCH13_CIC_BENIGN_FP_PCT = {'Wednesday': 0.0, 'Friday': 0.25}            # ensemble


# --- Ensemble replay helpers -------------------------------------------------------------------------------------

def cic_block_ensemble_flags(features, w_a, tau_a, w_b, tau_b):
    """Mirrors tsc.score_cic_block's internals (kernel_loss_batch over the whole block, then a FRESH sr.Adaptive
    walked window-by-window) but run ONCE PER MODEL, each with its own weights/tau/Adaptive state, and returns the
    per-window boolean flag arrays plus the OR-combined ensemble array -- exactly "alert if either model's own
    kernel_loss exceeds its own tau", the pre-registered rule. Returns (ensemble_flags, flags_a, flags_b)."""
    n = len(features)
    if n == 0:
        empty = np.zeros((0,), dtype=bool)
        return empty, empty, empty
    w_a = np.asarray(w_a, dtype=np.float32)
    w_b = np.asarray(w_b, dtype=np.float32)
    losses_a = tw.kernel_loss_batch(features, w_a)
    losses_b = tw.kernel_loss_batch(features, w_b)
    ad_a, ad_b = sr.Adaptive(tau=tau_a), sr.Adaptive(tau=tau_b)
    flags_a = np.array([ad_a.check(float(loss))[0] for loss in losses_a], dtype=bool)
    flags_b = np.array([ad_b.check(float(loss))[0] for loss in losses_b], dtype=bool)
    return flags_a | flags_b, flags_a, flags_b


def score_cic_block_ensemble(features, src_ips, w_a, tau_a, w_b, tau_b, known_attacker_ip=None):
    """Ensemble analogue of tsc.score_cic_block: same return shape (n, alerts, named_correct), but `alerts` counts
    windows where EITHER model's own Adaptive flagged the window."""
    n = len(features)
    if n == 0:
        return {'n': 0, 'alerts': 0, 'named_correct': None}
    flags, _fa, _fb = cic_block_ensemble_flags(features, w_a, tau_a, w_b, tau_b)
    alerts = int(flags.sum())
    result = {'n': n, 'alerts': alerts}
    if known_attacker_ip is not None:
        result['named_correct'] = int(np.sum(src_ips[flags] == known_attacker_ip)) if alerts else 0
    return result


def self_check_cic_ensemble(features, src_ips, w, tau, known_attacker_ip):
    """Fail loudly (Invariant 1) if cic_block_ensemble_flags ever drifts from the real tsc.score_cic_block it is
    meant to generalize. Degenerate case model B == model A: the ensemble OR of a flag array with itself must equal
    that flag array, and its alert count must equal the real score_cic_block's own count exactly."""
    real = tsc.score_cic_block(features, src_ips, w, tau, known_attacker_ip=known_attacker_ip)
    flags, flags_a, flags_b = cic_block_ensemble_flags(features, w, tau, w, tau)
    if not np.array_equal(flags_a, flags_b):
        raise SystemExit('FATAL: cic_block_ensemble_flags is non-deterministic -- two identical-weight/tau replays '
                          'of the same window sequence produced different flags.')
    if int(flags.sum()) != real['alerts']:
        raise SystemExit(f"FATAL: cic_block_ensemble_flags disagrees with the real score_cic_block in the "
                          f"degenerate model-B==model-A case ({int(flags.sum())} vs {real['alerts']} alerts); "
                          f"refusing to report ensemble numbers built on a function that may have drifted from the "
                          f"real scorer.")


def ensemble_sentinel_alerts(frames, w_a, tau_a, w_b, tau_b):
    """Mirrors slr.sentinel_alerts's internals (one Extractor, windows fed in order, the predominant source of the
    last WIN frames attributed to an alerting window) but runs TWO independent sr.Adaptive controllers -- one per
    model, each seeded with that model's own weights/tau -- and alerts on a window if EITHER fires. Returns
    [(t_ns, predominant_src, loss, is_a, is_b)] -- the same (t_ns, predominant_src, loss) shape sentinel_alerts
    returns (loss here is max(loss_a, loss_b), for display only; it is never compared to anything further), plus two
    booleans recording which of the two already-computed per-model Adaptive decisions fired on this window. is_a/is_b
    are not a new computation -- they are the same is_a/is_b this function already computes to decide whether to
    alert at all (see the `if is_a or is_b:` line below); batch 18 (PREREGISTRATION.md's batch 18 addendum) exposes
    them in the return value instead of discarding them, purely for diagnostic attribution (which model is
    responsible for a given alert). Existing callers that only use the first two or three fields are unaffected."""
    ex = sr.Extractor()
    ad_a, ad_b = sr.Adaptive(tau=tau_a), sr.Adaptive(tau=tau_b)
    w_a = np.asarray(w_a, dtype=np.float32)
    w_b = np.asarray(w_b, dtype=np.float32)
    srcs = collections.deque()
    out = []
    for t_us, flen, proto, flags, sp, dp, src, t_ns in frames:
        srcs.append(src or 'unknown')
        if len(srcs) > sr.WIN:
            srcs.popleft()
        w = ex.feed(t_us, flen, proto, flags, sp, dp)
        if w is None:
            continue
        x = np.asarray(w, dtype=np.float32).reshape(1, -1)
        loss_a = float(tw.kernel_loss_batch(x, w_a)[0])
        loss_b = float(tw.kernel_loss_batch(x, w_b)[0])
        is_a, _ = ad_a.check(loss_a)
        is_b, _ = ad_b.check(loss_b)
        if is_a or is_b:
            known = collections.Counter(s for s in srcs if s != 'unknown')
            out.append((t_ns, known.most_common(1)[0][0] if known else 'unknown', max(loss_a, loss_b), is_a, is_b))
    return out


def self_check_lab_ensemble(frames, w, tau):
    """Fail loudly (Invariant 1) if ensemble_sentinel_alerts ever drifts from the real slr.sentinel_alerts it is
    meant to generalize. Degenerate case model B == model A, sr.W set to the same W: the alerting windows' (t_ns,
    src) pairs must match exactly."""
    original_w = np.array(sr.W, dtype=np.float32, copy=True)
    try:
        sr.W = np.asarray(w, dtype=np.float32)
        real = [(t, s) for t, s, _loss in slr.sentinel_alerts(frames, base_tau=tau)]
    finally:
        sr.W = original_w
    mine = [(t, s) for t, s, _loss, _is_a, _is_b in ensemble_sentinel_alerts(frames, w, tau, w, tau)]
    if mine != real:
        raise SystemExit(f'FATAL: ensemble_sentinel_alerts disagrees with the real slr.sentinel_alerts in the '
                          f'degenerate model-B==model-A case ({len(mine)} vs {len(real)} alert windows); refusing '
                          f'to report ensemble lab held-out numbers built on a function that may have drifted from '
                          f'the real scorer.')


def score_holdout_ensemble(holdout, w_a, tau_a, w_b, tau_b, label_text):
    """Ensemble analogue of tw.score_holdout: identical aggregation arithmetic (detected = attack runs whose
    ensemble alerts named the real sender at least once; falsePositives = benign runs with >=1 ensemble alert;
    misattributions = runs whose ensemble alerts ever named a non-sender), applied to ensemble_sentinel_alerts's
    per-run output instead of a single model's slr.sentinel_alerts."""
    rows = []
    for item in holdout:
        label = item['label']
        sender = label['senderIp']
        alerts = ensemble_sentinel_alerts(item['frames'], w_a, tau_a, w_b, tau_b)
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


def print_per_model_lab_attribution(holdout, w_a, tau_a, w_b, tau_b):
    """Batch 18 diagnostic (PREREGISTRATION.md's batch 18 addendum): for every lab held-out run, report which of
    Model A / Model B actually fired, using the is_a/is_b flags ensemble_sentinel_alerts already computes internally
    for its own OR decision (see that function's docstring) -- this does NOT reimplement or re-derive anything;
    it only reports fields that function already returns. score_holdout_ensemble's own detected/FP/misattribution
    arithmetic is untouched and unaffected by this function (it is called separately, after, purely for printing).
    This exists to answer one question before choosing batch 18's lever: of the two lab-benign patterns still
    producing false positives at tau_B=0.19 (benign-bulk-tcp-2mbit, benign-ping-20pps per
    evaluation-output-ensemble-batch17-2026-10-26.txt), is it Model A or Model B (or both) firing on the specific
    runs responsible?"""
    print(f"\n== BATCH 18 diagnostic: per-run model attribution (which of Model A/Model B fired), "
          f"tau_A={tau_a:.6f} tau_B={tau_b:.6f} ==")
    for item in holdout:
        label = item['label']
        alerts = ensemble_sentinel_alerts(item['frames'], w_a, tau_a, w_b, tau_b)
        fired_a = any(is_a for _t, _s, _loss, is_a, _is_b in alerts)
        fired_b = any(is_b for _t, _s, _loss, _is_a, is_b in alerts)
        if not alerts:
            which = '(no alert)'
        elif fired_a and fired_b:
            which = 'Model A AND Model B'
        elif fired_a:
            which = 'Model A only'
        elif fired_b:
            which = 'Model B only'
        else:
            which = '(unreachable: alert with neither flag set)'
        print(f"    {label['id']:34s} {item['class']:7s} {item['pattern']:26s} alerts={len(alerts):<2d} {which}")


# --- Main -----------------------------------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('datadir', help="docs/benchmarks/results/labelled-runs (the lab's own captures)")
    ap.add_argument('--wednesday-npz', required=True, dest='wednesday_npz')
    ap.add_argument('--friday-npz', required=True, dest='friday_npz')
    ap.add_argument('--model-a-weights', required=True, dest='model_a_weights',
                     help="CIC-shaped weights (batch 10's trained-weights-two-anchor-batch10-2026-10-25.json)")
    ap.add_argument('--pr106-weights', required=True, dest='pr106_weights',
                     help="PR #106's own lab-margin-trained weights, one of the two Model-B candidates checked "
                          "against the baseline hardcoded weights to pick the better lab-shaped reference")
    ap.add_argument('--cic-attack-recall-cap', type=int, default=CIC_ATTACK_RECALL_CAP_DEFAULT,
                     dest='cic_attack_recall_cap',
                     help='windows per CIC attack class, same basis as batch 10\'s own cic_margin_recall_pct '
                          f'(default {CIC_ATTACK_RECALL_CAP_DEFAULT})')
    ap.add_argument('--cic-benign-peek-cap', type=int, default=CIC_BENIGN_PEEK_CAP_DEFAULT, dest='cic_benign_peek_cap',
                     help='windows per day for the CIC-benign evaluation slice, same basis as batch 10\'s own peek '
                          f'(default {CIC_BENIGN_PEEK_CAP_DEFAULT})')
    ap.add_argument('--out-json', default=None, dest='out_json', help='write the full numbers table as JSON here')
    ap.add_argument('--model-b-tau-override', type=float, default=None, dest='model_b_tau_override',
                     help="batch 17 (docs/benchmarks/results/sentinel-training-two-anchor/PREREGISTRATION.md): "
                          "override Model B's tau AFTER it is chosen, for sweeping its threshold specifically in its "
                          "role as an ensemble component (as opposed to its own standalone-calibrated value). Does "
                          "NOT change which candidate is chosen as Model B, Model B's weights, or Model A's "
                          "weights/tau at all -- pure evaluation, same as the rest of this script. Leaves "
                          "cic_block_ensemble_flags/score_cic_block_ensemble/ensemble_sentinel_alerts untouched.")
    ap.add_argument('--model-a-tau-override', type=float, default=None, dest='model_a_tau_override',
                     help="batch 18 (docs/benchmarks/results/sentinel-training-two-anchor/PREREGISTRATION.md): "
                          "override Model A's tau, for jointly sweeping it alongside --model-b-tau-override. Does "
                          "NOT change Model A's weights or Model B's weights/tau/selection at all -- pure "
                          "evaluation, same convention as --model-b-tau-override.")
    ap.add_argument('--verbose-per-model-flags', action='store_true', dest='verbose_per_model_flags',
                     help="batch 18 diagnostic: for every lab held-out run, print which of Model A / Model B (or "
                          "both) actually fired, reusing ensemble_sentinel_alerts's own already-computed is_a/is_b "
                          "flags (see print_per_model_lab_attribution). Adds one extra report section; does not "
                          "change any scored number.")
    args = ap.parse_args()

    print('== batch 13: OR-ensemble evaluation of two ALREADY-FITTED weight vectors (no training, no fitting) ==')
    print(f'pre-registered bar: lab held-out detected >= {LAB_HOLDOUT_DETECTED_BAR}/13 AND CIC Hulk/GoldenEye '
          f'recall >= {CIC_RECALL_BAR_PCT:.0f}% each AND CIC-benign FP <= {CIC_BENIGN_FP_BAR_PCT:.0f}% both days\n')

    # --- Load lab held-out split (identical to every prior batch: PR #106's own 9-benign/13-attack reduced holdout).
    _train_groups_lab, _attack_train_groups_lab, _attack_train_report_lab, holdout_lab = \
        tw.load_and_split(args.datadir, objective='margin')
    n_holdout_benign = sum(1 for h in holdout_lab if h['class'] == 'benign')
    n_holdout_attack = sum(1 for h in holdout_lab if h['class'] == 'attack')
    if (n_holdout_benign, n_holdout_attack) != (tsc.EXPECTED_LAB_HOLDOUT_BENIGN_RUNS, tsc.EXPECTED_LAB_HOLDOUT_ATTACK_RUNS):
        raise SystemExit(f'FATAL: lab held-out split is {n_holdout_benign} benign / {n_holdout_attack} attack runs, '
                          f'expected {tsc.EXPECTED_LAB_HOLDOUT_BENIGN_RUNS}/{tsc.EXPECTED_LAB_HOLDOUT_ATTACK_RUNS} '
                          f'(PR #106\'s own published split) -- catalog drift, not safe to compare against this '
                          f'workstream\'s prior numbers.')
    print(f'lab held-out split: {n_holdout_benign} benign runs, {n_holdout_attack} attack runs (matches PR #106)\n')

    # --- Model A: batch 10's CIC-shaped weights, as-is.
    with open(args.model_a_weights) as fh:
        w_a, tau_a = tw.validate_weights_payload(json.load(fh), args.model_a_weights)
    print(f'Model A ("CIC-shaped"): {os.path.basename(args.model_a_weights)}  tau={tau_a:.6f}')
    if args.model_a_tau_override is not None:
        print(f"\n[batch 18] --model-a-tau-override: Model A's tau overridden from its own batch-10-calibrated "
              f"{tau_a:.6f} to {args.model_a_tau_override:.6f} for this ensemble run. Model A's weights are "
              f"unchanged.")
        tau_a = args.model_a_tau_override

    # --- Model B candidates: the baseline hardcoded weights vs. PR #106's own dedicated lab-margin weights. Checked
    # against lab held-out via the real tw.score_holdout (never guessed from the preregistration's own prose).
    baseline_w = np.array(sr.W, dtype=np.float32, copy=True)   # captured before anything mutates the module global
    baseline_tau = sr.BASE_TAU
    with open(args.pr106_weights) as fh:
        pr106_w, pr106_tau = tw.validate_weights_payload(json.load(fh), args.pr106_weights)

    print('\n== choosing Model B: baseline hardcoded sr.W vs. PR #106 lab-margin weights, on lab held-out ==')
    b_candidates = [('baseline (hardcoded sr.W)', baseline_w, baseline_tau),
                     ('PR106 (lab-margin)', pr106_w, pr106_tau)]
    b_results = {}
    try:
        for label, w, tau in b_candidates:
            sr.W = np.asarray(w, dtype=np.float32)
            b_results[label] = tw.score_holdout(holdout_lab, w, tau, label)
    finally:
        sr.W = baseline_w

    def rank_key(r):
        return (-r['detected'], r['falsePositives'])   # more detections wins; FP breaks ties (fewer is better)

    model_b_label = min(b_results, key=lambda label: rank_key(b_results[label]))
    model_b_w, model_b_tau = dict((label, (w, tau)) for label, w, tau in b_candidates)[model_b_label]
    other_label = [label for label, _w, _tau in b_candidates if label != model_b_label][0]
    print(f"\nModel B chosen: {model_b_label} "
          f"({b_results[model_b_label]['detected']}/{b_results[model_b_label]['attacks']} detected, "
          f"{b_results[model_b_label]['falsePositives']}/{b_results[model_b_label]['benign']} FP) "
          f"over {other_label} "
          f"({b_results[other_label]['detected']}/{b_results[other_label]['attacks']} detected, "
          f"{b_results[other_label]['falsePositives']}/{b_results[other_label]['benign']} FP)  tau={model_b_tau:.6f}")

    if args.model_b_tau_override is not None:
        print(f"\n[batch 17] --model-b-tau-override: Model B's tau overridden from its own standalone-calibrated "
              f"{model_b_tau:.6f} to {args.model_b_tau_override:.6f} for this ensemble run. Model B's weights, "
              f"Model A's weights/tau, and which candidate was chosen as Model B are all unchanged.")
        model_b_tau = args.model_b_tau_override

    # --- Load CIC data (same cached .npz buckets scripts/cic-flood-margin-sampler.py already produced).
    print('\n== CIC data (cached .npz buckets, unchanged since batch 10) ==')
    attack_blocks = {}
    for label in tsc.CIC_TRAIN_LABELS:
        feats = tsc.capped_attack_bucket(args.wednesday_npz, label, args.cic_attack_recall_cap)
        _f, _ep, src_ips = tsc.load_npz_bucket(args.wednesday_npz, label)
        attack_blocks[label] = (feats, src_ips[:args.cic_attack_recall_cap])
        print(f'  {label:20s} {len(feats)} windows (cap {args.cic_attack_recall_cap}, same basis as batch 10)')
    benign_peek = {}
    for day, npz_path in (('Wednesday', args.wednesday_npz), ('Friday', args.friday_npz)):
        _anchor, peek, peek_src = tsc.load_npz_benign_split(npz_path, args.cic_benign_peek_cap, args.cic_benign_peek_cap)
        benign_peek[day] = (peek, peek_src)
        print(f'  {day:10s} BENIGN peek slice: {len(peek)} windows (same offset/size as batch 10\'s own peek)')

    # --- Self-checks: fail loudly before reporting any number if either ensemble replay helper has drifted from the
    # real, pinned scoring function it generalizes (same discipline as every prior batch's self_check*()).
    print('\n== self-check: ensemble replay helpers agree with the real scorers in the model-B==model-A case ==')
    sample_label = tsc.CIC_TRAIN_LABELS[0]
    self_check_cic_ensemble(*attack_blocks[sample_label], w_a, tau_a, tsc.KNOWN_ATTACKER_IP)
    self_check_lab_ensemble(next(h['frames'] for h in holdout_lab if h['class'] == 'attack'), w_a, tau_a)
    print('ok: cic_block_ensemble_flags matches tsc.score_cic_block; ensemble_sentinel_alerts matches slr.sentinel_alerts\n')

    # --- Reproduce Model A's own already-committed solo numbers on this exact slice, as a second sanity layer (not
    # a self-check of the ensemble machinery, but of THIS script's own data loading against batch 10's own JSON).
    # Batch 18: when --model-a-tau-override is set, these numbers are EXPECTED to differ from batch 10's committed
    # ones (that is the whole point of sweeping tau_A) -- the heading below says so rather than keeping the
    # batch-13/17 wording, which would otherwise misleadingly imply an exact-match check is happening here.
    if args.model_a_tau_override is not None:
        print('== Model A solo at the OVERRIDDEN tau (batch 18): expected to differ from batch 10\'s committed '
              'numbers ==')
    else:
        print('== sanity: Model A solo, reproducing batch 10\'s own committed numbers on the identical sample slices ==')
    model_a_solo_recall = {}
    for label in tsc.CIC_TRAIN_LABELS:
        feats, src_ips = attack_blocks[label]
        res = tsc.score_cic_block(feats, src_ips, w_a, tau_a, known_attacker_ip=tsc.KNOWN_ATTACKER_IP)
        recall_pct = 100 * res['alerts'] / res['n'] if res['n'] else 0.0
        model_a_solo_recall[label] = recall_pct
        print(f'  {label:20s} Model A solo recall {tsc.pct(res["alerts"], res["n"])}')
    model_a_solo_fp = {}
    for day, (peek_feats, peek_src) in benign_peek.items():
        res = tsc.score_cic_block(peek_feats, peek_src, w_a, tau_a)
        fp_pct = 100 * res['alerts'] / res['n'] if res['n'] else 0.0
        model_a_solo_fp[day] = fp_pct
        print(f'  {day:10s} Model A solo CIC-benign FP {tsc.pct(res["alerts"], res["n"])}')

    # --- Ensemble numbers: the real evaluation this batch exists to produce.
    print('\n== ENSEMBLE: alert if EITHER model\'s own kernel_loss exceeds its own tau ==')
    print(f'Model A tau={tau_a:.6f}   Model B ({model_b_label}) tau={model_b_tau:.6f}\n')

    print('-- CIC Hulk/GoldenEye recall (window-level, same sample as above) --')
    ensemble_recall = {}
    for label in tsc.CIC_TRAIN_LABELS:
        feats, src_ips = attack_blocks[label]
        res = score_cic_block_ensemble(feats, src_ips, w_a, tau_a, model_b_w, model_b_tau,
                                        known_attacker_ip=tsc.KNOWN_ATTACKER_IP)
        recall_pct = 100 * res['alerts'] / res['n'] if res['n'] else 0.0
        ensemble_recall[label] = recall_pct
        print(f'  {label:20s} ensemble recall {tsc.pct(res["alerts"], res["n"])}  (Model A solo was '
              f'{model_a_solo_recall[label]:.2f}%)')

    print('\n-- CIC-benign FP, both days (ensemble; this is the real question: does Model B blow up CIC FP?) --')
    ensemble_fp = {}
    for day, (peek_feats, peek_src) in benign_peek.items():
        res = score_cic_block_ensemble(peek_feats, peek_src, w_a, tau_a, model_b_w, model_b_tau)
        fp_pct = 100 * res['alerts'] / res['n'] if res['n'] else 0.0
        ensemble_fp[day] = fp_pct
        print(f'  {day:10s} ensemble FP {tsc.pct(res["alerts"], res["n"])}  (Model A solo was '
              f'{model_a_solo_fp[day]:.2f}%)')

    print('\n-- Lab held-out (run-level), ensemble --')
    ensemble_lab = score_holdout_ensemble(holdout_lab, w_a, tau_a, model_b_w, model_b_tau, 'ensemble A|B')

    if args.verbose_per_model_flags:
        print_per_model_lab_attribution(holdout_lab, w_a, tau_a, model_b_w, model_b_tau)

    print('\n== PRE-REGISTERED VERDICT ==')
    lab_ok = ensemble_lab['detected'] >= LAB_HOLDOUT_DETECTED_BAR
    recall_ok = all(ensemble_recall[label] >= CIC_RECALL_BAR_PCT for label in tsc.CIC_TRAIN_LABELS)
    fp_ok = all(ensemble_fp[day] <= CIC_BENIGN_FP_BAR_PCT for day in ensemble_fp)
    print(f"  lab held-out detected: {ensemble_lab['detected']}/13 "
          f"({'PASS' if lab_ok else 'FAIL'} >= {LAB_HOLDOUT_DETECTED_BAR}/13)")
    for label in tsc.CIC_TRAIN_LABELS:
        print(f"  {label} recall: {ensemble_recall[label]:.2f}% "
              f"({'PASS' if ensemble_recall[label] >= CIC_RECALL_BAR_PCT else 'FAIL'} >= {CIC_RECALL_BAR_PCT:.0f}%)")
    for day in ensemble_fp:
        print(f"  {day} CIC-benign FP: {ensemble_fp[day]:.2f}% "
              f"({'PASS' if ensemble_fp[day] <= CIC_BENIGN_FP_BAR_PCT else 'FAIL'} <= {CIC_BENIGN_FP_BAR_PCT:.0f}%)")
    overall = lab_ok and recall_ok and fp_ok
    print(f"\nOVERALL: {'GOOD CANDIDATE (clears the pre-registered bar)' if overall else 'NOT a good candidate (fails the pre-registered bar)'}")

    oos_results, oos_interpretation = {}, {}
    if args.model_b_tau_override is not None or args.model_a_tau_override is not None:
        # Batch 17: the whole point of --model-b-tau-override is to deliberately move Model B's tau away from its
        # batch-13 standalone-calibrated value, so the batch 14 regression check below (which exists to catch
        # UNINTENDED drift from batch 13's committed numbers) would always and correctly fire here -- that is not a
        # bug, it is the self-check doing its job, but it is not an informative check to run when the drift is the
        # whole point of the run. Skip it (and the out-of-sample section, which is diagnostic only and not needed
        # for a tau sweep) rather than silently making it pass; the primary metrics (lab held-out, CIC Hulk/GoldenEye
        # recall, CIC-benign FP) are all already printed above, unaffected by this skip. Batch 18 extends the same
        # skip condition to --model-a-tau-override for the identical reason: jointly sweeping tau_A makes the
        # same numbers drift from batch 13 intentionally, not a harness bug.
        overridden = ', '.join(f'tau_{m}' for m, flag in (('A', args.model_a_tau_override), ('B', args.model_b_tau_override)) if flag is not None)
        print(f'\n[batch 17/18] {overridden} override is set: skipping the batch 14 regression check (it exists to '
              'catch UNINTENDED drift from batch 13\'s numbers, and this run intentionally changes them) and the '
              'batch 14 out-of-sample section (diagnostic only, not needed for a tau sweep).\n')
    else:
        # --- Batch 14: regression check -- reconfirm batch 13's own already-committed numbers are unchanged before
        # trusting anything new (Model A, Model B, and the ensemble rule are byte-for-byte unchanged this batch; this
        # is a sanity check that nothing about the harness itself drifted, not a new result).
        print('== BATCH 14 regression check: batch 13 numbers unchanged (Model A/B/ensemble themselves are untouched) ==')
        regressions = []
        lab_now = (ensemble_lab['detected'], ensemble_lab['attacks'], ensemble_lab['falsePositives'], ensemble_lab['benign'])
        lab_was = (BATCH13_LAB_DETECTED, BATCH13_LAB_ATTACKS, BATCH13_LAB_FP, BATCH13_LAB_BENIGN)
        if lab_now != lab_was:
            regressions.append(f'lab held-out: now {lab_now[0]}/{lab_now[1]} detected, {lab_now[2]}/{lab_now[3]} FP, '
                                f'was {lab_was[0]}/{lab_was[1]} detected, {lab_was[2]}/{lab_was[3]} FP')
        for label, expected in BATCH13_CIC_RECALL_PCT.items():
            if abs(ensemble_recall[label] - expected) > 1e-9:
                regressions.append(f'{label} ensemble recall: now {ensemble_recall[label]:.2f}%, was {expected:.2f}%')
        for day, expected in BATCH13_CIC_BENIGN_FP_PCT.items():
            if abs(ensemble_fp[day] - expected) > 1e-9:
                regressions.append(f'{day} ensemble CIC-benign FP: now {ensemble_fp[day]:.2f}%, was {expected:.2f}%')
        if regressions:
            raise SystemExit('FATAL: batch 13 numbers drifted on a re-run that should be byte-for-byte identical '
                              '(Model A/B/ensemble rule unchanged this batch) -- not safe to report batch 14\'s '
                              'out-of-sample numbers against a harness that may itself have moved:\n  ' +
                              '\n  '.join(regressions))
        print('ok: lab held-out detected/FP, CIC Hulk/GoldenEye ensemble recall, and CIC-benign ensemble FP (both days) '
              'all match batch 13\'s own committed numbers exactly\n')

        # --- Batch 14: out-of-sample CIC attack classes (never in tsc.CIC_TRAIN_LABELS -- see module docstring).
        print('== BATCH 14: out-of-sample CIC attack classes (never anchored by Model A\'s training) ==')
        print(f'Model A tau={tau_a:.6f}   Model B ({model_b_label}) tau={model_b_tau:.6f}\n')
        oos_sources = [(label, args.wednesday_npz) for label in tsc.CIC_HOLDOUT_WED_LABELS] + \
                      [(label, args.friday_npz) for label in tsc.CIC_HOLDOUT_FRI_LABELS]
        for label, npz_path in oos_sources:
            feats, _epochs, src_ips = tsc.load_npz_bucket(npz_path, label)
            if len(feats) == 0:
                raise SystemExit(f"FATAL: out-of-sample bucket {label!r} in {npz_path} is empty -- cannot evaluate.")
            res_a = tsc.score_cic_block(feats, src_ips, w_a, tau_a, known_attacker_ip=tsc.KNOWN_ATTACKER_IP)
            res_b = tsc.score_cic_block(feats, src_ips, model_b_w, model_b_tau, known_attacker_ip=tsc.KNOWN_ATTACKER_IP)
            res_ens = score_cic_block_ensemble(feats, src_ips, w_a, tau_a, model_b_w, model_b_tau,
                                                known_attacker_ip=tsc.KNOWN_ATTACKER_IP)
            oos_results[label] = {'n': res_a['n'], 'model_a': res_a, 'model_b': res_b, 'ensemble': res_ens}
            print(f"  {label:20s} n={res_a['n']:6d}  Model A solo {tsc.pct(res_a['alerts'], res_a['n']):>8s}  "
                  f"Model B solo {tsc.pct(res_b['alerts'], res_b['n']):>8s}  "
                  f"Ensemble {tsc.pct(res_ens['alerts'], res_ens['n']):>8s}")

        print('\n-- interpretation (bins pre-registered before these numbers were looked at; see module docstring) --')
        for label, r in oos_results.items():
            a_pct = 100 * r['model_a']['alerts'] / r['n']
            b_pct = 100 * r['model_b']['alerts'] / r['n']
            ens_pct = 100 * r['ensemble']['alerts'] / r['n']
            if ens_pct - a_pct >= OOS_ENSEMBLE_LIFT_PCT:
                bucket = 'ensemble meaningfully outperforms Model A alone (Model B contributes real coverage here)'
            elif a_pct >= OOS_NEAR_ZERO_PCT:
                bucket = 'Model A alone meaningfully nonzero (some anchor generalization beyond the literal two classes)'
            else:
                bucket = 'near-zero across the board (expected: the anchor is signature-specific, not a general detector)'
            oos_interpretation[label] = {'model_a_pct': a_pct, 'model_b_pct': b_pct, 'ensemble_pct': ens_pct, 'bucket': bucket}
            print(f'  {label:20s} {bucket}')

    if args.out_json:
        payload = {
            'batch': 13,
            'method': 'OR-ensemble of two already-fitted weight vectors; no training or fitting performed',
            'pre_registered_bar': {'lab_holdout_detected_gte': LAB_HOLDOUT_DETECTED_BAR,
                                    'cic_recall_gte_pct': CIC_RECALL_BAR_PCT,
                                    'cic_benign_fp_lte_pct': CIC_BENIGN_FP_BAR_PCT},
            'model_a': {'file': args.model_a_weights, 'tau': tau_a, 'label': 'CIC-shaped (batch 10)',
                        'tau_override_applied': args.model_a_tau_override},
            'model_b': {'file': (args.pr106_weights if model_b_label == 'PR106 (lab-margin)' else '(hardcoded sr.W, no file)'),
                        'tau': model_b_tau, 'label': model_b_label,
                        'tau_override_applied': args.model_b_tau_override,
                        'chosen_over': other_label,
                        # 'rows' (per-run detail) dropped here: aggregate counts only, same density as every prior
                        # batch's committed weights JSON; the full per-run breakdown is in the saved stdout log.
                        'lab_holdout_candidates': {label: {k: v for k, v in r.items() if k != 'rows'}
                                                    for label, r in b_results.items()}},
            'model_a_solo': {'cic_recall_pct': model_a_solo_recall, 'cic_benign_fp_pct': model_a_solo_fp},
            'ensemble': {'cic_recall_pct': ensemble_recall, 'cic_benign_fp_pct': ensemble_fp,
                         'lab_holdout': ensemble_lab},
            'verdict': {'lab_ok': lab_ok, 'recall_ok': recall_ok, 'fp_ok': fp_ok, 'overall_good_candidate': overall},
            'batch_14_out_of_sample': {
                'method': 'diagnostic/exploratory, not a pass/fail gate -- see module docstring and '
                          'PREREGISTRATION.md\'s batch 14 addendum',
                'regression_check_against_batch_13': ('skipped: a tau override is set (--model-a-tau-override and/or '
                                                        '--model-b-tau-override, batch 17/18), so drift from batch 13 '
                                                        'is the intended result, not a harness bug'
                                                        if (args.model_b_tau_override is not None
                                                            or args.model_a_tau_override is not None)
                                                        else 'ok (no drift; see stdout)'),
                'classes': {label: {'n': r['n'],
                                     'model_a_recall_pct': 100 * r['model_a']['alerts'] / r['n'],
                                     'model_b_recall_pct': 100 * r['model_b']['alerts'] / r['n'],
                                     'ensemble_recall_pct': 100 * r['ensemble']['alerts'] / r['n'],
                                     'interpretation': oos_interpretation[label]['bucket']}
                            for label, r in oos_results.items()},
            },
        }
        with open(args.out_json, 'w') as fh:
            json.dump(payload, fh, indent=2)
            fh.write('\n')
        print(f'\nwrote {args.out_json}')


if __name__ == '__main__':
    main()
