#!/usr/bin/env python3
"""Track C scenario 5, narrowed: frames from the workload side that the policy should not forward. Pre-registration:
docs/benchmarks/results/scenario5-workload-frames/PREREGISTRATION.md (read it before running; this script does what it registers and nothing else).

agentic-node-02 (the adversary) sends 18 frame classes from its workload interface (eth1 on that host; see scripts/track-c-scenario1-arp-spoof.py for why not eth0) into the Zodiac P1,
in three groups, each opened by two positive controls. Observers on the Jetson: O3 (the mirror of the Zodiac P2 link: what left the uplink) and O2 (the P3 tap: the frame arrived).
Counting, validity and the verdict rules are in scripts/workload_frames_lib.py; nothing is installed on the switch and no fault is injected.

Refuses to send unless, in this order: node-02's adversary-bind.py preflight reports ok (no unexcused route to the lab LAN; control channels eth0 and tailscale0 declared by name), the isolation
status is verified/drops with no quarantine, and every capture is proven listening. A breach, an unexplained frame at O3, a failed control, an invalid observer, a quarantine appearing or a
status change stops the run before the next group.

Usage: python3 scripts/workload-frames.py LABEL [--dry-run] [--groups 1,2,3]
  --dry-run: preflight, status and the capture plumbing for group 1 with no frame sent (the controls then read 0 and the group is void by design; what matters is `invalid` being empty).
Prints one JSON line. Needs ssh to jetson and agentic-node-02.
"""
import base64, json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import table_miss_lib as tm
import workload_frames_lib as wf

JETSON, NODE02 = 'jetson', 'agentic-node-02'
NODE02_WORKLOAD_IFACE = 'eth1'
NODE02_KNOWN_CONTROL_IFACES = ('eth0', 'tailscale0')   # the same two the scenario 1 run declared: our ssh path and the tailnet that rides it
O2_IF, O3_IF = 'enx9c69d39dd0a6', 'enx9c69d39ddcc0'
OBSERVERS = {wf.OBSERVER_O3: (JETSON, O3_IF, False), wf.OBSERVER_O2: (JETSON, O2_IF, False)}
ADVERSARY_BIND = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'adversary-bind.py')
SEND_TIMEOUT_S = 120

SENDER = '''import os, socket, sys, time
iface = %r
if not os.path.isdir('/sys/class/net/' + iface):
    sys.exit('no such interface: ' + iface)
s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW)
s.bind((iface, 0))   # interface-exact by construction: nothing is left to the routing table
frames = [%s]
for h in frames:
    s.send(bytes.fromhex(h))
    time.sleep(%s)
print('sent', len(frames))
'''

def remote(host, cmd, timeout=60, stdin=None):
    return tm.run_remote(tm.ssh_runner, host, cmd, timeout, stdin)

def preflight():
    """node-02's adversary-bind preflight, pushed fresh. Returns (ok, report or reason)."""
    src = open(ADVERSARY_BIND).read()
    pushed = remote(NODE02, f'echo {base64.b64encode(src.encode()).decode()} | base64 -d > /tmp/adversary-bind.py')
    if not pushed.ok:
        return False, f'could not push the bind guard: {pushed.reason}'
    flags = ' '.join(f'--known-control-iface {i}' for i in NODE02_KNOWN_CONTROL_IFACES)
    r = remote(NODE02, f'python3 /tmp/adversary-bind.py preflight --iface {NODE02_WORKLOAD_IFACE} {flags}')
    if not r.ok:
        return False, f'the preflight did not run: {r.reason}'
    try:
        report = json.loads(r.out)
    except ValueError as e:
        return False, f'the preflight printed no JSON: {e}'
    return bool(report.get('ok')), report

def status():
    r = remote(JETSON, 'curl -s -m 8 localhost:3003/api/zodiac/flows', 30)
    return {'error': r.reason} if not r.ok else wf.parse_status(r.out)

def make_send(dry_run):
    def send(hexes):
        if dry_run:
            return True, 'dry-run: 0 frames sent'
        code = SENDER % (NODE02_WORKLOAD_IFACE, ', '.join(repr(h) for h in hexes), repr(wf.SPACING_S))
        r = remote(NODE02, 'python3 -', SEND_TIMEOUT_S, code)
        if not r.ok:
            return False, f'the sender failed: {r.reason}'
        if r.out.strip() != f'sent {len(hexes)}':
            return False, f'the sender printed {r.out.strip()[:80]!r}, not "sent {len(hexes)}"'
        return True, r.out.strip()
    return send

def option(name):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv and sys.argv.index(name) + 1 < len(sys.argv) else None

def main():
    if len(sys.argv) < 2 or sys.argv[1].startswith('--'):
        print(__doc__); return 2
    label, dry = sys.argv[1], '--dry-run' in sys.argv
    picked = option('--groups')
    try:
        idx = [int(x) for x in picked.split(',')] if picked else [1, 2, 3]
        groups = [wf.GROUPS[i - 1] for i in idx if 1 <= i <= len(wf.GROUPS)]
        if not groups or len(groups) != len(idx):
            raise ValueError(picked)
    except ValueError:
        print(json.dumps({'label': label, 'error': f'--groups must name groups from 1 to {len(wf.GROUPS)}, for example 1,2,3'})); return 2
    if dry:
        groups = groups[:1]
    ok, report = preflight()
    out = {'label': label, 'dry_run': dry, 'preflight': report}
    if not ok:
        out['error'] = f'refusing to send: the adversary preflight did not pass ({report if isinstance(report, str) else report.get("refusalReason")})'
        print(json.dumps(out)); return 1
    deps = wf.Deps(tm.ssh_runner, OBSERVERS, make_send(dry), status, time.sleep, lambda: time.monotonic_ns() // 1_000_000)
    out.update(wf.run_all(groups, deps, label))
    out['at'] = time.strftime('%H:%M:%S')
    print(json.dumps(out))
    last = out['groups'][-1] if out['groups'] else {}
    if dry:
        return 0 if not last.get('invalid') and 'error' not in last else 1
    return 1 if out['stopped'] else 0

if __name__ == '__main__':
    sys.exit(main())
