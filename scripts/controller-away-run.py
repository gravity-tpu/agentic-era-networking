"""What does the Zodiac FX do to its flow table when its controller goes away? Orchestrates the traffic observations and the read-only probe.
Pre-registration: docs/benchmarks/results/controller-away-readback/PREREGISTRATION.md (read it first; this script implements its timeline).

The script does NOT stop or start the bridge (that needs sudo; the owner does it with the one command printed at READY, which always brings the bridge back).
It does NOT write to the switch: the probe it starts (src/sdn/controller-away-probe-cli.ts) is read-only by construction and by test.
Run on the Mac with the same setup as scripts/outage-forwarding.py (it creates and removes the sender neighbor entry and the promiscuous tap NIC itself).

Usage: python3 scripts/controller-away-run.py OUT_PREFIX      then paste the owner command when READY is printed.
       python3 scripts/controller-away-run.py --plan          prints the timeline, the limits and the owner command, touching nothing.
Observations, all the same frame class (2,000 pps UDP, 572 B, workload side to the tap NIC, matched by p1-default-tap-only):
  baseline_bridge_up -> [owner stops the bridge] -> no_controller_before_probe -> [probe starts, switch reconnects, probe reads the table]
  -> probe_connected (traffic while the probe holds the session; the probe installs nothing) -> [probe exits; owner's command restarts the bridge]
  -> after_bridge_back.
"""
import importlib.util, hashlib, json, os, re, shlex, subprocess, sys, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
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
BASELINE_MIN_RATIO = 0.90          # below this the preconditions (neighbor entry, promiscuous NIC) are not holding: abort before the outage
WAIT_FOR_OUTAGE_S = 300            # how long to wait for the owner to stop the bridge
WAIT_FOR_BRIDGE_BACK_S = 240       # after this the script reports and exits (the owner's command should have restarted it long before)
PROBE_FIRST_READ_WAIT_S = (PROBE_RECONNECT_WAIT_MS + PROBE_READBACK_TIMEOUT_MS) // 1000 + 5
SETTLE_AFTER_BRIDGE_BACK_S = 10    # as in scripts/outage-forwarding.py
PROBE_ROUTE_RETRY_S = 6            # the bridge spaces its on-demand table reads by 5 s

NEIGH_IP, NEIGH_MAC, NEIGH_DEV = '10.0.0.119', '02:00:00:00:00:77', 'eth0'   # the sender's destination; the MAC is locally administered and matches no rule
PROBE_CLI = '~/agentic-era-networking/dist/sdn/controller-away-probe-cli.js'
BRIDGE_ENV_FILE = '/etc/zodiac/zodiac-bridge.env'

OWNER_COMMAND = f"sudo sh -c 'systemctl stop zodiac-bridge; sleep {OUTAGE_SLEEP_S}; systemctl start zodiac-bridge'"
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
        '  T+%d          the owner\'s command restarts the bridge (the probe is dead by D+%d at the latest, the CLI\'s own limits)' % (OUTAGE_SLEEP_S, PROBE_START_DEADLINE_S + PROBE_REMOTE_KILL_S),
        '  +%d s          bridge answering again; %d s settle; isolation status read; after_bridge_back: 12 s of the same traffic' % (BRIDGE_RESTART_ALLOWANCE_S, SETTLE_AFTER_BRIDGE_BACK_S),
        'Probe limits: overall %d s, reconnect wait %d s, readback timeout %d s, %d readbacks %d s apart; remote last-resort kill at %d s.' % (
            PROBE_OVERALL_MS // 1000, PROBE_RECONNECT_WAIT_MS // 1000, PROBE_READBACK_TIMEOUT_MS // 1000, PROBE_READBACKS, PROBE_INTERVAL_MS // 1000, PROBE_REMOTE_KILL_S),
        'Worst-case blackout: %d s sleep + about %d s restart = about %d s, under the isolation watcher\'s alert of %d s (3 polls of 60 s); the sleep is fixed, so the blackout is about that long whether or not the probe finishes early.' % (
            OUTAGE_SLEEP_S, BRIDGE_RESTART_ALLOWANCE_S, WORST_BLACKOUT_S, ISOLATION_WATCH_ALERT_S),
        'Owner command (one line, on the Jetson): ' + OWNER_COMMAND,
    ])

assert WORST_BLACKOUT_S < ISOLATION_WATCH_ALERT_S, 'the blackout must stay under the isolation watcher alert threshold'
assert PROBE_OVERALL_MS >= PROBE_RECONNECT_WAIT_MS + PROBE_READBACK_TIMEOUT_MS
assert PROBE_INTERVAL_MS >= (lc.STEP_SECONDS + 4) * 1000 - 3000, 'read 2 must start after the traffic step ends'

# ---- helpers ----
OUT = None
def log(s):
    line = f'[{lc.now_et()}] {s}'; print(line, flush=True)
    if OUT: open(OUT + '.log', 'a').write(line + '\n')

def bridge_up():
    code = lc.run(lc.JETSON, "curl -s -m 3 -o /dev/null -w '%{http_code}' localhost:3003/api/zodiac/flows || true").strip()
    return code == '200'

def sh(host, cmd, timeout=30):
    """Like lc.run but returns (rc, stdout, stderr) instead of raising, for checks that are allowed to fail."""
    p = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, cmd], capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout.strip(), p.stderr.strip()

class Probe:
    """The read-only probe, run on the Jetson over ssh. Its output lines are collected with a monotonic timestamp."""
    def __init__(self, arp_peers, host):
        env = f'ZODIAC_UPLINK_ARP_PEERS={shlex.quote(arp_peers)} ' if arp_peers else ''
        hostarg = f' --host {shlex.quote(host)}' if host else ''
        remote = (f'cd ~/agentic-era-networking && {env}timeout -s KILL {PROBE_REMOTE_KILL_S} node {PROBE_CLI} --overall-ms {PROBE_OVERALL_MS} '
                  f'--reconnect-wait-ms {PROBE_RECONNECT_WAIT_MS} --readback-timeout-ms {PROBE_READBACK_TIMEOUT_MS} --readbacks {PROBE_READBACKS} --interval-ms {PROBE_INTERVAL_MS}{hostarg}')
        self.remote = remote; self.lines = []; self.lock = threading.Lock(); self.proc = None; self.started = None
    def start(self):
        self.started = time.monotonic()
        self.proc = subprocess.Popen(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', lc.JETSON, self.remote], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        threading.Thread(target=self._read, daemon=True).start()
    def _read(self):
        for line in self.proc.stdout:
            with self.lock: self.lines.append((time.monotonic(), line.rstrip('\n')))
            log('probe| ' + line.rstrip('\n'))
    def wait_line(self, pattern, timeout_s):
        """The first collected line matching `pattern`, or None; also returns early (None) if the probe has exited."""
        rx = re.compile(pattern); end = time.monotonic() + timeout_s
        while time.monotonic() < end:
            with self.lock:
                for t, l in self.lines:
                    if rx.search(l): return t, l
            if self.proc.poll() is not None: time.sleep(0.3)  # let the reader drain, then look once more
            with self.lock:
                for t, l in self.lines:
                    if rx.search(l): return t, l
            if self.proc.poll() is not None: return None
            time.sleep(0.2)
        return None
    def finish(self, timeout_s):
        """Waits for exit, bounded; kills what is left. Returns (exit code or None, parsed RESULT or None, killed)."""
        killed = False
        try: self.proc.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            killed = True; log('probe still running at its bound; killing it'); self.kill()
        time.sleep(0.5)
        result = None
        with self.lock:
            for t, l in self.lines:
                if l.startswith('RESULT '):
                    try: result = json.loads(l[len('RESULT '):])
                    except ValueError: result = None
        return self.proc.returncode, result, killed
    def kill(self):
        if self.proc is not None and self.proc.poll() is None: self.proc.terminate()
        try: sh(lc.JETSON, 'pkill -f controller-away-probe-cli || true', 15)
        except Exception as e: log(f'remote pkill failed: {e}')

# ---- preconditions ----
def preflight():
    log('preflight')
    for h in (lc.JETSON, lc.NODE01):
        rc, out, err = sh(h, 'true')
        if rc != 0: raise SystemExit(f'cannot ssh to {h}: {err}')
    rc, _, _ = sh(lc.NODE01, 'sudo -n true')
    if rc != 0: raise SystemExit(f'sudo -n does not work on {lc.NODE01}: run by hand: sudo ip neigh replace {NEIGH_IP} lladdr {NEIGH_MAC} dev {NEIGH_DEV} nud permanent')
    rc, _, _ = sh(lc.JETSON, 'sudo -n true')
    if rc != 0: raise SystemExit(f'sudo -n does not work on {lc.JETSON}: start by hand in another terminal: sudo tcpdump -i {lc.TAP_IF} -w /dev/null  (and rerun with the capture running)')
    rc, out, _ = sh(lc.JETSON, 'pgrep -f controller-away-probe-cli || true')
    if out: raise SystemExit(f'a probe process is already running on the Jetson ({out}); not starting')
    rc, out, _ = sh(lc.JETSON, f'test -f {PROBE_CLI} && echo yes || echo no')
    if out != 'yes': raise SystemExit(f'{PROBE_CLI} is missing on the Jetson: build and deploy this branch first (npx tsc, then the dist copy)')
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
    rc, out, err = sh(lc.JETSON, f"sudo -n sh -c 'nohup tcpdump -i {lc.TAP_IF} -s 64 -U -w /dev/null >/dev/null 2>&1 & echo $!'")
    if rc != 0 or not out.isdigit(): raise SystemExit(f'could not start the tap capture: {err}')
    time.sleep(1.5)
    rc, prom, _ = sh(lc.JETSON, f"ip -d link show {lc.TAP_IF} | grep -o 'promiscuity [0-9]*'")
    log(f'setup: neighbor entry {NEIGH_IP} on {lc.NODE01} {NEIGH_DEV}; tap capture pid {out}; {prom}')
    if prom.split()[-1:] == ['0']: raise SystemExit('the tap NIC is not promiscuous; refusing to measure')
    return int(out)

def teardown(tcpdump_pid):
    log('teardown')
    if tcpdump_pid is not None:
        rc, _, err = sh(lc.JETSON, f'sudo -n kill {tcpdump_pid}'); log(f'tap capture stopped (rc {rc})')
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
def observe(label, idle):
    t_epoch = time.time(); t0 = time.monotonic()
    r = lc.step(2000)
    total, med, bins = lc.delivered_stats(r['series'], idle)
    try: up = bridge_up()
    except Exception as e: up = f'unknown ({e})'
    RES[label] = {'sent': r['sent'], 'delivered': round(total), 'ratio': round(total / r['sent'], 4) if r['sent'] else 0, 'medianBusyPps': round(med),
                  'startedEpoch': round(t_epoch, 1), 'durationS': round(time.monotonic() - t0, 1), 'startedEt': lc.now_et(), 'bridgeUpAtEnd': up}
    log(f'{label}: sent {r["sent"]}, delivered {round(total)}, ratio {RES[label]["ratio"]:.3f}, bridge up at end: {up}')
    return RES[label]

def main():
    global OUT
    if sys.argv[1:] == ['--plan']:
        print(plan_text()); return 0
    if len(sys.argv) != 2: raise SystemExit(__doc__)
    OUT = sys.argv[1]
    prov = {'startedEt': lc.now_et(), 'harnessSha256': hashlib.sha256(open(__file__, 'rb').read()).hexdigest(), 'lcSha256': hashlib.sha256(open(lc.__file__, 'rb').read()).hexdigest(),
            'senderSha256': hashlib.sha256(lc.SENDER_SRC.encode()).hexdigest(),
            'probeCliSha256': lc.run(lc.JETSON, f'sha256sum {PROBE_CLI}').split()[0], 'jetsonRepo': lc.run(lc.JETSON, 'cd ~/agentic-era-networking && git rev-parse HEAD && git rev-parse --abbrev-ref HEAD').split(),
            'limits': {'probeOverallMs': PROBE_OVERALL_MS, 'reconnectWaitMs': PROBE_RECONNECT_WAIT_MS, 'readbackTimeoutMs': PROBE_READBACK_TIMEOUT_MS, 'readbacks': PROBE_READBACKS, 'intervalMs': PROBE_INTERVAL_MS,
                       'remoteKillS': PROBE_REMOTE_KILL_S, 'startDeadlineS': PROBE_START_DEADLINE_S, 'ownerSleepS': OUTAGE_SLEEP_S, 'baselineMinRatio': BASELINE_MIN_RATIO}}
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
        if base['ratio'] < BASELINE_MIN_RATIO: raise SystemExit(f'baseline ratio {base["ratio"]} is under {BASELINE_MIN_RATIO}: the preconditions are not holding; nothing was disturbed')
        RES['tableBeforeOutage'] = table_counters(); log(f'table counters before the outage: {json.dumps(RES["tableBeforeOutage"])[:400]}')
        open(OUT + '.ready', 'w').write('ready')
        log('READY. Owner: paste this on the Jetson now (it stops the bridge, waits, starts it again):')
        log('    ' + OWNER_COMMAND)
        t0 = time.monotonic()
        while bridge_up():
            if time.monotonic() - t0 > WAIT_FOR_OUTAGE_S: log('gave up waiting for the outage; nothing was disturbed'); return 1
            time.sleep(1)
        D = time.monotonic(); RES['bridgeDownSeenAfterReadyS'] = round(D - t0, 1)
        log('bridge unreachable (D). The switch has no controller. Measuring before the probe connects.')
        observe('no_controller_before_probe', idle)
        late = time.monotonic() - D > PROBE_START_DEADLINE_S
        back = bridge_up()
        if back or late:
            RES['probeSkipped'] = 'bridge already back' if back else f'later than {PROBE_START_DEADLINE_S} s after the bridge went down'
            log(f'probe NOT started: {RES["probeSkipped"]}')
        else:
            probe = Probe(peers, host); probe.start(); RES['probeStartedAfterDS'] = round(time.monotonic() - D, 1)
            log(f'probe started {RES["probeStartedAfterDS"]} s after D; waiting for the switch to connect and the first readback')
            got = probe.wait_line(r'readback 1[: ]', PROBE_FIRST_READ_WAIT_S)
            if got is None:
                RES['probeConnectedObservation'] = 'skipped: no readback 1 line (the switch did not connect or the read failed); see the probe lines'
                log(RES['probeConnectedObservation'])
            else:
                RES['probeFirstReadAfterDS'] = round(got[0] - D, 1)
                observe('probe_connected', idle)
            code, result, killed = probe.finish(max(1, PROBE_OVERALL_MS / 1000 + PROBE_BACKSTOP_S - (time.monotonic() - probe.started)))
            RES['probe'] = {'exitCode': code, 'killedAtBound': killed, 'result': result}
            log(f'probe finished: exit {code}, outcome {result.get("outcome") if result else "no RESULT line"}')
        t1 = time.monotonic()
        while not bridge_up():
            if time.monotonic() - t1 > WAIT_FOR_BRIDGE_BACK_S:
                log('THE BRIDGE IS STILL DOWN after the wait: the owner must check systemctl status zodiac-bridge'); RES['bridgeBack'] = False; rc = 2; return rc
            time.sleep(2)
        RES['bridgeBack'] = True; RES['bridgeBackAfterDS'] = round(time.monotonic() - D, 1)
        log(f'bridge answering again {RES["bridgeBackAfterDS"]} s after D')
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
