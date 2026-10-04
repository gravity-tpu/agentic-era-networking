#!/usr/bin/env python3
"""Build the benchmark timeline from stored physical-run artifacts.

usage: build_timeline.py [--status FILE] RESULTS_DIR [RESULTS_DIR ...]

Reads provenance.startedAtIso and the monotonic span (finishedMonotonicNs - startedMonotonicNs) of every artifact,
orders runs by start time, and prints (a) a run table and (b) gaps between consecutive runs. With --status it also
classifies runs and incidents and prints the time accounting. Run durations are the harness's own monotonic span.
Interpretation of gaps (engineering time, outages) is in the run-breakdown document, not here.

All arithmetic is exact: durations are integer nanoseconds and decimal strings are produced by integer rounding
(see artifact_types.py). No floating point is used.
"""
import datetime as dt
import glob
import os
import sys
from fractions import Fraction
from typing import Dict, List, Optional, Tuple, cast

from artifact_types import (
    AnyArtifact, BlackoutArtifact, LadderArtifact, RunStatus, TrialsArtifact, WorkdayArtifact, fixed, kind, read_artifact,
    read_run_status, u,
)

NS_PER_S = 10 ** 9
Run = Tuple[dt.datetime, int, str, str, str]  # start, span in ns, what, size, artifact path


def parse(iso: str) -> dt.datetime:
    return dt.datetime.strptime(iso, '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=dt.timezone.utc)


def parse_s(iso: str) -> dt.datetime:
    return dt.datetime.strptime(iso, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=dt.timezone.utc)


def span_delta(span_ns: int) -> dt.timedelta:
    return dt.timedelta(microseconds=span_ns // 1000)


def describe(art: AnyArtifact) -> Tuple[str, str]:
    cmd = kind(art)
    if cmd == 'workday':
        w = cast(WorkdayArtifact, art)
        p = w['params']
        done = w.get('completedWindows', len(w['windows']))
        return f"workday {p['profile']} {p['udpLoadPercent']}% tcp={p.get('tcpMbps', 'unbounded')}", f"{done}/{p['windows']} windows"
    if cmd == 'ladder':
        lad = cast(LadderArtifact, art)
        return f"ladder {lad['params']['layout']} {lad['params']['udpPayloadBytes']}B", f"{len(lad['steps'])} steps"
    if cmd == 'sweep':
        return 'sweep', f"{len(cast(TrialsArtifact, art)['trials'])} trials"
    if cmd == 'blackout':
        return 'blackout', f"{len(cast(BlackoutArtifact, art)['records'])} records"
    return 'dataplane run (3 depths)', f"{len(cast(TrialsArtifact, art)['trials'])} trials"


def hm(seconds: int) -> str:
    return f'{seconds // 3600} h {seconds % 3600 // 60:02d} min'


def fmt_ns(ns: int) -> str:
    """Hours and minutes of a nanosecond duration, rounded to the nearest whole second first."""
    return hm(round(Fraction(ns, NS_PER_S)))


def collect(dirs: List[str]) -> List[Run]:
    runs: List[Run] = []
    for d in dirs:
        for f in glob.glob(os.path.join(d, '**', '*.json'), recursive=True):
            art = read_artifact(f)
            if art is None:
                continue
            prov = art['provenance']
            span = u(prov['finishedMonotonicNs']) - u(prov['startedMonotonicNs'])
            what, size = describe(art)
            runs.append((parse(prov['startedAtIso']), span, what, size, f))
    runs.sort(key=lambda r: r[0])
    return runs


def main(dirs: List[str], status_file: Optional[str] = None) -> None:
    status: Optional[RunStatus] = read_run_status(status_file) if status_file else None
    runs = collect(dirs)
    print('| # | start (UTC) | end (UTC) | duration | run | content | status | artifact |')
    print('| --- | --- | --- | --- | --- | --- | --- | --- |')
    by_status: Dict[str, int] = {}
    total_ns = 0
    for i, (s, span, what, size, f) in enumerate(runs, 1):
        e = s + span_delta(span)
        total_ns += span
        st = status['runs'].get(os.path.basename(f), ['unclassified', ''])[0] if status else '-'
        by_status[st] = by_status.get(st, 0) + span
        secs = span // NS_PER_S
        print(f"| {i} | {s:%m-%d %H:%M:%S} | {e:%m-%d %H:%M:%S} | {secs // 60} min {secs % 60:02d} s | {what} | {size} | {st} | `{os.path.basename(f)}` |")
    print(f"\nTotal artifact-recorded run time: {fixed(Fraction(total_ns, 3600 * NS_PER_S), 2)} h over {len(runs)} artifacts\n")
    print('Gaps between consecutive artifacts longer than 2 minutes:\n')
    print('| after run | gap start (UTC) | gap end (UTC) | gap |')
    print('| --- | --- | --- | --- |')
    for a, b in zip(runs, runs[1:]):
        a_end = a[0] + span_delta(a[1])
        gap = (b[0] - a_end) // dt.timedelta(seconds=1)
        if gap > 120:
            print(f"| {a[2]} | {a_end:%m-%d %H:%M:%S} | {b[0]:%m-%d %H:%M:%S} | {gap // 3600} h {gap % 3600 // 60:02d} min |")
    if status:
        accounting(status, total_ns, by_status)


def seconds_between(start: str, end: str) -> int:
    return (parse_s(end) - parse_s(start)) // dt.timedelta(seconds=1)


def accounting(status: RunStatus, artifact_total_ns: int, by_status: Dict[str, int]) -> None:
    spans = status['spans']
    cal = seconds_between(spans['calendar_start'], spans['calendar_end'])
    extra: Dict[str, int] = {}
    for r in status.get('extra_runs', []):
        extra[r['status']] = extra.get(r['status'], 0) + seconds_between(r['start'], r['end'])
    inc: Dict[str, int] = {}
    for i in status['incidents']:
        inc[i['category']] = inc.get(i['category'], 0) + seconds_between(i['start'], i['end'])
    artifact_total = round(Fraction(artifact_total_ns, NS_PER_S))
    measured = artifact_total + sum(extra.values())
    other = cal - measured - sum(inc.values())
    assert other >= 0, 'overlapping intervals in the status file'
    stalls = inc.get('stall', 0)
    dev = inc.get('development', 0)
    idle = inc.get('idle', 0)
    print('\n### Time accounting\n')
    print('| component | duration |')
    print('| --- | --- |')
    print(f"| Calendar span ({spans['calendar_start']} to {spans['calendar_end']}) | {hm(cal)} |")
    for k in sorted(by_status, key=lambda k: -by_status[k]):
        print(f'| Measurement recorded in artifacts: {k} | {fmt_ns(by_status[k])} |')
    for k in sorted(extra, key=lambda k: -extra[k]):
        print(f'| Measurement without an artifact: {k} | {hm(extra[k])} |')
    print(f'| Idle: no benchmark requested (incident G) | {hm(idle)} |')
    print(f'| Harness development between runs (incident H) | {hm(dev)} |')
    print(f'| **Stalls (incidents A, B, C, D)** | **{hm(stalls)}** |')
    print(f'| Driver overhead, inter-run gaps and short analysis pauses (remainder) | {hm(other)} |')
    print(f'| **Calendar span excluding stalls** | **{hm(cal - stalls)}** |')
    print(f'| Calendar span excluding stalls, idle time and harness development | {hm(cal - stalls - idle - dev)} |')
    print(f'| Total measurement time (artifacts + extra runs) | {hm(measured)} |')
    print('\n### Incidents\n')
    print('| id | category | start (UTC) | end (UTC) | duration | cause |')
    print('| --- | --- | --- | --- | --- | --- |')
    for i in status['incidents']:
        d = seconds_between(i['start'], i['end'])
        print(f"| {i['id']} | {i['category']} | {i['start'][5:19].replace('T', ' ')} | {i['end'][5:19].replace('T', ' ')} | {hm(d)} | {i['cause']} |")


if __name__ == '__main__':
    args = sys.argv[1:]
    status_file: Optional[str] = None
    if args and args[0] == '--status':
        status_file, args = args[1], args[2:]
    main(args or ['.'], status_file)
