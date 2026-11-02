#!/usr/bin/env python3
"""The table-miss under load: unmatched frames at stepped rates while the table-miss is in a given state.

DANGEROUS, supervised only (owner present, workload idle, the one-at-a-time hardware rule). The Zodiac FX has lost its OpenFlow session at 1.3 to 2.3 times its forwarding capacity
(docs/benchmarks/results/layout-capacity/README.md). This script therefore has named, bounded limits (scripts/table_miss_lib.py: a maximum rate per state, a step length of 5 to 10 s, at most
6 steps and 120 s of load), validates the whole plan before it sends anything, and stops AT THE FIRST SIGN OF TROUBLE, saying why in its output:
  the bridge could not be read twice in a row, the switch's OpenFlow session is not Connected, the bridge logged a new switch session, the switch returned an OFPT_ERROR, the bridge logged a CoPP rate limit on packet-ins (the switch is punting unmatched frames to the controller),
  the test fault ended or was cancelled, the isolation status is not one expected for the state (a status of readback_failed, say), the fault's time limit is nearly used,
  or an observer saw a frame where none may appear (out of P1 in any state, out of P3 in a state that does not forward).
It polls the bridge every 2 s DURING a step and, on an abort, stops the sender through a stop file it checks every 50 ms (one ssh round trip plus 50 ms); the sender is also bounded by `timeout`.
What it proves: that the listed signs were absent at the polls (a poll is a 2 s sample, and the isolation status itself is read from the switch only every 60 s: its age is recorded).
It does not see a session loss that is repaired between two polls without a log line.

Frames: 60-byte ethertype 0x88b5 from agentic-node-01 eth1 (the uplink NIC) into the Zodiac P2, as in scripts/table-miss-traffic.py; the same VLAN arrangement on switch #2 is needed.
Observers are counted by rx_packets deltas (a sampler on each NIC, corrected for the idle rate measured just before): O3 the mirror of the P2 link (control), O2 the tap NIC, O4 the two workload NICs.
Usage: python3 scripts/table-miss-load.py LABEL --state drop|absent|unrecognised|forwards [--rates 500,1000,2000,4000,8000] [--step-seconds 10] [--fault-seconds 600] [--wait-for-fault]
  A state other than drop needs --fault-seconds (the ZODIAC_FAULT_TABLE_MISS_SECONDS in force) and --wait-for-fault (or the fault already active).
Prints one JSON line; progress goes to stderr. Exit 0 only if every planned step ran and no abort fired.
"""
import json, os, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import table_miss_lib as lib

JETSON, NODE01, LISTENER = 'jetson', 'agentic-node-01', 'rpi-hailo'
UPLINK_IF = 'eth1'
O2_IF, O3_IF = 'enx9c69d39dd0a6', 'enx9c69d39ddcc0'
OBSERVERS = {'O3': [(JETSON, O3_IF, False)], 'O2': [(JETSON, O2_IF, False)], 'O4': [(NODE01, 'eth0', False), (LISTENER, 'eth0', False)]}  # rx_packets is world-readable: no sudo
STOP_FILE = '/tmp/tm-load-stop'
IDLE_SECONDS = lib.IDLE_MEASURE_SECONDS
SAMPLER_MARGIN_S = 2          # the sampler runs this long after the sender is due to end (it starts 1 s before the sender), so every frame is counted
SENDER_SLACK_S = 5            # the remote `timeout` is the step plus this
WAIT_FOR_FAULT_S = 240
SSH = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8']
SAMPLER_SRC = '''
import json, sys, time
iface, secs = sys.argv[1], int(sys.argv[2])
path = "/sys/class/net/" + iface + "/statistics/rx_packets"
t0 = time.perf_counter_ns(); end = t0 + secs * 1_000_000_000
out = []
while True:
    now = time.perf_counter_ns()
    out.append((now - t0, int(open(path).read())))
    if now >= end: break
    time.sleep(0.5)
print(json.dumps(out))
'''


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def ssh(host, cmd, timeout=30):
    return subprocess.run(SSH + [host, cmd], capture_output=True, text=True, timeout=timeout)


def poll():
    try:
        r = ssh(JETSON, lib.POLL_COMMAND, timeout=20)
    except subprocess.TimeoutExpired:
        return {'ok': False, 'error': 'the poll timed out after 20 s'}
    if r.returncode != 0:
        return {'ok': False, 'error': f'ssh exit {r.returncode}: {r.stderr.strip()[:120]}'}
    return lib.parse_poll(r.stdout)


def start_sampler(host, iface, sudo, secs):
    code = SAMPLER_SRC.replace("'", "'\"'\"'")
    return subprocess.Popen(SSH + [host, f"{'sudo -n ' if sudo else ''}timeout {secs + 10} python3 -c '{code}' {iface} {secs}"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def read_series(proc):
    out, err = proc.communicate(timeout=60)
    try:
        return [tuple(x) for x in json.loads(out)], None
    except ValueError:
        return [], f'sampler gave no series ({err.strip()[:100]})'


def measure_idle():
    procs = {k: [start_sampler(h, i, s, IDLE_SECONDS) for h, i, s in v] for k, v in OBSERVERS.items()}
    idle = {}  # per observer, per NIC, whole packets per second
    for k, ps in procs.items():
        idle[k] = []
        for p in ps:
            series, err = read_series(p)
            if err or len(series) < 2:
                raise RuntimeError(f'idle rate of {k} could not be measured: {err}')
            (t0, c0), (t1, c1) = series[0], series[-1]
            idle[k].append((c1 - c0) * lib.NS // (t1 - t0))
    return idle


def run_step(pps, step_s, monitor, frame_hex, idle):
    """One step. Returns (record, abort_reason or None). The sender runs remotely and is stopped through STOP_FILE on an abort."""
    ssh(NODE01, f'sudo -n rm -f {STOP_FILE}')
    sampler_s = step_s + 1 + SAMPLER_MARGIN_S
    samplers = {k: [start_sampler(h, i, s, sampler_s) for h, i, s in v] for k, v in OBSERVERS.items()}
    time.sleep(1)
    sender = subprocess.Popen(SSH + [NODE01, f'sudo -n timeout {step_s + SENDER_SLACK_S} python3 - {UPLINK_IF} {pps} {step_s} {STOP_FILE} {frame_hex}'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    sender.stdin.write(lib.LOAD_SENDER_SRC)
    sender.stdin.close()
    abort, polls, seen, of_msgs = None, 0, set(), []
    last = None
    while sender.poll() is None:
        t0 = time.monotonic_ns()
        sample = poll()
        polls += 1
        if sample.get('ok'):
            last = sample
            of_msgs.append(sample['of_messages'])
            seen.add((sample['isolation_state'], sample['table_miss']))
        abort = monitor.feed(sample)
        if abort is not None:
            ssh(NODE01, f'sudo -n touch {STOP_FILE}')
            log(f'  ABORT ({abort["code"]}): {abort["text"]}')
            break
        rest = lib.POLL_INTERVAL_SECONDS * lib.NS - (time.monotonic_ns() - t0)
        if rest > 0:
            time.sleep(rest / lib.NS)
    try:
        out, err = sender.communicate(timeout=step_s + SENDER_SLACK_S + 5)
    except subprocess.TimeoutExpired:
        sender.kill()
        out, err = '', 'sender did not exit in time and was killed'
    ssh(NODE01, f'sudo -n rm -f {STOP_FILE}')
    sent = lib.parse_sender_line(out)
    observed, errors = {}, {}
    for k, ps in samplers.items():
        total = 0
        for j, p in enumerate(ps):
            series, e = read_series(p)
            if e:
                errors[k] = e
            total += lib.delivered(series, idle[k][j]) if series else 0
        observed[k] = total
    rec = {'targetPps': pps, 'stepSeconds': step_s, 'polls': polls, 'ofMessagesReceivedFirstLast': [of_msgs[0], of_msgs[-1]] if of_msgs else None, 'isolationSeen': sorted(f'{a}/{b}' for a, b in seen), 'lastPoll': last, 'observed': observed, 'errors': errors, 'sender': sent, 'senderStderr': err.strip()[:150]}
    if sent is None:
        rec['verdict'] = {'verdict': 'sender_gave_no_result', 'breach': False}
        return rec, abort or {'code': 'sender_failed', 'text': 'the sender printed no result line'}
    rec['sentPps'] = sent['sent'] * lib.NS // max(1, sent['elapsed_ns'])
    rec['senderLimited'] = lib.sender_limited(sent['sent'], sent['elapsed_ns'], pps)
    rec['stoppedEarly'] = bool(sent['stopped'])
    rec['verdict'] = lib.judge_step(monitor.state, sent['sent'], observed)
    if abort is None and rec['verdict']['breach']:
        abort = {'code': 'frame_where_none_may_appear', 'text': f'observers read {observed}: {rec["verdict"]["verdict"]} in state {monitor.state!r}'}
    return rec, abort


def option(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv and sys.argv.index(name) + 1 < len(sys.argv) else default


def finish(label, state, steps, reason, note=None):
    out = {'label': label, 'state': state, 'steps': steps, 'stopReason': reason, 'completed': reason.get('code') == 'completed', 'at': time.strftime('%H:%M:%S')}
    if note:
        out['note'] = note
    print(json.dumps(out))
    return 0 if out['completed'] else 1


def main():
    if len(sys.argv) < 2 or sys.argv[1].startswith('--'):
        print(__doc__)
        return 2
    label, state = sys.argv[1], option('--state')
    try:
        rates = [int(x) for x in option('--rates', ','.join(str(r) for r in lib.DEFAULT_RATES)).split(',')]
        step_s, fault_s = int(option('--step-seconds', str(lib.MAX_STEP_SECONDS))), int(option('--fault-seconds', '0'))
        total = lib.validate_plan(state or '', rates, step_s)
    except (lib.PlanError, ValueError) as e:
        print(json.dumps({'label': label, 'error': f'plan refused: {e}'}))
        return 2
    if state != 'drop' and fault_s <= 0:
        print(json.dumps({'label': label, 'error': 'a state other than drop needs --fault-seconds (the fault time limit in force)'}))
        return 2
    if state != 'drop' and '--wait-for-fault' in sys.argv:
        deadline = time.monotonic() + WAIT_FOR_FAULT_S
        while time.monotonic() < deadline:
            if lib.parse_poll(poll_text()).get('fault_active_epoch') is not None:
                break
            time.sleep(2)
        else:
            return finish(label, state, [], {'code': 'no_fault', 'text': 'no TEST FAULT ACTIVE line within the wait; nothing was sent'})
    monitor = lib.Monitor(state, fault_s)
    first = poll()
    reason = monitor.feed(first)
    if reason is None and not first.get('ok'):
        first = poll()  # one unreadable poll is tolerated; two in a row are not
        reason = monitor.feed(first)
    if reason is None and state != 'drop' and first.get('fault_active_epoch') is None:
        reason = {'code': 'no_fault', 'text': 'the state under test is a fault but the journal shows no TEST FAULT ACTIVE line for this bridge process'}
    if reason is None:
        reason = monitor.may_start_step(first, total + lib.IDLE_MEASURE_SECONDS * 2)  # the whole plan, with the idle measurement, must fit inside the fault's time limit
    if reason is not None:
        return finish(label, state, [], reason, 'refused to start: ' + reason['text'])
    log(f'{label}: state {state}, rates {rates}, {step_s} s steps, about {total} s of load; first poll {first.get("isolation_state")}/{first.get("table_miss")}, {first.get("openflow")}')
    try:
        idle = measure_idle()
    except (RuntimeError, subprocess.TimeoutExpired) as e:
        return finish(label, state, [], {'code': 'idle_unmeasured', 'text': str(e)}, 'nothing was sent')
    frame = lib.CLASSES[lib.LEGACY_CLASS].frame(0).hex()
    steps = []
    for i, pps in enumerate(rates):
        sample = poll()
        reason = monitor.feed(sample) or (monitor.may_start_step(sample, step_s) if sample.get('ok') else None)
        if reason is not None:
            return finish(label, state, steps, reason, f'stopped before the step at {pps} pps')
        log(f'  step {i + 1}/{len(rates)}: {pps} pps for {step_s} s')
        rec, reason = run_step(pps, step_s, monitor, frame, idle)
        steps.append(rec)
        log(f'    sent {rec.get("sentPps")} pps; observed {rec["observed"]}; {rec["verdict"]["verdict"]}; sender-limited: {rec.get("senderLimited")}')
        if reason is not None:
            return finish(label, state, steps, reason, f'stopped during or after the step at {pps} pps')
        if rec.get('senderLimited'):
            return finish(label, state, steps, {'code': 'sender_limited', 'text': f'the sender could not reach {pps} pps; higher rates would measure the sender, not the switch'})
        if i + 1 < len(rates):
            time.sleep(lib.STEP_PAUSE_SECONDS)
    sample = poll()
    reason = monitor.feed(sample)
    return finish(label, state, steps, reason or {'code': 'completed', 'text': f'all {len(rates)} planned steps ran and no abort condition fired'})


def poll_text():
    r = ssh(JETSON, lib.POLL_COMMAND, timeout=20)
    return r.stdout


if __name__ == '__main__':
    sys.exit(main())
