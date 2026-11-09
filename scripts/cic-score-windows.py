#!/usr/bin/env python3
"""
scripts/cic-score-windows.py
============================
Scores the deployed GPU sentinel's alert rule against the CIC-IDS2017 per-window output of scripts/cic-ids2017-adapter.py
(`--out windows.jsonl`: one JSON object per 64-packet window with `loss` and `majority_label`). Reports, per label, how many
windows alert, and overall false-positive rate on benign windows, recall on attack windows and precision, each with a 95% Wilson
interval. Two views, both reported: the static threshold (loss >= BASE_TAU) and the adaptive controller (sr.Adaptive, run
continuously across the file in window order as the deployed service runs it). Nothing here fits or changes a weight: the
arithmetic (kernel_loss, Adaptive, BASE_TAU) is imported unmodified from scripts/sentinel-replay.py via the adapter's loss values.

Honest limits, stated in the output as well as here: windows overlap (a 64-packet sliding window per packet), so consecutive
windows are strongly dependent and the Wilson intervals, which treat windows as independent, are optimistic; precision depends on
the benign-to-attack mix of the day scored and is not a rate the deployed detector would see on the lab network; a window's
label is the majority label of its packets, joined from CICFlowMeter flows, and windows whose packets matched no flow are
counted as unlabelled and left out of every rate.

Usage:
  python3 scripts/cic-score-windows.py --day Monday --out monday.summary.json windows.jsonl
  python3 scripts/cic-score-windows.py --combine --out all.summary.json monday.summary.json tuesday.summary.json ...

Invariant 3/4: malformed input, a missing or non-finite loss, an empty input, or summaries produced with different settings are
refused with the reason; nothing is skipped silently. Pure arithmetic, integer counts, no I/O except the files named.
"""
import argparse
import importlib.util
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BENIGN = 'BENIGN'
UNLABELLED = 'UNLABELLED'
SCHEMA = 'cic-score-windows/v1'


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


sr = _load('sentinel_replay', os.path.join(HERE, 'sentinel-replay.py'))


def wilson(k, n, z=1.96):
    """95% Wilson score interval for k successes in n trials; (0.0, 1.0) when n is 0 is NOT returned: callers guard n > 0."""
    if n <= 0:
        raise ValueError('wilson: n must be positive')
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def _settings():
    ad = sr.Adaptive()
    return {'static_tau': sr.BASE_TAU, 'adaptive': {'tau': ad.base, 'alpha': ad.a, 'sigma': ad.s}}


def _rate(k, n):
    if n == 0:
        return {'value': None, 'k': k, 'n': n, 'interval95': None}
    lo, hi = wilson(k, n)
    return {'value': k / n, 'k': k, 'n': n, 'interval95': [lo, hi]}


def _derive(labels, unlabelled, windows_total, days, settings):
    """Build the full summary from per-label counts. Used by score_lines and combine so both report identically."""
    summary = {'schema': SCHEMA, 'settings': settings, 'days': days, 'windows_total': windows_total,
               'unlabelled_windows': unlabelled, 'labels': labels}
    benign = labels.get(BENIGN, {'windows': 0, 'static_alerts': 0, 'adaptive_alerts': 0})
    att = {'windows': 0, 'static_alerts': 0, 'adaptive_alerts': 0}
    for name, c in labels.items():
        if name == BENIGN:
            continue
        for key in att:
            att[key] += c[key]
    summary['benign'] = {'windows': benign['windows'], 'static_false_positives': benign['static_alerts'],
                         'adaptive_false_positives': benign['adaptive_alerts']}
    summary['attack'] = {'windows': att['windows'], 'static_true_positives': att['static_alerts'],
                         'adaptive_true_positives': att['adaptive_alerts']}
    for view in ('static', 'adaptive'):
        fp = benign[f'{view}_alerts']
        tp = att[f'{view}_alerts']
        recall = _rate(tp, att['windows'])
        precision = _rate(tp, tp + fp)
        summary[view] = {
            'false_positive_rate': _rate(fp, benign['windows']),   # {value, k, n, interval95}
            'recall': recall['value'], 'recall_interval95': recall['interval95'],
            'precision': precision['value'], 'precision_interval95': precision['interval95'],
        }
    summary['limits'] = ('windows overlap and are strongly dependent, so the intervals (which assume independence) are optimistic; '
                         'precision depends on the benign-to-attack mix of the days scored; unlabelled windows are excluded from every rate')
    return summary


def score_lines(lines, day=None):
    """Score an iterable of JSONL lines. Windows are fed to the adaptive controller in the order given (all of them, labelled or
    not, as the live service would see them)."""
    ad = sr.Adaptive()
    labels = {}
    unlabelled = 0
    total = 0
    for i, raw in enumerate(lines, start=1):
        if not raw.strip():
            continue
        try:
            w = json.loads(raw)
        except json.JSONDecodeError as e:
            raise ValueError(f'line {i}: not valid JSON ({e.msg})')
        if not isinstance(w, dict):
            raise ValueError(f'line {i}: expected a JSON object')
        loss = w.get('loss')
        if isinstance(loss, bool) or not isinstance(loss, (int, float)) or not math.isfinite(loss):
            raise ValueError(f'line {i}: loss is missing or not a finite number')
        label = w.get('majority_label')
        if label is not None and not isinstance(label, str):
            raise ValueError(f'line {i}: majority_label must be a string or null')
        total += 1
        static_alert = loss >= sr.BASE_TAU
        adaptive_alert, _ = ad.check(loss)
        if label is None:
            unlabelled += 1
            continue
        c = labels.setdefault(label, {'windows': 0, 'static_alerts': 0, 'adaptive_alerts': 0})
        c['windows'] += 1
        c['static_alerts'] += 1 if static_alert else 0
        c['adaptive_alerts'] += 1 if adaptive_alert else 0
    if total == 0:
        raise ValueError('no windows in the input: refusing to report rates from nothing')
    result = _derive(dict(sorted(labels.items())), unlabelled, total, [day] if day is not None else [], _settings())
    result['day'] = day
    return result


def combine(summaries):
    if not summaries:
        raise ValueError('nothing to combine')
    settings = summaries[0].get('settings')
    labels = {}
    unlabelled = 0
    total = 0
    days = []
    for s in summaries:
        if s.get('schema') != SCHEMA:
            raise ValueError('a summary has the wrong schema; refusing to combine')
        if s.get('settings') != settings:
            raise ValueError('summaries were scored with different settings; refusing to combine')
        for name, c in s['labels'].items():
            t = labels.setdefault(name, {'windows': 0, 'static_alerts': 0, 'adaptive_alerts': 0})
            for key in t:
                t[key] += c[key]
        unlabelled += s['unlabelled_windows']
        total += s['windows_total']
        days.extend(s.get('days', []))
    return _derive(dict(sorted(labels.items())), unlabelled, total, days, settings)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('inputs', nargs='+', help='windows JSONL files (one day), or summary JSON files with --combine')
    ap.add_argument('--day', default=None, help='label for the day scored')
    ap.add_argument('--combine', action='store_true', help='combine per-day summary files instead of scoring windows')
    ap.add_argument('--out', default=None, help='write the summary JSON here (default: stdout)')
    args = ap.parse_args(argv)
    try:
        if args.combine:
            summaries = []
            for path in args.inputs:
                with open(path, 'r', encoding='utf8') as fh:
                    summaries.append(json.load(fh))
            result = combine(summaries)
        else:
            def stream():
                for path in args.inputs:
                    with open(path, 'r', encoding='utf8') as fh:
                        yield from fh
            result = score_lines(stream(), args.day)
    except (ValueError, OSError) as e:
        print(f'cic-score-windows: {e}', file=sys.stderr)
        return 1
    text = json.dumps(result, indent=2, sort_keys=True) + '\n'
    if args.out:
        with open(args.out, 'w', encoding='utf8') as fh:
            fh.write(text)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == '__main__':
    sys.exit(main())
