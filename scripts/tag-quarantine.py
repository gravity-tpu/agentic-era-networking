#!/usr/bin/env python3
"""Does a quarantine DROP match a tagged frame? Pre-registration: docs/benchmarks/results/scenario5-tag-quarantine/PREREGISTRATION.md (read it first; this script does what it registers).

Installs ONE quarantine of 10.0.2.101 on the live bridge (POST /api/sdn/quarantine, then /approve if the bridge is in propose mode; both are loopback-only, so they are made over ssh to the Jetson),
sends five classes of frame from agentic-node-02's workload interface (eth1) through the bind guard, releases the quarantine on every exit path, and refuses to finish clean unless the final status
is verified/drops with 0 quarantines. The switch-side hard timeout of the quarantine removes it on its own if this process dies. Counting, the verdict rules and the choreography are in
scripts/tag_quarantine_lib.py; the observers and the preflight are those of scripts/workload-frames.py.

Usage: python3 scripts/tag-quarantine.py LABEL --dry-run | --owner-go-for-install
  --dry-run: the preflight, the status gate, the mode read and the capture plumbing; nothing is installed and nothing is sent.
  --owner-go-for-install: required for the real run, and only to be passed after the owner has said go for this install in so many words (Invariant 4: a person approves the install).
Prints one JSON line. Needs ssh to jetson and agentic-node-02; node-02's wlan0 down.
"""
import importlib.util, json, os, shlex, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import table_miss_lib as tm
import workload_frames_lib as wf
import tag_quarantine_lib as tq

_spec = importlib.util.spec_from_file_location('workload_frames_runner', os.path.join(HERE, 'workload-frames.py'))
wfs = importlib.util.module_from_spec(_spec)   # the observers, preflight, status read and sender of the scenario 5 runner, not copied
_spec.loader.exec_module(wfs)

REASON = 'tag-quarantine experiment (pre-registered), time-limited and released by the script'

def jetson_api(method, path, body=None):
    cmd = f'curl -s -m 10 -X {method} localhost:3003{path}'
    if body is not None:
        cmd += " -H 'content-type: application/json' -d " + shlex.quote(json.dumps(body))
    r = wfs.remote(wfs.JETSON, cmd, 30)
    if not r.ok:
        return None, r.reason
    try:
        return json.loads(r.out), r.out[:200]
    except ValueError:
        return None, f'not JSON: {r.out[:120]!r}'

def mode():
    r = wfs.remote(wfs.JETSON, 'curl -s -m 8 localhost:3003/api/sdn/quarantine/proposals', 30)
    return {'error': r.reason} if not r.ok else tq.parse_mode(r.out)

def install(ip):
    body, detail = jetson_api('POST', '/api/sdn/quarantine', {'targetIp': ip, 'reason': REASON})
    if body is None:
        return False, f'the request failed: {detail}'
    if body.get('quarantined'):
        return True, f'installed directly (enforce mode): {detail}'
    if not body.get('proposed'):
        return False, f'refused by the bridge: {detail}'
    body, detail = jetson_api('POST', '/api/sdn/quarantine/approve', {'targetIp': ip})
    if body is None or not body.get('quarantined'):
        return False, f'the approval did not install it: {detail}'
    return True, f'proposed, then approved: {detail}'

def release(ip):
    body, detail = jetson_api('POST', '/api/sdn/release', {'targetIp': ip, 'reason': REASON})
    return (body is not None), detail

def main():
    if len(sys.argv) < 2 or sys.argv[1].startswith('--'):
        print(__doc__); return 2
    label, dry, go = sys.argv[1], '--dry-run' in sys.argv, '--owner-go-for-install' in sys.argv
    if dry == go:
        print(json.dumps({'label': label, 'error': 'refusing to install anything: pass exactly one of --dry-run, or --owner-go-for-install once the owner has said go for the install'})); return 2
    ok, report = wfs.preflight()
    out = {'label': label, 'preflight': report}
    if not ok:
        out['error'] = f'refusing to start: the adversary preflight did not pass ({report if isinstance(report, str) else report.get("refusalReason")})'
        print(json.dumps(out)); return 1
    deps = tq.Deps(tm.ssh_runner, wfs.OBSERVERS, wfs.make_send(False), wfs.status, mode, install, release, time.sleep, lambda: time.monotonic_ns() // 1_000_000)
    out.update(tq.dry_run(deps, label) if dry else tq.run_experiment(deps, label))
    out['at'] = time.strftime('%H:%M:%S')
    print(json.dumps(out))
    if dry:
        return 0 if not out.get('invalid') and 'error' not in out else 1
    return 1 if out.get('stop') or 'error' in out else 0

if __name__ == '__main__':
    sys.exit(main())
