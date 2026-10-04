#!/usr/bin/env python3
"""Summarise the Zodiac FX depth / ladder / workday / blackout artifacts.

usage: analyze_depth.py [--windows|--steps] DIR [DIR ...]   (DIRs under docs/benchmarks/results/ that hold depth-*.json artifacts)

Prints markdown tables. This is analysis of stored physical-run artifacts (provenance.origin == physical_bench_run);
the floating-point arithmetic here is presentation only, not packet accounting.
"""
import collections
import glob
import json
import os
import statistics
import sys
from typing import Any, Dict, List, Optional, Tuple

Json = Dict[str, Any]


def u(x: Any) -> int:
    """Decode the artifact's {"$bigint": "..."} integers; plain numbers pass through."""
    if isinstance(x, dict):
        return int(str(x['$bigint']))
    return int(x)


def load(dirs: List[str], pattern: str) -> List[Tuple[str, Json]]:
    out = []
    for d in dirs:
        for f in sorted(glob.glob(os.path.join(d, pattern))):
            try:
                with open(f, encoding='utf-8') as fh:
                    j = json.load(fh)
            except ValueError as e:
                # A corrupt artifact must be visible to the operator, never silently dropped.
                print(f'error: cannot parse {f}: {e}', file=sys.stderr)
                raise SystemExit(2)
            if j.get('provenance', {}).get('origin') != 'physical_bench_run':
                continue
            out.append((f, j))
    return out


def fit(points: List[Tuple[int, int]]) -> Optional[Tuple[float, float]]:
    """least squares t = a + b*depth over (depth, pps) points; returns (a_us, b_us) or None."""
    pts = [(d, 1e6 / p) for d, p in points if p > 0]
    if len(pts) < 2:
        return None
    n = len(pts)
    mx = sum(d for d, _ in pts) / n
    my = sum(t for _, t in pts) / n
    den = sum((d - mx) ** 2 for d, _ in pts)
    if den == 0:
        return None
    b = sum((d - mx) * (t - my) for d, t in pts) / den
    return my - b * mx, b


def ladders(dirs: List[str]) -> Dict[Tuple[str, int], Json]:
    groups = collections.defaultdict(lambda: {'cap': {}, 'sat': {}, 'lost': {}, 'clean': {}, 'files': set()})
    for f, j in load(dirs, 'depth-ladder-*.json'):
        p = j['params']
        key = (p['layout'], p['udpPayloadBytes'])
        g = groups[key]
        g['files'].add(os.path.basename(f))
        for s in j['steps']:
            m = s['trial']['metrics']
            off = u(s['offeredPps'])
            depth = s['depth']
            if s['sessionLost']:
                g['lost'][depth] = min(g['lost'].get(depth, 10 ** 9), off)
                continue
            if m is None or key[0].startswith('hit'):
                continue
            p2 = u(m['switchPort2TxPps'])
            g['clean'][depth] = max(g['clean'].get(depth, 0), p2 if p2 * 100 >= off * 90 else 0)
            if p2 * 100 < off * 90:  # saturated: forwarded rate is the capacity
                g['sat'][depth] = max(g['sat'].get(depth, 0), p2)
            g['cap'][depth] = max(g['cap'].get(depth, 0), p2)
    return groups


def print_ladders(dirs: List[str]) -> None:
    groups = ladders(dirs)
    print('## Rate ladder: maximum forwarded packets/s by rule depth\n')
    print('`cap` = highest forwarded rate in any step without a session loss; `*` = the switch was saturated there (a true capacity); `[x]` = lowest offered rate at which a session loss occurred.\n')
    depths = [0, 16, 32, 64, 126]
    print('| layout | payload B | ' + ' | '.join(str(d) for d in depths) + ' | fit: fixed us + per-rule us |')
    print('| --- | --- | ' + ' | '.join('---' for _ in depths) + ' | --- |')
    for (layout, payload), g in sorted(groups.items()):
        if layout.startswith('hit'):
            continue
        cells = []
        for d in depths:
            if d not in g['cap']:
                cells.append('-')
                continue
            star = '*' if d in g['sat'] else ''
            lost = f" [{g['lost'][d]}]" if d in g['lost'] else ''
            cells.append(f"{g['cap'][d]}{star}{lost}")
        pts = [(d, g['sat'][d]) for d in g['sat']]
        f = fit(pts)
        fs = f"{f[0]:.1f} + {f[1]:.2f} x rules (n={len(pts)})" if f else 'n/a'
        print(f"| {layout} | {payload} | " + ' | '.join(cells) + f' | {fs} |')
    print()


def print_workday(dirs: List[str]) -> None:
    print('## Working-window runs\n')
    print('| profile | UDP load | TCP cap | windows done | session losses | outage s (reconnect+reinstall) | p1 RX pps by rule count (median) |')
    print('| --- | --- | --- | --- | --- | --- | --- |')
    for f, j in load(dirs, 'depth-workday-*.json'):
        p = j['params']
        wins = j['windows']
        if not wins:
            continue
        losses = [l for w in wins for l in w['sessionLosses']]
        outage = sum(u(l['reconnectNs']) + u(l['reinstallNs']) for l in losses) / 1e9
        by = collections.defaultdict(list)
        for w in wins:
            for s in w['samples']:
                by[s['rules'] // 4 * 4].append(u(s['p1RxPps']))
        curve = ', '.join(f"{k}-{k + 3}: {int(statistics.median(v))}" for k, v in sorted(by.items()))
        print(f"| {p['profile']} ({p['targetRulesPerWindow']} rules) | {p['udpLoadPercent']}% = {u(p['udpPps'])} pps | {p.get('tcpMbps', 'unbounded')} Mbit/s | {len(wins)}/{p['windows']} | {len(losses)} | {outage:.1f} | {curve} |")
    print()


def print_blackout(dirs: List[str]) -> None:
    print('## Flush / reinstall blackout (ping every 10 ms from the workload node)\n')
    for f, j in load(dirs, 'depth-blackout-*.json'):
        recs = j['records']
        print(f"Artifact `{os.path.basename(f)}`: load {j['params'].get('loadPps', 'line rate')} pps when loaded; {len(recs)} records, {sum(1 for r in recs if r['error'])} with errors.\n")
        print('| depth | flush mode | load | n | median max ping gap ms | median flush-to-verified ms |')
        print('| --- | --- | --- | --- | --- | --- |')
        g = collections.defaultdict(list)
        for r in recs:
            g[(r['depth'], r['mode'], r['loaded'])].append(r)
        for (d, m, l), rs in sorted(g.items()):
            gaps = [u(r['maxGapUs']) / 1000 for r in rs if r['maxGapUs'] is not None]
            fl = [u(r['flushToVerifiedNs']) / 1e6 for r in rs if r['flushToVerifiedNs'] is not None]
            print(f"| {d} | {m} | {'udp' if l else 'idle'} | {len(rs)} | {statistics.median(gaps):.0f} | {(statistics.median(fl) if fl else float('nan')):.0f} |")
        print()


def print_events(dirs: List[str]) -> None:
    print('## OpenFlow session events per artifact\n')
    print('| artifact | disconnects | controller dead-peer timeouts | median echo RTT ms | p99 echo RTT ms |')
    print('| --- | --- | --- | --- | --- |')
    for f, j in load(dirs, 'depth-*.json'):
        ev = j.get('sessionEvents')
        if not ev:
            continue
        rtt = sorted(u(e['detail']) / 1e6 for e in ev if e['event'] == 'echoLatency')
        dis = sum(1 for e in ev if e['event'] == 'disconnected')
        dead = sum(1 for e in ev if e['event'] == 'deadPeerTimeout')
        med = statistics.median(rtt) if rtt else float('nan')
        p99 = rtt[int(len(rtt) * 0.99) - 1] if len(rtt) > 1 else float('nan')
        print(f"| {os.path.basename(f)} | {dis} | {dead} | {med:.2f} | {p99:.1f} |")
    print()


def print_window_detail(dirs: List[str]) -> None:
    print('## Working-window runs: per-window detail\n')
    for f, j in load(dirs, 'depth-workday-*.json'):
        p = j['params']
        wins = j['windows']
        if len(wins) < 2:
            continue
        print(f"### {os.path.basename(f)}: {p['profile']} profile, UDP {p['udpLoadPercent']}% ({u(p['udpPps'])} pps), TCP cap {p.get('tcpMbps', 'unbounded')} Mbit/s, {len(wins)}/{p['windows']} windows\n")
        print('| window | rules at end | median p1 RX pps | min p1 RX pps | session losses | outage s | flush-to-verified ms |')
        print('| --- | --- | --- | --- | --- | --- | --- |')
        for w in wins:
            pps = [u(s_['p1RxPps']) for s_ in w['samples']]
            out = sum(u(l['reconnectNs']) + u(l['reinstallNs']) for l in w['sessionLosses']) / 1e9
            fl = u(w['flushToVerifiedNs']) / 1e6 if w['flushToVerifiedNs'] is not None else float('nan')
            rules = w['samples'][-1]['rules'] if w['samples'] else 0
            med = int(statistics.median(pps)) if pps else 0
            print(f"| {w['index'] + 1} | {rules} | {med} | {min(pps) if pps else 0} | {len(w['sessionLosses'])} | {out:.1f} | {fl:.0f} |")
        print()


def print_ladder_steps(dirs: List[str]) -> None:
    print('## Rate ladder: every step\n')
    print('`fwd` = packets per second the switch forwarded (Port 2 TX); `lost` marks a step during or just after which the OpenFlow session was lost; `echo+` is the time to the first echo reply after the load ended.\n')
    for f, j in load(dirs, 'depth-ladder-*.json'):
        p = j['params']
        if len(j['steps']) < 6:
            continue
        print(f"### {os.path.basename(f)}: layout {p['layout']}, payload {p['udpPayloadBytes']} B, {p['stepSeconds']} s steps\n")
        print('| depth | offered pps | fwd pps | receiver loss ppm | session lost | echo+ ms | stop reason |')
        print('| --- | --- | --- | --- | --- | --- | --- |')
        for s_ in j['steps']:
            m = s_['trial']['metrics']
            fwd = u(m['switchPort2TxPps']) if m else 'n/a'
            loss = u(m['iperfLossPpm']) if m and m['iperfLossPpm'] is not None else 'n/a'
            e = u(s_['echoRecoveryNs']) // 10 ** 6 if s_.get('echoRecoveryNs') is not None else 'n/a'
            print(f"| {s_['depth']} | {u(s_['offeredPps'])} | {fwd} | {loss} | {'yes' if s_['sessionLost'] else 'no'} | {e} | {s_['stopped'] or ''} |")
        print()


if __name__ == '__main__':
    args = sys.argv[1:]
    mode = 'summary'
    if args and args[0] in ('--windows', '--steps'):
        mode, args = args[0], args[1:]
    dirs = args or ['.']
    if mode == '--windows':
        print_window_detail(dirs)
    elif mode == '--steps':
        print_ladder_steps(dirs)
    else:
        print_ladders(dirs)
        print_workday(dirs)
        print_blackout(dirs)
        print_events(dirs)
