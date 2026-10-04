#!/usr/bin/env python3
"""Build the benchmark timeline from stored physical-run artifacts.

usage: build_timeline.py [--status FILE] RESULTS_DIR [RESULTS_DIR ...]

Reads provenance.startedAtIso and the monotonic span (finishedMonotonicNs - startedMonotonicNs) of every artifact,
orders runs by start time, and prints (a) a run table and (b) gaps between consecutive runs. Run durations are the
harness's own monotonic span, not wall-clock estimates. Interpretation of gaps (engineering time, outages) is done
in the run-breakdown document, not here.
"""
import datetime as dt
import glob
import json
import os
import sys
from typing import Any, Dict, List, Optional, Tuple

Json = Dict[str, Any]


def u(x: Any) -> int:
    if isinstance(x, dict):
        return int(str(x['$bigint']))
    return int(x)


def parse(iso: str) -> dt.datetime:
    return dt.datetime.strptime(iso, '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=dt.timezone.utc)


def describe(j: Json) -> Tuple[str, str]:
    p = j.get('params', {})
    cmd = j['provenance'].get('command', 'run')
    if cmd == 'workday':
        done = j.get('completedWindows', len(j.get('windows', [])))
        return f"workday {p['profile']} {p['udpLoadPercent']}% tcp={p.get('tcpMbps', 'unbounded')}", f"{done}/{p['windows']} windows"
    if cmd == 'ladder':
        return f"ladder {p['layout']} {p['udpPayloadBytes']}B", f"{len(j['steps'])} steps"
    if cmd == 'sweep':
        return 'sweep', f"{len(j['trials'])} trials"
    if cmd == 'blackout':
        return 'blackout', f"{len(j['records'])} records"
    return 'dataplane run (3 depths)', f"{len(j.get('trials', []))} trials"


def fmt(sec: float) -> str:
    sec = int(round(sec))
    return f"{sec // 3600} h {sec % 3600 // 60:02d} min"


def main(dirs: List[str], status_file: Optional[str] = None) -> None:
    status: Optional[Json] = None
    if status_file:
        with open(status_file, encoding='utf-8') as sf:
            status = json.load(sf)
    runs = []
    for d in dirs:
        for f in glob.glob(os.path.join(d, '**', '*.json'), recursive=True):
            try:
                with open(f, encoding='utf-8') as fh:
                    j = json.load(fh)
            except ValueError as e:
                # A corrupt artifact must be visible to the operator, never silently dropped.
                print(f'error: cannot parse {f}: {e}', file=sys.stderr)
                raise SystemExit(2)
            prov = j.get('provenance') if isinstance(j, dict) else None
            if not prov or prov.get('origin') != 'physical_bench_run' or 'startedAtIso' not in prov:
                continue
            start = parse(prov['startedAtIso'])
            span = (u(prov['finishedMonotonicNs']) - u(prov['startedMonotonicNs'])) / 1e9
            what, size = describe(j)
            runs.append((start, span, what, size, os.path.relpath(f, os.path.dirname(dirs[0].rstrip('/')))))
    runs.sort()
    print('| # | start (UTC) | end (UTC) | duration | run | content | status | artifact |')
    print('| --- | --- | --- | --- | --- | --- | --- | --- |')
    by_status = {}
    total = 0.0
    for i, (s, span, what, size, f) in enumerate(runs, 1):
        e = s + dt.timedelta(seconds=span)
        total += span
        st = status['runs'].get(os.path.basename(f), ['unclassified', ''])[0] if status else '-'
        by_status[st] = by_status.get(st, 0.0) + span
        print(f"| {i} | {s:%m-%d %H:%M:%S} | {e:%m-%d %H:%M:%S} | {int(span // 60)} min {int(span % 60):02d} s | {what} | {size} | {st} | `{os.path.basename(f)}` |")
    print(f"\nTotal artifact-recorded run time: {total / 3600:.2f} h over {len(runs)} artifacts\n")
    print('Gaps between consecutive artifacts longer than 2 minutes:\n')
    print('| after run | gap start (UTC) | gap end (UTC) | gap |')
    print('| --- | --- | --- | --- |')
    for a, b in zip(runs, runs[1:]):
        a_end = a[0] + dt.timedelta(seconds=a[1])
        gap = (b[0] - a_end).total_seconds()
        if gap > 120:
            print(f"| {a[2]} | {a_end:%m-%d %H:%M:%S} | {b[0]:%m-%d %H:%M:%S} | {int(gap // 3600)} h {int(gap % 3600 // 60):02d} min |")


    if status:
        accounting(status, total, by_status)


def accounting(status: Json, artifact_total: float, by_status: Dict[str, float]) -> None:
    def t(x: str) -> dt.datetime:
        return dt.datetime.strptime(x, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=dt.timezone.utc)
    cal = (t(status['spans']['calendar_end']) - t(status['spans']['calendar_start'])).total_seconds()
    extra = {}
    for r in status.get('extra_runs', []):
        d = (t(r['end']) - t(r['start'])).total_seconds()
        extra[r['status']] = extra.get(r['status'], 0.0) + d
    inc = {}
    for i in status['incidents']:
        d = (t(i['end']) - t(i['start'])).total_seconds()
        inc[i['category']] = inc.get(i['category'], 0.0) + d
    measured = artifact_total + sum(extra.values())
    other = cal - measured - sum(inc.values())
    assert other >= 0, 'overlapping intervals in the status file'
    stalls = inc.get('stall', 0.0)
    print('\n### Time accounting\n')
    print('| component | duration |')
    print('| --- | --- |')
    print(f"| Calendar span ({status['spans']['calendar_start']} to {status['spans']['calendar_end']}) | {fmt(cal)} |")
    for k in sorted(by_status, key=lambda k: -by_status[k]):
        print(f"| Measurement recorded in artifacts: {k} | {fmt(by_status[k])} |")
    for k in sorted(extra, key=lambda k: -extra[k]):
        print(f"| Measurement without an artifact: {k} | {fmt(extra[k])} |")
    print(f"| Idle: no benchmark requested (incident G) | {fmt(inc.get('idle', 0.0))} |")
    print(f"| Harness development between runs (incident H) | {fmt(inc.get('development', 0.0))} |")
    print(f"| **Stalls (incidents A, B, C, D)** | **{fmt(stalls)}** |")
    print(f"| Driver overhead, inter-run gaps and short analysis pauses (remainder) | {fmt(other)} |")
    print(f"| **Calendar span excluding stalls** | **{fmt(cal - stalls)}** |")
    print(f"| Calendar span excluding stalls, idle time and harness development | {fmt(cal - stalls - inc.get('idle', 0.0) - inc.get('development', 0.0))} |")
    print(f"| Total measurement time (artifacts + extra runs) | {fmt(measured)} |")
    print('\n### Incidents\n')
    print('| id | category | start (UTC) | end (UTC) | duration | cause |')
    print('| --- | --- | --- | --- | --- | --- |')
    for i in status['incidents']:
        d = (t(i['end']) - t(i['start'])).total_seconds()
        print(f"| {i['id']} | {i['category']} | {i['start'][5:19].replace('T', ' ')} | {i['end'][5:19].replace('T', ' ')} | {fmt(d)} | {i['cause']} |")


if __name__ == '__main__':
    args = sys.argv[1:]
    status_file = None
    if args and args[0] == '--status':
        status_file, args = args[1], args[2:]
    main(args or ['.'], status_file)
