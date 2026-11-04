#!/usr/bin/env python3
"""Pure helpers and the run choreography for scripts/tag-quarantine.py: does a quarantine DROP match a tagged frame?
(docs/benchmarks/results/scenario5-tag-quarantine/PREREGISTRATION.md, which this code follows and which the tests in test/invariants/tag-quarantine.test.ts hold it to.)

One quarantine of 10.0.2.101 is installed for one capture window; five classes of frame are sent from the workload side and counted per source MAC at O3 (what left the Zodiac P2 link)
and O2 (the P3 tap). The question is whether a TAGGED frame from the quarantined address is dropped (the DROP matches through the tag, as the IPv4 allow rule did in the scenario 5
results) or crosses (a tag would then be a way around a quarantine).

What the checks here prove and what they do not. The frame builders prove only that the bytes are what the test writes out. The judge applies the registered verdict rules to counts; it cannot say
why a count differs, which is why three controls must hold or the run is void and nothing is concluded. The choreography proves that a quarantine installed here is released on every exit path, that
the run is reported clean only when the final status is verified/drops with 0 quarantines, and that no frame is sent unless the install is shown on the switch; the switch's own hard timeout is the
backstop if this process dies, and it is not tested here. Nothing proves that every tagged form is matched: one VLAN ID pair, single tags, 20 frames per class.

No I/O at import. CLI (used by the tests): python3 scripts/tag_quarantine_lib.py dump | judge | selftest   (JSON on stdin for judge).
"""
import json, os, sys
from typing import Any, Callable, Dict, List, Optional, Tuple
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import table_miss_lib as tm
import workload_frames_lib as wf

QUARANTINED_IP = '10.0.2.101'
FRAMES_PER_CLASS = wf.FRAMES_PER_CLASS
SPACING_S = wf.SPACING_S
SRC_MAC_BASE = 0xa0
INSTALL_BUDGET_S = 15          # room in the capture window for the install and its verification, which happen after the captures start and before the first frame
INSTALL_CHECKS = 3             # status reads, INSTALL_CHECK_PAUSE_S apart, for the install to show on the switch (the flow readback can lag the install by a moment)
INSTALL_CHECK_PAUSE_S = 2
RELEASE_CHECKS = 5             # status reads after the release, RELEASE_CHECK_PAUSE_S apart, before the run is called not clean
RELEASE_CHECK_PAUSE_S = 2
OBSERVER_O3, OBSERVER_O2 = wf.OBSERVER_O3, wf.OBSERVER_O2


def tagged_vid(src: str, vid: int, inner: int, body: bytes) -> bytes:
    return tm.pad_to(tm.eth(wf.BCAST, src, 0x8100, vid.to_bytes(2, 'big') + inner.to_bytes(2, 'big') + body))


class QClass:
    def __init__(self, cid: str, name: str, prediction: str, builder: Callable[[str, int], bytes], what: str):
        self.id, self.name, self.prediction, self._builder, self.what = cid, name, prediction, builder, what
        self.src = ''
        self.bpf = ''

    def frame(self, n: int) -> bytes:
        return self._builder(self.src, n)


_SPECS: List[QClass] = [
    QClass('QC0', 'untagged-allowed-source', 'crosses', lambda s, n: wf.plain(s, 0x0800, wf.ipv4_packet(wf.SENDER_IP, wf.INSIDE_IP, n)), 'control: allowed traffic still crosses'),
    QClass('QC1', 'tagged100-allowed-source', 'crosses', lambda s, n: tagged_vid(s, 100, 0x0800, wf.ipv4_packet(wf.SENDER_IP, wf.INSIDE_IP, n)), 'control: a tag crosses in this run'),
    QClass('Q0', 'untagged-quarantined', 'dropped', lambda s, n: wf.plain(s, 0x0800, wf.ipv4_packet(QUARANTINED_IP, wf.INSIDE_IP, n)), 'control: the quarantine is installed and effective'),
    QClass('Q1', 'tagged100-quarantined', 'question', lambda s, n: tagged_vid(s, 100, 0x0800, wf.ipv4_packet(QUARANTINED_IP, wf.INSIDE_IP, n)), 'the question'),
    QClass('Q2', 'tagged200-quarantined', 'question', lambda s, n: tagged_vid(s, 200, 0x0800, wf.ipv4_packet(QUARANTINED_IP, wf.INSIDE_IP, n)), 'whether the VLAN ID matters'),
]
for _i, _c in enumerate(_SPECS):
    _c.src = f'02:00:00:00:00:{SRC_MAC_BASE + _i:02x}'
    _c.bpf = f'ether src {_c.src}'
CLASSES: List[QClass] = _SPECS
BY_ID: Dict[str, QClass] = {c.id: c for c in CLASSES}
IDS: List[str] = [c.id for c in CLASSES]
CROSSING_CONTROLS = ['QC0', 'QC1']
DROPPED_CONTROL = 'Q0'
QUESTIONS = ['Q1', 'Q2']


def send_schedule(ids: List[str], n_frames: int = FRAMES_PER_CLASS) -> List[Tuple[str, int, str]]:
    """(class id, sequence number, frame hex), interleaved by round so no class is sent in one burst."""
    return [(cid, i, BY_ID[cid].frame(i).hex()) for i in range(n_frames) for cid in ids]


def capture_filter(ids: List[str]) -> str:
    return ' or '.join(f'({BY_ID[c].bpf})' for c in ids)


def judge(counts: Dict[str, Dict[str, int]], invalid: Optional[Dict[str, str]] = None, n: int = FRAMES_PER_CLASS) -> Dict[str, Any]:
    """The verdict rules of the pre-registration, in order. counts is {class id: {'O3': frames, 'O2': frames}}."""
    invalid = invalid or {}
    if invalid:
        return {'verdicts': {c: 'observer_invalid' for c in counts}, 'evaded': [], 'o3_frames': {}, 'void': True, 'stop': True, 'invalid': invalid}
    verdicts: Dict[str, str] = {}
    void = any(c not in counts for c in CROSSING_CONTROLS + [DROPPED_CONTROL])
    for cid in CROSSING_CONTROLS:
        if cid in counts:
            ok = counts[cid]['O3'] == n and counts[cid]['O2'] == n
            verdicts[cid] = 'as_predicted' if ok else 'control_failed'
            void = void or not ok
    if DROPPED_CONTROL in counts:
        ok = counts[DROPPED_CONTROL]['O3'] == 0 and counts[DROPPED_CONTROL]['O2'] == 0
        verdicts[DROPPED_CONTROL] = 'as_predicted' if ok else 'control_failed'
        void = void or not ok
    o3_frames = {cid: counts[cid]['O3'] for cid in QUESTIONS if cid in counts and counts[cid]['O3'] > 0}   # shown even when the run is void, never hidden
    evaded: List[str] = []
    for cid in QUESTIONS:
        if cid not in counts:
            continue
        o3, o2 = counts[cid]['O3'], counts[cid]['O2']
        if void:
            verdicts[cid] = 'void'
        elif o3 > 0:
            verdicts[cid] = 'evaded'
            evaded.append(cid)
        elif o2 > 0:
            verdicts[cid] = 'reached_tap_only'
        else:
            verdicts[cid] = 'dropped'
    return {'verdicts': verdicts, 'evaded': evaded, 'o3_frames': o3_frames, 'void': void, 'stop': void or bool(evaded), 'invalid': {}}


def parse_mode(text: str) -> Any:
    """The bridge's quarantine mode from GET /api/sdn/quarantine/proposals. Strict: anything but propose or enforce is an error, never a default."""
    try:
        mode = json.loads(text)['mode']
    except (ValueError, KeyError, TypeError) as e:
        return {'error': f'{type(e).__name__}: {str(e)[:100]}'}
    return mode if mode in ('propose', 'enforce') else {'error': f'unexpected mode {mode!r}'}


# ---- the choreography ---------------------------------------------------------------------------------------------------------------------------------------

class Deps:
    """Everything the run touches, injected so the tests can script it. install and release take the target address and return (ok, detail)."""

    def __init__(self, runner: tm.Runner, observers: Dict[str, Tuple[str, str, bool]], send: Callable[[List[str]], Tuple[bool, str]], status: Callable[[], dict],
                 mode: Callable[[], Any], install: Callable[[str], Tuple[bool, str]], release: Callable[[str], Tuple[bool, str]], sleep: Callable[[float], None], now_ms: Callable[[], int]):
        self.runner, self.observers, self.send, self.status, self.mode, self.install, self.release, self.sleep, self.now_ms = runner, observers, send, status, mode, install, release, sleep, now_ms


def clean_status(s: dict) -> bool:
    return 'error' not in s and s.get('state') == 'verified' and s.get('tableMiss') == 'drops' and s.get('quarantines') == 0


def run_experiment(d: Deps, label: str, prefix: str = '/tmp/tq') -> Dict[str, Any]:
    out: Dict[str, Any] = {'label': label, 'quarantined_ip': QUARANTINED_IP, 'installed': False}
    before = d.status()
    out['status_before'] = before
    problem = wf.status_problem(before)
    if problem:
        return {**out, 'error': f'refusing to start: {problem}', 'stop': True}
    mode = d.mode()
    if isinstance(mode, dict):
        return {**out, 'error': f'refusing to start: the bridge quarantine mode could not be read: {mode["error"]}', 'stop': True}
    out['mode'] = mode
    sched = send_schedule(IDS)
    capture_s = int(4 + INSTALL_BUDGET_S + len(sched) * SPACING_S + 8)
    t0 = d.now_ms()
    started = tm.start_captures(d.runner, d.observers, capture_filter(IDS), capture_s, prefix, d.sleep)
    not_listening = {k: v['reason'] for k, v in started.items() if not v['listening']}
    if not_listening:
        return {**out, 'error': 'aborted before installing: an observer is not listening', 'not_listening': not_listening, 'stop': True}

    error: Optional[str] = None
    sent_ok = False
    try:
        ok, detail = d.install(QUARANTINED_IP)
        out['install'] = detail
        out['installed'] = ok
        if not ok:
            error = f'the quarantine was not installed: {detail}'
        else:
            on_switch: dict = {}
            for i in range(INSTALL_CHECKS):
                on_switch = d.status()
                if 'error' not in on_switch and on_switch.get('quarantines') == 1:
                    break
                if i + 1 < INSTALL_CHECKS:
                    d.sleep(INSTALL_CHECK_PAUSE_S)
            out['status_installed'] = on_switch
            if 'error' in on_switch or on_switch.get('quarantines') != 1:
                error = f'the install did not show on the switch as exactly one quarantine rule: {on_switch}'
            else:
                sent_ok, sent = d.send([h for _, _, h in sched])
                out['sender'] = sent
                out['status_during'] = d.status()
                if not sent_ok:
                    error = sent
    except Exception as e:   # recorded in the result, never swallowed: the release below runs either way
        error = f'{type(e).__name__}: {str(e)[:160]}'
    finally:
        rel_ok, rel_detail = d.release(QUARANTINED_IP)
        after: dict = {}
        clean = False
        for i in range(RELEASE_CHECKS):
            after = d.status()
            clean = clean_status(after)
            if clean:
                break
            if i + 1 < RELEASE_CHECKS:
                d.sleep(RELEASE_CHECK_PAUSE_S)
        out['release'] = {'ok': rel_ok, 'detail': rel_detail, 'clean': clean, 'status_after': after}

    if not clean:
        out['release_failed'] = True
        out['error'] = (error + '; ' if error else '') + f'the quarantine of {QUARANTINED_IP} could not be confirmed removed (status {after}): remove it by hand with POST /api/sdn/release; the switch hard timeout will remove it on its own'
        out['stop'] = True
        return out
    if error:
        out['error'] = error
        out['stop'] = True
        return out

    d.sleep(tm.seconds_until_capture_end(t0, d.now_ms(), capture_s))
    results, invalid = tm.read_all(d.runner, d.observers, {k: v['base'] for k, v in started.items()})
    counts: Dict[str, Dict[str, int]] = {}
    for cid in IDS:
        row = {}
        for obs in d.observers:
            r = results[obs]
            row[tm.observer_group(obs)] = tm.parse_capture(str(r['text'])).get(BY_ID[cid].src, {'count': 0})['count'] if r['valid'] else 0
        counts[cid] = row
    j = judge(counts, invalid)
    out.update({'counts': counts, 'capture_summaries': {k: v['packets'] for k, v in results.items()}, **j})
    during = out.get('status_during', {})
    if 'error' in during or during.get('quarantines') != 1 or during.get('state') != 'verified' or during.get('tableMiss') != 'drops':
        out['void'], out['stop'], out['status_problem_during'] = True, True, f'during the send the status was {during}, not exactly our one quarantine with verified/drops: a second quarantine or a change voids the run'
        for cid in QUESTIONS:
            if cid in out['verdicts'] and out['verdicts'][cid] != 'observer_invalid':
                out['verdicts'][cid] = 'void'
        out['evaded'] = []
    return out


DRY_RUN_CAPTURE_S = 8


def dry_run(d: Deps, label: str, prefix: str = '/tmp/tq-dry') -> Dict[str, Any]:
    """The readiness check: the status gate, the mode read and the capture plumbing, with nothing installed and nothing sent. What must hold is that no observer is invalid."""
    out: Dict[str, Any] = {'label': label, 'dry_run': True, 'installed': False}
    before = d.status()
    out['status_before'] = before
    problem = wf.status_problem(before)
    if problem:
        return {**out, 'error': f'refusing to start: {problem}'}
    mode = d.mode()
    if isinstance(mode, dict):
        return {**out, 'error': f'refusing to start: the bridge quarantine mode could not be read: {mode["error"]}'}
    out['mode'] = mode
    t0 = d.now_ms()
    started = tm.start_captures(d.runner, d.observers, capture_filter(IDS), DRY_RUN_CAPTURE_S, prefix, d.sleep)
    not_listening = {k: v['reason'] for k, v in started.items() if not v['listening']}
    if not_listening:
        return {**out, 'error': 'an observer is not listening', 'not_listening': not_listening}
    d.sleep(tm.seconds_until_capture_end(t0, d.now_ms(), DRY_RUN_CAPTURE_S))
    results, invalid = tm.read_all(d.runner, d.observers, {k: v['base'] for k, v in started.items()})
    return {**out, 'invalid': invalid, 'capture_summaries': {k: v['packets'] for k, v in results.items()}}


# ---- selftest ----------------------------------------------------------------------------------------------------------------------------------------------

def _fake_text(per_class: Dict[str, int]) -> str:
    lines = []
    for cid, k in per_class.items():
        for j in range(k):
            lines.append(f'12:00:00.{j:06d} {BY_ID[cid].src} > ff:ff:ff:ff:ff:ff, ethertype IPv4 (0x0800), length 60: x')
    return '\n'.join(lines) + ('\n' if lines else '')


class _Runner(tm.ScriptedRunner):
    """A fake ssh: captures start and report listening (or not); a read returns the scripted per-class counts for O3 or O2."""

    def __init__(self, o3: Dict[str, int], o2: Dict[str, int], listening: str = '1'):
        super().__init__([])
        self.o3, self.o2, self.listening, self.starts = o3, o2, listening, 0

    def __call__(self, host: str, cmd: str, timeout: int, stdin: Optional[str] = None) -> Tuple[int, str, str]:
        del timeout, stdin
        self.calls.append(f'{host}: {cmd}')
        if 'setsid nohup' in cmd:
            self.starts += 1
            return 0, '', ''
        if "grep -c 'listening on'" in cmd:
            return 0, self.listening + '\n', ''
        if 'head -c 150' in cmd:
            return 0, 'empty', ''
        if 'head -c 4000' in cmd:
            per = self.o3 if 'O3_p2_mirror' in cmd else self.o2
            return 0, f'listening on x\n{sum(per.values())} packets captured\n0 packets dropped by kernel\n#TXT#\n{_fake_text(per)}', ''
        return 255, '', 'no scripted response'


def selftest() -> None:
    n = FRAMES_PER_CLASS
    healthy = {'state': 'verified', 'tableMiss': 'drops', 'quarantines': 0}
    one = {**healthy, 'quarantines': 1}
    obs = {OBSERVER_O3: ('jetson', 'o3if', False), OBSERVER_O2: ('jetson', 'o2if', False)}
    clean_o3 = {'QC0': n, 'QC1': n, 'Q0': 0, 'Q1': 0, 'Q2': 0}
    clean_o2 = {'QC0': n, 'QC1': n, 'Q0': 0, 'Q1': 0, 'Q2': 0}

    def deps(runner, statuses, *, mode: Any = 'propose', install=(True, 'installed'), release=(True, 'released'), send=(True, 'sent'), send_raises=False):
        it = iter(statuses)
        log: Dict[str, list] = {'sends': [], 'installs': [], 'releases': []}
        def status(): return next(it, statuses[-1])
        def do_send(hexes):
            log['sends'].append(len(hexes))
            if send_raises:
                raise OSError('boom')
            return send
        def do_install(ip): log['installs'].append(ip); return install
        def do_release(ip): log['releases'].append(ip); return release
        return Deps(runner, obs, do_send, status, lambda: mode, do_install, do_release, lambda _s: None, lambda: 10_000_000), log

    # 1. clean: dropped, one install, one release, run clean, nothing void.
    d, log = deps(_Runner(clean_o3, clean_o2), [healthy, one, one, healthy])
    out = run_experiment(d, 't1')
    assert out['verdicts']['Q1'] == 'dropped' and out['verdicts']['Q2'] == 'dropped' and not out['void'] and not out['stop'] and out['release']['clean'], out
    assert log['installs'] == [QUARANTINED_IP] and log['releases'] == [QUARANTINED_IP] and log['sends'] == [n * len(IDS)], log

    # 2. a refused install: nothing sent, release still attempted, stop.
    d, log = deps(_Runner(clean_o3, clean_o2), [healthy, healthy], install=(False, 'refused: gate'))
    out = run_experiment(d, 't2')
    assert log['sends'] == [] and log['releases'] == [QUARANTINED_IP] and out['stop'] and 'was not installed' in out['error'], (out, log)

    # 3. an install that does not show on the switch: nothing sent, released.
    d, log = deps(_Runner(clean_o3, clean_o2), [healthy, healthy, healthy])
    out = run_experiment(d, 't3')
    assert log['sends'] == [] and len(log['releases']) == 1 and 'did not show on the switch' in out['error'] and out['stop'], (out, log)

    # 3b. a readback that lags the install by one read is tolerated.
    d, log = deps(_Runner(clean_o3, clean_o2), [healthy, healthy, one, one, healthy])
    out = run_experiment(d, 't3b')
    assert out['verdicts']['Q1'] == 'dropped' and not out['stop'] and log['sends'] == [n * len(IDS)], out

    # 4. the sender raises after the install: still released, the error recorded, not swallowed.
    d, log = deps(_Runner(clean_o3, clean_o2), [healthy, one, one, healthy], send_raises=True)
    out = run_experiment(d, 't4')
    assert len(log['releases']) == 1 and 'OSError' in out['error'] and out['stop'] and out['release']['clean'], (out, log)

    # 5. the release does not take: reported, not hidden, with the hand-removal instruction.
    d, log = deps(_Runner(clean_o3, clean_o2), [healthy, one, one] + [one] * RELEASE_CHECKS, release=(False, 'no answer'))
    out = run_experiment(d, 't5')
    assert out['release_failed'] and out['stop'] and 'remove it by hand' in out['error'] and not out['release']['clean'], out

    # 6. an evasion: a tagged quarantined class seen at O3 is evaded and stops the run; the quarantine was still released.
    o3 = dict(clean_o3); o3['Q1'] = 3
    d, log = deps(_Runner(o3, clean_o2), [healthy, one, one, healthy])
    out = run_experiment(d, 't6')
    assert out['evaded'] == ['Q1'] and out['stop'] and out['release']['clean'] and len(log['releases']) == 1, out

    # 7. a second quarantine during the send voids the run: nothing concluded.
    d, log = deps(_Runner(clean_o3, clean_o2), [healthy, one, {**healthy, 'quarantines': 2}, healthy])
    out = run_experiment(d, 't7')
    assert out['void'] and out['stop'] and out['evaded'] == [] and out['verdicts']['Q1'] == 'void' and 'second quarantine' in out['status_problem_during'], out

    # 8. a status that is not clean before: refused, no capture started, nothing installed.
    r = _Runner(clean_o3, clean_o2)
    d, log = deps(r, [{'state': 'mismatch', 'tableMiss': 'forwards', 'quarantines': 0}])
    out = run_experiment(d, 't8')
    assert r.starts == 0 and log['installs'] == [] and 'refusing to start' in out['error'], out

    # 9. an unreadable mode: refused before any capture or install.
    r = _Runner(clean_o3, clean_o2)
    d, log = deps(r, [healthy], mode={'error': 'boom'})
    out = run_experiment(d, 't9')
    assert r.starts == 0 and log['installs'] == [] and 'mode could not be read' in out['error'], out

    # 10. an observer that is not listening: nothing installed, nothing sent.
    d, log = deps(_Runner(clean_o3, clean_o2, listening='0'), [healthy])
    out = run_experiment(d, 't10')
    assert log['installs'] == [] and log['sends'] == [] and out['error'].startswith('aborted before installing'), out

    # 10b. a dry run installs nothing and sends nothing, and reports an observer that did not run.
    d, log = deps(_Runner(clean_o3, clean_o2), [healthy])
    out = dry_run(d, 'd1')
    assert log['installs'] == [] and log['sends'] == [] and log['releases'] == [] and out['invalid'] == {} and 'error' not in out, (out, log)
    d, log = deps(_Runner(clean_o3, clean_o2, listening='0'), [healthy])
    out = dry_run(d, 'd2')
    assert log['installs'] == [] and out['error'] == 'an observer is not listening', out

    # 11. the mode parser is strict.
    assert parse_mode('{"mode": "propose", "proposals": []}') == 'propose' and parse_mode('{"mode": "enforce"}') == 'enforce'
    assert isinstance(parse_mode('{"mode": "off"}'), dict) and isinstance(parse_mode('not json'), dict) and isinstance(parse_mode('{}'), dict)
    print('selftest ok')



def _cli(argv: List[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    if argv[0] == 'dump':
        print(json.dumps({'frames_per_class': FRAMES_PER_CLASS, 'quarantined_ip': QUARANTINED_IP, 'classes': [
            {'id': c.id, 'name': c.name, 'prediction': c.prediction, 'src': c.src, 'bpf': c.bpf, 'frame_hex': c.frame(0).hex(), 'frame_hex_7': c.frame(7).hex(), 'what': c.what} for c in CLASSES]}))
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
