#!/usr/bin/env python3
"""scripts/layout-capacity-run.py: hardware confirmation of the A4 versus A9 decision (docs/ROADMAP.md, Track A).

Question: with the DEPLOYED isolation policy on the switch and k quarantine DROP rules above it (installed through the bridge's own
quarantine path, so the layout is exactly the deployed one), what is the forwarding capacity, and does the per-packet time grow by
about 4.24 us per quarantine, as the fitted cost model (src/sdn/zodiac-cost-model.ts, base layout) says?

Method. For each k, install k quarantines (propose then approve, through the bridge on the Jetson, on unused workload addresses), then ramp
the offered rate of 572-byte UDP from node-01 (10.0.2.50, eth0) towards 10.0.0.119 in steps of x1.2. Under the deployed policy that traffic is
matched by p1-default-tap-only (in_port 1 -> P3), so the switch's output is read as the packet counter of the Jetson NIC on the P3 link
(O2, enx9c69d39dd0a6), sampled every 0.1 s and corrected for the idle rate measured just before. The ramp STOPS at the first step whose
delivered/sent ratio is below 0.97 (saturation), so the offered rate never exceeds 1.2x the capacity; it also stops if the bridge's isolation
status stops verifying (a sign the session is in trouble), and never goes above MAX_OFFERED_PPS. Capacity is the median of the 1 s delivered
rates inside the saturated step. Everything raw is kept: sampler series, sender counts, every step, provenance.

What it does not do: it does not test the forwarding-first layout (the quarantine path cannot build it, by A4), does not read switch CPU,
and measures one layout path (a frame matched by the third-priority tap-only rule). One switch, firmware 0.86.

Usage: python3 scripts/layout-capacity-run.py --out <dir> [--ks 0,2,4,8] [--rounds 2]
"""
import argparse, base64, json, os, subprocess, threading, time, hashlib, statistics
from datetime import datetime
from zoneinfo import ZoneInfo

JETSON = 'jetson'
NODE01 = 'agentic-node-01'
TAP_IF = 'enx9c69d39dd0a6'            # O2: the Jetson NIC on the Zodiac P3 link
SENDER_IF, SENDER_IP, DST_IP, DST_PORT, PAYLOAD = 'eth0', '10.0.2.50', '10.0.0.119', 41950, 572
QUARANTINE_IPS = [f'10.0.2.{n}' for n in range(101, 117)]   # unused workload addresses (not .50, not the protected ones, not the ARP-probe .200)
START_PPS, STEP_FACTOR, MAX_OFFERED_PPS = 2000, 1.2, 16000
STEP_SECONDS, SAT_RATIO, QUARANTINE_TTL_S = 12, 0.97, 300
# Quarantines expire after QUARANTINE_TTL_S. The ramp stops TTL_SAFETY_S before that, so a step never straddles the expiry; a re-probe needs one more
# step plus REPROBE_SLACK_S for the status check and the 3 s pause, so it is skipped when less than that is left.
TTL_SAFETY_S, REPROBE_SLACK_S = 40, 5
NS = 1_000_000_000
SAMPLE_S = 0.1

SENDER_SRC = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'layout-capacity-sender.py')).read()
SAMPLER_SRC = '''
import sys, time
iface, secs = sys.argv[1], float(sys.argv[2])
path = f"/sys/class/net/{iface}/statistics/rx_packets"
t0 = time.perf_counter_ns(); end = t0 + int(secs * 1e9)
out = []
while True:
    now = time.perf_counter_ns()
    if now >= end: break
    with open(path) as f: out.append((now - t0, int(f.read())))
    time.sleep(0.1)
print(__import__("json").dumps(out))
'''

def now_et(): return datetime.now(ZoneInfo('America/New_York')).strftime('%Y-%m-%d %H:%M:%S ET')

def run(host, remote, timeout=120):
    p = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, remote], capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0: raise RuntimeError(f'ssh {host} failed ({p.returncode}): {p.stderr.strip()[:300]}')
    return p.stdout

def py(host, code, args, timeout=120):
    b64 = base64.b64encode(code.encode()).decode()
    return run(host, f'echo {b64} | base64 -d > /tmp/lc-snippet.py && python3 /tmp/lc-snippet.py {" ".join(args)}', timeout)

def api(method, path, body=None):
    cmd = f'curl -s -m 10 -X {method} localhost:3003{path}'
    if body is not None: cmd += " -H 'content-type: application/json' -d '" + json.dumps(body) + "'"
    out = run(JETSON, cmd)
    return json.loads(out) if out.strip() else {}

def isolation_ok():
    d = api('GET', '/api/zodiac/flows')
    return d.get('port1Isolation', {}).get('state') == 'verified', d

def quarantine_count():
    d = api('GET', '/api/zodiac/flows')
    return sum(1 for r in d.get('rules', []) if str(r.get('ruleId', '')).startswith('quarantine-') and r.get('openFlowInstalled'))

def set_quarantines(k):
    """Release every quarantine, then install exactly k. Returns the monotonic time the quarantines were installed."""
    for ip in QUARANTINE_IPS:
        api('POST', '/api/sdn/release', {'targetIp': ip, 'reason': 'layout capacity run'})
    for ip in QUARANTINE_IPS[:k]:
        api('POST', '/api/sdn/quarantine', {'targetIp': ip, 'reason': 'layout capacity run'})
        r = api('POST', '/api/sdn/quarantine/approve', {'targetIp': ip})
        if not r.get('quarantined'): raise RuntimeError(f'could not install quarantine for {ip}: {r}')
    time.sleep(2)
    got = quarantine_count()
    if got != k: raise RuntimeError(f'expected {k} quarantine rules on the switch, the bridge reports {got}')
    return time.monotonic()

def ensure_allow_rules(j, priority):
    """Install allow rules until exactly j are on the switch. Each matches in_port 2 and a source MAC that never appears on the wire, so it adds a
    lookup entry and carries no traffic. Allow rules are only ever added here: the bridge removes them when the session restarts."""
    global ALLOW_INSTALLED
    while ALLOW_INSTALLED < j:
        n = ALLOW_INSTALLED + 1
        r = api('POST', '/api/sdn/allow', {'inPort': 2, 'outPort': 1, 'priority': priority, 'srcMac': f'02:00:00:00:00:{n:02x}', 'description': 'layout capacity run: inert allow rule'})
        if not r.get('ok') or not r.get('openFlowInstalled'): raise RuntimeError(f'could not install allow rule {n}: {r}')
        ALLOW_INSTALLED = n
    time.sleep(2)

ALLOW_INSTALLED = 0

def sample_idle(seconds=4):
    series = json.loads(py(JETSON, SAMPLER_SRC, [TAP_IF, str(seconds)]))
    dt = (series[-1][0] - series[0][0]) / 1e9
    return (series[-1][1] - series[0][1]) / dt

def step(pps):
    res = {}
    def sampler():
        res['series'] = json.loads(py(JETSON, SAMPLER_SRC, [TAP_IF, str(STEP_SECONDS + 4)]))
    th = threading.Thread(target=sampler); th.start()
    time.sleep(1.5)  # let the sampler start before the first packet
    out = py(NODE01, SENDER_SRC, [DST_IP, str(DST_PORT), str(pps), str(STEP_SECONDS), SENDER_IP, SENDER_IF, str(PAYLOAD)])
    th.join()
    parts = out.split()
    return {'sent': int(parts[1]), 'elapsedNs': int(parts[3]), 'series': res['series']}

def delivered_stats(series, idle_pps):
    """Total delivered over the whole window (idle-corrected), and the median 1 s rate over the busy part."""
    total = series[-1][1] - series[0][1] - idle_pps * (series[-1][0] - series[0][0]) / 1e9
    bins, t = [], series[0][0]
    i = 0
    while i < len(series):
        j = i
        while j < len(series) and series[j][0] - series[i][0] < 1e9: j += 1
        if j >= len(series): break
        dt = (series[j][0] - series[i][0]) / 1e9
        bins.append((series[j][1] - series[i][1]) / dt - idle_pps)
        i = j
    peak = max(bins) if bins else 0
    busy = [b for b in bins if b > 0.5 * peak]
    return total, (statistics.median(busy) if busy else 0.0), bins

def ramp(k, idle_pps, log):
    steps, pps = [], START_PPS
    t_installed_ns = time.monotonic_ns()
    while pps <= MAX_OFFERED_PPS:
        ok, flows = isolation_ok()
        if not ok:
            log(f'  k={k}: isolation status not verified before the step ({flows.get("port1Isolation", {}).get("state")}); stopping the ramp')
            steps.append({'targetPps': pps, 'aborted': 'isolation not verified'}); break
        r = step(pps)
        total, med, bins = delivered_stats(r['series'], idle_pps)
        ratio = total / r['sent'] if r['sent'] else 0
        sent_pps = r['sent'] / (r['elapsedNs'] / 1e9)
        rec = {'targetPps': pps, 'sent': r['sent'], 'sentPps': round(sent_pps), 'delivered': round(total), 'ratio': round(ratio, 4), 'medianBusyDeliveredPps': round(med), 'binsPps': [round(b) for b in bins], 'series': r['series']}
        steps.append(rec)
        log(f'  k={k} offered {pps:>6} (sent {sent_pps:7.0f}/s): delivered ratio {ratio:.3f}, median busy rate {med:7.0f} pps')
        if sent_pps < 0.97 * pps:
            rec['senderLimited'] = True; log('  the sender could not reach the target rate; stopping the ramp (sender-limited, not a switch capacity)'); break
        if ratio < SAT_RATIO:
            # Added after run-2026-10-20 (whose k=2 round 1 was stopped by a ~2 s stall): re-probe the same rate once; a step that recovers is a
            # transient, recorded and not treated as capacity. Runs before this change (see provenance harnessSha256) used the single-step rule.
            if time.monotonic_ns() - t_installed_ns > (QUARANTINE_TTL_S - TTL_SAFETY_S - STEP_SECONDS - REPROBE_SLACK_S) * NS:
                rec['saturated'] = True; rec['unconfirmed'] = True  # no time left inside the quarantine limit to re-probe: recorded as unconfirmed, not hidden
                log('  no time left to re-probe inside the quarantine time limit; recording the step as saturated but unconfirmed'); break
            r2 = step(pps)
            total2, med2, bins2 = delivered_stats(r2['series'], idle_pps)
            ratio2 = total2 / r2['sent'] if r2['sent'] else 0
            rec['confirmation'] = {'ratio': round(ratio2, 4), 'medianBusyDeliveredPps': round(med2), 'binsPps': [round(b) for b in bins2], 'sent': r2['sent']}
            log(f'  k={k} re-probe at {pps}: ratio {ratio2:.3f}')
            if ratio2 < SAT_RATIO:
                rec['saturated'] = True; break
            rec['transient'] = True
        if time.monotonic_ns() - t_installed_ns > (QUARANTINE_TTL_S - TTL_SAFETY_S) * NS:
            log('  quarantine time limit too close; stopping the ramp'); steps[-1]['stoppedByTtl'] = True; break
        pps = int(pps * STEP_FACTOR)
        time.sleep(3)
    return steps

def main():
    global MAX_OFFERED_PPS
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True); ap.add_argument('--ks', default='0,2,4,8'); ap.add_argument('--rounds', type=int, default=2); ap.add_argument('--max-pps', type=int, default=MAX_OFFERED_PPS)
    ap.add_argument('--allow-js', default=None, help='measure with this many inert allow rules (ascending, cumulative, k = 0) instead of quarantines, e.g. 0,4,8')
    ap.add_argument('--allow-priority', type=int, default=10, help='priority of the allow rules: below the measured rule (150) or above the policy (300)')
    a = ap.parse_args()
    MAX_OFFERED_PPS = min(a.max_pps, MAX_OFFERED_PPS)
    ks = [int(x) for x in a.ks.split(',')]
    allow_js = None if a.allow_js is None else sorted(int(x) for x in a.allow_js.split(','))
    if allow_js is not None: ks = allow_js; a.rounds = 1  # the allow rules cannot be removed without a restart, so one ascending pass
    os.makedirs(a.out, exist_ok=True)
    logf = open(os.path.join(a.out, 'run.log'), 'a')
    def log(s):
        line = f'[{now_et()}] {s}'; print(line, flush=True); logf.write(line + '\n'); logf.flush()
    prov = {
        'startedEt': now_et(),
        'bridgeCommit': run(JETSON, 'cd ~/agentic-era-networking && git rev-parse HEAD && git rev-parse --abbrev-ref HEAD && git status --short | wc -l').split(),
        'bridgeDistSha256': run(JETSON, 'sha256sum ~/agentic-era-networking/dist/sdn/zodiac-bridge-server.js').split()[0],
        'senderSha256': hashlib.sha256(SENDER_SRC.encode()).hexdigest(),
        'harnessSha256': hashlib.sha256(open(__file__, 'rb').read()).hexdigest(),
        'params': {'startPps': START_PPS, 'stepFactor': STEP_FACTOR, 'maxOfferedPps': MAX_OFFERED_PPS, 'stepSeconds': STEP_SECONDS, 'saturationRatio': SAT_RATIO, 'payloadBytes': PAYLOAD,
                   'sender': f'{NODE01} {SENDER_IP} via {SENDER_IF} to {DST_IP}', 'observe': f'Jetson {TAP_IF} rx_packets (Zodiac P3 link)', 'quarantineIps': QUARANTINE_IPS, 'allowRuleCounts': allow_js, 'allowPriority': a.allow_priority if allow_js is not None else None},
        'quarantineEnvelope': 'bridge defaults (propose mode, approve through the local API; cap 8, ttl 300 s)',
    }
    json.dump(prov, open(os.path.join(a.out, 'provenance.json'), 'w'), indent=1)
    ok, flows = isolation_ok()
    if not ok: raise SystemExit('refusing to start: the isolation policy is not verified')
    if quarantine_count() != 0: raise SystemExit('refusing to start: quarantines are already active')
    results = []
    try:
        for rnd in range(1, a.rounds + 1):
            order = ks if rnd % 2 == 1 else list(reversed(ks))
            for k in order:
                if allow_js is not None:
                    log(f'round {rnd}: {k} allow rule(s) at priority {a.allow_priority}, no quarantines')
                    set_quarantines(0)
                    ensure_allow_rules(k, a.allow_priority)
                else:
                    log(f'round {rnd}: installing {k} quarantine(s)')
                    set_quarantines(k)
                idle = sample_idle()
                log(f'  idle rate on the tap NIC: {idle:.1f} pps')
                steps = ramp(k, idle, log)
                sat = [s for s in steps if s.get('saturated')]
                cap = sat[0]['medianBusyDeliveredPps'] if sat else None
                log(f'  k={k}: capacity {cap if cap is not None else "not reached"} pps')
                results.append({'round': rnd, 'k': k, 'idlePps': round(idle, 2), 'capacityPps': cap, 'steps': steps})
                json.dump(results, open(os.path.join(a.out, 'results.json'), 'w'))
                set_quarantines(0)
                time.sleep(8)
    finally:
        try:
            for ip in QUARANTINE_IPS: api('POST', '/api/sdn/release', {'targetIp': ip, 'reason': 'layout capacity run finished'})
            ok, flows = isolation_ok(); log(f'finished; quarantines left: {quarantine_count()}; isolation verified: {ok}')
        except Exception as e:  # report, never hide, a failed clean-up
            log(f'CLEAN-UP FAILED: {e}')
    json.dump(results, open(os.path.join(a.out, 'results.json'), 'w'))

if __name__ == '__main__':
    main()
