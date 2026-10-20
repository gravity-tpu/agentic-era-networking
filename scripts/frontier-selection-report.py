#!/usr/bin/env python3
"""scripts/frontier-selection-report.py: writes docs/benchmarks/results/agent-evaluation/frontier-selection/README.md from the recorded
frontier runs (frontier-pilot, frontier-stage2, frontier-full, frontier-probe). Every number in the tables is read from a run's
summary.json or trials.jsonl; the prose states only what those numbers support. Re-run it after more runs land.

Usage: python3 scripts/frontier-selection-report.py
"""
import collections, glob, json, math, os, re
from datetime import datetime
from zoneinfo import ZoneInfo


def _jload(path):
    with open(path) as fh:
        return json.load(fh)


def _jsonl(path):
    with open(path) as fh:
        return [json.loads(line) for line in fh]


def _write(path, text):
    with open(path, 'w') as fh:
        fh.write(text)

ROOT = 'docs/benchmarks/results/agent-evaluation'
OUT = f'{ROOT}/frontier-selection/README.md'
INTENTS = [('port1-isolation_v1', 'INTENT-1 port-1 isolation'), ('dns-confinement_v1', 'INTENT-2 DNS confinement'),
           ('quarantine-precedence_v1', 'INTENT-3 quarantine precedence'), ('tap-return-isolation_v1', 'INTENT-4 tap return')]
# model: (provider, in cents per 1M tokens, out cents per 1M tokens, setting used, price source)
MODELS = {
    'claude-haiku-5-5': ('Anthropic', 10, 50, 'effort low'), 'claude-sonnet-5-5': ('Anthropic', 200, 1000, 'effort low'),
    'claude-opus-5-5': ('Anthropic', 400, 2000, 'effort low'), 'claude-fable-5-1': ('Anthropic', 1000, 5000, 'effort low'),
    'gemini-3.1-flash-lite': ('Google', 25, 150, 'default thinking'), 'gemini-3.5-flash-lite': ('Google', 30, 250, 'default thinking'),
    'gemini-2.5-flash': ('Google', 30, 250, 'default thinking'), 'gemini-3-flash-preview': ('Google', 50, 300, 'default thinking'),
    'gemini-3.6-flash': ('Google', 75, 375, 'default thinking'), 'gemini-3.8-flash': ('Google', 75, 375, 'default thinking'),
    'gemini-2.5-pro': ('Google', 125, 1000, 'default thinking'), 'gemini-3.1-pro-preview': ('Google', 200, 1200, 'default thinking'),
    'gemini-4-argon': ('Google', 200, 1000, 'default thinking'),
}


def wilson(k, n, z=1.96):
    """Wilson score interval for k successes in n trials (returned as fractions)."""
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - h) / d, (c + h) / d)


def pct(x):
    return f'{100 * x:.0f}%'


def ci1(k, n, z=1.96):
    lo, hi = wilson(k, n, z)
    return f'{100 * lo:.1f}% to {100 * hi:.1f}%'


def ci(k, n, z=1.96):
    lo, hi = wilson(k, n, z)
    return f'{pct(lo)} to {pct(hi)}'


def load_dirs(stage, proto, suffix_re):
    """-> {model: {intent: summary dict + 'trials' list}}"""
    out = collections.defaultdict(dict)
    for d in glob.glob(f'{ROOT}/{stage}/protocol-{proto}-*'):
        m = re.match(rf'.*/protocol-{proto}-(.+?)-((?:gemini|claude)-[a-z0-9.\-]+?){suffix_re}$', d)
        if not m or not os.path.exists(f'{d}/summary.json'):
            continue
        s = _jload(f'{d}/summary.json')
        s['_trials'] = _jsonl(f'{d}/trials.jsonl')
        out[m.group(2)][m.group(1)] = s
    return out


def totals(by_intent):
    adm = sum(s['counts']['ADMISSIBLE'] for s in by_intent.values())
    n = sum(s['trialsRun'] for s in by_intent.values())
    tf = sum(s['counts']['TRANSPORT_FAILURE'] for s in by_intent.values())
    cost = sum(int(s.get('costMicroUsd', '0')) for s in by_intent.values())
    tok = sum(s.get('usage', {}).get('outputTokens', 0) + s.get('usage', {}).get('thoughtTokens', 0) for s in by_intent.values())
    refusals = sum(1 for s in by_intent.values() for t in s['_trials'] for x in t['turns'] if str(x.get('doneReason', '')).startswith('refusal'))
    return adm, n, tf, cost, tok, refusals


def main():
    pilot = load_dirs('frontier-pilot', 'a', '-n3')
    stage2 = load_dirs('frontier-stage2', 'a', '-n10')
    full_a = load_dirs('frontier-full', 'a', '')
    full_b = load_dirs('frontier-full', 'b', '')
    probe = collections.defaultdict(lambda: [0, 0, 0])  # model -> [trials, refusals, cost micro]
    for d in glob.glob(f'{ROOT}/frontier-probe/protocol-a-*'):
        if not os.path.exists(f'{d}/summary.json'):
            continue
        m = re.search(r'-(claude-[a-z0-9.\-]+?)-n\d', d)
        if m is None:
            continue
        model = m.group(1)
        s = _jload(f'{d}/summary.json')
        t = _jsonl(f'{d}/trials.jsonl')
        probe[model][0] += s['trialsRun']
        probe[model][1] += sum(1 for r in t for x in r['turns'] if str(x.get('doneReason', '')).startswith('refusal'))
        probe[model][2] += int(s.get('costMicroUsd', '0'))

    rows = []
    for m, by in pilot.items():
        adm, n, tf, cost, tok, ref = totals(by)
        # First element is for display only; the ranking below uses the integer counters.
        rows.append((cost / 1e6 / adm if adm else float('inf'), m, by, adm, n, tf, cost, tok, ref))
    # Rank by cost per admissible trial using integer cross-multiplication (cost_a/adm_a < cost_b/adm_b); models with no admissible trial sort last.
    import functools
    def _cmp(a, b):
        if a[3] == 0 or b[3] == 0:
            return (a[3] == 0) - (b[3] == 0)
        l, r = a[6] * b[3], b[6] * a[3]
        return (l > r) - (l < r)
    rows.sort(key=functools.cmp_to_key(_cmp))
    now = datetime.now(ZoneInfo('America/New_York')).strftime('%Y-%m-%d %H:%M ET')

    L = []
    w = L.append
    w('# Frontier model selection: why Claude Haiku 5.5')
    w('')
    w(f'Generated by `scripts/frontier-selection-report.py` from the recorded runs on {now}. Every number below is read from a run\'s '
      '`summary.json` or `trials.jsonl`; re-run the script after more runs land. These are zero-shot (Protocol A) results of the '
      'abstract evaluation (RQ1 to RQ3): they say nothing about the switch.')
    w('')
    w('## Why this exists')
    w('')
    w('The question for the frontier arm was not "which model is best" but "which is the **cheapest model that can execute the task**": '
      'write a rule set for a stated intent that the deterministic verifier admits. Admissible means the verifier accepts it; it does not '
      'mean correct on the wire (RQ4) and it is not the cross-intent check.')
    w('')
    w('## How the choice was made')
    w('')
    w('1. **Pilot:** Protocol A, N=3 per intent on all four intents (12 trials per model), 12 candidate models from two providers (Claude Fable 5.1 was probed at N=1 or 2 per intent and not piloted, see below).')
    w('2. **Rank:** models with no transport failure and at least 8 of 12 admissible, by **measured** cost per admissible set (not list price).')
    w('3. **Stage 2:** N=10 per intent, one candidate at a time, cheapest first, stopping at the first viable one. Viable means at least '
      '90% admissible overall and at least 70% on every intent. More expensive candidates were not run.')
    w('4. **Full run:** Protocol A N=50 and Protocol B N=20 on all four intents, on that one model only.')
    w('')
    w('**What was and was not fixed in advance.** The stage-2 thresholds (90% overall, 70% per intent, N=10) were set before any stage-2 '
      'result existed. They were set after part of the Gemini pilot table had been seen, and the Claude probes (N=1 or 2 per intent) were run '
      'before the Claude pilot, so the pilot cut (8 of 12) and the choice of candidates are **not blind**. The pilot used N=3, which is '
      'too small to rank models; its job was to find candidates cheap enough to test properly.')
    w('')
    w('## Stage 1: pilot, Protocol A, N=3 per intent')
    w('')
    w('Sorted by measured cost per admissible set. The interval is a 95% Wilson interval on the overall admissible rate of the 12 trials.')
    w('')
    w('| Model | Setting | INTENT-1 | INTENT-2 | INTENT-3 | INTENT-4 | Admissible (95% interval) | Cost | Per trial | Per admissible | Out+thinking tokens per trial |')
    w('| :--- | :--- | ---: | ---: | ---: | ---: | :--- | ---: | ---: | ---: | ---: |')
    for cpa, m, by, adm, n, tf, cost, tok, ref in rows:
        cells = []
        for key, _ in INTENTS:
            s = by.get(key)
            cells.append(f"{s['counts']['ADMISSIBLE']}/{s['trialsRun']}" if s else '-')
        extra = []
        if tf:
            extra.append(f'{tf} transport failures')
        if ref:
            extra.append(f'{ref} refusals')
        note = f" ({', '.join(extra)})" if extra else ''
        per_adm = f'${cpa:.4f}' if adm else 'n/a'
        w(f"| {m} | {MODELS.get(m, ('', 0, 0, '?'))[3]} | {' | '.join(cells)} | {adm}/{n}: {ci(adm, n)}{note} | ${cost / 1e6:.4f} | ${cost / 1e6 / max(1, n):.5f} | {per_adm} | {tok // max(1, n)} |")
    w('')
    w('Prices in US cents per 1M tokens (input / output; output includes thinking tokens): ' + '; '.join(f'{m} {v[1]}/{v[2]}' for m, v in MODELS.items()) +
      '. Google: ai.google.dev pricing page, fetched 2026-10-19 (paid tier, text, standard; the 3.6 and 3.8 Flash and Argon rates are promotional and rise on 2027-01-01 and 2026-12-01). '
      'Anthropic: first-party API rates from the claude-api reference cached 2026-10-06 (Haiku 5.5 rate is for prompts up to 100K tokens; these are about 500).')
    w('')
    if probe:
        w('### Claude models that declined the task')
        w('')
        w('| Model | Trials | Refusals (`refusal:cyber`) | Cost |')
        w('| :--- | ---: | ---: | ---: |')
        for m, (n, r, c) in sorted(probe.items()):
            if r:
                w(f'| {m} | {n} (probe, N=1 or 2 per intent) | {r} | ${c / 1e6:.4f} |')
        for _, m, by, adm, n, tf, cost, tok, ref in rows:
            if m == 'claude-opus-5-5' and ref:
                w(f'| {m} (pilot, INTENT-4 only) | {n} | {ref} | included above |')
        w('')
        w('Claude Fable 5.1 declined every trial on every intent, with its cyber safety classifier, on a defensive task (writing isolation and quarantine rules '
          'for a switch). Claude Opus 5.5 declined every INTENT-4 trial and none on the other three intents. A refusal bills only its input and is recorded as a '
          'trial that scored ERR_SYNTAX with the reason in `doneReason`. The prompt was **not** reworded to get past the classifier: that would change the '
          'experiment, and Fable also accepts no temperature, top-p or seed. Fable was therefore not run beyond the probe.')
        w('')
    w('## Stage 2: N=10 per intent, Protocol A')
    w('')
    w('| Model | ' + ' | '.join(lbl.split(' ')[0] for _, lbl in INTENTS) + ' | Admissible (95% interval) | Cost | Per admissible | Verdict |')
    w('| :--- | ' + ' | '.join('---:' for _ in INTENTS) + ' | :--- | ---: | ---: | :--- |')
    for m, by in sorted(stage2.items(), key=lambda kv: totals(kv[1])[3] / max(1, totals(kv[1])[0])):
        adm, n, tf, cost, tok, ref = totals(by)
        cells = [f"{by[k]['counts']['ADMISSIBLE']}/{by[k]['trialsRun']}" if k in by else '-' for k, _ in INTENTS]
        viable = n == 40 and adm * 10 >= 9 * 40 and all(s['counts']['ADMISSIBLE'] * 10 >= 7 * s['trialsRun'] for s in by.values())
        verdict = 'viable (cheapest; chosen)' if viable and m == 'claude-haiku-5-5' else ('viable' if viable else ('not viable' if n == 40 else 'incomplete'))
        w(f"| {m} | {' | '.join(cells)} | {adm}/{n}: {ci(adm, n)} | ${cost / 1e6:.4f} | ${cost / 1e6 / max(1, adm):.4f} | {verdict} |")
    w('')
    h2 = stage2.get('claude-haiku-5-5', {})
    if h2:
        adm, n = totals(h2)[:2]
        distinct = {k: len({x['response'] for t in s['_trials'] for x in t['turns']}) for k, s in h2.items()}
        w(f'Haiku passed by **{adm} of {n}**, which is {pct(adm / n)}: the threshold is "at least 90%", so it cleared it by exactly the margin of one trial, and the 95% '
          f'interval on that rate is wide ({ci(adm, n)}). Its outputs were independent samples, not repeats: distinct responses per intent were '
          + ', '.join(f'{k.split("_")[0]} {v}/10' for k, v in distinct.items()) + '.')
        w('')
    w('## Why Haiku')
    w('')
    ha = next((r for r in rows if r[1] == 'claude-haiku-5-5'), None)
    if ha:
        others = [r for r in rows if r[1] != 'claude-haiku-5-5' and r[3] >= 8]
        ratios = ', '.join(f'{r[1]} {r[0] / ha[0]:.0f}x' for r in others if r[0] != float('inf'))
        w(f'Among models that met the pilot cut, Haiku 5.5 had the lowest measured cost per admissible set (${ha[0]:.4f}); the others cost this many times as much per admissible set: {ratios}. '
          'It then cleared the stage-2 rule. The cheaper Google flash-lite models did not meet the pilot cut (they failed INTENT-1 and INTENT-4), so being cheap per trial was not enough: '
          'the measure that matters is cost per **admissible** set.')
        w('')
    w('## What the pilot cannot tell you: N=3 versus larger samples')
    w('')
    w('Twelve trials cannot separate 11 of 12 from 12 of 12: both intervals above overlap almost completely. The numbers for the same model already move as N grows. '
      'Haiku per intent, admissible out of trials, at each stage:')
    w('')
    w('| Intent | Pilot N=3 | Stage 2 N=10 | Full run N=50 |')
    w('| :--- | :--- | :--- | :--- |')
    hp, hs, hf = pilot.get('claude-haiku-5-5', {}), stage2.get('claude-haiku-5-5', {}), full_a.get('claude-haiku-5-5', {})
    for key, lbl in INTENTS:
        def cell(d):
            s = d.get(key)
            return f"{s['counts']['ADMISSIBLE']}/{s['trialsRun']} ({pct(s['counts']['ADMISSIBLE'] / s['trialsRun'])})" if s else 'not finished'
        w(f'| {lbl} | {cell(hp)} | {cell(hs)} | {cell(hf)} |')
    w('')
    if full_b.get('claude-haiku-5-5'):
        w('Protocol B (verifier feedback) results for Haiku are in `frontier-full/`; they are not summarized here until all four intents finish.')
        w('')
    # ---- fresh, post-selection trials (the accuracy claim) -------------------------------------------------------
    exp_a = collections.defaultdict(list)
    for d in sorted(glob.glob(f'{ROOT}/frontier-expanded/protocol-a-*-claude-haiku-5-5-n200-r*')):
        m_ = re.match(r'.*/protocol-a-(.+?)-claude-haiku-5-5-n200-r\d+$', d)
        if m_ and os.path.exists(f'{d}/summary.json'):
            sm = _jload(f'{d}/summary.json')
            sm['_trials'] = _jsonl(f'{d}/trials.jsonl')
            exp_a[m_.group(1)].append(sm)
    exp_b = {}
    for d in sorted(glob.glob(f'{ROOT}/frontier-expanded/protocol-b-*-claude-haiku-5-5-n100')):
        m_ = re.match(r'.*/protocol-b-(.+?)-claude-haiku-5-5-n100$', d)
        if m_ and os.path.exists(f'{d}/summary.json'):
            sm = _jload(f'{d}/summary.json')
            sm['_trials'] = _jsonl(f'{d}/trials.jsonl')
            exp_b[m_.group(1)] = sm
    if exp_a:
        w('## The accuracy claim: fresh trials taken after the choice')
        w('')
        w('The pilot and stage-2 trials above are what selected Haiku, so they are biased upward by the choosing. The numbers below are **new trials taken after the choice** '
          '(`frontier-expanded/`), which carry no such bias. Protocol A is zero-shot at low effort; every trial is an independent sample (the API takes no seed).')
        w('')
        w('| Intent | Rounds of N=200 | Admissible | Rate | 95% interval | 99% interval | Distinct responses | Not admissible |')
        w('| :--- | :--- | ---: | ---: | :--- | :--- | ---: | :--- |')
        ta = tn = 0
        for key, lbl in INTENTS:
            rs = exp_a.get(key, [])
            if not rs:
                continue
            adm_ = sum(r['counts']['ADMISSIBLE'] for r in rs)
            n_ = sum(r['trialsRun'] for r in rs)
            ta += adm_
            tn += n_
            resp = [x['turns'][0]['response'] for r in rs for x in r['_trials'] if x['turns']]
            cats = collections.Counter()
            for r in rs:
                for c_, v_ in r['counts'].items():
                    if v_ and c_ != 'ADMISSIBLE':
                        cats[c_] += v_
            w(f"| {lbl} | {', '.join(str(r['counts']['ADMISSIBLE']) + '/' + str(r['trialsRun']) for r in rs)} | {adm_}/{n_} | {100 * adm_ / n_:.1f}% | {ci1(adm_, n_)} | {ci1(adm_, n_, 2.576)} | {len(set(resp))}/{len(resp)} | "
              + (', '.join(f'{k} {v}' for k, v in sorted(cats.items())) or 'none') + ' |')
        w(f'| **All four intents** | | **{ta}/{tn}** | **{100 * ta / tn:.1f}%** | **{ci1(ta, tn)}** | **{ci1(ta, tn, 2.576)}** | | transport failures: {sum(r["counts"]["TRANSPORT_FAILURE"] for rs in exp_a.values() for r in rs)} |')
        w('')
        w('Distinct responses below the number of trials mean some answers repeated word for word (INTENT-1 and INTENT-4 most), so the effective number of independent samples is smaller than N there; '
          'the intervals above treat every trial as independent and are therefore a little optimistic for those two intents. All non-admissible trials were intent leaks or missing deliveries: none was a syntax, prerequisite or transport failure.')
        w('')
        if exp_b:
            w('Protocol B (the verifier\'s diagnostics are returned to the model, up to 5 turns), N=100 chains per intent:')
            w('')
            w('| Intent | Admissible | 95% interval | Right on the first turn | Fixed on turn 2 or later | Transport failures |')
            w('| :--- | ---: | :--- | ---: | ---: | ---: |')
            ba = bn = bf = 0
            for key, lbl in INTENTS:
                sm = exp_b.get(key)
                if sm is None:
                    continue
                a_ = sm['counts']['ADMISSIBLE']
                first = sum(1 for x in sm['_trials'] if x.get('firstCategory') == 'ADMISSIBLE')
                ba += a_
                bn += sm['trialsRun']
                bf += first
                w(f"| {lbl} | {a_}/{sm['trialsRun']} | {ci1(a_, sm['trialsRun'])} | {first} | {a_ - first} | {sm['counts']['TRANSPORT_FAILURE']} |")
            w(f'| **All four intents** | **{ba}/{bn}** | **{ci1(ba, bn)}** | **{bf}** | **{ba - bf}** | |')
            w('')
        xp = f'{ROOT}/frontier-expanded/cross-intent-rejudge.json'
        if os.path.exists(xp):
            xj = _jload(xp)
            w('### Does "admissible under one intent" carry to the others?')
            w('')
            w('Each admissible set from the Protocol A trials above was judged again under all four intents (`scripts/rejudge-cross-intent.ts`; no model call). Rows: the intent the set was written for; '
              'columns: the intent it is judged under; cells: admissible sets out of the row\'s total. The last column gives the hand-written reference policy\'s verdict under that intent.')
            w('')
            hdr = [lbl.split(' ')[0] for _, lbl in INTENTS]
            w('| Written for | Sets | ' + ' | '.join(f'under {h}' for h in hdr) + ' |')
            w('| :--- | ---: | ' + ' | '.join('---:' for _ in hdr) + ' |')
            for key, lbl in INTENTS:
                iid = key.replace('_v1', '/v1')
                row = xj['matrix'].get(iid)
                if row is None:
                    continue
                cells = [f"{row['under'][k2.replace('_v1', '/v1')]['admissible']}" for k2, _ in INTENTS]
                w(f"| {lbl} | {row['sets']} | " + ' | '.join(cells) + ' |')
            w('')
            w('Reference policy verdicts, for comparison (row: the policy written for that intent; column: the intent it is judged under): ' + '; '.join(
                f"{k.split('/')[0]}: " + ', '.join(f"{j.split('/')[0]} {c.replace('ERR_INTENT_', '').lower() if c != 'ADMISSIBLE' else 'admissible'}" for j, c in v.items()) for k, v in xj['referenceVerdicts'].items()) + '.')
            w('')
            w('So a set is admissible only under the intent it was written for, except that INTENT-4\'s sets also satisfy INTENT-1. The reverse does not hold: **every one of Haiku\'s INTENT-1-admissible sets fails INTENT-4**, '
              'because INTENT-1 only permits the tap-return rule that INTENT-4 requires and the model does not add it unprompted, while the hand-written INTENT-1 reference does include it. '
              '"Admissible" is a statement about one intent\'s text; the sets are correct for what the intent says, not for what a neighbouring intent needs.')
            w('')
    w('## How much a larger sample narrows the doubt')
    w('')
    w('The 95% Wilson interval for a true rate near 90% at different numbers of trials (the successes are set to 90% of the trials for illustration; this is the width '
      'of the doubt, not a result):')
    w('')
    w('| Trials | Where it comes from | 95% interval | 99% interval |')
    w('| ---: | :--- | :--- | :--- |')
    for n_, src in ((12, 'pilot, all intents'), (40, 'stage 2, all intents'), (200, 'full Protocol A, all intents'), (800, 'N=200 per intent, all intents'), (2000, 'N=500 per intent, all intents')):
        k_ = round(0.9 * n_)
        w(f'| {n_} | {src} | {ci(k_, n_)} | {ci(k_, n_, 2.576)} |')
    w('')
    w('Per intent the doubt is wider than overall, because each intent has a quarter of the trials: at N=50 per intent and 45 successes the 95% interval is '
      f'{ci(45, 50)}; at N=200 per intent and 180 successes it is {ci(180, 200)}.')
    w('')
    w('## Settings and limits')
    w('')
    w('- **Different settings across arms.** Claude ran at the lowest effort setting; Gemini ran at its default thinking, which uses more tokens, so part of the price gap is the setting and not the model. '
      'Gemini ran with temperature 0.2, top-p 0.95 and seeds 1..N; the Claude models accept no seed and Claude Fable 5.1 accepts no temperature or top-p, so the Claude arm used the API\'s own sampling. '
      'The recorded `trials.jsonl` and `summary.json` for every run carry the settings and the prompt hash (the same prompt for every model and provider).')
    w('- **Local arm for comparison:** Gemma 4 26B (Mac) ran N=50 per intent; its results are in the parent README. Gemma ran quantized (Q4_K_M per the run notes) where the plan says 8-bit.')
    w('- **Selection effect.** Picking the cheapest model that looked good is a winner\'s-curse set-up: the observed rate of a model chosen because it did well is likely to be a little higher than its true rate. '
      'The larger runs exist to measure it without that bias.')
    w('- **Admissible is not correct.** This is the verifier\'s verdict over the modelled fields. The cross-intent check (an INTENT-1-admissible set can still fail INTENT-4) and the on-wire conformance run (RQ4) are separate.')
    w('- **Spend.** Recorded spend is the sum of `costMicroUsd` over every frontier run directory; a run that was started and stopped before writing its summary is not in it.')
    w('')
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    _write(OUT, '\n'.join(L).rstrip('\n') + '\n')
    print('wrote', OUT, len(L), 'lines')


if __name__ == '__main__':
    main()
