#!/usr/bin/env python3
"""scripts/hailo-saturation-soak.py: Hailo-8 sustained-load benchmark driver (owner approved 2026-10-19).

Phase 1: the same two short passes as the first benchmark (10 s throughput, 5 s latency), raw JSON saved.
Phase 2: back-to-back 30 s throughput calls to /benchmark for SOAK_SECONDS (the endpoint caps one call at 30 s).
Phase 3: a post-soak 5 s latency pass (does latency drift when hot?).
A sampler thread reads the Pi's SoC temperature, throttle flags and ARM clock over ssh every 10 s.
Aborts early if the Hailo chip reaches ABORT_C. Everything is written under OUT as it happens.
"""
import json, os, subprocess, threading, time, urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

BASE = 'http://100.114.195.7:8000'
OUT = os.environ.get('OUT', '/tmp/hailo-soak')
SOAK_SECONDS = int(os.environ.get('SOAK_SECONDS', '900'))
ABORT_C = float(os.environ.get('ABORT_C', '85'))  # owner's dashboard limit; the 2026-10-19 run used ABORT_C=100 (too high, see README)
MODEL = 'yolov8s_h8.hef'
ET = ZoneInfo('America/New_York')


def now_et():
    return datetime.now(ET).strftime('%Y-%m-%d %H:%M:%S %Z')


def post(path, body, timeout=90):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), headers={'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def get(path, timeout=10):
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        return json.loads(r.read())


def save(name, obj):
    with open(os.path.join(OUT, name), 'w') as f:
        json.dump(obj, f, indent=2)


def sh(cmd):
    return subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'rpi-hailo', cmd], capture_output=True, text=True, timeout=30).stdout.strip()


stop = threading.Event()


def sampler():
    path = os.path.join(OUT, 'pi-samples.jsonl')
    while not stop.is_set():
        try:
            raw = sh("echo $(vcgencmd measure_temp) $(vcgencmd get_throttled) $(vcgencmd measure_clock arm) $(cut -d' ' -f1 /proc/loadavg)")
            rec = {'t_et': now_et(), 'raw': raw}
        except Exception as e:  # sampling must never stop the run; the gap itself is recorded
            rec = {'t_et': now_et(), 'error': str(e)[:120]}
        with open(path, 'a') as f:
            f.write(json.dumps(rec) + '\n')
        stop.wait(10)


def main():
    os.makedirs(OUT, exist_ok=True)
    meta = {
        'started_et': now_et(), 'host': 'rpi-hailo (Raspberry Pi 5)', 'model': MODEL, 'soak_seconds_requested': SOAK_SECONDS,
        'abort_chip_c': ABORT_C, 'health_before': get('/health'),
        'hailortcli': sh('hailortcli fw-control identify 2>&1 | head -8'),
        'hailort_version': sh('hailortcli --version 2>&1 | head -2'),
        'kernel': sh('uname -r'),
        'pcie_link': sh('lspci -vv -s 0001:01:00.0 2>/dev/null | grep -E "LnkCap:|LnkSta:"'),
        'pi_vcgencmd_before': sh('vcgencmd measure_temp; vcgencmd get_throttled; vcgencmd measure_clock arm'),
    }
    save('meta.json', meta)
    threading.Thread(target=sampler, daemon=True).start()

    save('short-throughput-10s.json', post('/benchmark', {'model_name': MODEL, 'seconds': 10, 'measure_latency': False}))
    save('short-latency-5s.json', post('/benchmark', {'model_name': MODEL, 'seconds': 5, 'measure_latency': True}))
    print(now_et(), 'short passes done', flush=True)

    t0 = time.monotonic()
    calls = []
    aborted = None
    fails = 0
    while time.monotonic() - t0 < SOAK_SECONDS:
        try:
            r = post('/benchmark', {'model_name': MODEL, 'seconds': 30, 'measure_latency': False})
            fails = 0
        except Exception as e:
            fails += 1
            calls.append({'t_et': now_et(), 'error': str(e)[:200]})
            if fails >= 2:
                aborted = 'two consecutive request failures'
                break
            time.sleep(2)
            continue
        r.pop('raw_output', None)  # the per-second progress text adds nothing the structured fields do not carry
        r['t_et'] = now_et()
        r['elapsed_s'] = round(time.monotonic() - t0, 1)
        try:
            r['health_after'] = get('/health')
        except Exception as e:
            r['health_after'] = {'error': str(e)[:100]}
        calls.append(r)
        save('soak-calls.json', calls)
        print(r['t_et'], 'call', len(calls), 'fps', r['fps_milli'] / 1000, 'chip avg/max', r['temp_avg_c'], r['temp_max_c'], flush=True)
        if r['temp_max_c'] is not None and r['temp_max_c'] >= ABORT_C:
            aborted = f"chip temperature {r['temp_max_c']} C reached the {ABORT_C} C abort limit"
            break
    save('soak-calls.json', calls)

    if aborted is None:
        save('post-soak-latency-5s.json', post('/benchmark', {'model_name': MODEL, 'seconds': 5, 'measure_latency': True}))
    meta['finished_et'] = now_et()
    meta['aborted'] = aborted
    meta['soak_calls'] = len(calls)
    meta['health_after'] = get('/health')
    meta['pi_vcgencmd_after'] = sh('vcgencmd measure_temp; vcgencmd get_throttled; vcgencmd measure_clock arm')
    save('meta.json', meta)
    stop.set()
    print(now_et(), 'done', 'aborted=' + str(aborted), flush=True)


if __name__ == '__main__':
    try:
        main()
    finally:
        stop.set()
