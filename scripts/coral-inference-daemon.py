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
  All counters and percentile indices use pure integer arithmetic — zero
  floating-point arithmetic anywhere in the accounting path.
"""

import json
import os
import signal
import socket
import sys
import time
import traceback

MODEL_PATH         = '/home/zodiac/coral-models/mobilenet_v2_1.0_224_quant_edgetpu.tflite'
REPORT_INTERVAL_NS = 1_000_000_000   # 1 second in nanoseconds (integer)
WARMUP_N           = 5


def atomic_write_telemetry_json(filename: str, data: dict):
    """
    Council Invariant (Demis Hassabis & Sanjay Ghemawat):
    Writes telemetry atomically via rename to secure tmpfs RuntimeDirectory (/run/zodiac),
    falling back to /tmp on OSError without TOCTOU pre-check indirection.
    """
    candidate_dirs = ['/run/zodiac', '/tmp']
    last_err = None
    for d in candidate_dirs:
        tmp = os.path.join(d, filename + '.tmp')
        target = os.path.join(d, filename)
        try:
            with open(tmp, 'w') as f:
                json.dump(data, f, separators=(',', ':'))
            os.replace(tmp, target)
            return
        except OSError as e:
            last_err = e
            continue
    if last_err:
        sys.stderr.write(f'[coral-daemon] Failed writing telemetry {filename}: {last_err}\n')


def write_offline(reason):
    atomic_write_telemetry_json('coral-telemetry.json', {
        'detected': False,
        'status': 'OFFLINE',
        'error': reason,
        'inferencesPerSecond': 0,
        'totalInferences': 0,
        'latencyP50Ns': 0,
        'latencyP99Ns': 0,
        'timestampNs': time.monotonic_ns(),
    })


def write_standby(total_inf, usb_p, usb_t):
    atomic_write_telemetry_json('coral-telemetry.json', {
        'detected': True,
        'status': 'STANDBY',
        'model': 'MobileNet V2 224x224 INT8 (EdgeTPU) - Wire Tap DPI',
        'inferencesPerSecond': 0,
        'totalInferences': total_inf,
        'latencyP50Ns': 0,
        'latencyP99Ns': 0,
        'windowSampleCount': 0,
        'usbPath': usb_p,
        'usbType': usb_t,
        'timestampNs': time.monotonic_ns(),
    })


def percentile_ns(sorted_lats, p_num, p_den):
    """
    Pure-integer percentile: p_num/p_den fraction (e.g. 50/100 for P50).

    Council Invariant 2 (Determinism): no floating-point arithmetic.
    The index is computed as (n * p_num) // p_den — integer division only.
    """
    n = len(sorted_lats)
    if n == 0:
        return 0
    idx = min((n * p_num) // p_den, n - 1)
    return sorted_lats[idx]


def find_tap_interface() -> str:
    """Finds the mirror tap interface (ASIX USB GbE adapter enx*)."""
    env_iface = os.environ.get('TAP_INTERFACE')
    if env_iface:
        return env_iface
    try:
        for iface in os.listdir('/sys/class/net'):
            if iface.startswith('enx'):
                return iface
    except Exception as e:
        sys.stderr.write(f'[coral-daemon] Notice: /sys/class/net scan failed: {e}\n')
    return 'enx9c69d39dd0a6'


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

    target_usb_path = os.environ.get('CORAL_PRIMARY_USB_PATH', '2-1.3')
    target_idx = None
    for idx, t in enumerate(tpus):
        if target_usb_path in t.get('path', ''):
            target_idx = idx
            break

    if target_idx is None:
        msg = f'Required Edge TPU matching topology {target_usb_path} not found among {tpus}'
        print(f'[coral-daemon] ERROR: {msg}', file=sys.stderr, flush=True)
        write_offline(msg)
        sys.exit(1)

    tpu = tpus[target_idx]
    usb_path = tpu.get('path', 'unknown')
    usb_type = tpu.get('type', 'usb')
    print(f'[coral-daemon] TPU detected: {tpu} (index :{target_idx})', flush=True)

    if not os.path.exists(MODEL_PATH):
        msg = f'Model not found: {MODEL_PATH}'
        print(f'[coral-daemon] ERROR: {msg}', file=sys.stderr, flush=True)
        write_offline(msg)
        sys.exit(1)

    print(f'[coral-daemon] Loading model onto Edge TPU :{target_idx}...', flush=True)
    try:
        interp = make_interpreter(MODEL_PATH, device=f':{target_idx}')
        interp.allocate_tensors()
    except Exception as exc:
        msg = f'make_interpreter failed: {exc}'
        print(f'[coral-daemon] ERROR: {msg}', file=sys.stderr, flush=True)
        write_offline(msg)
        sys.exit(1)

    inp_detail = interp.get_input_details()[0]
    inp_shape = inp_detail['shape']
    inp_size = int(np.prod(inp_shape))
    tensor_buf = np.zeros(inp_shape, dtype=np.uint8)
    flat_buf = tensor_buf.reshape(-1)

    print(f'[coral-daemon] Warming up ({WARMUP_N} inferences)...', flush=True)
    for _ in range(WARMUP_N):
        interp.set_tensor(inp_detail['index'], tensor_buf)
        interp.invoke()

    tap_iface = find_tap_interface()
    raw_sock = None
    try:
        raw_sock = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.ntohs(0x0003))
        raw_sock.bind((tap_iface, 0))
        raw_sock.settimeout(0.2)
        print(f'[coral-daemon] Successfully bound AF_PACKET raw socket on {tap_iface}', flush=True)
    except Exception as e:
        print(f'[coral-daemon] Warning: unable to bind AF_PACKET raw socket on {tap_iface} ({e}). '
              f'Operating in standby listener mode.', file=sys.stderr, flush=True)

    print('[coral-daemon] Warm-up complete. Entering wire-packet inference loop.', flush=True)

    total_inferences   = 0           # int — never float
    window_latencies   = []          # list[int] nanoseconds — never float
    window_start_ns    = time.monotonic_ns()
    last_report_ns     = window_start_ns

    # Emit initial STANDBY state with zero rates (Council Invariant 6: Anti-Simulation Law)
    write_standby(total_inferences, usb_path, usb_type)

    while True:
        try:
            if raw_sock is not None:
                try:
                    # Ingest real Ethernet frame directly from physical wire tap
                    frame = raw_sock.recv(65535)
                    if frame:
                        n_bytes = min(len(frame), inp_size)
                        flat_buf[:n_bytes] = np.frombuffer(frame[:n_bytes], dtype=np.uint8)
                        if n_bytes < inp_size:
                            flat_buf[n_bytes:] = 0

                        t0 = time.monotonic_ns()
                        interp.set_tensor(inp_detail['index'], tensor_buf)
                        interp.invoke()
                        t1 = time.monotonic_ns()

                        window_latencies.append(t1 - t0)
                        total_inferences += 1
                except socket.timeout:
                    # No packets arrived on wire in 200ms timeout window
                    pass
                except Exception as exc:
                    print(f'[coral-daemon] Frame read warning: {exc}', file=sys.stderr, flush=True)
                    time.sleep(0.05)
            else:
                # AF_PACKET raw socket unavailable (waiting on interface or CAP_NET_RAW)
                time.sleep(0.2)

            now_ns = time.monotonic_ns()
            if now_ns - last_report_ns >= REPORT_INTERVAL_NS:
                elapsed_ns  = now_ns - window_start_ns
                sorted_lats = sorted(window_latencies)
                n           = len(sorted_lats)

                # Pure integer arithmetic (Council Invariant 2: Determinism)
                if n > 0 and elapsed_ns > 0:
                    p50_ns  = percentile_ns(sorted_lats, 50, 100)
                    p99_ns  = percentile_ns(sorted_lats, 99, 100)
                    inf_sec = (n * 1_000_000_000) // elapsed_ns
                    status  = 'ACTIVE'
                else:
                    p50_ns  = 0
                    p99_ns  = 0
                    inf_sec = 0
                    status  = 'STANDBY'

                atomic_write_telemetry_json('coral-telemetry.json', {
                    'detected':            True,
                    'status':              status,
                    'model':               'MobileNet V2 224x224 INT8 (EdgeTPU) - Wire Tap DPI',
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
            print('[coral-daemon] Received SIGINT, shutting down cleanly.', flush=True)
            write_standby(total_inferences, usb_path, usb_type)
            if raw_sock:
                try:
                    raw_sock.close()
                except Exception as e:
                    sys.stderr.write(f'[coral-daemon] Notice: error closing raw socket: {e}\n')
            break
        except Exception:
            err = traceback.format_exc()
            print(f'[coral-daemon] ERROR in inference loop:\n{err}',
                  file=sys.stderr, flush=True)
            write_offline(f'Inference loop error: {err[:200]}')
            time.sleep(2)


if __name__ == '__main__':
    main()
