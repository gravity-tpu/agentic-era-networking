#!/usr/bin/env python3
"""Pure helpers and the group runner for scripts/workload-frames.py: Track C scenario 5, narrowed (docs/benchmarks/results/scenario5-workload-frames/PREREGISTRATION.md).

Eighteen frame classes are sent from the workload side (into the Zodiac P1) and counted per source MAC at two observers: O3 (the Jetson NIC on the mirror of the Zodiac P2
link: what LEFT the uplink) and O2 (the tap, out of P3: the frame arrived and a rule that outputs to P3 handled it). Every number in the registered table (ids, predictions, source MACs,
groups) is held by test/invariants/workload-frames.test.ts, which builds the new frames' bytes independently and evaluates each prediction against the six live policy rules.

What the checks here prove and what they do not. The frame builders prove only that the bytes are what the test writes out. The judge compares counts with the prediction fixed in
advance; it cannot say why a count differs. A class whose tap control (O2 = 20) fails is never read as contained, and frames seen at O3 for such a class stop the run and are shown, because
a frame that reaches O3 without reaching the tap would be a path around the Zodiac, which is a finding of its own. An observer counts only if its capture provably ran (the observer rules of
scripts/table_miss_lib.py, reused here). Nothing here proves that no other frame can leave P2: one sample of 20 per class, one firmware, one switch.

No I/O at import. CLI (used by the tests): python3 scripts/workload_frames_lib.py dump | judge | selftest   (JSON on stdin for judge).
"""
import json, os, sys
from typing import Any, Callable, Dict, List, Optional, Tuple
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import table_miss_lib as tm

FRAMES_PER_CLASS = 20
SPACING_S = 0.1
BCAST = 'ff:ff:ff:ff:ff:ff'
SENDER_IP, INSIDE_IP, OUTSIDE_IP = '10.0.2.52', '10.0.2.50', '198.51.100.7'   # the sender's own address; a host in the segment; RFC 5737 TEST-NET-2
SPOOF_IP, UNKNOWN_SPA, ARP_TARGET = '192.0.2.77', '10.0.2.77', '10.0.2.1'     # TEST-NET-1 source; a sender address that is not a workload host; the address asked for
VLAN_ID = 100
OPTIONS_NOPS = bytes([1, 1, 1, 0])   # NOP, NOP, NOP, end of options: IHL 6
MORE_FRAGMENTS, LATER_OFFSET = 0x2000, 185   # offset 185 x 8 bytes = 1480
SRC_MAC_BASE = 0x80
OBSERVER_O3, OBSERVER_O2 = 'O3_p2_mirror', 'O2_p3_tap'


def payload(n: int) -> bytes:
    return f'wf {n:04d}'.ljust(16).encode('ascii')   # 16 bytes: a multiple of 8, so a first fragment's data length is legal


def ipv4_packet(src: str, dst: str, n: int, options: bytes = b'', flags_frag: int = 0, udp: bool = True) -> bytes:
    l4 = (40000).to_bytes(2, 'big') + (9).to_bytes(2, 'big') + (8 + 16).to_bytes(2, 'big') + bytes(2) + payload(n) if udp else payload(n)
    ihl = 5 + len(options) // 4
    head = bytearray([(4 << 4) | ihl, 0]) + (ihl * 4 + len(l4)).to_bytes(2, 'big') + (n & 0xffff).to_bytes(2, 'big') + flags_frag.to_bytes(2, 'big') + bytes([64, 17, 0, 0]) + tm.ip4(src) + tm.ip4(dst) + options
    head[10:12] = tm.ipv4_checksum(bytes(head)).to_bytes(2, 'big')
    return bytes(head) + l4


def arp_request(src_mac: str, spa: str, tpa: str) -> bytes:
    return (1).to_bytes(2, 'big') + (0x0800).to_bytes(2, 'big') + bytes([6, 4]) + (1).to_bytes(2, 'big') + tm.mac(src_mac) + tm.ip4(spa) + bytes(6) + tm.ip4(tpa)


def plain(src: str, ethertype: int, body: bytes) -> bytes:
    return tm.pad_to(tm.eth(BCAST, src, ethertype, body))


def tagged(src: str, inner: int, body: bytes) -> bytes:
    return tm.pad_to(tm.eth(BCAST, src, 0x8100, VLAN_ID.to_bytes(2, 'big') + inner.to_bytes(2, 'big') + body))


class WorkloadClass:
    def __init__(self, cid: str, name: str, prediction: str, model_says: str, visible: dict, builder: Callable[[str, int], bytes], what: str):
        self.id, self.name, self.prediction, self.model_says, self.visible, self._builder, self.what = cid, name, prediction, model_says, visible, builder, what
        self.src = ''
        self.bpf = ''

    def frame(self, n: int) -> bytes:
        return self._builder(self.src, n)


def _ip(src: str, dst: str) -> dict:
    return {'etherType': 0x0800, 'srcIp': src, 'dstIp': dst}


_SPECS: List[WorkloadClass] = [
    WorkloadClass('C0', 'allow-ipv4-inside', 'p2p3', 'p2p3', _ip(SENDER_IP, INSIDE_IP), lambda s, n: plain(s, 0x0800, ipv4_packet(SENDER_IP, INSIDE_IP, n)), 'positive control: in-segment IPv4, rule p1-ipv4-intra-segment'),
    WorkloadClass('C1', 'allow-arp-known-host', 'p2p3', 'p2p3', {'etherType': 0x0806, 'arpSpa': SENDER_IP}, lambda s, _n: plain(s, 0x0806, arp_request(s, SENDER_IP, ARP_TARGET)), 'positive control: ARP from a known workload host'),
    WorkloadClass('A1', 'experimental', 'p3only', 'p3only', {'etherType': 0x88b5}, tm.build_experimental, 'EtherType 0x88b5'),
    WorkloadClass('A2', 'ipv6', 'p3only', 'p3only', {'etherType': 0x86dd}, tm.build_ipv6, 'IPv6'),
    WorkloadClass('A3', 'vlan-tagged', 'p3only', 'p3only', {'etherType': 0x8100}, tm.build_vlan_tagged, '802.1Q VID 100, inner 0x88b5'),
    WorkloadClass('A4', 'stp-bpdu', 'p3only', 'p3only', {'etherType': 0x0026}, tm.build_stp, 'STP BPDU to the bridge group address (802.3 length field)'),
    WorkloadClass('A5', 'runt', 'p3only', 'p3only', {'etherType': 0x88b5}, tm.build_runt, '0x88b5 with a 4-byte payload'),
    WorkloadClass('A6', 'near-mtu', 'p3only', 'p3only', {'etherType': 0x88b5}, tm.build_near_mtu, '0x88b5, 1514 bytes'),
    WorkloadClass('A7', 'arp-unknown-spa', 'p3only', 'p3only', {'etherType': 0x0806, 'arpSpa': UNKNOWN_SPA}, lambda s, _n: plain(s, 0x0806, arp_request(s, UNKNOWN_SPA, ARP_TARGET)), 'ARP claiming an address that is not a workload host'),
    WorkloadClass('A8', 'lldp', 'p3only', 'p3only', {'etherType': 0x88cc}, tm.build_lldp, 'LLDP; expected to be consumed on the way'),
    WorkloadClass('B1', 'ipv4-options-outside', 'p3only', 'p3only', _ip(SENDER_IP, OUTSIDE_IP), lambda s, n: plain(s, 0x0800, ipv4_packet(SENDER_IP, OUTSIDE_IP, n, options=OPTIONS_NOPS)), 'IPv4 with options, destination outside the segment'),
    WorkloadClass('B2', 'ipv4-first-fragment-outside', 'p3only', 'p3only', _ip(SENDER_IP, OUTSIDE_IP), lambda s, n: plain(s, 0x0800, ipv4_packet(SENDER_IP, OUTSIDE_IP, n, flags_frag=MORE_FRAGMENTS)), 'first fragment, destination outside'),
    WorkloadClass('B3', 'ipv4-later-fragment-outside', 'p3only', 'p3only', _ip(SENDER_IP, OUTSIDE_IP), lambda s, n: plain(s, 0x0800, ipv4_packet(SENDER_IP, OUTSIDE_IP, n, flags_frag=LATER_OFFSET, udp=False)), 'later fragment (no L4 header), destination outside'),
    WorkloadClass('B4', 'vlan-ipv4-outside', 'p3only', 'p3only', {'etherType': 0x8100}, lambda s, n: tagged(s, 0x0800, ipv4_packet(SENDER_IP, OUTSIDE_IP, n)), '802.1Q IPv4, destination outside: the one with a real chance of a surprise'),
    WorkloadClass('B5', 'ipv4-spoofed-source', 'p3only', 'p3only', _ip(SPOOF_IP, INSIDE_IP), lambda s, n: plain(s, 0x0800, ipv4_packet(SPOOF_IP, INSIDE_IP, n)), 'source outside the segment, destination inside'),
    WorkloadClass('I1', 'vlan-ipv4-inside', 'info', 'p3only', {'etherType': 0x8100}, lambda s, n: tagged(s, 0x0800, ipv4_packet(SENDER_IP, INSIDE_IP, n)), 'informational: matched through a tag, or not'),
    WorkloadClass('I2', 'ipv4-options-inside', 'info', 'p2p3', _ip(SENDER_IP, INSIDE_IP), lambda s, n: plain(s, 0x0800, ipv4_packet(SENDER_IP, INSIDE_IP, n, options=OPTIONS_NOPS)), 'informational: in-segment IPv4 with options'),
    WorkloadClass('I3', 'ipv4-later-fragment-inside', 'info', 'p2p3', _ip(SENDER_IP, INSIDE_IP), lambda s, n: plain(s, 0x0800, ipv4_packet(SENDER_IP, INSIDE_IP, n, flags_frag=LATER_OFFSET, udp=False)), 'informational: in-segment later fragment'),
]
for _i, _c in enumerate(_SPECS):
    _c.src = f'02:00:00:00:00:{SRC_MAC_BASE + _i:02x}'
    _c.bpf = f'ether src {_c.src}'
CLASSES: List[WorkloadClass] = _SPECS
BY_ID: Dict[str, WorkloadClass] = {c.id: c for c in CLASSES}
CONTROL_IDS = ['C0', 'C1']
GROUPS: List[List[str]] = [
    CONTROL_IDS + ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8'],
    CONTROL_IDS + ['B1', 'B2', 'B3', 'B4', 'B5'],
    CONTROL_IDS + ['I1', 'I2', 'I3'],
]


def send_schedule(ids: List[str], n_frames: int = FRAMES_PER_CLASS) -> List[Tuple[str, int, str]]:
    """(class id, sequence number, frame hex), interleaved by round so no class is sent in one burst."""
    return [(cid, i, BY_ID[cid].frame(i).hex()) for i in range(n_frames) for cid in ids]


def capture_filter(ids: List[str]) -> str:
    return ' or '.join(f'({BY_ID[c].bpf})' for c in ids)


def judge(counts: Dict[str, Dict[str, int]], invalid: Optional[Dict[str, str]] = None, n: int = FRAMES_PER_CLASS) -> Dict[str, Any]:
    """The verdict rules of the pre-registration, in their order. counts is {class id: {'O3': frames, 'O2': frames}}; invalid is {observer: reason} for any observer whose capture is not proven."""
    invalid = invalid or {}
    if invalid:
        return {'verdicts': {c: 'observer_invalid' for c in counts}, 'breaches': [], 'o3_frames': {}, 'void': True, 'stop': True, 'invalid': invalid}
    verdicts: Dict[str, str] = {}
    breaches: List[str] = []
    o3_frames: Dict[str, int] = {}
    void = False
    for cid, c in counts.items():
        spec, o3, o2 = BY_ID[cid], c['O3'], c['O2']
        if spec.prediction == 'p2p3':
            ok = o2 == n and o3 == n
            verdicts[cid] = 'as_predicted' if ok else 'control_failed'
            void = void or not ok
        elif o2 != n:
            verdicts[cid] = 'control_failed'
            if spec.prediction == 'p3only' and o3 > 0:
                o3_frames[cid] = o3   # reached O3 without the tap control: shown and stops the run, never read as contained
        elif spec.prediction == 'p3only':
            verdicts[cid] = 'breach' if o3 > 0 else 'contained'
            if o3 > 0:
                breaches.append(cid)
        else:
            verdicts[cid] = 'observed_p2_p3' if o3 == n else 'observed_p3_only' if o3 == 0 else 'observed_partial'
    if any(c not in counts for c in CONTROL_IDS):
        void = True
    return {'verdicts': verdicts, 'breaches': breaches, 'o3_frames': o3_frames, 'void': void, 'stop': bool(breaches) or bool(o3_frames) or void, 'invalid': {}}


# ---- the group runner ---------------------------------------------------------------------------------------------------------------------------------------

class Deps:
    """Everything the runner touches, injected so the tests can script it: the ssh runner for the captures, the observers, the sender, the status read, the sleep and a monotonic clock."""

    def __init__(self, runner: tm.Runner, observers: Dict[str, Tuple[str, str, bool]], send: Callable[[List[str]], Tuple[bool, str]], status: Callable[[], dict],
                 sleep: Callable[[float], None], now_ms: Callable[[], int]):
        self.runner, self.observers, self.send, self.status, self.sleep, self.now_ms = runner, observers, send, status, sleep, now_ms


def status_problem(s: dict) -> Optional[str]:
    """None if the isolation status allows a run: verified, a DROP table-miss, no quarantine, and the status itself readable."""
    if 'error' in s:
        return f'the status could not be read: {s["error"]}'
    if s.get('state') != 'verified' or s.get('tableMiss') != 'drops':
        return f'isolation is {s.get("state")}/{s.get("tableMiss")}, not verified/drops'
    if s.get('quarantines') != 0:
        return f'quarantines are active ({s.get("quarantines")}): the detectors act on what the tap sees and a quarantine of the sender changes the predictions'
    return None


def parse_status(text: str) -> dict:
    """From the bridge's /api/zodiac/flows: the isolation state, the table-miss verdict and the number of installed quarantine rules. Strict: a field that is missing is an error, never a 0."""
    try:
        d = json.loads(text)
        p = d['port1Isolation']
        rules = d['rules']
    except (ValueError, KeyError, TypeError) as e:
        return {'error': f'{type(e).__name__}: {str(e)[:100]}'}
    if not isinstance(rules, list) or not isinstance(p, dict):
        return {'error': 'the status has no rule list or no isolation block'}
    q = sum(1 for r in rules if str(r.get('ruleId', '')).startswith('quarantine-') and r.get('openFlowInstalled'))
    return {'state': p.get('state'), 'tableMiss': (p.get('actions') or {}).get('tableMiss'), 'quarantines': q}


def run_group(ids: List[str], d: Deps, label: str, prefix: str = '/tmp/wf') -> Dict[str, Any]:
    before = d.status()
    problem = status_problem(before)
    if problem:
        return {'label': label, 'ids': ids, 'error': f'refusing to start: {problem}', 'status_before': before, 'stop': True}
    sched = send_schedule(ids)
    capture_s = int(4 + len(sched) * SPACING_S + 8)
    t0 = d.now_ms()
    started = tm.start_captures(d.runner, d.observers, capture_filter(ids), capture_s, prefix, d.sleep)
    not_listening = {k: v['reason'] for k, v in started.items() if not v['listening']}
    if not_listening:
        return {'label': label, 'ids': ids, 'error': 'aborted before sending: an observer is not listening', 'not_listening': not_listening, 'stop': True}
    ok, sent = d.send([h for _, _, h in sched])
    after = d.status()
    if not ok:
        return {'label': label, 'ids': ids, 'error': sent, 'status_before': before, 'status_after': after, 'stop': True}
    d.sleep(tm.seconds_until_capture_end(t0, d.now_ms(), capture_s))
    results, invalid = tm.read_all(d.runner, d.observers, {k: v['base'] for k, v in started.items()})
    counts = {}
    for cid in ids:
        row = {}
        for obs in d.observers:
            r = results[obs]
            row[tm.observer_group(obs)] = tm.parse_capture(str(r['text'])).get(BY_ID[cid].src, {'count': 0})['count'] if r['valid'] else 0
        counts[cid] = row
    j = judge(counts, invalid)
    out: Dict[str, Any] = {'label': label, 'ids': ids, 'counts': counts, 'sender': sent, 'capture_summaries': {k: v['packets'] for k, v in results.items()}, 'status_before': before, 'status_after': after, **j}
    after_problem = status_problem(after)
    if after_problem:
        out['void'], out['stop'], out['status_problem_after'] = True, True, after_problem   # a quarantine or a changed table-miss during the group: its predictions no longer hold
    return out


def run_all(groups: List[List[str]], d: Deps, label: str) -> Dict[str, Any]:
    """Groups in order; a group that says stop ends the run, so no later group is sent."""
    done: List[Dict[str, object]] = []
    for i, g in enumerate(groups):
        r = run_group(g, d, f'{label}-g{i + 1}')
        done.append(r)
        if r.get('stop'):
            break
    return {'label': label, 'groups_run': len(done), 'groups_planned': len(groups), 'groups': done,
            'breaches': [b for r in done for b in r.get('breaches', [])], 'stopped': any(r.get('stop') for r in done)}


# ---- selftest ----------------------------------------------------------------------------------------------------------------------------------------------

def _fake_text(ids: List[str], per_class: Dict[str, int]) -> str:
    lines = []
    for cid in ids:
        for k in range(per_class.get(cid, 0)):
            lines.append(f'12:00:00.{k:06d} {BY_ID[cid].src} > ff:ff:ff:ff:ff:ff, ethertype IPv4 (0x0800), length 60: x')
    return '\n'.join(lines) + ('\n' if lines else '')


def _scripted(ids_by_call: List[List[str]], o3_by_call: List[Dict[str, int]], o2_by_call: List[Dict[str, int]], listening: str = '1') -> Tuple[tm.ScriptedRunner, dict]:
    """A fake ssh in which each group's captures come back with the given per-class counts (call index = group index)."""
    state = {'group': -1, 'starts': 0}

    class R(tm.ScriptedRunner):
        def __call__(self, host: str, cmd: str, timeout: int, stdin: Optional[str] = None) -> Tuple[int, str, str]:
            del timeout, stdin
            self.calls.append(f'{host}: {cmd}')
            if 'setsid nohup' in cmd and cmd.endswith('&)') and 'O3_p2_mirror' in cmd:
                state['group'] += 1
                state['starts'] += 1
                return 0, '', ''
            if 'setsid nohup' in cmd:
                return 0, '', ''
            if "grep -c 'listening on'" in cmd:
                return 0, listening + '\n', ''
            if 'head -c 150' in cmd:
                return 0, 'empty', ''
            if 'head -c 4000' in cmd:
                g = max(state['group'], 0)
                ids = ids_by_call[g]
                per = (o3_by_call if 'O3_p2_mirror' in cmd else o2_by_call)[g]
                text = _fake_text(ids, per)
                total = sum(per.get(c, 0) for c in ids)
                return 0, f'listening on x\n{total} packets captured\n0 packets dropped by kernel\n#TXT#\n{text}', ''
            return 255, '', 'no scripted response'
    return R([]), state


def selftest() -> None:
    n = FRAMES_PER_CLASS
    clean_o3 = lambda ids: {c: (n if BY_ID[c].prediction == 'p2p3' else 0) for c in ids}
    clean_o2 = lambda ids: {c: n for c in ids}
    healthy = {'state': 'verified', 'tableMiss': 'drops', 'quarantines': 0}
    obs = {OBSERVER_O3: ('jetson', 'o3if', False), OBSERVER_O2: ('jetson', 'o2if', False)}

    def deps(runner, statuses, sends):
        it = iter(statuses)
        def status(): return next(it, statuses[-1])
        def send(hexes):
            sends.append(len(hexes))
            return True, 'sent'
        return Deps(runner, obs, send, status, lambda s: None, lambda: 10_000_000)

    # 1. a clean run of all three groups: contained, nothing stops, 3 sends of 20 x group size frames.
    sends: List[int] = []
    r, _ = _scripted(GROUPS, [clean_o3(g) for g in GROUPS], [clean_o2(g) for g in GROUPS])
    out = run_all(GROUPS, deps(r, [healthy], sends), 't1')
    assert out['groups_run'] == 3 and not out['stopped'] and out['breaches'] == [], out
    assert sends == [n * len(g) for g in GROUPS], sends
    assert out['groups'][0]['verdicts']['A1'] == 'contained' and out['groups'][1]['verdicts']['B4'] == 'contained'

    # 2. no observer listening: nothing is sent.
    sends = []
    r, _ = _scripted(GROUPS, [clean_o3(g) for g in GROUPS], [clean_o2(g) for g in GROUPS], listening='0')
    out = run_all(GROUPS, deps(r, [healthy], sends), 't2')
    assert sends == [] and out['groups'][0]['error'].startswith('aborted before sending') and out['stopped'], out

    # 3. a breach in group 2 (a tap-only class seen at O3) stops the run: group 3 is never started.
    sends = []
    o3 = [clean_o3(g) for g in GROUPS]
    o3[1]['B4'] = 3
    r, state = _scripted(GROUPS, o3, [clean_o2(g) for g in GROUPS])
    out = run_all(GROUPS, deps(r, [healthy], sends), 't3')
    assert out['groups_run'] == 2 and out['breaches'] == ['B4'] and out['stopped'] and len(sends) == 2 and state['starts'] == 2, (out, sends, state)

    # 4. a quarantine appearing during a group voids it.
    sends = []
    r, _ = _scripted(GROUPS, [clean_o3(g) for g in GROUPS], [clean_o2(g) for g in GROUPS])
    out = run_all(GROUPS, deps(r, [healthy, {**healthy, 'quarantines': 1}], sends), 't4')
    g1 = out['groups'][0]
    assert out['groups_run'] == 1 and g1['void'] and g1['stop'] and 'quarantines are active' in g1['status_problem_after'], out

    # 5. isolation not verified before: refused, no capture started, nothing sent.
    sends = []
    r, state = _scripted(GROUPS, [clean_o3(g) for g in GROUPS], [clean_o2(g) for g in GROUPS])
    out = run_all(GROUPS, deps(r, [{'state': 'mismatch', 'tableMiss': 'forwards', 'quarantines': 0}], sends), 't5')
    assert sends == [] and state['starts'] == 0 and 'refusing to start' in out['groups'][0]['error'], out

    # 5b. the status parser is strict: a missing field is an error, quarantine rules are counted only when installed.
    good = json.dumps({'port1Isolation': {'state': 'verified', 'actions': {'tableMiss': 'drops'}}, 'rules': [{'ruleId': 'p1-default-tap-only', 'openFlowInstalled': True}, {'ruleId': 'quarantine-1', 'openFlowInstalled': True}, {'ruleId': 'quarantine-2', 'openFlowInstalled': False}]})
    assert parse_status(good) == {'state': 'verified', 'tableMiss': 'drops', 'quarantines': 1}, parse_status(good)
    assert 'error' in parse_status('{"port1Isolation": {}}') and 'error' in parse_status('not json') and 'error' in parse_status('{"rules": []}')

    # 6. an unreadable status is a refusal, not a pass.
    assert status_problem({'error': 'boom'}) is not None and status_problem({'state': 'verified', 'tableMiss': 'drops'}) is not None   # quarantines missing: not 0
    assert status_problem(healthy) is None
    print('selftest ok')


def _cli(argv: List[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    if argv[0] == 'dump':
        print(json.dumps({'frames_per_class': FRAMES_PER_CLASS, 'groups': GROUPS, 'classes': [
            {'id': c.id, 'name': c.name, 'kind': 'control' if c.id in CONTROL_IDS else 'info' if c.prediction == 'info' else 'contained', 'prediction': c.prediction, 'src': c.src, 'bpf': c.bpf,
             'visible': c.visible, 'model_says': c.model_says, 'frame_hex': c.frame(0).hex(), 'frame_hex_7': c.frame(7).hex(), 'what': c.what} for c in CLASSES]}))
        return 0
    if argv[0] == 'judge':
        req = json.load(sys.stdin)
        print(json.dumps(judge(req['counts'], req.get('invalid'), req.get('n', FRAMES_PER_CLASS))))
        return 0
    if argv[0] == 'selftest':
        selftest()
        return 0
    print(__doc__)
    return 2


if __name__ == '__main__':
    sys.exit(_cli(sys.argv[1:]))
