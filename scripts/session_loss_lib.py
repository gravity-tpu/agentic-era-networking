#!/usr/bin/env python3
"""Pure helpers and the run choreography for scripts/session-loss.py: scenario 4, reframed (docs/benchmarks/results/scenario4-session-loss/PREREGISTRATION.md).

Offers forwarded traffic at EXACTLY 25,000 pps (2x the deployed table's measured capacity at k = 0 quarantines, 12,500 pps; src/sdn/deployed-cost-model.ts) for one bounded step, from
agentic-node-02's workload interface, built with the unchanged frame-construction code already used and tested by the scenario 5 tooling (workload_frames_lib). The frame is matched
by p1-default-tap-only (destination outside the segment), never by an allow rule, so it is never expected at O3 (the mirror of the Zodiac P2 link) in any state the policy defines.

This measures whether the switch's own OpenFlow reconnect, followed by the bridge's existing session-start handler (which already re-sends the table-miss DROP and the isolation
policy on every 'ready' event), restores forwarding without a person acting, and times how long that takes. It does not restart the bridge process as its primary path: the one
allowed fallback, a local `systemctl restart zodiac-bridge`, fires only if the switch has not reconnected and re-verified within RECONNECT_WAIT_S, and is itself a reported outcome
(recovered_with_fallback), not something hidden inside a "recovered" result.

What the checks here prove and what they do not. `validate_plan` proves only that the one registered plan (25,000 pps, 5 to 10 s) is accepted and nothing else is; it is deliberately an
exact match, not a ceiling with headroom. `judge` proves the verdict rules apply correctly to a given sequence of polls and frame counts; it cannot say why a poll reads what it does.
The choreography's selftest proves the fallback fires at most once, only after the reconnect wait, and that a dry run sends no load and never constructs the restart command for real;
it cannot prove the real switch behaves as predicted, which is the entire point of running the experiment.

No I/O at import. CLI (used by the tests): python3 scripts/session_loss_lib.py dump | validate | judge | selftest   (JSON on stdin for validate and judge).
"""
import json, os, sys
from typing import Any, Callable, Dict, List, Optional, Tuple
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import table_miss_lib as tm
import workload_frames_lib as wf

TARGET_PPS = 25_000                # 2x deployedCapacityPps(572n, 0n) = 2 x 12,500; exact, not a ceiling with a lower starting point
MIN_STEP_SECONDS, MAX_STEP_SECONDS = tm.MIN_STEP_SECONDS, tm.MAX_STEP_SECONDS   # reused unchanged: 5 to 10 s
# Invariant 2 (integer accounting): these bounds must be whole seconds, never float. validate_plan() rejects a float step at the call boundary; this assertion makes the same
# requirement fail loudly and immediately on the reused constants themselves, rather than as a buried crash deep inside run_experiment's `assert plan['ok']` if table_miss_lib
# ever changed MIN_STEP_SECONDS/MAX_STEP_SECONDS to a float.
assert isinstance(MIN_STEP_SECONDS, int) and isinstance(MAX_STEP_SECONDS, int), 'Invariant 2: the reused step bounds must be integers'
STEP_SECONDS = MAX_STEP_SECONDS    # the registered duration: the top of the reused range
RECONNECT_WAIT_S = 30              # longer than any session-recovery time measured anywhere in this project, including a full device reboot (2026-10-18: back within 30 s)
FALLBACK_WAIT_S = 30               # the same bound again, after the one allowed local restart
POLL_INTERVAL_S = 1
SENDER_SRC_MAC = '02:00:00:00:00:c0'
OBSERVER_O3, OBSERVER_O2 = wf.OBSERVER_O3, wf.OBSERVER_O2


def build_frame(n: int = 0) -> bytes:
    """Plain, untagged, in-segment source to an outside destination, 572 B: the unchanged construction already used and tested by workload_frames_lib. No IP options, no fragment
    flags (unlike that module's B1/B2/B3, which exist to test those specific fields; neither is needed or wanted for a high-rate sender)."""
    body = wf.ipv4_packet(wf.SENDER_IP, wf.OUTSIDE_IP, n)
    frame = wf.plain(SENDER_SRC_MAC, 0x0800, body)
    pad = 572 - len(frame)
    return frame + bytes(pad) if pad > 0 else frame[:572]


def validate_plan(pps: int, step_seconds: float) -> Dict[str, Any]:
    """The registered plan is the ONLY plan this accepts: exactly TARGET_PPS, not "up to" it. Returns {'ok': True} or {'ok': False, 'reason': ...}, never raises, so a caller can report
    a refusal without a traceback."""
    if pps != TARGET_PPS:
        return {'ok': False, 'reason': f'the registered rate is exactly {TARGET_PPS:,} pps; {pps} was asked for, and this is not a ceiling with room above or below it'}
    if not isinstance(step_seconds, int) or not (MIN_STEP_SECONDS <= step_seconds <= MAX_STEP_SECONDS):
        return {'ok': False, 'reason': f'a step must be a whole number of seconds from {MIN_STEP_SECONDS} to {MAX_STEP_SECONDS}, got {step_seconds!r}'}
    return {'ok': True}


def judge(polls: List[Dict[str, Any]], o3_frames: Optional[int], o2_frames: Optional[int], invalid: Optional[Dict[str, str]] = None, fallback_fired: bool = False) -> Dict[str, Any]:
    """The verdict rules of the pre-registration, in order. `polls` is the sequence read over the whole window, oldest first, each shaped like table_miss_lib.parse_poll's return.
    An unreadable poll (`ok: False`) counts as neither connected nor disconnected: it never by itself flips loss_detected or a recovery finding, because the only thing it proves is
    that this one read failed, not what the switch was doing. A frame count is `None`, never a fabricated `0`, when its observer's capture was not proven valid: an invalid
    observer tells you nothing about what crossed, and reporting it as a confirmed zero would misrepresent "unknown" as "measured" (the provenance invariant this project holds
    telemetry to generally). `judge` is called directly in tests with any combination of these, so the leak check below must not assume o3_frames/o2_frames are int just because
    invalid happens to be non-empty in the caller that built them that way; it must hold as its own contract."""
    invalid = invalid or {}
    readable = [p for p in polls if p.get('ok')]
    baseline_sessions = readable[0]['sessions'] if readable else None
    loss_detected = any(p.get('ok') and p.get('openflow') != 'Connected' for p in polls)
    last = readable[-1] if readable else None
    recovered_state = (
        last is not None
        and last.get('openflow') == 'Connected'
        and last.get('isolation_state') == 'verified'
        and last.get('table_miss') == 'drops'
        and baseline_sessions is not None
        and last.get('sessions', 0) > baseline_sessions
    )
    if not loss_detected:
        verdict = 'no_loss_observed'
    elif recovered_state:
        verdict = 'recovered_with_fallback' if fallback_fired else 'recovered'
    else:
        verdict = 'not_recovered'
    if invalid:
        verdict = 'observer_invalid'
    elif o3_frames is not None and o3_frames > 0:
        verdict = 'leak'   # this frame shape is never matched by an allow rule in any state the policy defines; any count at O3 overrides every other finding
    return {'verdict': verdict, 'loss_detected': loss_detected, 'baseline_sessions': baseline_sessions, 'o3_frames': o3_frames, 'o2_frames': o2_frames, 'fallback_fired': fallback_fired, 'invalid': invalid}


# ---- the choreography ---------------------------------------------------------------------------------------------------------------------------------------

class Deps:
    """Everything the run touches, injected so the tests can script it."""

    def __init__(self, runner: tm.Runner, observers: Dict[str, Tuple[str, str, bool]], status: Callable[[], dict],
                 start_send: Callable[[str, int, int], Any], send_running: Callable[[Any], bool],
                 restart_bridge: Callable[[], Tuple[bool, str]], poll: Callable[[], Dict[str, Any]], sleep: Callable[[float], None], now_ms: Callable[[], int]):
        self.runner, self.observers, self.status, self.start_send, self.send_running, self.restart_bridge, self.poll, self.sleep, self.now_ms = \
            runner, observers, status, start_send, send_running, restart_bridge, poll, sleep, now_ms


def dry_run(d: Deps, label: str, prefix: str = '/tmp/sl-dry') -> Dict[str, Any]:
    """The readiness check: the status gate and the capture plumbing, with no load sent, no restart command ever constructed. What must hold is that no observer is invalid."""
    out: Dict[str, Any] = {'label': label, 'dry_run': True}
    before = d.status()
    out['status_before'] = before
    problem = wf.status_problem(before)
    if problem:
        return {**out, 'error': f'refusing to start: {problem}'}
    t0 = d.now_ms()
    capture_s = 8
    started = tm.start_captures(d.runner, d.observers, f'ether src {SENDER_SRC_MAC}', capture_s, prefix, d.sleep)
    not_listening = {k: v['reason'] for k, v in started.items() if not v['listening']}
    if not_listening:
        return {**out, 'error': 'an observer is not listening', 'not_listening': not_listening}
    d.sleep(tm.seconds_until_capture_end(t0, d.now_ms(), capture_s))
    results, invalid = tm.read_all(d.runner, d.observers, {k: v['base'] for k, v in started.items()})
    return {**out, 'invalid': invalid, 'capture_summaries': {k: v['packets'] for k, v in results.items()}}


def run_experiment(d: Deps, label: str, prefix: str = '/tmp/sl') -> Dict[str, Any]:
    plan = validate_plan(TARGET_PPS, STEP_SECONDS)
    assert plan['ok'], plan   # the one call site always passes the registered plan; this assertion is the test that it still does after any future edit
    out: Dict[str, Any] = {'label': label, 'target_pps': TARGET_PPS, 'step_seconds': STEP_SECONDS}
    before = d.status()
    out['status_before'] = before
    problem = wf.status_problem(before)
    if problem:
        return {**out, 'error': f'refusing to start: {problem}'}

    window_s = STEP_SECONDS + RECONNECT_WAIT_S + FALLBACK_WAIT_S + 10
    t0 = d.now_ms()
    started = tm.start_captures(d.runner, d.observers, f'ether src {SENDER_SRC_MAC}', window_s, prefix, d.sleep)
    not_listening = {k: v['reason'] for k, v in started.items() if not v['listening']}
    if not_listening:
        return {**out, 'error': 'aborted before sending: an observer is not listening', 'not_listening': not_listening}

    handle = d.start_send(build_frame(0).hex(), TARGET_PPS, STEP_SECONDS)
    polls: List[Dict[str, Any]] = []
    loss_since: Optional[int] = None
    fallback_fired = False
    fallback_detail = ''
    deadline_ms = t0 + window_s * 1000
    while True:
        now = d.now_ms()
        if now >= deadline_ms:
            break
        sample = d.poll()
        polls.append(sample)
        if sample.get('ok') and sample.get('openflow') != 'Connected' and loss_since is None:
            loss_since = now
        current = judge(polls, 0, 0)   # frame counts are not known until the captures are read; used here only to see whether recovery already holds
        send_done = not d.send_running(handle)
        if loss_since is not None and current['loss_detected'] and current['verdict'] in ('recovered', 'recovered_with_fallback'):
            break
        if loss_since is not None and not fallback_fired and (now - loss_since) >= RECONNECT_WAIT_S * 1000:
            ok, detail = d.restart_bridge()
            fallback_fired, fallback_detail = True, detail
            if not ok:
                out['restart_failed'] = detail
        if loss_since is not None and fallback_fired and (now - loss_since) >= (RECONNECT_WAIT_S + FALLBACK_WAIT_S) * 1000:
            break
        if send_done and loss_since is None and now >= t0 + (STEP_SECONDS + 5) * 1000:
            break   # the load finished, nothing was ever seen to drop, and a short grace period has passed: no_loss_observed
        d.sleep(POLL_INTERVAL_S)

    out['fallback_fired'] = fallback_fired
    if fallback_fired:
        out['fallback_detail'] = fallback_detail
    d.sleep(tm.seconds_until_capture_end(t0, d.now_ms(), window_s))
    results, invalid = tm.read_all(d.runner, d.observers, {k: v['base'] for k, v in started.items()})
    # None, never a fabricated 0, when the capture was not proven valid: a count that was never measured is not the same finding as a count that was measured and came back zero.
    o3 = tm.parse_capture(str(results[OBSERVER_O3]['text'])).get(SENDER_SRC_MAC, {'count': 0})['count'] if results[OBSERVER_O3]['valid'] else None
    o2 = tm.parse_capture(str(results[OBSERVER_O2]['text'])).get(SENDER_SRC_MAC, {'count': 0})['count'] if results[OBSERVER_O2]['valid'] else None
    j = judge(polls, o3, o2, invalid, fallback_fired)
    out.update({'polls': polls, 'capture_summaries': {k: v['packets'] for k, v in results.items()}, **j})
    return out


# ---- selftest ----------------------------------------------------------------------------------------------------------------------------------------------

def selftest() -> None:
    obs = {OBSERVER_O3: ('jetson', 'o3if', False), OBSERVER_O2: ('jetson', 'o2if', False)}
    healthy = {'state': 'verified', 'tableMiss': 'drops', 'quarantines': 0}

    def fake_captures_runner(o3_total: int, o2_total: int, invalid_o3_read: bool = False):
        class R(tm.ScriptedRunner):
            def __call__(self, host, cmd, timeout, stdin=None):
                del timeout, stdin
                self.calls.append(f'{host}: {cmd}')
                if 'setsid nohup' in cmd:
                    return 0, '', ''
                if "grep -c 'listening on'" in cmd:
                    return 0, '1\n', ''
                if 'head -c 150' in cmd:
                    return 0, 'empty', ''
                if 'head -c 4000' in cmd:
                    if invalid_o3_read and OBSERVER_O3 in cmd:
                        return 0, 'listening on x\n(no summary: the capture never finished)\n#TXT#\n', ''   # no "N packets captured" line: tm.read_capture marks this invalid
                    n = o3_total if OBSERVER_O3 in cmd else o2_total
                    lines = '\n'.join(f'12:00:00.{i:06d} {SENDER_SRC_MAC} > ff:ff:ff:ff:ff:ff, ethertype IPv4 (0x0800), length 572: x' for i in range(n))
                    text = lines + ('\n' if n else '')
                    return 0, f'listening on x\n{n} packets captured\n0 packets dropped by kernel\n#TXT#\n{text}', ''
                return 255, '', 'no scripted response'
        return R([])

    def deps(poll_sequence: List[Dict[str, Any]], o3_total: int = 0, o2_total: int = 0, restart_ok: bool = True, send_steps: int = 3, invalid_o3_read: bool = False):
        state = {'polls_taken': 0, 'send_polls': 0, 'restarts': []}

        def status():
            return healthy

        def start_send(_frame_hex, _pps, _step_s):
            return object()

        def send_running(_handle):
            state['send_polls'] += 1
            return state['send_polls'] <= send_steps

        def restart_bridge():
            state['restarts'].append(1)
            return restart_ok, 'restarted' if restart_ok else 'refused'

        def poll():
            i = min(state['polls_taken'], len(poll_sequence) - 1)
            state['polls_taken'] += 1
            return poll_sequence[i]

        clock = {'ms': 0}

        def sleep(seconds):
            clock['ms'] += int(seconds * 1000) if seconds else 1000

        return Deps(fake_captures_runner(o3_total, o2_total, invalid_o3_read), obs, status, start_send, send_running, restart_bridge, poll, sleep, lambda: clock['ms']), state

    def connected(sessions, state='verified', table_miss='drops'):
        return {'ok': True, 'openflow': 'Connected', 'isolation_state': state, 'table_miss': table_miss, 'sessions': sessions}

    disconnected = {'ok': True, 'openflow': 'Disconnected', 'isolation_state': 'mismatch', 'table_miss': None, 'sessions': 0}

    # 1. loss then a quick recovery with a higher session count: no fallback needed.
    d, state = deps([connected(1), disconnected, disconnected, connected(2)] + [connected(2)] * 50)
    out = run_experiment(d, 't1')
    assert out['verdict'] == 'recovered' and not out['fallback_fired'] and state['restarts'] == [], (out, state)

    # 2. loss that does not clear until after RECONNECT_WAIT_S: the fallback fires exactly once, and recovery is reported as recovered_with_fallback.
    seq = [connected(1)] + [disconnected] * (RECONNECT_WAIT_S + 2) + [connected(2)] * 50
    d, state = deps(seq)
    out = run_experiment(d, 't2')
    assert out['verdict'] == 'recovered_with_fallback' and out['fallback_fired'] and len(state['restarts']) == 1, (out, state)

    # 3. the fallback itself fails to bring it back within FALLBACK_WAIT_S: not_recovered, and the restart was still only attempted once.
    seq = [connected(1)] + [disconnected] * (RECONNECT_WAIT_S + FALLBACK_WAIT_S + 5)
    d, state = deps(seq)
    out = run_experiment(d, 't3')
    assert out['verdict'] == 'not_recovered' and out['fallback_fired'] and len(state['restarts']) == 1, (out, state)

    # 4. nothing ever drops: no_loss_observed, no fallback, no restart call.
    d, state = deps([connected(1)] * 80, send_steps=3)
    out = run_experiment(d, 't4')
    assert out['verdict'] == 'no_loss_observed' and not out['fallback_fired'] and state['restarts'] == [], out

    # 5. a leak: frames at O3 override a clean recovery.
    d, state = deps([connected(1), disconnected, connected(2)] + [connected(2)] * 50, o3_total=2)
    out = run_experiment(d, 't5')
    assert out['verdict'] == 'leak' and out['o3_frames'] == 2, out

    # 5b. an invalid O3 capture: the frame count is reported as null, never a fabricated 0, and the run is observer_invalid, not a silent "recovered" or "contained".
    d, state = deps([connected(1), disconnected, connected(2)] + [connected(2)] * 50, invalid_o3_read=True)
    out = run_experiment(d, 't5b')
    assert out['verdict'] == 'observer_invalid' and out['o3_frames'] is None and out['invalid'], out

    # 6. a dry run sends no load and never calls the restart command.
    d, state = deps([connected(1)])
    out = dry_run(d, 't6')
    assert state['restarts'] == [] and state['send_polls'] == 0 and out['invalid'] == {} and 'error' not in out, (out, state)

    # 7. a dry run refuses on a bad status, before any capture.
    def bad_status():
        return {'state': 'mismatch', 'tableMiss': 'forwards', 'quarantines': 0}
    d, state = deps([connected(1)])
    d.status = bad_status
    out = dry_run(d, 't7')
    assert 'refusing to start' in out['error'] and state['restarts'] == [], out

    # 8. the plan validator: exact match only, a symmetric rejection above and below, and the step bound.
    for pps in (TARGET_PPS - 1, TARGET_PPS + 1, 0, TARGET_PPS * 2):
        r = validate_plan(pps, STEP_SECONDS)
        assert not r['ok'] and '25,000' in r['reason'], r
    assert validate_plan(TARGET_PPS, MIN_STEP_SECONDS)['ok'] and validate_plan(TARGET_PPS, MAX_STEP_SECONDS)['ok']
    assert not validate_plan(TARGET_PPS, MIN_STEP_SECONDS - 1)['ok'] and not validate_plan(TARGET_PPS, MAX_STEP_SECONDS + 1)['ok']

    print('selftest ok')


def _cli(argv: List[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    if argv[0] == 'dump':
        print(json.dumps({'target_pps': TARGET_PPS, 'step_seconds': STEP_SECONDS, 'reconnect_wait_s': RECONNECT_WAIT_S, 'fallback_wait_s': FALLBACK_WAIT_S, 'frame_hex': build_frame(0).hex()}))
        return 0
    if argv[0] == 'validate':
        req = json.load(sys.stdin)
        print(json.dumps(validate_plan(req['pps'], req['step_seconds'])))
        return 0
    if argv[0] == 'judge':
        req = json.load(sys.stdin)
        print(json.dumps(judge(req['polls'], req['o3_frames'], req['o2_frames'], req.get('invalid'), req.get('fallback_fired', False))))
        return 0
    if argv[0] == 'selftest':
        selftest()
        return 0
    print(__doc__)
    return 2


if __name__ == '__main__':
    sys.exit(_cli(sys.argv[1:]))
