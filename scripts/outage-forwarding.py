"""Does the switch keep forwarding while the bridge (its controller) is down? Run with the same setup as scripts/layout-capacity-run.py (sender neighbor entry, promiscuous tap NIC).
Sends 2,000 pps from the workload side for one step before, two steps during and one after an outage the operator creates, and counts delivery on the tap NIC.
Usage: python3 scripts/outage-forwarding.py OUT_PREFIX   (then stop the bridge when it prints READY)."""
import importlib.util, json, os, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('lc', os.path.join(HERE, 'layout-capacity-run.py'))
lc = importlib.util.module_from_spec(spec); spec.loader.exec_module(lc)
OUT = sys.argv[1]
def log(s):
    line = f'[{lc.now_et()}] {s}'; print(line, flush=True); open(OUT + '.log', 'a').write(line + '\n')
def bridge_up():
    code = lc.run(lc.JETSON, "curl -s -m 3 -o /dev/null -w '%{http_code}' localhost:3003/api/zodiac/flows || true").strip()
    return code == '200'
res = {}
ok, flows = lc.isolation_ok(); log(f'isolation verified before: {ok}')
idle = lc.sample_idle(); log(f'idle rate {idle:.1f} pps')
def run_step(label):
    r = lc.step(2000)
    total, med, bins = lc.delivered_stats(r['series'], idle)
    res[label] = {'sent': r['sent'], 'delivered': round(total), 'ratio': round(total / r['sent'], 4), 'medianBusyPps': round(med)}
    log(f'{label}: sent {r["sent"]}, delivered {round(total)}, ratio {total / r["sent"]:.3f}, bridge up at end: {bridge_up()}')
run_step('baseline_bridge_up')
open(OUT + '.ready', 'w').write('ready')
log('READY: waiting for the bridge to go away')
t0 = time.monotonic()
while bridge_up():
    if time.monotonic() - t0 > 300: log('gave up waiting for the outage'); json.dump(res, open(OUT + '.json', 'w')); sys.exit(1)
    time.sleep(1)
log('bridge unreachable; measuring forwarding without a controller')
res['bridge_down_seen_after_s'] = round(time.monotonic() - t0, 1)
run_step('during_outage_1')
run_step('during_outage_2') if not bridge_up() else log('bridge already back; second step skipped')
while not bridge_up():
    time.sleep(2)
time.sleep(10)
ok, flows = lc.isolation_ok(); log(f'isolation after: {ok}')
run_step('after_bridge_back')
json.dump(res, open(OUT + '.json', 'w'))
log('finished')
