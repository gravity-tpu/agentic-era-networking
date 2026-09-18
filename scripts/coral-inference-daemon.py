#!/home/zodiac/coral-venv/bin/python3
"""
coral-inference-daemon.py
=========================
Continuous Edge TPU inference daemon for real-time telemetry.

Runs MobileNet V2 INT8 inference continuously, computes rolling P50/P99
latency + inferences/sec, and writes results atomically to
/tmp/coral-telemetry.json every REPORT_INTERVAL_S seconds.

Council Invariant 6 (Anti-Simulation / Goodhart's Law):
  All reported values are derived exclusively from real physical Edge TPU
  execution. No synthetic counters, no estimated rates.

Council Invariant 2 (Determinism):
  All timestamps use time.monotonic_ns() for monotonic nanosecond precision.
  Throughput and latency are computed using integer arithmetic only.
"""

import json
import os
import sys
import time
import traceback

OUTPUT_PATH        = '/tmp/coral-telemetry.json'
MODEL_PATH         = '/home/zodiac/coral-models/mobilenet_v2_1.0_224_quant_edgetpu.tflite'
REPORT_INTERVAL_S  = 1.0
BATCH_SIZE         = 10
WARMUP_N           = 5


def atomic_write_json(path, data):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f, separators=(',', ':'))
    os.replace(tmp, path)


def write_offline(reason):
    atomic_write_json(OUTPUT_PATH, {
        'detected': False,
        'status': 'OFFLINE',
        'error': reason,
        'inferencesPerSecond': 0,
        'totalInferences': 0,
        'latencyP50Ns': 0,
        'latencyP99Ns': 0,
        'timestampNs': time.monotonic_ns(),
    })


def percentile_ns(sorted_lats, p):
    n = len(sorted_lats)
    if n == 0:
        return 0
    idx = min(int(n * p), n - 1)
    return sorted_lats[idx]


def main():
    try:
        import numpy as np
        from pycoral.utils.edgetpu import list_edge_tpus, make_interpreter
    except ImportError as exc:
        msg = f'pycoral import failed: {exc}'
        print(f'[coral-daemon] ERROR: {msg}', file=sys.stderr, flush=True)
        write_offline(msg)
        sys.exit(1)

    tpus = list_edge_tpus()
    if not tpus:
        msg = 'No Edge TPU device found on USB bus'
        print(f'[coral-daemon] {msg}', file=sys.stderr, flush=True)
        write_offline(msg)
        sys.exit(0)

    tpu = tpus[0]
    usb_path = tpu.get('path', 'unknown')
    usb_type = tpu.get('type', 'usb')
    print(f'[coral-daemon] TPU detected: {tpu}', flush=True)

    if not os.path.exists(MODEL_PATH):
        msg = f'Model not found: {MODEL_PATH}'
        print(f'[coral-daemon] ERROR: {msg}', file=sys.stderr, flush=True)
        write_offline(msg)
        sys.exit(1)

    print(f'[coral-daemon] Loading model onto Edge TPU...', flush=True)
    try:
        interp = make_interpreter(MODEL_PATH)
        interp.allocate_tensors()
    except Exception as exc:
        msg = f'make_interpreter failed: {exc}'
        print(f'[coral-daemon] ERROR: {msg}', file=sys.stderr, flush=True)
        write_offline(msg)
        sys.exit(1)

    inp_detail = interp.get_input_details()[0]
    import numpy as np
    dummy = np.zeros(inp_detail['shape'], dtype=np.uint8)

    print(f'[coral-daemon] Warming up ({WARMUP_N} inferences)...', flush=True)
    for _ in range(WARMUP_N):
        interp.set_tensor(inp_detail['index'], dummy)
        interp.invoke()

    print('[coral-daemon] Warm-up complete. Entering inference loop.', flush=True)

    total_inferences   = 0
    window_latencies   = []
    window_start_ns    = time.monotonic_ns()
    last_report_ns     = window_start_ns
    report_interval_ns = int(REPORT_INTERVAL_S * 1_000_000_000)

    while True:
        try:
            for _ in range(BATCH_SIZE):
                t0 = time.monotonic_ns()
                interp.set_tensor(inp_detail['index'], dummy)
                interp.invoke()
                t1 = time.monotonic_ns()
                window_latencies.append(t1 - t0)
                total_inferences += 1

            now_ns = time.monotonic_ns()

            if now_ns - last_report_ns >= report_interval_ns:
                elapsed_ns  = now_ns - window_start_ns
                sorted_lats = sorted(window_latencies)
                n           = len(sorted_lats)
                p50_ns      = percentile_ns(sorted_lats, 0.50)
                p99_ns      = percentile_ns(sorted_lats, 0.99)
                inf_sec     = (n * 1_000_000_000) // elapsed_ns if elapsed_ns > 0 else 0

                atomic_write_json(OUTPUT_PATH, {
                    'detected':            True,
                    'status':              'ACTIVE',
                    'model':               'MobileNet V2 224x224 INT8 (EdgeTPU)',
                    'inferencesPerSecond': inf_sec,
                    'totalInferences':     total_inferences,
                    'latencyP50Ns':        p50_ns,
                    'latencyP99Ns':        p99_ns,
                    'windowSampleCount':   n,
                    'usbPath':             usb_path,
                    'usbType':             usb_type,
                    'timestampNs':         now_ns,
                })

                window_latencies = []
                window_start_ns  = now_ns
                last_report_ns   = now_ns

        except KeyboardInterrupt:
            print('[coral-daemon] Received SIGINT, shutting down.', flush=True)
            write_offline('Daemon stopped (SIGINT)')
            break
        except Exception:
            err = traceback.format_exc()
            print(f'[coral-daemon] ERROR in inference loop:\n{err}', file=sys.stderr, flush=True)
            write_offline(f'Inference loop error: {err[:200]}')
            time.sleep(2.0)


if __name__ == '__main__':
    main()
