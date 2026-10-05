#!/usr/bin/env python3
"""Summarise the Zodiac FX depth / ladder / workday / blackout artifacts.

usage: analyze_depth.py [--windows|--steps] DIR [DIR ...]   (DIRs under docs/benchmarks/results/ that hold depth-*.json artifacts)

Prints markdown tables from stored physical-run artifacts (provenance.origin == physical_bench_run). All arithmetic is
exact (integers and fractions.Fraction, see artifact_types.py); no floating point is used.
"""
import collections
import glob
import os
import sys
from dataclasses import dataclass, field
from fractions import Fraction
from typing import Dict, List, Optional, Tuple, cast

from artifact_types import (
    AnyArtifact, BlackoutArtifact, LadderArtifact, WorkdayArtifact, fixed, kind, least_squares, median, median_frac,
    read_artifact, u,
)

NS_PER_S = 10 ** 9


def load_all(dirs: List[str], pattern: str) -> List[Tuple[str, AnyArtifact]]:
    out: List[Tuple[str, AnyArtifact]] = []
    for d in dirs:
        for f in sorted(glob.glob(os.path.join(d, pattern))):
            art = read_artifact(f)
            if art is not None:
                out.append((f, art))
    return out


def load_ladders(dirs: List[str]) -> List[Tuple[str, LadderArtifact]]:
    return [(f, cast(LadderArtifact, a)) for f, a in load_all(dirs, 'depth-ladder-*.json') if kind(a) == 'ladder']


def load_workdays(dirs: List[str]) -> List[Tuple[str, WorkdayArtifact]]:
    return [(f, cast(WorkdayArtifact, a)) for f, a in load_all(dirs, 'depth-workday-*.json') if kind(a) == 'workday']


def load_blackouts(dirs: List[str]) -> List[Tuple[str, BlackoutArtifact]]:
    return [(f, cast(BlackoutArtifact, a)) for f, a in load_all(dirs, 'depth-blackout-*.json') if kind(a) == 'blackout']


def fit(points: List[Tuple[int, int]]) -> Optional[Tuple[Fraction, Fraction]]:
    """Exact least squares t = a + b*depth over (depth, pps) points, t in microseconds per packet."""
    return least_squares([(Fraction(d), Fraction(10 ** 6, p)) for d, p in points if p > 0])


@dataclass
class LadderGroup:
    cap: Dict[int, int] = field(default_factory=dict)    # highest forwarded pps in any step without a session loss
    sat: Dict[int, int] = field(default_factory=dict)    # highest forwarded pps in a saturated step (a true capacity)
    lost: Dict[int, int] = field(default_factory=dict)   # lowest offered pps at which a session loss occurred


def ladders(dirs: List[str]) -> Dict[Tuple[str, int], LadderGroup]:
    groups: Dict[Tuple[str, int], LadderGroup] = collections.defaultdict(LadderGroup)
    for _, j in load_ladders(dirs):
        p = j['params']
        key = (p['layout'], p['udpPayloadBytes'])
        g = groups[key]
        for s in j['steps']:
            m = s['trial']['metrics']
            off = u(s['offeredPps'])
            depth = s['depth']
            if s['sessionLost']:
                g.lost[depth] = min(g.lost.get(depth, 10 ** 9), off)
                continue
            if m is None or key[0].startswith('hit'):
                continue
            p2 = u(m['switchPort2TxPps'])
            if p2 * 100 < off * 90:  # saturated: the forwarded rate is the capacity
                g.sat[depth] = max(g.sat.get(depth, 0), p2)
            g.cap[depth] = max(g.cap.get(depth, 0), p2)
    return groups


def outage_seconds(losses: List[Dict[str, int]]) -> Fraction:
    return Fraction(sum(x['reconnect'] + x['reinstall'] for x in losses), NS_PER_S)


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
        cells: List[str] = []
        for d in depths:
            if d not in g.cap:
                cells.append('-')
                continue
            star = '*' if d in g.sat else ''
            lost = f' [{g.lost[d]}]' if d in g.lost else ''
            cells.append(f'{g.cap[d]}{star}{lost}')
        pts = [(d, g.sat[d]) for d in g.sat]
        f = fit(pts)
        fs = f'{fixed(f[0], 1)} + {fixed(f[1], 2)} x rules (n={len(pts)})' if f else 'n/a'
        print(f'| {layout} | {payload} | ' + ' | '.join(cells) + f' | {fs} |')
    print()


def print_workday(dirs: List[str]) -> None:
    print('## Working-window runs\n')
    print('| profile | UDP load | TCP cap | windows done | session losses | outage s (reconnect+reinstall) | p1 RX pps by rule count (median) |')
    print('| --- | --- | --- | --- | --- | --- | --- |')
    for _, j in load_workdays(dirs):
        p = j['params']
        wins = j['windows']
        if not wins:
            continue
        losses = [{'reconnect': u(l['reconnectNs']), 'reinstall': u(l['reinstallNs'])} for w in wins for l in w['sessionLosses']]
        by: Dict[int, List[int]] = collections.defaultdict(list)
        for w in wins:
            for s in w['samples']:
                by[s['rules'] // 4 * 4].append(u(s['p1RxPps']))
        curve = ', '.join(f'{k}-{k + 3}: {int(median(v))}' for k, v in sorted(by.items()))
        tcp = p.get('tcpMbps', 'unbounded')
        print(f"| {p['profile']} ({p['targetRulesPerWindow']} rules) | {p['udpLoadPercent']}% = {u(p['udpPps'])} pps | {tcp} Mbit/s | {len(wins)}/{p['windows']} | {len(losses)} | {fixed(outage_seconds(losses), 1)} | {curve} |")
    print()


def print_blackout(dirs: List[str]) -> None:
    print('## Flush / reinstall blackout (ping every 10 ms from the workload node)\n')
    for f, j in load_blackouts(dirs):
        recs = j['records']
        load_pps = j['params'].get('loadPps', 'line rate')
        print(f"Artifact `{os.path.basename(f)}`: load {load_pps} pps when loaded; {len(recs)} records, {sum(1 for r in recs if r['error'])} with errors.\n")
        print('| depth | flush mode | load | n | median max ping gap ms | median flush-to-verified ms |')
        print('| --- | --- | --- | --- | --- | --- |')
        g: Dict[Tuple[int, str, bool], list] = collections.defaultdict(list)
        for r in recs:
            g[(r['depth'], r['mode'], r['loaded'])].append(r)
        for (d, m, loaded), rs in sorted(g.items()):
            gaps = [Fraction(u(r['maxGapUs']), 1000) for r in rs if r['maxGapUs'] is not None]
            fl = [Fraction(u(r['flushToVerifiedNs']), 10 ** 6) for r in rs if r['flushToVerifiedNs'] is not None]
            gap_s = fixed(median_frac(gaps), 0)
            fl_s = fixed(median_frac(fl), 0) if fl else 'nan'
            print(f"| {d} | {m} | {'udp' if loaded else 'idle'} | {len(rs)} | {gap_s} | {fl_s} |")
        print()


def print_events(dirs: List[str]) -> None:
    print('## OpenFlow session events per artifact\n')
    print('| artifact | disconnects | controller dead-peer timeouts | median echo RTT ms | p99 echo RTT ms |')
    print('| --- | --- | --- | --- | --- |')
    for f, j in load_all(dirs, 'depth-*.json'):
        ev = j.get('sessionEvents')
        if not ev:
            continue
        rtt = sorted(Fraction(u(e['detail']), 10 ** 6) for e in ev if e['event'] == 'echoLatency' and not isinstance(e['detail'], str))
        dis = sum(1 for e in ev if e['event'] == 'disconnected')
        dead = sum(1 for e in ev if e['event'] == 'deadPeerTimeout')
        med = fixed(median_frac(rtt), 2) if rtt else 'nan'
        p99 = fixed(rtt[len(rtt) * 99 // 100 - 1], 1) if len(rtt) > 1 else 'nan'
        print(f'| {os.path.basename(f)} | {dis} | {dead} | {med} | {p99} |')
    print()


def print_window_detail(dirs: List[str]) -> None:
    print('## Working-window runs: per-window detail\n')
    for f, j in load_workdays(dirs):
        p = j['params']
        wins = j['windows']
        if len(wins) < 2:
            continue
        tcp = p.get('tcpMbps', 'unbounded')
        print(f"### {os.path.basename(f)}: {p['profile']} profile, UDP {p['udpLoadPercent']}% ({u(p['udpPps'])} pps), TCP cap {tcp} Mbit/s, {len(wins)}/{p['windows']} windows\n")
        print('| window | rules at end | median p1 RX pps | min p1 RX pps | session losses | outage s | flush-to-verified ms |')
        print('| --- | --- | --- | --- | --- | --- | --- |')
        for w in wins:
            pps = [u(s['p1RxPps']) for s in w['samples']]
            losses = [{'reconnect': u(l['reconnectNs']), 'reinstall': u(l['reinstallNs'])} for l in w['sessionLosses']]
            fl_ns = w['flushToVerifiedNs']
            fl = fixed(Fraction(u(fl_ns), 10 ** 6), 0) if fl_ns is not None else 'nan'
            rules = w['samples'][-1]['rules'] if w['samples'] else 0
            med = int(median(pps)) if pps else 0
            print(f"| {w['index'] + 1} | {rules} | {med} | {min(pps) if pps else 0} | {len(losses)} | {fixed(outage_seconds(losses), 1)} | {fl} |")
        print()


def print_ladder_steps(dirs: List[str]) -> None:
    print('## Rate ladder: every step\n')
    print('`fwd` = packets per second the switch forwarded (Port 2 TX); `lost` marks a step during or just after which the OpenFlow session was lost; `echo+` is the time to the first echo reply after the load ended.\n')
    for f, j in load_ladders(dirs):
        p = j['params']
        if len(j['steps']) < 6:
            continue
        print(f"### {os.path.basename(f)}: layout {p['layout']}, payload {p['udpPayloadBytes']} B, {p['stepSeconds']} s steps\n")
        print('| depth | offered pps | fwd pps | receiver loss ppm | session lost | echo+ ms | stop reason |')
        print('| --- | --- | --- | --- | --- | --- | --- |')
        for s in j['steps']:
            m = s['trial']['metrics']
            fwd = str(u(m['switchPort2TxPps'])) if m else 'n/a'
            loss_v = m['iperfLossPpm'] if m else None
            loss = str(u(loss_v)) if loss_v is not None else 'n/a'
            echo = s['echoRecoveryNs']
            e = str(u(echo) // 10 ** 6) if echo is not None else 'n/a'
            print(f"| {s['depth']} | {u(s['offeredPps'])} | {fwd} | {loss} | {'yes' if s['sessionLost'] else 'no'} | {e} | {s['stopped'] or ''} |")
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
