#!/usr/bin/env python3
"""Diagnostic only, not part of the registered scenario-4 tooling and not itself pre-registered: tries to exercise the one
branch scripts/session-loss.py's real-hardware trials never reached, recovered_with_fallback / not_recovered
(docs/benchmarks/results/scenario4-session-loss/README.md, "The fallback path"). Reuses scripts/session_loss_lib.py's real
run_experiment() and every real I/O function unmodified (restart_bridge, start_send, poll, preflight), with only
RECONNECT_WAIT_S and FALLBACK_WAIT_S overridden in memory for this process -- not edited in session_loss_lib.py itself, and
not touching TARGET_PPS or STEP_SECONDS, which stay at the registered 25,000 pps / 10 s. Shortening the wait makes a known
natural ~2 s recovery (observed on real hardware in try5/try6, see the README) cross the threshold, so the real fallback
(`sudo -n systemctl restart zodiac-bridge.service` on the jetson) is attempted for real instead of only in
session_loss_lib.py's own selftest (scripted ssh).

Usage: python3 scripts/diagnostics/session-loss-fallback-diag.py LABEL --owner-go-for-real-load [--reconnect-wait-s N] [--fallback-wait-s N]
  Needs the same --owner-go-for-real-load confirmation as scripts/session-loss.py (Invariant 4): this sends the same real
  25,000 pps / 10 s load against real hardware. --reconnect-wait-s/--fallback-wait-s default to 1 (seconds); they only ever
  shorten the registered 30 s/30 s wait, never lengthen it past the registered bound, and are rejected otherwise.
"""
import importlib.util, json, os, sys, time, shlex, re, subprocess
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # scripts/, one level up from scripts/diagnostics/
sys.path.insert(0, HERE)
import table_miss_lib as tm
import session_loss_lib as sl

_spec = importlib.util.spec_from_file_location('workload_frames_runner', os.path.join(HERE, 'workload-frames.py'))
if _spec is None or _spec.loader is None:
    sys.exit(f'could not load workload-frames.py from {HERE}')
wfs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(wfs)

JETSON, NODE02 = wfs.JETSON, wfs.NODE02
SENDER_IFACE = wfs.NODE02_WORKLOAD_IFACE
STOP_FILE = '/tmp/sl-load-stop'


# The same real functions scripts/session-loss.py's main() wires up (copied, not imported: session-loss.py is a
# __main__-style script, not an importable module with a stable API). Kept byte-identical in behaviour on purpose,
# so this diagnostic exercises the real fallback and sender code paths, not a simplified stand-in for them.

def restart_bridge():
    r = wfs.remote(JETSON, 'sudo -n systemctl restart zodiac-bridge.service', 30)
    return r.ok, (r.reason if not r.ok else 'restarted')


def check_raw_socket_capability():
    r = wfs.remote(NODE02, f'python3 -c "import socket; s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW); s.bind(({SENDER_IFACE!r}, 0))"', 8)
    if not r.ok:
        raise RuntimeError(f'node-02 cannot bind an AF_PACKET raw socket to {SENDER_IFACE}: {r.reason}')


def start_send(frame_hex, pps, step_s):
    if not (isinstance(pps, int) and isinstance(step_s, int) and 0 < step_s <= sl.MAX_STEP_SECONDS):
        raise TypeError(f'pps must be a positive int and step_s a positive int up to {sl.MAX_STEP_SECONDS}, not {pps!r}, {step_s!r}')
    if not re.fullmatch(r'[0-9a-fA-F]+', frame_hex):
        raise ValueError(f'frame_hex must be hex digits only: {frame_hex!r}')
    check_raw_socket_capability()
    removed = wfs.remote(NODE02, f'rm -f {shlex.quote(STOP_FILE)}', 8)
    if not removed.ok:
        raise RuntimeError(f'the stop file could not be cleared: {removed.reason}')
    ssh_cmd = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', NODE02,
               f'timeout {shlex.quote(str(step_s + 5))} python3 - {shlex.quote(SENDER_IFACE)} {shlex.quote(str(pps))} {shlex.quote(str(step_s))} {shlex.quote(STOP_FILE)} {shlex.quote(frame_hex)}']
    p = subprocess.Popen(ssh_cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if p.stdin is None:
        raise RuntimeError('Popen was not given stdin=PIPE')
    p.stdin.write(tm.LOAD_SENDER_SRC)
    p.stdin.close()
    return p


def send_running(handle):
    return handle.poll() is None


def poll():
    r = wfs.remote(JETSON, tm.POLL_COMMAND, timeout=tm.POLL_TIMEOUT_SECONDS)
    return {'ok': False, 'error': r.reason} if not r.ok else tm.parse_poll(r.out)


def option(name, default=None):
    """The flag's value, or `default` if the flag is absent. Raises ValueError (never silently takes another flag as
    the value, never lets a missing value fall through to a confusing int(None) TypeError) if the flag is given with
    no following argument, or with another `--flag` immediately after it."""
    if name not in sys.argv:
        return default
    i = sys.argv.index(name) + 1
    if i >= len(sys.argv) or sys.argv[i].startswith('--'):
        raise ValueError(f'{name} needs a value')
    return sys.argv[i]


# DIAGNOSTIC_SCRIPT_PATH is the repo-relative path to this file, computed from __file__ rather than hardcoded, so the
# provenance field in the JSONL output cannot silently go stale if this file is ever moved.
REPO_ROOT = os.path.dirname(HERE)
DIAGNOSTIC_SCRIPT_PATH = os.path.relpath(os.path.abspath(__file__), REPO_ROOT)


def main():
    if len(sys.argv) < 2 or sys.argv[1].startswith('--'):
        print(__doc__); return 2
    label = sys.argv[1]
    if '--owner-go-for-real-load' not in sys.argv:
        print(json.dumps({'label': label, 'error': 'refusing to run: pass --owner-go-for-real-load once the owner has said go for this specific diagnostic run (Invariant 4); this sends real load'})); return 2
    try:
        reconnect = int(option('--reconnect-wait-s', 1))
        fallback = int(option('--fallback-wait-s', 1))
    except ValueError as e:
        print(json.dumps({'label': label, 'error': f'refusing to run: {e}'})); return 2
    if not (0 < reconnect <= sl.RECONNECT_WAIT_S and 0 < fallback <= sl.FALLBACK_WAIT_S):
        print(json.dumps({'label': label, 'error': f'refusing to run: --reconnect-wait-s/--fallback-wait-s may only shorten the registered {sl.RECONNECT_WAIT_S}s/{sl.FALLBACK_WAIT_S}s bounds, never lengthen them'})); return 2
    # session_loss_lib.run_experiment() reads RECONNECT_WAIT_S/FALLBACK_WAIT_S as bare names resolved against its
    # own module's globals at call time (ordinary Python name resolution, not captured at def time), so setting
    # these module attributes here does take effect for the real call below -- confirmed empirically by every
    # sl-fallback-diag-* trial actually using the shortened wait rather than the registered 30s/30s. This would
    # break silently (reverting to 30s/30s with no error) if session_loss_lib.py ever stopped reading these as
    # plain globals (for example, by capturing them as function-default-argument values instead).
    sl.RECONNECT_WAIT_S, sl.FALLBACK_WAIT_S = reconnect, fallback
    print(f'# diagnostic override: RECONNECT_WAIT_S={sl.RECONNECT_WAIT_S}s FALLBACK_WAIT_S={sl.FALLBACK_WAIT_S}s '
          f'(registered values are 30s/30s; TARGET_PPS={sl.TARGET_PPS}, STEP_SECONDS={sl.STEP_SECONDS} unchanged)', file=sys.stderr)

    ok, report = wfs.preflight()
    out = {'label': label, 'diagnostic': True, 'diagnostic_script': DIAGNOSTIC_SCRIPT_PATH, 'preflight': report}
    if not ok:
        out['error'] = f'refusing to start: the adversary preflight did not pass ({report if isinstance(report, str) else report.get("refusalReason")})'
        print(json.dumps(out)); return 1
    deps = sl.Deps(tm.ssh_runner, wfs.OBSERVERS, wfs.status, start_send, send_running, restart_bridge, poll, time.sleep, lambda: time.monotonic_ns() // 1_000_000)
    out.update(sl.run_experiment(deps, label))
    out['at'] = time.strftime('%H:%M:%S')
    print(json.dumps(out))
    # Exit 0 for every outcome this diagnostic can legitimately reach without anything going wrong, including
    # no_loss_observed (the dominant outcome: the branch this script exists to exercise simply was not reached this
    # time, which is not a script failure) and recovered_with_fallback (the branch it was trying to reach). Exit 1
    # only for not_recovered (the fallback itself did not work) or an explicit error.
    return 1 if out.get('verdict') == 'not_recovered' or 'error' in out else 0


if __name__ == '__main__':
    sys.exit(main())
