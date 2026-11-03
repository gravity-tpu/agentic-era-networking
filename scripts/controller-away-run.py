"""What does the Zodiac FX do to its flow table when its controller goes away? Orchestrates the traffic observations and the read-only probe.
Pre-registration: docs/benchmarks/results/controller-away-readback/PREREGISTRATION.md (read it first; this script implements its timeline).

The script does NOT stop or start the bridge (that needs sudo; the owner does it with the one command printed at READY, which always brings the bridge back).
It does NOT write to the switch: the probe it starts (src/sdn/controller-away-probe-cli.ts) is read-only by construction and by test.
Run on the Mac with the same setup as scripts/outage-forwarding.py (it creates and removes the sender neighbor entry and the promiscuous tap NIC itself).

Usage: python3 scripts/controller-away-run.py OUT_PREFIX      then paste the owner command when READY is printed.
       python3 scripts/controller-away-run.py --selftest   runs the offline checks of the judging helpers.
       python3 scripts/controller-away-run.py --plan          prints the timeline, the limits and the owner command, touching nothing.
Observations, all the same frame class (2,000 pps UDP, 572 B, workload side to the tap NIC, matched by p1-default-tap-only):
  baseline_bridge_up -> [owner stops the bridge] -> no_controller_before_probe -> [probe starts, switch reconnects, probe reads the table]
  -> probe_connected (traffic while the probe holds the session; the probe installs nothing) -> [probe exits; owner's command restarts the bridge]
  -> after_bridge_back.
"""
import collections, importlib.util, hashlib, json, os, re, shlex, subprocess, sys, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))

def now_ms():
    """Monotonic integer milliseconds: every interval in this script is measured with this, never with float seconds."""
    return time.monotonic_ns() // 1_000_000

def permille(delivered, sent):
    """Integer delivery ratio in thousandths; 0 when nothing was sent. A negative delivered (idle-correction overshoot) counts as 0."""
    if sent <= 0: return 0
    return max(0, delivered) * 1000 // sent

def judge(pm):
    """'zero', 'resumed' or 'partial' from a permille ratio, by the pre-registered thresholds."""
    if pm < ZERO_BELOW_PERMILLE: return 'zero'
    if pm >= RESUMED_AT_PERMILLE: return 'resumed'
    return 'partial'

def selftest():
    assert permille(23689, 24000) == 987 and permille(0, 24000) == 0 and permille(5, 0) == 0 and permille(-3, 24000) == 0 and permille(24000, 24000) == 1000
    assert judge(0) == 'zero' and judge(19) == 'zero' and judge(20) == 'partial' and judge(899) == 'partial' and judge(900) == 'resumed' and judge(1000) == 'resumed'
    assert judge(permille(23690, 24000)) == 'resumed' and judge(permille(0, 24000)) == 'zero'
    calls = []
    def flaky(n):
        def f():
            calls.append(1)
            if len(calls) <= n: raise RuntimeError('ssh failed (255): Connection closed')
            return 'ok'
        return f
    assert with_ssh_retry(flaky(2), 'selftest', sleep=lambda s: None) == 'ok' and len(calls) == 3   # two dropped connections, then it answers
    calls.clear()
    try: with_ssh_retry(flaky(99), 'selftest', sleep=lambda s: None); raise AssertionError('should have raised')
    except RuntimeError as e: assert 'failed 3 times' in str(e) and len(calls) == SSH_RETRIES
    # The owner command arms the bridge's return as a detached timer first, and stops the bridge only if arming worked (&&).
    assert 'systemd-run' in OWNER_COMMAND and OWNER_COMMAND.index('systemd-run') < OWNER_COMMAND.index('systemctl stop zodiac-bridge') and '&& systemctl stop zodiac-bridge' in OWNER_COMMAND and 'sleep' not in OWNER_COMMAND
    assert OWNER_ABORT_COMMAND.index("systemctl stop 'away-restart-*.timer'") < OWNER_ABORT_COMMAND.index('systemctl start zodiac-bridge')
    # preflight against a faked ssh: it refuses on a leftover timer and on package activity, and passes on a quiet Jetson.
    real_sh, real_iso, real_sleep = globals()['sh'], lc.isolation_ok, time.sleep
    def quiet(overrides):
        def fake(host, cmd, timeout=30):
            for needle, answer in overrides.items():
                if needle in cmd: return answer
            if 'pgrep -f "[c]ontroller-away-probe-cli"' in cmd: return 0, '', ''
            if 'test -f' in cmd: return 0, 'yes', ''
            if 'sport = :6633' in cmd: return 0, '1', ''   # exactly one listener, the bridge
            return 0, '', ''
        return fake
    def preflight_says(overrides):
        globals()['sh'] = quiet(overrides); lc.isolation_ok = lambda: (True, {}); globals()['time'].sleep = lambda s: None
        try: preflight(); return 'ok'
        except SystemExit as e: return str(e)
        finally: globals()['sh'], lc.isolation_ok, globals()['time'].sleep = real_sh, real_iso, real_sleep
    assert preflight_says({}) == 'ok'
    assert 'leftover away-restart timer' in preflight_says({"list-timers --all --no-legend 'away-restart-*'": (0, '1', '')})
    assert 'package activity is running' in preflight_says({'pgrep -af "[u]pdate-notifier': (0, '4242 /usr/bin/aptd --foo', '')})
    # observe(): a failed traffic step is retried once, then recorded as not measured; the run is not ended.
    real_step, real_stats = lc.step, lc.delivered_stats
    tries = []
    def step_fails(n):
        def f(pps):
            tries.append(1)
            if len(tries) <= n: raise KeyError('series')
            return {'sent': 24000, 'elapsedNs': 12_000_000_000, 'series': [(0, 0), (12_000_000_000, 23690)]}
        return f
    globals()['time'].sleep = lambda s: None; lc.delivered_stats = lambda series, idle: (23690, 1973, [])
    try:
        lc.step = step_fails(1); r = observe('selftest_once', 0.0); assert r['sent'] == 24000 and 'error' not in r and len(tries) == 2
        tries.clear(); lc.step = step_fails(9); r = observe('selftest_twice', 0.0); assert 'error' in r and r['attempts'] == 2 and len(tries) == 2
    finally:
        lc.step, lc.delivered_stats, globals()['time'].sleep = real_step, real_stats, real_sleep
        RES.pop('selftest_once', None); RES.pop('selftest_twice', None)
    seen = {}; pats = {'first_readback': re.compile(r'readback 1[: ]')}
    for i in range(PROBE_HEAD_LINES + PROBE_TAIL_LINES + 50):      # a target line far inside the part the bounded buffer drops is still seen
        note_arrival(seen, pats, i, 'noise' if i != PROBE_HEAD_LINES + 10 else 'readback 1: 12 entries, equals_policy')
    assert seen['first_readback'] == (PROBE_HEAD_LINES + 10, 'readback 1: 12 entries, equals_policy')
    print('selftest ok')

def note_arrival(seen, patterns, t, line):
    """Match one line AS IT ARRIVES; record the first time each awaited pattern is seen. Waiting depends on this, never on the bounded output buffer."""
    for name, rx in patterns.items():
        if name not in seen and rx.search(line): seen[name] = (t, line)
spec = importlib.util.spec_from_file_location('lc', os.path.join(HERE, 'layout-capacity-run.py'))
lc = importlib.util.module_from_spec(spec); spec.loader.exec_module(lc)

# ---- Limits (Invariant 5): named, and the arithmetic that ties them together is below and printed by --plan ----
PROBE_OVERALL_MS = 65_000          # the probe's own hard limit (--overall-ms)
PROBE_RECONNECT_WAIT_MS = 35_000   # how long the probe waits for the switch (--reconnect-wait-ms)
PROBE_READBACK_TIMEOUT_MS = 8_000
PROBE_READBACKS = 2                # one at connect, one after the traffic step
PROBE_INTERVAL_MS = 20_000         # read 2 starts this long after read 1 begins: after the 12 s traffic step (+1.5 s sampler lead-in)
PROBE_BACKSTOP_S = 5               # the CLI's backstop timer fires this long after its overall limit
PROBE_REMOTE_KILL_S = (PROBE_OVERALL_MS // 1000) + PROBE_BACKSTOP_S + 2   # `timeout -s KILL` on the Jetson: the last resort if ssh dies
PROBE_START_DEADLINE_S = 25        # from the moment the bridge is seen down: the no-controller step must be over and the probe started by then, else no probe
DETECTION_SLACK_S = 5              # the bridge is seen down at most this long after the owner's stop
OWNER_MARGIN_S = 8
OUTAGE_SLEEP_S = PROBE_START_DEADLINE_S + PROBE_REMOTE_KILL_S + DETECTION_SLACK_S + OWNER_MARGIN_S   # the owner's sleep: the probe is dead before the bridge starts
ISOLATION_WATCH_ALERT_S = 150      # 3 polls of 60 s: stay under this for the whole blackout
BRIDGE_RESTART_ALLOWANCE_S = 6     # about how long the bridge takes to answer again after systemctl start (a few seconds; not measured here)
# Delivery ratios are integer permille (delivered * 1000 // sent), never floats (Invariant 2). The earlier run: baseline 987, outage 0, after 987.
BASELINE_FLOOR_PERMILLE = 900      # below this the preconditions (neighbor entry, promiscuous NIC) are not holding: abort before the outage
ZERO_BELOW_PERMILLE = 20           # "zero": under this (the earlier zeros were exactly 0)
RESUMED_AT_PERMILLE = 900          # "resumed": at least this, the baseline floor
WAIT_FOR_OUTAGE_S = 300            # how long to wait for the owner to stop the bridge
WAIT_FOR_BRIDGE_BACK_S = 240       # after this the script reports and exits (the owner's command should have restarted it long before)
PROBE_FIRST_READ_WAIT_S = (PROBE_RECONNECT_WAIT_MS + PROBE_READBACK_TIMEOUT_MS) // 1000 + 5
SETTLE_AFTER_BRIDGE_BACK_S = 10    # as in scripts/outage-forwarding.py
PROBE_HEAD_LINES, PROBE_TAIL_LINES = 100, 400   # probe output kept in memory: the first and the last lines; the rest is counted (the log file has every line)
PROBE_ROUTE_RETRY_S = 6            # the bridge spaces its on-demand table reads by 5 s

NEIGH_IP, NEIGH_MAC, NEIGH_DEV = '10.0.0.119', '02:00:00:00:00:77', 'eth0'   # the sender's destination; the MAC is locally administered and matches no rule
PROBE_CLI = '~/agentic-era-networking/dist/sdn/controller-away-probe-cli.js'
BRIDGE_ENV_FILE = '/etc/zodiac/zodiac-bridge.env'

# The bridge's return is armed FIRST as a detached systemd timer, then the bridge is stopped, so nothing that happens to this ssh session or to the owner's sudo session can leave the bridge down.
# (2026-11-02: the first run used `stop; sleep; start` in one shell, a package update restarted Tailscale mid-run, the shell died before `start`, and the bridge stayed down 169 s.)
OWNER_COMMAND = f"sudo sh -c 'systemd-run --unit=away-restart-$(date +%s) --on-active={OUTAGE_SLEEP_S}s systemctl start zodiac-bridge && systemctl stop zodiac-bridge'"
OWNER_ABORT_COMMAND = "sudo systemctl stop 'away-restart-*.timer'; sudo systemctl start zodiac-bridge"   # ends the outage early: cancel the pending timers, then start the bridge now
WORST_BLACKOUT_S = OUTAGE_SLEEP_S + BRIDGE_RESTART_ALLOWANCE_S

def plan_text():
    return '\n'.join([
        'Timeline (seconds from the owner pressing enter; D = the script sees the bridge down, at most %d s after):' % DETECTION_SLACK_S,
        '  T+0            owner stops the bridge (the switch loses its controller; workload frames start to be dropped)',
        '  D              no_controller_before_probe: 12 s of 2,000 pps (sampler lead-in 1.5 s, so about 16 s with the ssh calls)',
        '  D+~18          probe starts on the Jetson (must start by D+%d or it is not started); it binds 6633 and waits up to %d s for the switch' % (PROBE_START_DEADLINE_S, PROBE_RECONNECT_WAIT_MS // 1000),
        '  P+r            the switch connects (r unmeasured), the probe reads the table (read 1)',
        '  P+r            probe_connected: 12 s of the same traffic while the probe holds the session',
        '  P+r+%d         read 2; the probe exits and the switch has no controller again' % (PROBE_INTERVAL_MS // 1000),
        '  T+%d          the detached timer armed by the owner\'s command starts the bridge (the probe is dead by D+%d at the latest, the CLI\'s own limits)' % (OUTAGE_SLEEP_S, PROBE_START_DEADLINE_S + PROBE_REMOTE_KILL_S),
        '  +%d s          bridge answering again; %d s settle; isolation status read; after_bridge_back: 12 s of the same traffic' % (BRIDGE_RESTART_ALLOWANCE_S, SETTLE_AFTER_BRIDGE_BACK_S),
        'Probe limits: overall %d s, reconnect wait %d s, readback timeout %d s, %d readbacks %d s apart; remote last-resort kill at %d s.' % (
            PROBE_OVERALL_MS // 1000, PROBE_RECONNECT_WAIT_MS // 1000, PROBE_READBACK_TIMEOUT_MS // 1000, PROBE_READBACKS, PROBE_INTERVAL_MS // 1000, PROBE_REMOTE_KILL_S),
        'Worst-case blackout: %d s sleep + about %d s restart = about %d s, under the isolation watcher\'s alert of %d s (3 polls of 60 s); the sleep is fixed, so the blackout is about that long whether or not the probe finishes early.' % (
            OUTAGE_SLEEP_S, BRIDGE_RESTART_ALLOWANCE_S, WORST_BLACKOUT_S, ISOLATION_WATCH_ALERT_S),
        'Owner command (one line, on the Jetson): ' + OWNER_COMMAND,
        'To end the outage early: ' + OWNER_ABORT_COMMAND,
    ])

assert WORST_BLACKOUT_S < ISOLATION_WATCH_ALERT_S, 'the blackout must stay under the isolation watcher alert threshold'
assert PROBE_OVERALL_MS >= PROBE_RECONNECT_WAIT_MS + PROBE_READBACK_TIMEOUT_MS
assert PROBE_INTERVAL_MS >= (lc.STEP_SECONDS + 4) * 1000 - 3000, 'read 2 must start after the traffic step ends'

# ---- helpers ----
OUT = None
def log(s):
    line = f'[{lc.now_et()}] {s}'; print(line, flush=True)
    if OUT: open(OUT + '.log', 'a').write(line + '\n')

SSH_RETRIES = 3
SSH_RETRY_PAUSE_S = 3

def with_ssh_retry(fn, what, sleep=time.sleep):
    """Runs fn, retrying when an ssh call fails (a dropped connection is not the bridge being down). Raises after SSH_RETRIES failures, never returns a guess."""
    last = None
    for attempt in range(1, SSH_RETRIES + 1):
        try: return fn()
        except (RuntimeError, subprocess.TimeoutExpired) as e:
            last = e; log(f'ssh failure in {what} (attempt {attempt} of {SSH_RETRIES}): {str(e)[:160]}')
            if attempt < SSH_RETRIES: sleep(SSH_RETRY_PAUSE_S)
    raise RuntimeError(f'{what} failed {SSH_RETRIES} times: {str(last)[:200]}')

def bridge_up():
    code = with_ssh_retry(lambda: lc.run(lc.JETSON, "curl -s -m 3 -o /dev/null -w '%{http_code}' localhost:3003/api/zodiac/flows || true"), 'the bridge status check').strip()
    return code == '200'

def sh(host, cmd, timeout=30):
    """Like lc.run but returns (rc, stdout, stderr) instead of raising, for checks that are allowed to fail."""
    p = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, cmd], capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout.strip(), p.stderr.strip()

class Probe:
    """The read-only probe, run on the Jetson over ssh. Its output lines are collected with a monotonic timestamp."""
    def __init__(self, arp_peers, host):
        self.patterns = {'first_readback': re.compile(r'readback 1[: ]')}; self.seen = {}; self.result = None
        env = f'ZODIAC_UPLINK_ARP_PEERS={shlex.quote(arp_peers)} ' if arp_peers else ''
        hostarg = f' --host {shlex.quote(host)}' if host else ''
        remote = (f'cd ~/agentic-era-networking && {env}timeout -s KILL {PROBE_REMOTE_KILL_S} node {PROBE_CLI} --overall-ms {PROBE_OVERALL_MS} '
                  f'--reconnect-wait-ms {PROBE_RECONNECT_WAIT_MS} --readback-timeout-ms {PROBE_READBACK_TIMEOUT_MS} --readbacks {PROBE_READBACKS} --interval-ms {PROBE_INTERVAL_MS}{hostarg}')
        self.remote = remote; self.head = []; self.tail = collections.deque(maxlen=PROBE_TAIL_LINES); self.dropped = 0; self.lines_seen = 0; self.lock = threading.Lock(); self.proc = None; self.started = None
    def start(self):
        self.started_ms = now_ms()
        self.proc = subprocess.Popen(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', lc.JETSON, self.remote], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        threading.Thread(target=self._read, daemon=True).start()
    def _read(self):
        for line in self.proc.stdout:
            with self.lock:
                t = now_ms(); text = line.rstrip('\n'); entry = (t, text); self.lines_seen += 1
                note_arrival(self.seen, self.patterns, t, text)
                if text.startswith('RESULT ') and self.result is None:
                    try: self.result = json.loads(text[len('RESULT '):])
                    except ValueError as e: self.result = None; log(f'warning: the probe RESULT line is not valid JSON ({e}); treating the result as missing')
                if len(self.head) < PROBE_HEAD_LINES: self.head.append(entry)
                else:
                    if len(self.tail) == self.tail.maxlen: self.dropped += 1
                    self.tail.append(entry)
            log('probe| ' + line.rstrip('\n'))
    def snapshot(self):
        with self.lock: return list(self.head) + list(self.tail)
    def wait_seen(self, name, timeout_s):
        """(arrival ms, line) of the first line that matched pattern `name`, or None on timeout or if the probe exited without it. Independent of the bounded buffer."""
        end = now_ms() + timeout_s * 1000
        while now_ms() < end:
            with self.lock:
                if name in self.seen: return self.seen[name]
            if self.proc.poll() is not None:
                time.sleep(0.3)  # let the reader drain, then look once more
                with self.lock: return self.seen.get(name)
            time.sleep(0.2)
        return None
    def finish(self, timeout_s):
        """Waits for exit, bounded; kills what is left. Returns (exit code or None, parsed RESULT or None, killed)."""
        killed = False
        try: self.proc.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            killed = True; log('probe still running at its bound; killing it'); self.kill()
        time.sleep(0.5)
        with self.lock: result = self.result
        if self.dropped: log(f'probe output: {self.dropped} middle line(s) were not kept in memory ({self.lines_seen} seen; the log has all of them)')
        return self.proc.returncode, result, killed
    def kill(self):
        if self.proc is not None and self.proc.poll() is None: self.proc.terminate()
        try: sh(lc.JETSON, 'pkill -f "[c]ontroller-away-probe-cli" || true', 15)  # the bracket stops the pattern matching the ssh shell that runs it
        except Exception as e: log(f'remote pkill failed: {e}')

# ---- preconditions ----
def preflight():
    log('preflight')
    for h in (lc.JETSON, lc.NODE01):
        rc, out, err = sh(h, 'true')
        if rc != 0: raise SystemExit(f'cannot ssh to {h}: {err}')
    rc, _, _ = sh(lc.NODE01, 'sudo -n true')
    if rc != 0: raise SystemExit(f'sudo -n does not work on {lc.NODE01}: run by hand: sudo ip neigh replace {NEIGH_IP} lladdr {NEIGH_MAC} dev {NEIGH_DEV} nud permanent')
    # The Jetson has no passwordless sudo and needs none here: the tap capture runs as the same user, as every earlier session did (the promiscuity check below proves it works).
    rc, out, _ = sh(lc.JETSON, 'pgrep -f "[c]ontroller-away-probe-cli" || true')  # the bracket stops the pattern matching the ssh shell that runs it (it did, on 2026-11-02)
    if out: raise SystemExit(f'a probe process is already running on the Jetson ({out}); not starting')
    rc, out, _ = sh(lc.JETSON, f'test -f {PROBE_CLI} && echo yes || echo no')
    if out != 'yes': raise SystemExit(f'{PROBE_CLI} is missing on the Jetson: build and deploy this branch first (npx tsc, then the dist copy)')
    rc, out, _ = sh(lc.JETSON, "systemctl list-timers --all --no-legend 'away-restart-*' | wc -l")
    if out.strip() not in ('', '0'): raise SystemExit(f'a leftover away-restart timer exists on the Jetson ({out.strip()}); cancel it with: sudo systemctl stop \'away-restart-*.timer\'')
    # A best-effort guard, not a guarantee: it recognises the apt and update processes seen on this Jetson (Ubuntu with the desktop update notifier), and the owner is told to keep updates off for the session.
    # Package activity restarted Tailscale mid-run on 2026-11-02 (the desktop update notifier started an apt transaction). Stop the notifier (a user process, no sudo, back at the next login) and refuse to start while apt or dpkg is working.
    sh(lc.JETSON, 'pkill -f "[u]pdate-notifier" || true'); time.sleep(1)
    rc, out, _ = sh(lc.JETSON, 'pgrep -af "[u]pdate-notifier|[a]pt-get|[a]ptd|[d]pkg|[u]nattended-upgr" || true')
    if out: raise SystemExit(f'package activity is running on the Jetson, which can restart Tailscale and kill the session; wait for it to finish: {out.splitlines()[0][:120]}')
    ok, flows = lc.isolation_ok()
    if not ok: raise SystemExit('refusing to start: the isolation policy is not verified')
    if lc.quarantine_count() != 0: raise SystemExit('refusing to start: quarantines are active (the probe compares the table with the bare policy)')
    rc, out, _ = sh(lc.JETSON, "ss -ltnH 'sport = :6633' | wc -l")
    if out.strip() != '1': raise SystemExit(f'expected exactly one listener on 6633 (the bridge), found {out.strip()}')

def bridge_env_value(name):
    """One value from the bridge's environment file (only the named key is read, never the file), so the probe binds and compares as the bridge does.
    An override from this script's own environment (AWAY_<NAME>) wins. Unreadable is an abort, not a guess."""
    if os.environ.get('AWAY_' + name) is not None: return os.environ['AWAY_' + name]
    for pre in ('', 'sudo -n '):
        rc, out, err = sh(lc.JETSON, f'{pre}grep -h "^{name}=" {BRIDGE_ENV_FILE}')
        if rc == 0: return out.splitlines()[-1].split('=', 1)[1].strip().strip('"\'')
        if rc == 1: return ''   # file readable, no such line: the bridge's default
    raise SystemExit(f'cannot read {BRIDGE_ENV_FILE} on the Jetson: set AWAY_{name} to the bridge\'s {name} value (empty string for unset) and rerun')

def setup():
    sh(lc.NODE01, f'sudo -n ip neigh replace {NEIGH_IP} lladdr {NEIGH_MAC} dev {NEIGH_DEV} nud permanent')
    rc, out, err = sh(lc.JETSON, f"sh -c 'nohup tcpdump -i {lc.TAP_IF} -s 64 -U -w /dev/null >/dev/null 2>&1 & echo $!'")
    if rc != 0 or not out.isdigit(): raise SystemExit(f'could not start the tap capture: {err}')
    time.sleep(1.5)
    rc, prom, _ = sh(lc.JETSON, f"ip -d link show {lc.TAP_IF} | grep -o 'promiscuity [0-9]*'")
    log(f'setup: neighbor entry {NEIGH_IP} on {lc.NODE01} {NEIGH_DEV}; tap capture pid {out}; {prom}')
    if prom.split()[-1:] == ['0']: raise SystemExit('the tap NIC is not promiscuous; refusing to measure')
    return int(out)

def teardown(tcpdump_pid):
    log('teardown')
    if tcpdump_pid is not None:
        rc, _, err = sh(lc.JETSON, f'kill {tcpdump_pid}'); log(f'tap capture stopped (rc {rc})')
    rc, _, err = sh(lc.NODE01, f'sudo -n ip neigh del {NEIGH_IP} dev {NEIGH_DEV}'); log(f'neighbor entry removed (rc {rc})')
    rc, prom, _ = sh(lc.JETSON, f"ip -d link show {lc.TAP_IF} | grep -o 'promiscuity [0-9]*'"); log(f'tap NIC now: {prom}')

# ---- observations ----
RES = {}
def table_counters():
    """The switch's own counters before the outage, through the bridge's read-only probe route (GET /api/zodiac/flows/probe, spaced by the bridge). Failure is recorded, not fatal."""
    for attempt in (1, 2):
        try:
            d = lc.api('GET', '/api/zodiac/flows/probe')
            if 'entries' in d:
                return {'capturedAtIso': d.get('capturedAtIso'), 'entryCount': d.get('entryCount'),
                        'entries': [{k: e.get(k) for k in ('priority', 'inPort', 'ethType', 'srcIp', 'dstIp', 'packetCount', 'byteCount')} for e in d['entries']]}
            err = d
        except Exception as e: err = str(e)
        if attempt == 1: time.sleep(PROBE_ROUTE_RETRY_S)
    return {'error': err}
OBSERVE_RETRY_PAUSE_S = 6

def observe(label, idle):
    t_epoch = int(time.time()); t0 = now_ms()
    r = None; err = None
    for attempt in (1, 2):   # one retry: a dropped ssh must cost one state at worst, not the whole run
        try: r = lc.step(2000); break
        except Exception as e:
            err = f'{type(e).__name__}: {str(e)[:160]}'; log(f'{label}: the traffic step failed (attempt {attempt} of 2): {err}')
            if attempt == 1: time.sleep(OBSERVE_RETRY_PAUSE_S)
    if r is None:
        RES[label] = {'error': err, 'attempts': 2, 'startedEt': lc.now_et()}; log(f'{label}: NOT MEASURED ({err}); the run goes on'); return RES[label]
    total, med, bins = lc.delivered_stats(r['series'], idle)
    try: up = bridge_up()
    except Exception as e: up = f'unknown ({e})'
    delivered = round(total)   # the sampler's idle-corrected total (from the layout-capacity harness) rounded once to an integer packet count
    pm = permille(delivered, r['sent'])
    RES[label] = {'sent': r['sent'], 'delivered': delivered, 'ratioPermille': pm, 'judgement': judge(pm), 'medianBusyPps': round(med),
                  'startedEpochS': t_epoch, 'durationMs': now_ms() - t0, 'startedEt': lc.now_et(), 'bridgeUpAtEnd': up}
    log(f'{label}: sent {r["sent"]}, delivered {delivered}, ratio {pm} permille ({judge(pm)}; zero is under {ZERO_BELOW_PERMILLE}, resumed is at least {RESUMED_AT_PERMILLE}), bridge up at end: {up}')
    return RES[label]

def main():
    global OUT
    if sys.argv[1:] == ['--selftest']:
        selftest(); return 0
    if sys.argv[1:] == ['--plan']:
        print(plan_text()); return 0
    if len(sys.argv) != 2: raise SystemExit(__doc__)
    OUT = sys.argv[1]
    prov = {'startedEt': lc.now_et(), 'harnessSha256': hashlib.sha256(open(__file__, 'rb').read()).hexdigest(), 'lcSha256': hashlib.sha256(open(lc.__file__, 'rb').read()).hexdigest(),
            'senderSha256': hashlib.sha256(lc.SENDER_SRC.encode()).hexdigest(),
            'probeCliSha256': lc.run(lc.JETSON, f'sha256sum {PROBE_CLI}').split()[0], 'jetsonRepo': lc.run(lc.JETSON, 'cd ~/agentic-era-networking && git rev-parse HEAD && git rev-parse --abbrev-ref HEAD').split(),
            'limits': {'probeOverallMs': PROBE_OVERALL_MS, 'reconnectWaitMs': PROBE_RECONNECT_WAIT_MS, 'readbackTimeoutMs': PROBE_READBACK_TIMEOUT_MS, 'readbacks': PROBE_READBACKS, 'intervalMs': PROBE_INTERVAL_MS,
                       'remoteKillS': PROBE_REMOTE_KILL_S, 'startDeadlineS': PROBE_START_DEADLINE_S, 'ownerSleepS': OUTAGE_SLEEP_S, 'baselineFloorPermille': BASELINE_FLOOR_PERMILLE, 'zeroBelowPermille': ZERO_BELOW_PERMILLE, 'resumedAtPermille': RESUMED_AT_PERMILLE}}
    log(plan_text())
    preflight()
    peers = bridge_env_value('ZODIAC_UPLINK_ARP_PEERS'); host = bridge_env_value('SDN_CONTROLLER_IP')
    prov['uplinkArpPeers'] = peers; prov['probeBindHost'] = host or '0.0.0.0 (the bridge default)'
    log(f'uplink ARP peers the probe compares against: {peers!r}; the probe binds {host or "0.0.0.0"} like the bridge')
    json.dump(prov, open(OUT + '.provenance.json', 'w'), indent=1)
    pid = None; probe = None; rc = 0
    try:
        pid = setup()
        idle = lc.sample_idle(); log(f'idle rate {idle:.1f} pps')
        base = observe('baseline_bridge_up', idle)
        if 'error' in base: raise SystemExit(f'the baseline could not be measured ({base["error"]}); nothing was disturbed')
        if base['ratioPermille'] < BASELINE_FLOOR_PERMILLE: raise SystemExit(f'baseline ratio {base["ratioPermille"]} permille is under {BASELINE_FLOOR_PERMILLE}: the preconditions are not holding; nothing was disturbed')
        RES['tableBeforeOutage'] = table_counters(); log(f'table counters before the outage: {json.dumps(RES["tableBeforeOutage"])[:400]}')
        open(OUT + '.ready', 'w').write('ready')
        log('READY. Owner: paste this on the Jetson now (it stops the bridge, waits, starts it again):')
        log('    ' + OWNER_COMMAND)
        t0 = now_ms()
        while bridge_up():
            if now_ms() - t0 > WAIT_FOR_OUTAGE_S * 1000: log('gave up waiting for the outage; nothing was disturbed'); return 1
            time.sleep(1)
        D = now_ms(); RES['bridgeDownSeenAfterReadyMs'] = D - t0
        log('bridge unreachable (D). The switch has no controller. Measuring before the probe connects.')
        observe('no_controller_before_probe', idle)
        late = now_ms() - D > PROBE_START_DEADLINE_S * 1000
        back = bridge_up()
        if back or late:
            RES['probeSkipped'] = 'bridge already back' if back else f'later than {PROBE_START_DEADLINE_S} s after the bridge went down'
            log(f'probe NOT started: {RES["probeSkipped"]}')
        else:
            probe = Probe(peers, host); probe.start(); RES['probeStartedAfterDMs'] = now_ms() - D
            log(f'probe started {RES["probeStartedAfterDMs"]} ms after D; waiting for the switch to connect and the first readback')
            got = probe.wait_seen('first_readback', PROBE_FIRST_READ_WAIT_S)
            if got is None:
                RES['probeConnectedObservation'] = 'skipped: no readback 1 line (the switch did not connect or the read failed); see the probe lines'
                log(RES['probeConnectedObservation'])
            else:
                RES['probeFirstReadAfterDMs'] = got[0] - D
                observe('probe_connected', idle)
            code, result, killed = probe.finish(max(1, PROBE_OVERALL_MS // 1000 + PROBE_BACKSTOP_S - (now_ms() - probe.started_ms) // 1000))
            RES['probe'] = {'exitCode': code, 'killedAtBound': killed, 'result': result, 'linesSeen': probe.lines_seen, 'linesDroppedFromMemory': probe.dropped}
            log(f'probe finished: exit {code}, outcome {result.get("outcome") if result else "no RESULT line"}')
        t1 = now_ms()
        while not bridge_up():
            if now_ms() - t1 > WAIT_FOR_BRIDGE_BACK_S * 1000:
                log('THE BRIDGE IS STILL DOWN after the wait: the owner must check systemctl status zodiac-bridge'); RES['bridgeBack'] = False; rc = 2; return rc
            time.sleep(2)
        RES['bridgeBack'] = True; RES['bridgeBackAfterDMs'] = now_ms() - D
        log(f'bridge answering again {RES["bridgeBackAfterDMs"]} ms after D')
        time.sleep(SETTLE_AFTER_BRIDGE_BACK_S)
        ok, flows = lc.isolation_ok(); RES['isolationAfter'] = ok; log(f'isolation after: {ok}')
        observe('after_bridge_back', idle)
        log('finished')
        return rc
    finally:
        if probe is not None: probe.kill()
        try: teardown(pid)
        except Exception as e: log(f'TEARDOWN FAILED: {e}')
        json.dump(RES, open(OUT + '.json', 'w'), indent=1)

if __name__ == '__main__':
    sys.exit(main())
