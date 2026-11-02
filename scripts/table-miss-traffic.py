#!/usr/bin/env python3
"""What does a frame that matches no rule do while the table-miss is in a given state?

Sends FRAMES raw Ethernet frames with the IEEE 802 local experimental ethertype 0x88b5 (neither IPv4 nor ARP, so no rule of the isolation policy matches it and it
reaches the table-miss) from agentic-node-01's uplink NIC into the Zodiac's port 2, and counts what arrives at each observer:
  O3   the Jetson NIC on switch #2's mirror of the Zodiac P2 link (control: the frames really were on the link),
  O2   the Jetson NIC on the Zodiac P3 tap (a frame forwarded out of port 3),
  O4   agentic-node-01 eth0 and rpi-hailo eth0, both on the workload side (a frame forwarded out of port 1).
Needs ssh to jetson, agentic-node-01 and rpi-hailo (passwordless sudo on the last two), and the wire-campaign VLAN arrangement on switch #2: node-01's uplink NIC
(switch port 2) in the same VLAN as the Zodiac's P2 link (port 4), and port 3 (the mirror of that link) in its own VLAN. With the normal arrangement node-01 eth1 is on the household LAN and the
frames never reach the Zodiac; the O3 control then reads 0 and the run is not valid.
Usage: python3 scripts/table-miss-traffic.py LABEL [--wait-for-fault] [--classes all|name,name,...] [--state drop|absent|unrecognised|forwards]
  --wait-for-fault: wait for the bridge's "TEST FAULT ACTIVE" line first, then send at once.
  Without --classes: the original single-class run (20 frames of ethertype 0x88b5), output unchanged.
  With --classes: FRAMES_PER_CLASS frames of each named class (or all nine), interleaved, each class counted separately at every observer by its own source MAC and filter
  (scripts/table_miss_lib.py), and judged against the expectation for --state (required with --classes), which is fixed in advance. Classes: see table_miss_lib.CLASSES.
Prints one JSON line. An observer counts only if its capture provably ran: each capture is verified listening before any frame is sent (the run is aborted if one is not), and its count is
accepted only if tcpdump's exit summary is present, drop-free and equal to the number of frame lines. Otherwise that observer is INVALID (`observer_invalid`, with the reason), never 0.
"""
import json, os, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import table_miss_lib as lib

JETSON, NODE01, LISTENER = 'jetson', 'agentic-node-01', 'rpi-hailo'
UPLINK_IF = 'eth1'
O2_IF, O3_IF = 'enx9c69d39dd0a6', 'enx9c69d39ddcc0'
FRAMES, SPACING_S, CAPTURE_S = 20, 0.1, 22
WAIT_FOR_FAULT_S = 240
OBSERVERS = {'O3_p2_mirror': (JETSON, O3_IF, False), 'O2_p3_tap': (JETSON, O2_IF, False), 'O4_node01_eth0': (NODE01, 'eth0', True), 'O4_rpi_hailo_eth0': (LISTENER, 'eth0', True)}

def ssh(host, cmd, timeout=90):
    """A structured result (lib.Remote): a failed ssh, a refused sudo or a timeout is ok=False with the reason, never an empty string."""
    return lib.run_remote(lib.ssh_runner, host, cmd, timeout)

def frame_hex(n):
    return lib.legacy_frame_hex(n)  # byte-for-byte the frame this script always sent (checked by test/invariants/table-miss-extended.test.ts)

def status():
    r = ssh(JETSON, 'curl -s -m 8 localhost:3003/api/zodiac/flows')
    if not r.ok:
        return {'error': r.reason}
    try:
        p = json.loads(r.out)['port1Isolation']
        return {'state': p.get('state'), 'tableMiss': (p.get('actions') or {}).get('tableMiss')}
    except (ValueError, KeyError, TypeError) as e:  # report, never hide, a status that could not be read
        return {'error': str(e)[:120]}

def option(name):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv and sys.argv.index(name) + 1 < len(sys.argv) else None

def send_frames(hexes):
    """Sends the frames from node-01's uplink NIC. Returns (ok, text): ok only if ssh and sudo worked and the sender printed 'sent'."""
    code = "import socket, time\ns = socket.socket(socket.AF_PACKET, socket.SOCK_RAW)\ns.bind(('%s', 0))\nfor h in [%s]:\n    s.send(bytes.fromhex(h))\n    time.sleep(%s)\nprint('sent')\n" % (UPLINK_IF, ', '.join(repr(h) for h in hexes), SPACING_S)
    r = lib.run_remote(lib.ssh_runner, NODE01, 'sudo -n python3 -', 120, code)
    if not r.ok:
        return False, f'the sender failed: {r.reason}'
    if r.out.strip() != 'sent':
        return False, f'the sender printed {r.out.strip()[:80]!r}, not "sent"'
    return True, 'sent'

def observe_pass(label, names, hexes, capture_s, prefix):
    """Starts and verifies the captures, sends, waits, reads. Returns (error dict or None, details). No frame is sent unless every observer is listening."""
    started = lib.start_captures(lib.ssh_runner, OBSERVERS, lib.capture_filter(names), int(capture_s), prefix, time.sleep)
    not_listening = {k: v['reason'] for k, v in started.items() if not v['listening']}
    if not_listening:
        return {'label': label, 'error': 'aborted before sending: an observer is not listening', 'not_listening': not_listening}, None
    before = status()
    ok, sent = send_frames(hexes)
    after = status()
    if not ok:
        return {'label': label, 'error': sent, 'status_before': before}, None
    time.sleep(8)  # the captures end at their own time limit; the summary is only printed then
    results, invalid = lib.read_all(lib.ssh_runner, OBSERVERS, {k: v['base'] for k, v in started.items()})
    return None, {'sent': sent, 'results': results, 'invalid': invalid, 'before': before, 'after': after}

def run_classes(label, names, state):
    """One pass over several frame classes. Returns the JSON-able result; every class has its own control count at O3."""
    sched = lib.send_schedule(names, lib.FRAMES_PER_CLASS)
    err, d = observe_pass(label, names, [h for _, _, h in sched], 4 + len(sched) * SPACING_S + 8, '/tmp/tm-classes')
    if err:
        return err
    per_obs = {k: (lib.counts_by_class(str(v['text']), names) if v['valid'] else None) for k, v in d['results'].items()}
    def count(obs, c): return None if per_obs[obs] is None else per_obs[obs][c]['count']
    def o4(c):
        a, b = count('O4_node01_eth0', c), count('O4_rpi_hailo_eth0', c)
        return 0 if a is None or b is None else a + b  # an invalid O4 is flagged through `invalid`; the number is not used
    rows = {c: {'O3': count('O3_p2_mirror', c) or 0, 'O2': count('O2_p3_tap', c) or 0, 'O4': o4(c)} for c in names}
    lengths = lambda obs: {c: (per_obs[obs][c]['lengths'] if per_obs[obs] is not None else None) for c in names}
    return {'label': label, 'state': state, 'classes': names, 'frames_per_class': lib.FRAMES_PER_CLASS, 'sender': d['sent'], 'counts': rows,
            'lengths_at_O3': lengths('O3_p2_mirror'), 'lengths_at_O2': lengths('O2_p3_tap'), 'capture_summaries': {k: v['packets'] for k, v in d['results'].items()},
            'invalid_observers': d['invalid'], 'judge': lib.judge(state, rows, lib.FRAMES_PER_CLASS, d['invalid']), 'status_before': d['before'], 'status_after': d['after'], 'at': time.strftime('%H:%M:%S')}

def run_legacy(label):
    """The original single-class run (20 frames of 0x88b5); the counts are per capture as before, but an invalid capture is null with its reason, never 0."""
    err, d = observe_pass(label, [lib.LEGACY_CLASS], [frame_hex(i) for i in range(FRAMES)], CAPTURE_S, '/tmp/tm-traffic')
    if err:
        return err
    counts = {k: (lib.counts_by_class(str(v['text']), [lib.LEGACY_CLASS])[lib.LEGACY_CLASS]['count'] if v['valid'] else None) for k, v in d['results'].items()}
    out = {'label': label, 'frames_sent': FRAMES, 'sender': d['sent'], 'counts': counts, 'status_before': d['before'], 'status_after': d['after'], 'at': time.strftime('%H:%M:%S')}
    if d['invalid']:
        out['invalid_observers'] = d['invalid']
        out['verdict'] = 'observer_invalid'
    return out

def wait_for_fault():
    t0 = ssh(JETSON, 'date +%s')
    if not t0.ok:
        return False
    deadline = time.monotonic() + WAIT_FOR_FAULT_S
    while time.monotonic() < deadline:
        r = ssh(JETSON, f'journalctl -u zodiac-bridge --no-pager --since @{t0.out.strip()} | grep -c "TEST FAULT ACTIVE"; true')
        if r.ok and r.out.strip().isdigit() and int(r.out.strip()) >= 1: return True
        time.sleep(2)
    return False

def main():
    if len(sys.argv) < 2 or sys.argv[1].startswith('--'):
        print(__doc__); return 2
    label = sys.argv[1]
    classes_arg = option('--classes')
    if classes_arg is not None:
        state = option('--state')
        if state not in lib.STATES:
            print(json.dumps({'label': label, 'error': f'--state is required with --classes and must be one of {", ".join(lib.STATES)}'})); return 2
        try:
            names = lib.pick_classes(classes_arg)
        except ValueError as e:
            print(json.dumps({'label': label, 'error': str(e)})); return 2
    if '--wait-for-fault' in sys.argv and not wait_for_fault():
        print(json.dumps({'label': label, 'error': 'no TEST FAULT ACTIVE line within the wait (or the Jetson could not be read)'})); return 1
    out = run_classes(label, names, state) if classes_arg is not None else run_legacy(label)
    print(json.dumps(out))
    return 1 if 'error' in out or out.get('invalid_observers') else 0

if __name__ == '__main__':
    sys.exit(main())
