#!/usr/bin/env python3
"""scripts/hailo-thermal-capped-soak.py: duty-cycled Hailo-8 load that holds the chip under a temperature cap.

The service's POST /benchmark runs flat out for 1 to 30 s and cannot be rate-limited, so the cap is enforced by
duty cycling: poll /health while resting, start a short saturated burst only when the hotter chip sensor is at or below
START_C, and stop the whole run if any reading (health or a burst's own maximum) reaches HARD_C. The result is the
throughput the device sustains while staying under the cap, plus a temperature trace. Written after the 2026-10-19
saturated run, which reached 95.4 C against the owner's 85 C dashboard limit (see hailo-capacity/README.md).

Environment (all optional): BASE, OUT, MODEL, RUN_SECONDS (default 720), BURST_SECONDS (4), START_C (66), HARD_C (80),
POLL_SECONDS (2).
Everything is written under OUT as it happens, so an interrupted run keeps its data.
"""
import json, os, time, urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

BASE = os.environ.get('BASE', 'http://100.114.195.7:8000')
OUT = os.environ.get('OUT', '/tmp/hailo-capped')
MODEL = os.environ.get('MODEL', 'yolov8s_h8.hef')
RUN_SECONDS = int(os.environ.get('RUN_SECONDS', '720'))
BURST_SECONDS = int(os.environ.get('BURST_SECONDS', '4'))
START_C = float(os.environ.get('START_C', '66'))
HARD_C = float(os.environ.get('HARD_C', '80'))
POLL_SECONDS = float(os.environ.get('POLL_SECONDS', '2'))
ET = ZoneInfo('America/New_York')


def now_et():
    return datetime.now(ET).strftime('%Y-%m-%d %H:%M:%S %Z')


def post(path, body, timeout=60):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), headers={'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def health():
    with urllib.request.urlopen(BASE + '/health', timeout=8) as r:
        h = json.loads(r.read())
    return h, max(h['chip_ts0_c'], h['chip_ts1_c'])


def save(name, obj):
    with open(os.path.join(OUT, name), 'w') as f:
        json.dump(obj, f, indent=2)


def main():
    os.makedirs(OUT, exist_ok=True)
    h0, _ = health()
    meta = {'started_et': now_et(), 'model': MODEL, 'run_seconds': RUN_SECONDS, 'burst_seconds': BURST_SECONDS,
            'start_c': START_C, 'hard_c': HARD_C, 'poll_seconds': POLL_SECONDS, 'health_before': h0}
    save('meta.json', meta)
    trace = open(os.path.join(OUT, 'temp-trace.jsonl'), 'a')
    bursts = []
    stop_reason = None
    start = time.monotonic()
    start_ns = time.monotonic_ns()
    busy_ns = 0

    def log_temp(kind, temp):
        trace.write(json.dumps({'t_et': now_et(), 'elapsed_s': round(time.monotonic() - start, 1), 'kind': kind, 'chip_c': temp}) + '\n')
        trace.flush()

    while time.monotonic() - start < RUN_SECONDS:
        try:
            _, temp = health()
        except Exception as e:  # a failed read is a gap, not a reason to keep loading blind: stop
            stop_reason = f'health read failed: {str(e)[:100]}'
            break
        log_temp('rest', temp)
        if temp >= HARD_C:
            stop_reason = f'chip {temp:.1f} C reached the {HARD_C} C hard limit while resting'
            break
        if temp > START_C:
            time.sleep(POLL_SECONDS)
            continue
        try:
            r = post('/benchmark', {'model_name': MODEL, 'seconds': BURST_SECONDS, 'measure_latency': False})
        except Exception as e:
            stop_reason = f'benchmark call failed: {str(e)[:100]}'
            break
        r.pop('raw_output', None)
        r['t_et'] = now_et()
        r['elapsed_s'] = round(time.monotonic() - start, 1)
        r['start_chip_c'] = temp
        busy_ns += r['duration_ns']
        bursts.append(r)
        save('bursts.json', bursts)
        log_temp('burst_max', r['temp_max_c'])
        print(r['t_et'], 'burst', len(bursts), 'start', round(temp, 1), 'fps', r['fps_milli'] / 1000, 'chip max', r['temp_max_c'], flush=True)
        if r['temp_max_c'] >= HARD_C:
            stop_reason = f"burst {len(bursts)} reached {r['temp_max_c']} C (hard limit {HARD_C} C)"
            break

    wall_ns = time.monotonic_ns() - start_ns
    frames = sum(b['frames_count'] for b in bursts)
    meta.update({'finished_et': now_et(), 'stop_reason': stop_reason, 'bursts': len(bursts), 'frames': frames,
                 'busy_ns': busy_ns, 'wall_ns': wall_ns,
                 'duty_permille': (busy_ns * 1000) // wall_ns if wall_ns else 0,
                 'sustained_fps_milli': (frames * 1_000_000_000_000) // wall_ns if wall_ns else 0,
                 'peak_burst_chip_c': max((b['temp_max_c'] for b in bursts), default=None)})
    try:
        meta['health_after'] = health()[0]
    except Exception as e:
        meta['health_after'] = {'error': str(e)[:100]}
    save('meta.json', meta)
    print(now_et(), 'done', json.dumps({k: meta[k] for k in ('stop_reason', 'bursts', 'duty_permille', 'sustained_fps_milli', 'peak_burst_chip_c')}), flush=True)


if __name__ == '__main__':
    main()
