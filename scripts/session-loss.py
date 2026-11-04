#!/usr/bin/env python3
"""Scenario 4, reframed: recovery after the control-plane session is lost. Pre-registration:
docs/benchmarks/results/scenario4-session-loss/PREREGISTRATION.md (read the Safety framing section first; this script does what it registers and nothing else).

Offers forwarded UDP traffic from agentic-node-02's workload interface (eth1) at EXACTLY 25,000 pps for one 10 s step -- the registered rate is fixed, not configurable upward, and
the plan is rejected before any ssh if anything else is asked for. The frame is matched by p1-default-tap-only (destination outside the segment), never by an allow rule. Watches the
existing status poll (scripts/table_miss_lib.py) for the switch's OpenFlow session to drop and reconnect on its own; if it has not reconnected and re-verified within
RECONNECT_WAIT_S, the one allowed fallback is a local `sudo systemctl restart zodiac-bridge` on the Jetson, which is reported as its own outcome, not hidden inside a clean recovery.

Usage: python3 scripts/session-loss.py LABEL --dry-run | --owner-go-for-real-load [--pps 25000]
  --dry-run: the preflight, the status gate and the capture plumbing; no load is sent and the restart command is never constructed.
  --owner-go-for-real-load: required for the real run, and only to be passed after the owner has said go for this specific run in so many words (Invariant 4).
  --pps: accepted only so the registered value can be stated explicitly on the command line; anything other than the registered 25,000 is refused before any ssh.
Prints one JSON line. Needs ssh to jetson and agentic-node-02; node-02's wlan0 down.
"""
import importlib.util, json, os, shlex, subprocess, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import table_miss_lib as tm
import session_loss_lib as sl

_spec = importlib.util.spec_from_file_location('workload_frames_runner', os.path.join(HERE, 'workload-frames.py'))
wfs = importlib.util.module_from_spec(_spec)   # the observers, preflight and status read of the scenario 5 runner, not copied
_spec.loader.exec_module(wfs)

JETSON, NODE02 = wfs.JETSON, wfs.NODE02
SENDER_IFACE = wfs.NODE02_WORKLOAD_IFACE
STOP_FILE = '/tmp/sl-load-stop'


def restart_bridge():
    # The jetson's NOPASSWD sudoers rule is scoped to the exact argument "zodiac-bridge.service" (confirmed live
    # 2026-11-04 via `sudo -n systemctl status zodiac-bridge` without the suffix: "a password is required"); sudo
    # does literal argument matching, so systemd's own tolerance of the unit name with or without ".service"
    # does not help here. The call must use the exact string the sudoers rule grants.
    r = wfs.remote(JETSON, 'sudo -n systemctl restart zodiac-bridge.service', 30)
    return r.ok, (r.reason if not r.ok else 'restarted')


def check_raw_socket_capability():
    """No sudo on node-02 (see start_send) rests entirely on this host's user already being able to open an
    AF_PACKET raw socket unprivileged -- a capability assumption, not a code-level guarantee (AI review,
    2026-11-04): if it were ever revoked (a kernel/capability change, a container runtime, a different node),
    the sender would fail to bind and the run would read as a confusing, silent no_loss_observed rather than a
    loud, diagnosable refusal. Checked fresh before every send, not just asserted in a comment."""
    r = wfs.remote(NODE02, 'python3 -c "import socket; socket.socket(socket.AF_PACKET, socket.SOCK_RAW)"', 8)
    if not r.ok:
        raise RuntimeError(f'node-02 cannot open an AF_PACKET raw socket without privilege any more (the sender would fail silently): {r.reason}')


def start_send(frame_hex, pps, step_s):
    """Launches the raw-socket pacer (table_miss_lib.LOAD_SENDER_SRC, unchanged) on node-02 as a background subprocess; returns the Popen handle. The remote `timeout` and the
    stop-file both bound the sender independently of whether this process is still watching it.

    No sudo on node-02: confirmed live 2026-11-04 that this host's user can already open an AF_PACKET raw socket
    and create/remove files under /tmp without it -- table-miss-load.py's `sudo -n` pattern (copied here
    uncritically) is specific to node-01, a different host where raw-socket creation does need root; the
    already-working scenario 5 sender on this same host (workload-frames.py) uses no sudo at all for exactly
    this reason. Adding a NOPASSWD sudoers grant here would have been solving a problem that does not exist."""
    assert isinstance(pps, int) and isinstance(step_s, int), f'Invariant 2: pps and step_s must be int, not injected into a remote shell command as anything else (got {pps!r}, {step_s!r})'
    check_raw_socket_capability()
    removed = wfs.remote(NODE02, f'rm -f {shlex.quote(STOP_FILE)}', 8)
    if not removed.ok:
        raise RuntimeError(f'the stop file could not be cleared, so an abort could not stop the sender: {removed.reason}')
    ssh_cmd = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', NODE02,
               f'timeout {step_s + 5} python3 - {shlex.quote(SENDER_IFACE)} {pps} {step_s} {shlex.quote(STOP_FILE)} {shlex.quote(frame_hex)}']
    p = subprocess.Popen(ssh_cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert p.stdin is not None
    p.stdin.write(tm.LOAD_SENDER_SRC)
    p.stdin.close()
    return p


def send_running(handle):
    return handle.poll() is None


def poll():
    r = wfs.remote(JETSON, tm.POLL_COMMAND, timeout=tm.POLL_TIMEOUT_SECONDS)
    return {'ok': False, 'error': r.reason} if not r.ok else tm.parse_poll(r.out)


def option(name):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv and sys.argv.index(name) + 1 < len(sys.argv) else None


def main():
    if len(sys.argv) < 2 or sys.argv[1].startswith('--'):
        print(__doc__); return 2
    label = sys.argv[1]
    dry, go = '--dry-run' in sys.argv, '--owner-go-for-real-load' in sys.argv
    if dry == go:
        print(json.dumps({'label': label, 'error': 'refusing to run: pass exactly one of --dry-run, or --owner-go-for-real-load once the owner has said go for this specific run'})); return 2
    pps_arg = option('--pps')
    pps = int(pps_arg) if pps_arg is not None else sl.TARGET_PPS
    plan = sl.validate_plan(pps, sl.STEP_SECONDS)
    if not plan['ok']:
        print(json.dumps({'label': label, 'error': f'refusing to run: {plan["reason"]}'})); return 2
    ok, report = wfs.preflight()
    out = {'label': label, 'preflight': report}
    if not ok:
        out['error'] = f'refusing to start: the adversary preflight did not pass ({report if isinstance(report, str) else report.get("refusalReason")})'
        print(json.dumps(out)); return 1
    observers = wfs.OBSERVERS
    deps = sl.Deps(tm.ssh_runner, observers, wfs.status, (lambda fh, p, s: start_send(fh, p, s)) if not dry else (lambda fh, p, s: None),
                   (lambda h: False) if dry else send_running, restart_bridge, poll, time.sleep, lambda: time.monotonic_ns() // 1_000_000)
    out.update(sl.dry_run(deps, label) if dry else sl.run_experiment(deps, label))
    out['at'] = time.strftime('%H:%M:%S')
    print(json.dumps(out))
    if dry:
        return 0 if not out.get('invalid') and 'error' not in out else 1
    return 1 if out.get('verdict') not in ('recovered',) or 'error' in out else 0

if __name__ == '__main__':
    sys.exit(main())
