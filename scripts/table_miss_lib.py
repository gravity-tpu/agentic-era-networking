#!/usr/bin/env python3
"""Pure helpers for scripts/table-miss-traffic.py and scripts/table-miss-load.py: frame builders, per-class capture filters, counting, the expectation for each
table-miss state, and the abort logic of the load test. No I/O, no ssh, no clocks: everything here is checked offline by test/invariants/table-miss-extended.test.ts,
which builds the expected bytes independently.

What the checks here prove and what they do not. The frame builders prove only that the bytes are what is written here. The judge compares counts at observers with the
expectation fixed in advance for a state; it cannot tell why a count differs (a drop in the switch, a drop in the NETGEAR between the sender and the switch, or a
capture that lost frames), which is why every class has its own control count at O3 (the mirror of the Zodiac P2 link) and a class whose control is not exact is
reported as invalid, never as a result. The abort logic proves that the listed signs of trouble stop the run; it cannot see trouble that has no sign in the API or journal it reads.

Table-miss states, as the owner arranges them: drop (the normal DROP), absent (strict delete), unrecognised (any of the four non-forwarding entries) and forwards
(a priority-0 forward to the tap, P3). With the isolation policy of src/sdn/port1-isolation.ts every class below from the uplink side reaches the table-miss: from P2 only IPv4
destined to 10.0.2.0/24 matches a rule, and the uplink ARP peer list is empty.

CLI (used by the tests): python3 scripts/table_miss_lib.py dump | judge | parse | poll | monitor | plan | step | observe   (JSON on stdin for all but dump).
"""
import json, re, sys
from typing import Callable, Dict, List, Optional, Tuple

NS = 1_000_000_000

# ---- frame classes -----------------------------------------------------------------------------------------------------------------------------------

DST_MAC = '02:00:00:00:be:ef'  # locally administered; nothing on the lab answers it
FRAMES_PER_CLASS = 20
ETHERTYPE_EXPERIMENTAL = 0x88b5
VLAN_ID = 100  # not VLAN 2 (the arrangement's own VLAN on switch #2), so a tagged frame is not silently untagged by a port that is a member of it
IPV4_SRC, IPV4_DST = '192.0.2.77', '198.51.100.7'  # TEST-NET-1 and TEST-NET-2 (RFC 5737): outside 10.0.2.0/24, nothing answers
ARP_TARGET = '192.0.2.78'
NEAR_MTU_FRAME_BYTES = 1514  # 14-byte header + 1500-byte payload, the largest untagged frame without FCS
RUNT_PAYLOAD_BYTES = 4       # an 18-byte frame, below the 60-byte minimum before FCS; the NIC may pad it, which the observers' length column shows
MIN_FRAME_BYTES = 60         # without FCS


def mac(text: str) -> bytes:
    return bytes(int(x, 16) for x in text.split(':'))


def ip4(text: str) -> bytes:
    return bytes(int(x) for x in text.split('.'))


def pad_to(frame: bytes, n: int = MIN_FRAME_BYTES) -> bytes:
    return frame.ljust(n, b'\x00')


def eth(dst: str, src: str, ethertype: int, payload: bytes) -> bytes:
    return mac(dst) + mac(src) + ethertype.to_bytes(2, 'big') + payload


def ipv4_checksum(header: bytes) -> int:
    s = sum(int.from_bytes(header[i:i + 2], 'big') for i in range(0, len(header), 2))
    while s >> 16:
        s = (s & 0xffff) + (s >> 16)
    return (~s) & 0xffff


def tag(n: int) -> bytes:
    return f'zodiac-table-miss-traffic {n:04d}'.encode()


def build_experimental(src: str, n: int) -> bytes:
    # byte-for-byte what scripts/table-miss-traffic.py sent before this module existed
    return eth(DST_MAC, src, ETHERTYPE_EXPERIMENTAL, tag(n).ljust(46, b'.'))


def build_ipv6(src: str, n: int) -> bytes:
    payload = tag(n)[:8]  # 8 bytes after the header; next header 59 = "no next header"
    header = (0x60000000).to_bytes(4, 'big') + len(payload).to_bytes(2, 'big') + bytes([59, 64])
    header += bytes.fromhex('20010db8000000000000000000000077') + bytes.fromhex('20010db80000000000000000000000ef')
    return pad_to(eth(DST_MAC, src, 0x86dd, header + payload))


def build_vlan_tagged(src: str, n: int) -> bytes:
    inner = ETHERTYPE_EXPERIMENTAL.to_bytes(2, 'big') + tag(n).ljust(42, b'.')
    return eth(DST_MAC, src, 0x8100, VLAN_ID.to_bytes(2, 'big') + inner)


def build_lldp(src: str, n: int) -> bytes:
    srcb = mac(src)
    tlvs = (0x0207).to_bytes(2, 'big') + bytes([4]) + srcb       # chassis ID: subtype 4 (MAC)
    tlvs += (0x0407).to_bytes(2, 'big') + bytes([3]) + srcb      # port ID: subtype 3 (MAC)
    tlvs += (0x0602).to_bytes(2, 'big') + (120).to_bytes(2, 'big')  # TTL 120 s
    tlvs += b'\x00\x00'                                          # end of LLDPDU
    return pad_to(eth('01:80:c2:00:00:0e', src, 0x88cc, tlvs))


def build_stp(src: str, n: int) -> bytes:
    bridge_id = (0xf000).to_bytes(2, 'big') + mac(src)  # priority 61440, the worst: it can never win a root election on a real bridge
    bpdu = b'\x00\x00' + b'\x00' + b'\x00' + b'\x00' + bridge_id + (0).to_bytes(4, 'big') + bridge_id + (0x8001).to_bytes(2, 'big')
    bpdu += (0).to_bytes(2, 'big') + (20 * 256).to_bytes(2, 'big') + (2 * 256).to_bytes(2, 'big') + (15 * 256).to_bytes(2, 'big')
    llc = bytes([0x42, 0x42, 0x03])
    body = llc + bpdu  # 3 + 35 = 38; the 802.3 length field, then padding
    return pad_to(mac('01:80:c2:00:00:00') + mac(src) + len(body).to_bytes(2, 'big') + body)


def build_runt(src: str, n: int) -> bytes:
    return eth(DST_MAC, src, ETHERTYPE_EXPERIMENTAL, tag(n)[:RUNT_PAYLOAD_BYTES])


def build_near_mtu(src: str, n: int) -> bytes:
    return eth(DST_MAC, src, ETHERTYPE_EXPERIMENTAL, tag(n).ljust(NEAR_MTU_FRAME_BYTES - 14, b'.'))


def build_ipv4_outside(src: str, n: int) -> bytes:
    payload = tag(n)[:18]
    udp = (41951).to_bytes(2, 'big') + (41951).to_bytes(2, 'big') + (8 + len(payload)).to_bytes(2, 'big') + (0).to_bytes(2, 'big') + payload  # UDP checksum 0 = none (IPv4)
    head = bytes([0x45, 0]) + (20 + len(udp)).to_bytes(2, 'big') + (n & 0xffff).to_bytes(2, 'big') + (0).to_bytes(2, 'big') + bytes([64, 17, 0, 0]) + ip4(IPV4_SRC) + ip4(IPV4_DST)
    head = head[:10] + ipv4_checksum(head).to_bytes(2, 'big') + head[12:]
    return pad_to(eth(DST_MAC, src, 0x0800, head + udp))


def build_arp_request(src: str, n: int) -> bytes:
    arp = (1).to_bytes(2, 'big') + (0x0800).to_bytes(2, 'big') + bytes([6, 4]) + (1).to_bytes(2, 'big') + mac(src) + ip4(IPV4_SRC) + bytes(6) + ip4(ARP_TARGET)
    return pad_to(eth('ff:ff:ff:ff:ff:ff', src, 0x0806, arp))


class ClassSpec:
    def __init__(self, name: str, src: str, builder: Callable[[str, int], bytes], bpf_rest: str, what: str, forward_confidence: str, control_caveat: str = ''):
        self.name, self.src, self._builder, self.what = name, src, builder, what
        self.bpf = f'ether src {src}' + (f' and {bpf_rest}' if bpf_rest else '')
        self.forward_confidence = forward_confidence  # how sure the prediction "forwards -> reaches the tap" is: high, medium or low (firmware may treat the class specially)
        self.control_caveat = control_caveat  # why the O3 control may legitimately not read exact for this class

    def frame(self, n: int) -> bytes:
        return self._builder(self.src, n)


LEGACY_CLASS = 'experimental'

CLASSES: Dict[str, ClassSpec] = {c.name: c for c in [
    ClassSpec('experimental', '02:00:00:00:00:77', build_experimental, 'ether proto 0x88b5', 'IEEE 802 local experimental ethertype 0x88b5, 60 bytes (the class measured on 2026-11-02)', 'high'),
    ClassSpec('ipv6', '02:00:00:00:00:71', build_ipv6, 'ether proto 0x86dd', 'IPv6 (0x86dd), 62 bytes, no next header', 'medium'),
    ClassSpec('vlan-tagged', '02:00:00:00:00:72', build_vlan_tagged, f'vlan {VLAN_ID}', f'802.1Q tag, VID {VLAN_ID}, inner ethertype 0x88b5, 60 bytes', 'low',
              'switch #2 may drop or untag a tagged frame at ingress, depending on its VLAN mode'),
    ClassSpec('lldp', '02:00:00:00:00:73', build_lldp, 'ether proto 0x88cc', 'LLDP (0x88cc) to the link-local group 01:80:c2:00:00:0e, 60 bytes', 'low',
              'a bridge is not required to forward 01:80:c2:00:00:0e; switch #2 may consume it'),
    ClassSpec('stp-bpdu', '02:00:00:00:00:74', build_stp, 'ether dst 01:80:c2:00:00:00', 'STP configuration BPDU to 01:80:c2:00:00:00 (802.3 + LLC), bridge priority 61440, 60 bytes', 'low',
              'a bridge must not forward 01:80:c2:00:00:00; switch #2 will probably consume it'),
    ClassSpec('runt', '02:00:00:00:00:75', build_runt, 'ether proto 0x88b5', f'ethertype 0x88b5 with a {RUNT_PAYLOAD_BYTES}-byte payload: 18 bytes before any NIC padding', 'low',
              'the sending NIC or switch #2 may pad or discard a frame below 60 bytes; the observed length says which'),
    ClassSpec('near-mtu', '02:00:00:00:00:76', build_near_mtu, 'ether proto 0x88b5', f'ethertype 0x88b5, {NEAR_MTU_FRAME_BYTES} bytes (a full 1500-byte payload)', 'medium'),
    ClassSpec('ipv4-outside-segment', '02:00:00:00:00:78', build_ipv4_outside, f'ip dst {IPV4_DST}', f'IPv4/UDP from {IPV4_SRC} to {IPV4_DST}, outside 10.0.2.0/24 so rule p2-ipv4-to-segment does not match, 60 bytes', 'medium'),
    ClassSpec('arp-request', '02:00:00:00:00:79', build_arp_request, 'arp', f'ARP who-has {ARP_TARGET} tell {IPV4_SRC} from the uplink (the uplink ARP peer list is empty, so no rule matches), 60 bytes', 'medium'),
]}
CLASS_ORDER = list(CLASSES)


def pick_classes(arg: str) -> List[str]:
    if arg == 'all':
        return list(CLASS_ORDER)
    names = [a.strip() for a in arg.split(',') if a.strip()]
    unknown = [a for a in names if a not in CLASSES]
    if unknown or not names:
        raise ValueError(f'unknown class(es) {unknown or arg!r}; known: {", ".join(CLASS_ORDER)}')
    return names


def send_schedule(names: List[str], per_class: int) -> List[Tuple[str, int, str]]:
    """(class, sequence number, frame hex), interleaved by round so no class is sent in one burst."""
    return [(name, i, CLASSES[name].frame(i).hex()) for i in range(per_class) for name in names]


def legacy_frame_hex(n: int) -> str:
    return CLASSES[LEGACY_CLASS].frame(n).hex()


def capture_filter(names: List[str]) -> str:
    """One BPF expression per observer: every class's own filter, OR-ed. Each class's own filter is also what a per-class capture would use. libpcap's `vlan` primitive shifts the
    decoding offsets for the rest of the expression, so a class that uses it goes last, where it cannot change how the others are read."""
    ordered = sorted(names, key=lambda n: ' vlan ' in f' {CLASSES[n].bpf} ')  # stable: only moves the vlan classes to the end
    return ' or '.join(f'({CLASSES[n].bpf})' for n in ordered)


# ---- counting ----------------------------------------------------------------------------------------------------------------------------------------

LINE = re.compile(r'^\S+\s+([0-9a-f]{2}(?::[0-9a-f]{2}){5}) > ([0-9a-f]{2}(?::[0-9a-f]{2}){5}),.*?\blength (\d+)')


def parse_capture(text: str) -> Dict[str, dict]:
    """From `tcpdump -nn -e` output: per source MAC, the number of frames and a histogram of the frame lengths tcpdump printed. A line that is not a frame line is ignored."""
    out: Dict[str, dict] = {}
    for line in text.splitlines():
        m = LINE.match(line)
        if not m:
            continue
        entry = out.setdefault(m.group(1), {'count': 0, 'lengths': {}})
        entry['count'] += 1
        entry['lengths'][m.group(3)] = entry['lengths'].get(m.group(3), 0) + 1
    return out


def counts_by_class(text: str, names: List[str]) -> Dict[str, dict]:
    parsed = parse_capture(text)
    return {n: parsed.get(CLASSES[n].src, {'count': 0, 'lengths': {}}) for n in names}


# ---- expectations and judgement ---------------------------------------------------------------------------------------------------------------------

STATES = ('drop', 'absent', 'unrecognised', 'forwards')


def expectation(state: str, name: str, n: int) -> Dict[str, object]:
    """Fixed in advance (docs/benchmarks/results/table-miss-extended/PREREGISTRATION.md). O3 is the control and must be exact; O2 is the tap (out of P3); O4 is the workload side (out of P1)."""
    if state not in STATES:
        raise ValueError(f'unknown table-miss state {state!r}')
    forwards = state == 'forwards'
    return {'O3': n, 'O2': n if forwards else 0, 'O4': 0, 'confidence': CLASSES[name].forward_confidence if forwards else 'high'}


def judge(state: str, per_class_counts: Dict[str, Dict[str, int]], n: int, invalid: Optional[Dict[str, str]] = None) -> Dict[str, object]:
    """Verdict per class, in this order: observer_invalid (an observer's evidence is incomplete: its capture did not start, did not finish, dropped frames or disagrees with its own summary;
    stronger than anything below, because a count from such an observer is not a count), control_failed (O3 != n: the class did not reach the switch intact, so nothing else about it counts),
    workload_reach (any frame out of P1: the isolation property is broken, whatever the state), leak (a frame out of P3 in a state that must not forward), forwarding_differs (state forwards,
    O2 != n: not a breach, a finding), as_predicted. `invalid` maps an observer (O3, O2 or O4) to the reason. `breach` is true for workload_reach or leak."""
    invalid = invalid or {}
    rows = {}
    for name, c in per_class_counts.items():
        e = expectation(state, name, n)
        o3, o2, o4 = c.get('O3', 0), c.get('O2', 0), c.get('O4', 0)
        if invalid:
            v = 'observer_invalid'
        elif o3 != n:
            v = 'control_failed'
        elif o4 > 0:
            v = 'workload_reach'
        elif state != 'forwards' and o2 > 0:
            v = 'leak'
        elif state == 'forwards' and o2 != e['O2']:
            v = 'forwarding_differs'
        else:
            v = 'as_predicted'
        rows[name] = {'verdict': v, 'expected': e, 'observed': {k: (None if k in invalid else x) for k, x in (('O3', o3), ('O2', o2), ('O4', o4))}}
    return {'state': state, 'classes': rows, 'invalid_observers': invalid, 'breach': any(r['verdict'] in ('workload_reach', 'leak') for r in rows.values()),
            'valid_classes': [k for k, r in rows.items() if r['verdict'] not in ('control_failed', 'observer_invalid')]}


# ---- observation: a count is evidence only if the observer's capture provably ran ------------------------------------------------------------------------------
# An ssh that fails, a `sudo -n` that is refused or a capture that never started all print nothing, and "nothing" read as "0 frames" is exactly what a correct DROP looks like. So: every
# remote command returns a structured result (never a bare string), a capture is verified listening before any frame is sent, and a count is taken only from a capture whose tcpdump exit
# summary ("N packets captured") is present, has no kernel drops and agrees with the number of frame lines. Anything else makes the observer INVALID, with the reason, never zero.

LISTEN_RETRIES = 3          # checks of the stderr file, one second apart, per start attempt
START_ATTEMPTS = 2          # the start is retried once, boundedly
REMOTE_TIMEOUT_SECONDS = 30
Runner = Callable[[str, str, int, Optional[str]], Tuple[int, str, str]]  # (host, command, timeout seconds, stdin) -> (return code, stdout, stderr); may raise subprocess.TimeoutExpired or OSError


class Remote:
    def __init__(self, ok: bool, rc: Optional[int], out: str, err: str, reason: str = ''):
        self.ok, self.rc, self.out, self.err, self.reason = ok, rc, out, err, reason


def ssh_runner(host: str, cmd: str, timeout: int, stdin: Optional[str] = None) -> Tuple[int, str, str]:
    import subprocess
    p = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host, cmd], input=stdin, capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout, p.stderr


def run_remote(runner: Runner, host: str, cmd: str, timeout: int = REMOTE_TIMEOUT_SECONDS, stdin: Optional[str] = None) -> Remote:
    """Never returns a bare string and never swallows a failure: a non-zero return code, a timeout or an OS error is `ok=False` with the reason."""
    try:
        rc, out, err = runner(host, cmd, timeout, stdin)
    except Exception as e:  # subprocess.TimeoutExpired, OSError: reported as a failure of the command, not as an empty result
        return Remote(False, None, '', '', f'{host}: {type(e).__name__}: {str(e)[:100]}')
    if rc != 0:
        return Remote(False, rc, out, err, f'{host}: exit {rc}: {err.strip()[:120] or "no stderr"}')
    return Remote(True, rc, out, err)


def capture_start_command(base: str, iface: str, sudo: bool, seconds: int, flt: str) -> str:
    # setsid + nohup + stdin from /dev/null: when the ssh session ends the remote shell may signal its process group; a detached capture survives that, a plain `( ... &)` may not.
    return (f"rm -f {base}.txt {base}.err; (setsid nohup {'sudo -n ' if sudo else ''}timeout {seconds} tcpdump -i {iface} -nn -e -l '{flt}' > {base}.txt 2> {base}.err < /dev/null &)")


def start_captures(runner: Runner, observers: Dict[str, Tuple[str, str, bool]], flt: str, seconds: int, prefix: str, sleep: Callable[[float], None]) -> Dict[str, Dict[str, object]]:
    """Starts one capture per observer and verifies each is listening (its stderr file holds `listening on`). A failed start is retried once with a fresh file name. Returns per observer
    {'listening': bool, 'base': file base, 'reason': why not}. The caller must not send a frame unless every observer is listening."""
    result: Dict[str, Dict[str, object]] = {}
    for name, (host, iface, sudo) in observers.items():
        reason = 'not attempted'
        base = f'{prefix}-{name}'
        for attempt in range(START_ATTEMPTS):
            base = f'{prefix}-{name}' + ('' if attempt == 0 else '-retry')
            started = run_remote(runner, host, capture_start_command(base, iface, sudo, seconds, flt))
            if not started.ok:
                reason = f'the capture could not be started: {started.reason}'
                continue
            reason = 'the capture never printed "listening on"'
            for _ in range(LISTEN_RETRIES):
                sleep(1)
                check = run_remote(runner, host, f"grep -c 'listening on' {base}.err; true")
                if not check.ok:
                    reason = f'the capture file could not be read: {check.reason}'
                elif check.out.strip() == '1':
                    reason = ''
                    break
                else:
                    reason = f'the capture never printed "listening on" (stderr so far: {run_remote(runner, host, f"head -c 150 {base}.err; true").out.strip()[:150] or "empty"})'
            if reason == '':
                break
        result[name] = {'listening': reason == '', 'base': base, 'reason': reason}
    return result


SUMMARY = re.compile(r'(\d+) packets captured')
DROPPED = re.compile(r'(\d+) packets dropped by kernel')


def read_capture(runner: Runner, host: str, base: str) -> Dict[str, object]:
    """Reads one finished capture. Valid only if tcpdump's exit summary is present, reports no kernel drops, and its packet count equals the number of frame lines in the text."""
    r = run_remote(runner, host, f"head -c 4000 {base}.err; echo '#TXT#'; head -c 2000000 {base}.txt")
    if not r.ok:
        return {'valid': False, 'reason': f'the capture could not be read: {r.reason}', 'text': '', 'packets': None}
    err, sep, text = r.out.partition('#TXT#\n')
    if not sep:
        return {'valid': False, 'reason': 'the capture read had no text section', 'text': '', 'packets': None}
    m, d = SUMMARY.search(err), DROPPED.search(err)
    if m is None:
        return {'valid': False, 'reason': 'no "N packets captured" summary in the capture: it did not finish, or never ran', 'text': text, 'packets': None}
    packets = int(m.group(1))
    if d is not None and int(d.group(1)) > 0:
        return {'valid': False, 'reason': f'the kernel dropped {d.group(1)} packets before tcpdump read them', 'text': text, 'packets': packets}
    lines = sum(int(v['count']) for v in parse_capture(text).values())
    if lines != packets:
        return {'valid': False, 'reason': f'the summary says {packets} packets but the text has {lines} frame lines', 'text': text, 'packets': packets}
    return {'valid': True, 'reason': '', 'text': text, 'packets': packets}


def seconds_until_capture_end(started_ms: int, now_ms: int, capture_s: int, margin_s: int = 3) -> int:
    """Whole seconds still to wait before the captures, which end `capture_s` seconds after they were started, have printed their exit summary (the summary appears only then; a read before it
    makes the observer invalid). Never negative. All integers: the caller passes monotonic milliseconds."""
    remaining_ms = started_ms + (capture_s + margin_s) * 1000 - now_ms
    return max(0, -(-remaining_ms // 1000))


def observer_group(name: str) -> str:
    """O3_p2_mirror -> O3, O4_node01_eth0 -> O4: the two workload-side captures are one observer, invalid if either is."""
    return name.split('_', 1)[0]


def read_all(runner: Runner, observers: Dict[str, Tuple[str, str, bool]], bases: Dict[str, str]) -> Tuple[Dict[str, Dict[str, object]], Dict[str, str]]:
    """Reads every capture; returns (per capture result, {observer group: reason} for each invalid one)."""
    results = {name: read_capture(runner, host, bases[name]) for name, (host, _i, _s) in observers.items()}
    invalid: Dict[str, str] = {}
    for name, r in results.items():
        if not r['valid']:
            invalid[observer_group(name)] = (invalid[observer_group(name)] + '; ' if observer_group(name) in invalid else '') + f'{name}: {r["reason"]}'
    return results, invalid


class ScriptedRunner:
    """A fake ssh for the offline tests: rules are {match, rc, out, err, times}; the first rule whose `match` is in the command and has uses left answers; no rule is an ssh failure (255)."""

    def __init__(self, rules: List[dict]):
        self.rules, self.calls = [dict(r) for r in rules], []

    def __call__(self, host: str, cmd: str, timeout: int, stdin: Optional[str] = None) -> Tuple[int, str, str]:
        self.calls.append(f'{host}: {cmd}')
        for r in self.rules:
            if r.get('host', host) == host and r['match'] in cmd and r.get('times', 1_000_000) > 0:
                r['times'] = r.get('times', 1_000_000) - 1
                if r.get('raise') == 'timeout':
                    import subprocess
                    raise subprocess.TimeoutExpired(cmd, timeout)
                return r.get('rc', 0), r.get('out', ''), r.get('err', '')
        return 255, '', 'no scripted response'


# ---- the load test: limits, plan, delivered counts, abort logic ----------------------------------------------------------------------------------------

DEFAULT_RATES = (500, 1000, 2000, 4000, 8000)
# Named, bounded limits (Invariant 5). The ceiling is the sender's: scripts/layout-capacity-sender.py paced up to 16000 pps of 572-byte UDP and layout-capacity-run.py flags a step as
# sender-limited below 97% of target; this sender does less work per frame, but it is Python, so the hard maximum stays at half of what was ever paced. 8000 pps is also 0.63 of the
# 12662 pps the switch forwarded on the live policy (docs/benchmarks/results/layout-capacity/README.md, k=0): a forwarding table-miss stays under the forwarding capacity.
MAX_PPS_HARD = 8000
MAX_PPS_BY_STATE = {'drop': 8000, 'forwards': 8000, 'unrecognised': 4000, 'absent': 2000}  # lower where the switch's cost per frame is unmeasured
MIN_STEP_SECONDS, MAX_STEP_SECONDS = 5, 10
STEP_PAUSE_SECONDS = 3
MAX_STEPS = 6
STEP_OVERHEAD_SECONDS = 8           # per step beyond the load itself: the poll before it, starting the samplers, the sampler margin after it and the ssh round trips (an estimate from reading the code; unmeasured on the rig)
IDLE_MEASURE_SECONDS = 4
MAX_TOTAL_LOAD_SECONDS = 120        # wall time of the steps, overhead and pauses included; inside a 600 s fault this leaves room for the frame-class pass first
POLL_INTERVAL_SECONDS = 2
MAX_CONSECUTIVE_POLL_FAILURES = 2
POLL_TIMEOUT_SECONDS = 8            # one poll is one ssh with two curls (4 s each at most) and a journal read; a poll that takes longer counts as a failed poll
FAULT_RESERVE_SECONDS = 30          # a step is not started unless this much of the fault's time limit remains afterwards
LEAK_FRAMES = 3                     # idle-corrected frames at an observer that must read zero, before it counts as a breach
CONTROL_PERMILLE_MIN = 970          # O3 must see at least this many thousandths of the frames sent, or the step is not valid (integer accounting, Invariant 2)
FORWARD_PERMILLE_MIN = 970          # in the forwarding state, O2 below this share of the frames sent means the tap path lost frames at this rate

ACCEPTABLE_ISOLATION = {
    'drop': {('verified', 'drops')},
    'forwards': {('verified', 'drops'), ('mismatch', 'forwards')},
    'absent': {('verified', 'drops'), ('mismatch', 'absent')},
    'unrecognised': {('verified', 'drops'), ('mismatch', 'unrecognised')},
}
# (verified, drops) is allowed in the fault states because the bridge reads the table back only every 60 s: until the first recheck after the injection the status still says so.
# The journal (fault ended, a new session) is what says the fault is over.


class PlanError(ValueError):
    pass


def validate_plan(state: str, rates: List[int], step_seconds: int) -> int:
    """Raises PlanError for anything outside the limits; returns the total seconds of load the plan needs, pauses included."""
    if state not in STATES:
        raise PlanError(f'unknown table-miss state {state!r}')
    if not rates or len(rates) > MAX_STEPS:
        raise PlanError(f'between 1 and {MAX_STEPS} steps are allowed, got {len(rates)}')
    if any(r <= 0 for r in rates) or any(b <= a for a, b in zip(rates, rates[1:])):
        raise PlanError('rates must be positive and strictly increasing')
    cap = min(MAX_PPS_HARD, MAX_PPS_BY_STATE[state])
    if rates[-1] > cap:
        raise PlanError(f'{rates[-1]} pps is above the {cap} pps limit for state {state!r}')
    if not (MIN_STEP_SECONDS <= step_seconds <= MAX_STEP_SECONDS):
        raise PlanError(f'a step must last {MIN_STEP_SECONDS} to {MAX_STEP_SECONDS} s, got {step_seconds}')
    total = len(rates) * (step_seconds + STEP_OVERHEAD_SECONDS) + (len(rates) - 1) * STEP_PAUSE_SECONDS
    if total > MAX_TOTAL_LOAD_SECONDS:
        raise PlanError(f'the plan needs {total} s of load, above the {MAX_TOTAL_LOAD_SECONDS} s limit')
    return total


def delivered(series: List[Tuple[int, int]], idle_pps: int) -> int:
    """Frames an observer counted over a sampling window, minus what its idle rate would have counted anyway. `series` is (monotonic ns, rx_packets); integer arithmetic, floored at 0."""
    if len(series) < 2:
        return 0
    (t0, c0), (t1, c1) = series[0], series[-1]
    extra = idle_pps * (t1 - t0) // NS
    return max(0, (c1 - c0) - extra)


def judge_step(state: str, sent: int, observed: Dict[str, int]) -> Dict[str, object]:
    """One load step. O3 is the control: if it saw fewer than CONTROL_RATIO_MIN of the frames sent, the step says nothing about the switch."""
    if sent <= 0:
        return {'verdict': 'no_frames_sent', 'breach': False}
    o3, o2, o4 = observed.get('O3', 0), observed.get('O2', 0), observed.get('O4', 0)
    if o3 * 1000 < sent * CONTROL_PERMILLE_MIN:
        return {'verdict': 'control_failed', 'breach': False}
    if o4 > LEAK_FRAMES:
        return {'verdict': 'workload_reach', 'breach': True}
    if state != 'forwards':
        return {'verdict': 'leak' if o2 > LEAK_FRAMES else 'as_predicted', 'breach': o2 > LEAK_FRAMES}
    return {'verdict': 'as_predicted' if o2 * 1000 >= sent * FORWARD_PERMILLE_MIN else 'tap_path_lossy', 'breach': False}


class Monitor:
    """Reads one poll sample at a time and returns None while all is as it should be, or {'code', 'text'} for the first sign of trouble: the run must stop at once.
    Sample keys: ok (bool), error (str), isolation_state, table_miss, checked_age_ms, openflow ('Connected' or not), sessions (count of switch sessions the bridge logged),
    switch_errors (count of OFPT_ERROR lines), copp_drops (count of CoPP rate-limit lines: packet-ins reaching the controller), fault_ended (count of lines saying the fault ended, could not end or was cancelled), epoch (jetson seconds), fault_active_epoch (or None)."""

    def __init__(self, state: str, fault_seconds: int = 0):
        if state not in STATES:
            raise PlanError(f'unknown table-miss state {state!r}')
        self.state, self.fault_seconds = state, fault_seconds
        self.failures = 0
        self.baseline: Optional[Dict[str, int]] = None

    def fault_left(self, sample: Dict[str, object]) -> Optional[int]:
        active, now = sample.get('fault_active_epoch'), sample.get('epoch')
        if self.state == 'drop' or self.fault_seconds <= 0 or not isinstance(active, int) or not isinstance(now, int):
            return None
        return self.fault_seconds - (now - active)

    def feed(self, sample: Dict[str, object]) -> Optional[Dict[str, str]]:
        if not sample.get('ok'):
            self.failures += 1
            if self.failures >= MAX_CONSECUTIVE_POLL_FAILURES:
                return {'code': 'poll_failed', 'text': f'{self.failures} polls in a row could not read the bridge ({sample.get("error", "no detail")}); an unobserved switch is not loaded further'}
            return None
        self.failures = 0
        if self.baseline is None:
            self.baseline = {'sessions': int(sample.get('sessions', 0)), 'switch_errors': int(sample.get('switch_errors', 0)), 'fault_ended': int(sample.get('fault_ended', 0)), 'copp_drops': int(sample.get('copp_drops', 0))}
        if sample.get('openflow') != 'Connected':
            return {'code': 'session_not_connected', 'text': f'the switch OpenFlow session reads {sample.get("openflow")!r}, not Connected'}
        if int(sample.get('sessions', 0)) > self.baseline['sessions']:
            return {'code': 'session_restarted', 'text': 'the bridge logged a new switch session: the switch lost and re-made its OpenFlow session (a new session also re-sends the DROP and ends the fault)'}
        if int(sample.get('switch_errors', 0)) > self.baseline['switch_errors']:
            return {'code': 'switch_error', 'text': 'the switch returned an OFPT_ERROR during the load'}
        if int(sample.get('copp_drops', 0)) > self.baseline['copp_drops']:
            return {'code': 'packet_in_flood', 'text': 'the bridge logged a CoPP rate limit on OFPT_PACKET_IN: the switch is sending unmatched frames to the controller instead of dropping them in hardware'}
        if self.state != 'drop' and int(sample.get('fault_ended', 0)) > self.baseline['fault_ended']:
            return {'code': 'fault_ended', 'text': 'the bridge says the test fault ended or was cancelled: the table-miss is no longer in the state under test'}
        pair = (sample.get('isolation_state'), sample.get('table_miss'))
        if pair not in ACCEPTABLE_ISOLATION[self.state]:
            return {'code': 'isolation_unexpected', 'text': f'isolation status {pair[0]!r} with table-miss {pair[1]!r} is not one of the statuses expected for state {self.state!r}'}
        left = self.fault_left(sample)
        if left is not None and left < FAULT_RESERVE_SECONDS:
            return {'code': 'fault_time_low', 'text': f'only {left} s of the fault time limit remain (reserve {FAULT_RESERVE_SECONDS} s)'}
        return None

    def may_start_step(self, sample: Dict[str, object], step_seconds: int) -> Optional[Dict[str, str]]:
        left = self.fault_left(sample)
        if left is not None and left < step_seconds + STEP_PAUSE_SECONDS + FAULT_RESERVE_SECONDS:
            return {'code': 'fault_time_low', 'text': f'{left} s of the fault remain; a {step_seconds} s step plus the {FAULT_RESERVE_SECONDS} s reserve does not fit'}
        return None


# What one poll of the bridge asks the Jetson for, in one ssh round trip, and how its output is read. The journal is restricted to the bridge's current process (ActiveEnterTimestamp),
# so lines of an earlier run of the bridge cannot count. `tableLookups` in the bridge's snapshot is its count of OpenFlow messages received from the switch (the snapshot's own name for it is misleading): a switch that sent a PACKET_IN for every unmatched frame would raise it by about the number of frames. It is recorded, not an abort condition, because its idle rate is unmeasured. The isolation status is only re-read from the switch every 60 s: `checked_age_ms` says how old the reading is.
POLL_COMMAND = (
    "echo '#epoch'; date +%s; "
    "echo '#flows'; curl -s -m 4 localhost:3003/api/zodiac/flows | python3 -c \"import json,sys; d=json.load(sys.stdin)['port1Isolation']; print(d['state'], (d.get('actions') or {}).get('tableMiss'), d.get('checkedAgeMs'))\"; "
    "echo '#summary'; curl -s -m 4 'localhost:3003/api/zodiac?summary=true' | python3 -c \"import json,sys; d=json.load(sys.stdin)['openflow']; print(d['status'], d['tableLookups'])\"; "
    "echo '#journal'; journalctl -u zodiac-bridge --no-pager -o short-unix --since \"$(systemctl show -p ActiveEnterTimestamp --value zodiac-bridge)\" | "
    "grep -E 'TEST FAULT ACTIVE|test fault ended|could NOT be ended|revert cancelled|Table-Miss flow rule installed|OFPT_ERROR|CoPP rate-limited'; true"
)


def parse_poll(text: str) -> Dict[str, object]:
    """Reads POLL_COMMAND's output into a Monitor sample. Anything missing or malformed gives ok=False with the reason, never a guess."""
    parts: Dict[str, List[str]] = {}
    cur = None
    for line in text.splitlines():
        if line.startswith('#') and line[1:] in ('epoch', 'flows', 'summary', 'journal'):
            cur = line[1:]
            parts[cur] = []
        elif cur is not None and line.strip():
            parts[cur].append(line)
    try:
        epoch = int(parts['epoch'][0])
        iso = parts['flows'][0].split()
        summary = parts['summary'][0].split()
        if len(summary) != 2 or not summary[1].isdigit():
            raise ValueError('the summary line is not "status messagesReceived"')
        openflow, of_messages = summary[0], int(summary[1])
        if len(iso) != 3:
            raise ValueError('the isolation line is not "state tableMiss age"')
        journal = parts.get('journal', [])
    except (KeyError, IndexError, ValueError) as e:
        return {'ok': False, 'error': f'unreadable poll ({type(e).__name__}: {e})'}
    active = [l for l in journal if 'TEST FAULT ACTIVE' in l]
    active_epoch = int(active[-1].split('.', 1)[0]) if active and active[-1].split('.', 1)[0].isdigit() else None
    age = None if iso[2] in ('None', 'null') else int(iso[2]) if iso[2].isdigit() else None
    return {'ok': True, 'epoch': epoch, 'isolation_state': iso[0], 'table_miss': None if iso[1] == 'None' else iso[1], 'checked_age_ms': age, 'openflow': openflow, 'of_messages': of_messages,
            'sessions': sum('Table-Miss flow rule installed' in l for l in journal), 'switch_errors': sum('OFPT_ERROR' in l for l in journal), 'copp_drops': sum('CoPP rate-limited' in l for l in journal),
            'fault_ended': sum(('test fault ended' in l or 'could NOT be ended' in l or 'revert cancelled' in l) for l in journal), 'fault_active_epoch': active_epoch}


# ---- the remote sender of the load test (run on agentic-node-01 with sudo; stdin is the source, args: iface pps seconds stopfile frame_hex) ---------------------------------

LOAD_SENDER_SRC = '''
import os, socket, sys, time
iface, pps, secs, stop, frame = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4], bytes.fromhex(sys.argv[5])
s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW)
s.bind((iface, 0))
start = time.perf_counter_ns()
end = start + secs * 1_000_000_000
sent = 0
stopped = 0
next_check = start
send = s.send
while True:
    now = time.perf_counter_ns()
    if now >= end:
        break
    if now >= next_check:
        next_check = now + 50_000_000
        if os.path.exists(stop):
            stopped = 1
            break
    due = (now - start) * pps // 1_000_000_000 + 1
    n = due - sent
    for _ in range(n if n < 200 else 200):
        send(frame)
        sent += 1
print("sent", sent, "elapsed_ns", time.perf_counter_ns() - start, "stopped", stopped)
'''


def parse_sender_line(text: str) -> Optional[Dict[str, int]]:
    m = re.search(r'sent (\d+) elapsed_ns (\d+) stopped (\d)', text)
    return {'sent': int(m.group(1)), 'elapsed_ns': int(m.group(2)), 'stopped': int(m.group(3))} if m else None


def sender_limited(sent: int, elapsed_ns: int, target_pps: int) -> bool:
    """True when the sender did not reach 97% of the target rate: the step then measured the sender, not the switch."""
    return elapsed_ns <= 0 or sent * NS * 100 < target_pps * elapsed_ns * 97


# ---- CLI for the offline tests ---------------------------------------------------------------------------------------------------------------------------

def _cli(argv: List[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else ''
    if cmd == 'dump':
        print(json.dumps({'classes': {n: {'src': c.src, 'bpf': c.bpf, 'frames': [c.frame(i).hex() for i in range(3)], 'forwardConfidence': c.forward_confidence} for n, c in CLASSES.items()},
                          'captureFilter': capture_filter(CLASS_ORDER), 'legacy0': legacy_frame_hex(0), 'schedule': [[a, b] for a, b, _ in send_schedule(CLASS_ORDER, 2)]}))
        return 0
    data = json.loads(sys.stdin.read())
    if cmd == 'judge':
        print(json.dumps(judge(data['state'], data['counts'], data['n'], data.get('invalid'))))
    elif cmd == 'parse':
        print(json.dumps(counts_by_class(data['text'], data['names'])))
    elif cmd == 'observe':
        runner = ScriptedRunner(data['rules'])
        obs = {k: (v[0], v[1], bool(v[2])) for k, v in data['observers'].items()}
        if data['op'] == 'start':
            res = start_captures(runner, obs, data.get('filter', 'ether proto 0x88b5'), 22, '/tmp/t', lambda _s: None)
            print(json.dumps({'result': res, 'calls': runner.calls}))
        elif data['op'] == 'read':
            results, invalid = read_all(runner, obs, {k: f'/tmp/t-{k}' for k in obs})
            print(json.dumps({'results': {k: {x: y for x, y in v.items() if x != 'text'} for k, v in results.items()}, 'invalid': invalid, 'counts': {k: counts_by_class(str(v['text']), ['experimental'])['experimental']['count'] for k, v in results.items() if v['valid']}}))
        else:
            r = run_remote(runner, 'h', data['cmd'])
            print(json.dumps({'ok': r.ok, 'rc': r.rc, 'out': r.out, 'reason': r.reason}))
    elif cmd == 'poll':
        print(json.dumps(parse_poll(data['text'])))
    elif cmd == 'plan':
        try:
            print(json.dumps({'ok': True, 'totalSeconds': validate_plan(data['state'], data['rates'], data['stepSeconds'])}))
        except PlanError as e:
            print(json.dumps({'ok': False, 'error': str(e)}))
    elif cmd == 'monitor':
        mon = Monitor(data['state'], data.get('faultSeconds', 0))
        print(json.dumps([mon.feed(s) for s in data['samples']]))
    elif cmd == 'step':
        print(json.dumps({'judge': judge_step(data['state'], data['sent'], data['observed']), 'delivered': delivered([tuple(x) for x in data['series']], data['idlePps']),
                          'senderLimited': sender_limited(data['sent'], data['elapsedNs'], data['targetPps'])}))
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(_cli(sys.argv))
