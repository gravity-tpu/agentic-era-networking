#!/usr/bin/env python3
"""scripts/layout-capacity-live-report.py: turns the run directory of the live-policy A8 re-measurement into tables and checks the criteria of
docs/benchmarks/results/layout-capacity/PREREGISTRATION-live-policy-2026-10-31.md. Every number is read from results.json and provenance.json.
Usage: python3 scripts/layout-capacity-live-report.py <run dir> <out.md>
"""
import json, sys, statistics

RUN, OUT = sys.argv[1], sys.argv[2]
res = json.load(open(f'{RUN}/results.json'))
prov = json.load(open(f'{RUN}/provenance.json'))

# The model under test (src/sdn/deployed-cost-model.ts) and the pre-registered tolerances.
FIXED_US, SLOPE_US = 80.0, 5.42
BAND, SPREAD_LIMIT = 0.05, 0.10
KS = [0, 2, 4, 8]

by_k = {k: [] for k in KS}
rows = []
for r in sorted(res, key=lambda x: (x['round'], KS.index(x['k']) if x['round'] == 1 else -KS.index(x['k']))):
    cap = r['capacityPps']
    sat = [s for s in r['steps'] if s.get('saturated')]
    t_us = 1e6 / cap
    by_k[r['k']].append((cap, t_us))
    rows.append((r['k'], r['round'], cap, t_us, sat[0]['sentPps'] if sat else None))

lines = []
lines.append('## Capacity of the live policy with k quarantines above it (572-byte UDP)\n')
lines.append('| k | Round | Capacity (pps) | Per-packet time (us) | Saturated at offered (pps) |')
lines.append('| ---: | ---: | ---: | ---: | ---: |')
for k, rd, cap, t, off in rows:
    lines.append(f'| {k} | {rd} | {cap} | {t:.1f} | {off} |')
lines.append('')

lines.append('## The pre-registered checks\n')
lines.append('| k | Mean per-packet time (us) | Model (us) | Difference | Accepted band (us) | Prediction 1 | Round-to-round spread | Prediction 3 |')
lines.append('| ---: | ---: | ---: | ---: | :--- | :--- | ---: | :--- |')
means = {}
p1 = p3 = True
for k in KS:
    ts = [t for _, t in by_k[k]]
    m = statistics.mean(ts)
    means[k] = m
    model = FIXED_US + SLOPE_US * k
    lo, hi = model * (1 - BAND), model * (1 + BAND)
    ok1 = lo <= m <= hi
    spread = abs(by_k[k][0][0] - by_k[k][1][0]) / statistics.mean([c for c, _ in by_k[k]])
    ok3 = spread <= SPREAD_LIMIT
    p1 &= ok1
    p3 &= ok3
    lines.append(f'| {k} | {m:.1f} | {model:.1f} | {100 * (m - model) / model:+.1f}% | {lo:.1f} to {hi:.1f} | {"holds" if ok1 else "**DOES NOT HOLD**"} | {100 * spread:.1f}% | {"holds" if ok3 else "**DOES NOT HOLD**"} |')
caps_mean = [statistics.mean([c for c, _ in by_k[k]]) for k in KS]
p2 = all(caps_mean[i] > caps_mean[i + 1] for i in range(len(KS) - 1))
n = len(KS)
kbar = sum(KS) / n
ybar = sum(means[k] for k in KS) / n
slope = sum((k - kbar) * (means[k] - ybar) for k in KS) / sum((k - kbar) ** 2 for k in KS)
intercept = ybar - slope * kbar
lines.append('')
lines.append('| Quantity | Value |')
lines.append('| :--- | :--- |')
lines.append(f'| Prediction 1 (every k within {int(BAND * 100)}% of the model) | {"**HOLDS**" if p1 else "**DOES NOT HOLD**"} |')
lines.append(f'| Prediction 2 (mean capacity falls monotonically with k) | {"**HOLDS**" if p2 else "**DOES NOT HOLD**"} ({", ".join(str(round(c)) for c in caps_mean)} pps) |')
lines.append(f'| Prediction 3 (round-to-round spread at most {int(SPREAD_LIMIT * 100)}%) | {"**HOLDS**" if p3 else "**DOES NOT HOLD**"} |')
lines.append(f'| Least-squares slope on the per-k means | {slope:.2f} us per quarantine (model {SLOPE_US}, {100 * (slope - SLOPE_US) / SLOPE_US:+.1f}%) |')
lines.append(f'| Least-squares intercept | {intercept:.1f} us (model {FIXED_US}, {100 * (intercept - FIXED_US) / FIXED_US:+.1f}%) |')
lines.append('')
lines.append('## Provenance\n')
lines.append(f'- Started {prov["startedEt"]}; bridge commit `{prov["bridgeCommit"][0]}` on `{prov["bridgeCommit"][1]}` with {prov["bridgeCommit"][2]} uncommitted files (as found, not examined); `dist/sdn/zodiac-bridge-server.js` SHA-256 `{prov["bridgeDistSha256"][:16]}`.')
lines.append(f'- Harness SHA-256 `{prov["harnessSha256"][:16]}`, sender `{prov["senderSha256"][:16]}`; parameters {json.dumps(prov["params"])}.')
open(OUT, 'w').write('\n'.join(lines) + '\n')
verdict = 'ALL THREE PREDICTIONS HOLD' if (p1 and p2 and p3) else 'AT LEAST ONE PREDICTION DOES NOT HOLD'
print(verdict, f'slope {slope:.2f} intercept {intercept:.1f}')
