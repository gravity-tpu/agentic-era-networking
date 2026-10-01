#!/usr/bin/env python3
"""
trt-inference-daemon.py
=======================
TensorRT GPU inference daemon — replaces Google Coral USB TPU.

Runs MobileNet V2 INT8 inference on the Jetson Orin Nano Super's Ampere GPU
(1024 CUDA cores, 32 Tensor Cores) via TensorRT, reading raw Ethernet frames
from the Zodiac Port 3 wire tap (AF_PACKET socket on enx*).

Provenance: source='jetson_trt_gpu' (physical Orin Nano Super silicon, not USB).

Engine setup (run once on Jetson before starting this daemon):
    python3 /home/zodiac/scripts/build-trt-engine.py

Council Invariants:
  INV-1 (Anti-Shortcut): Zero empty except blocks — all errors logged explicitly.
  INV-2 (Determinism): monotonic_ns() timestamps, integer arithmetic in accounting.
  INV-6 (Epistemic Provenance): Physical silicon truth — Ampere GPU on Jetson Orin Nano Super.
"""

import importlib
import json
import os
import queue
import signal
import socket
import sys
import threading
import time
import traceback
import types

ENGINE_PATH        = os.environ.get('TRT_ENGINE_PATH', '/home/zodiac/coral-models/trt-mobilenet-v2-gpu.engine')
TELEMETRY_FILE     = 'trt-telemetry.json'
REPORT_INTERVAL_NS = 1_000_000_000   # 1 second in nanoseconds (integer)
WARMUP_N           = 10              # more warmup than Coral to fully initialise TRT CUDA context

# Rate-anomaly quarantine (Council Invariant 2: integer arithmetic throughout)
QUARANTINE_THRESHOLD_PPS = int(os.environ.get('QUARANTINE_PPS_THRESHOLD', '10'))
RATE_WINDOW_NS           = 5_000_000_000  # 5-second sliding window per source MAC
BRIDGE_QUARANTINE_URL    = os.environ.get('BRIDGE_URL', 'http://localhost:3003') + '/api/sdn/quarantine'


def atomic_write_telemetry(filename: str, data: dict) -> None:
    candidate_dirs = ['/run/zodiac', '/tmp']
    last_err = None
    for d in candidate_dirs:
        tmp    = os.path.join(d, filename + '.tmp')
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
        sys.stderr.write(f'[trt-daemon] Failed writing telemetry {filename}: {last_err}\n')


def write_offline(reason: str) -> None:
    atomic_write_telemetry(TELEMETRY_FILE, {
        'detected': False,
        'status': 'OFFLINE',
        'source': 'jetson_trt_gpu',
        'error': reason,
        'inferencesPerSecond': 0,
        'totalInferences': 0,
        'latencyP50Ns': 0,
        'latencyP99Ns': 0,
        'timestampNs': time.monotonic_ns(),
    })


def write_standby(total_inf: int) -> None:
    atomic_write_telemetry(TELEMETRY_FILE, {
        'detected': True,
        'status': 'STANDBY',
        'source': 'jetson_trt_gpu',
        'model': 'MobileNet V2 224x224 INT8 (TensorRT Ampere GPU) — Wire Tap DPI',
        'inferencesPerSecond': 0,
        'totalInferences': total_inf,
        'latencyP50Ns': 0,
        'latencyP99Ns': 0,
        'windowSampleCount': 0,
        'timestampNs': time.monotonic_ns(),
    })


def percentile_ns(sorted_lats: list, p_num: int, p_den: int) -> int:
    """Pure-integer percentile (INV-2: no floating-point arithmetic)."""
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
    except OSError as e:
        sys.stderr.write(f'[trt-daemon] Notice: /sys/class/net scan failed: {e}\n')
    return 'enx9c69d39dd0a6'


def load_trt_engine(engine_path: str):
    """Loads a serialized TensorRT engine. Returns (runtime, engine) or raises RuntimeError."""
    try:
        trt: types.ModuleType = importlib.import_module('tensorrt')  # JetPack-only; no published stubs
    except ImportError as e:
        raise RuntimeError(
            f'tensorrt not importable — ensure JetPack is installed: {e}'
        ) from e

    logger  = trt.Logger(trt.Logger.WARNING)
    runtime = trt.Runtime(logger)
    try:
        with open(engine_path, 'rb') as f:
            engine_bytes = f.read()
    except OSError as e:
        raise RuntimeError(
            f'Cannot read TRT engine at {engine_path}: {e}\n'
            f'Build it first on the Jetson:\n'
            f'  python3 /home/zodiac/scripts/build-trt-engine.py'
        ) from e

    engine = runtime.deserialize_cuda_engine(engine_bytes)
    if engine is None:
        raise RuntimeError(f'TensorRT failed to deserialize engine from {engine_path}')
    return runtime, engine


def allocate_cuda_buffers(engine, cuda, np):
    """Allocates host and device memory for all engine bindings.

    pycuda.autoinit must already be imported before this is called so that the
    primary CUDA context exists and TRT can share it (no second context created).
    """
    trt_ctx = engine.create_execution_context()
    if trt_ctx is None:
        raise RuntimeError('engine.create_execution_context() returned None')

    host_bufs   = []
    device_bufs = []
    n_tensors = engine.num_io_tensors if hasattr(engine, 'num_io_tensors') else engine.num_bindings
    for i in range(n_tensors):
        if hasattr(engine, 'get_tensor_name'):
            name  = engine.get_tensor_name(i)
            shape = tuple(engine.get_tensor_shape(name))
            dtype = engine.get_tensor_dtype(name)
        else:
            shape = tuple(engine.get_binding_shape(i))
            dtype = engine.get_binding_dtype(i)
        if dtype.name == 'INT8':
            np_dtype = np.int8
        elif dtype.name == 'HALF':
            np_dtype = np.float16
        else:
            np_dtype = np.float32
        h_buf = np.zeros(shape, dtype=np_dtype)
        d_buf = cuda.mem_alloc(h_buf.nbytes)
        host_bufs.append(h_buf)
        device_bufs.append(d_buf)

    tensor_names = []
    for i in range(n_tensors):
        if hasattr(engine, 'get_tensor_name'):
            tensor_names.append(engine.get_tensor_name(i))
        else:
            tensor_names.append(str(i))

    bindings = [int(d) for d in device_bufs]
    stream   = cuda.Stream()
    return trt_ctx, host_bufs, device_bufs, bindings, stream, tensor_names


def parse_src_ip(frame: bytes) -> str | None:
    """Extract IPv4 source address from an Ethernet frame.

    IP-based tracking avoids a critical false-positive: all gateway-routed packets
    share the router MAC as source, so MAC tracking would quarantine the default
    gateway immediately. Internet traffic arrives from thousands of unique IPs so
    no external IP accumulates to threshold. A local flood (e.g. RPi eth0 at
    10.0.1.50) presents one IP consistently and triggers quarantine correctly.
    """
    if len(frame) < 34:
        return None
    etype = (frame[12] << 8) | frame[13]
    if etype != 0x0800:  # IPv4 only
        return None
    src = frame[26:30]
    if src[0] in (0, 127, 255) or src[0] >= 224:  # skip loopback, unspecified, multicast, broadcast
        return None
    return f'{src[0]}.{src[1]}.{src[2]}.{src[3]}'


_RATE_WINDOW_CAP = 1024  # max unique source IPs tracked before evicting oldest

# Single bounded worker queue for all outbound quarantine POSTs — prevents
# thread explosion under distributed IP-spoofing floods (Dean Invariant).
_quarantine_queue: queue.Queue[tuple[str, int] | None] = queue.Queue(maxsize=256)
_quarantine_drops: int = 0  # monotonic drop counter; logged at report interval, never in hot path


def _quarantine_worker() -> None:
    """Background daemon thread: drains _quarantine_queue and POSTs to bridge."""
    import urllib.request
    while True:
        item = _quarantine_queue.get()
        if item is None:
            break
        src_ip, pps = item
        body = json.dumps({
            'targetIp': src_ip,
            'reason': f'Wire-tap rate anomaly: {pps} pps from {src_ip} exceeds threshold {QUARANTINE_THRESHOLD_PPS} pps',
            'priority': 200,
        }).encode()
        req = urllib.request.Request(
            BRIDGE_QUARANTINE_URL,
            data=body,
            headers={'Content-Type': 'application/json'},
            method='POST',
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                result = json.loads(resp.read())
                print(
                    f'[trt-daemon] [QUARANTINE] {src_ip} @ {pps} pps -> '
                    f'ruleId={result.get("ruleId","?")} openFlowInstalled={result.get("openFlowInstalled")}',
                    flush=True,
                )
        except Exception as exc:
            sys.stderr.write(f'[trt-daemon] Quarantine POST error for {src_ip}: {exc}\n')
        finally:
            _quarantine_queue.task_done()


threading.Thread(target=_quarantine_worker, daemon=True, name='quarantine-worker').start()


def try_quarantine(src_ip: str, pps: int, quarantined: set[str]) -> None:
    """Enqueue an IP for quarantine; fire-and-forget via the single worker thread.

    quarantined.add() runs only on successful enqueue — if the queue is full the
    IP is NOT suppressed so the next packet still triggers the alert path and
    retries until the worker drains the backlog (fail-closed, no silent gaps).
    No I/O is performed here; the drop counter is reported at the telemetry interval.
    """
    global _quarantine_drops
    try:
        _quarantine_queue.put_nowait((src_ip, pps))
        # Evict an arbitrary entry when the set is full so it stays bounded.
        if len(quarantined) >= _RATE_WINDOW_CAP:
            quarantined.discard(next(iter(quarantined)))
        quarantined.add(src_ip)
    except queue.Full:
        _quarantine_drops += 1  # counted; flushed to telemetry report, not stderr


def main() -> None:
    print('[trt-daemon] Starting TensorRT GPU inference daemon.', flush=True)

    if not os.path.exists(ENGINE_PATH):
        msg = (
            f'TRT engine not found at {ENGINE_PATH}.\n'
            f'Build it first on the Jetson:\n'
            f'  python3 /home/zodiac/scripts/build-trt-engine.py'
        )
        sys.stderr.write(f'[trt-daemon] ERROR: {msg}\n')
        write_offline(f'Engine missing: {ENGINE_PATH}')
        sys.exit(1)

    # Import pycuda BEFORE TRT engine load so pycuda owns the primary CUDA context
    # and TRT reuses it — avoids two-context SEGV on process exit.
    try:
        importlib.import_module('pycuda.autoinit')  # creates primary CUDA context
        cuda: types.ModuleType = importlib.import_module('pycuda.driver')  # JetPack-only; no published stubs
        import numpy as np
    except ImportError as e:
        sys.stderr.write(f'[trt-daemon] ERROR: pycuda not importable: {e}\n')
        write_offline(f'pycuda missing: {e}')
        sys.exit(1)

    try:
        _runtime, engine = load_trt_engine(ENGINE_PATH)
    except RuntimeError as exc:
        sys.stderr.write(f'[trt-daemon] ERROR loading engine: {exc}\n')
        write_offline(str(exc)[:200])
        sys.exit(1)

    try:
        context, host_bufs, device_bufs, bindings, stream, tensor_names = allocate_cuda_buffers(engine, cuda, np)
    except RuntimeError as exc:
        sys.stderr.write(f'[trt-daemon] ERROR allocating CUDA buffers: {exc}\n')
        write_offline(str(exc)[:200])
        sys.exit(1)

    inp_host = host_bufs[0]
    inp_flat  = inp_host.reshape(-1)
    inp_size  = inp_flat.size
    inp_dev   = device_bufs[0]

    n_io = engine.num_io_tensors if hasattr(engine, 'num_io_tensors') else engine.num_bindings
    print(
        f'[trt-daemon] Engine loaded. Input: shape={inp_host.shape} dtype={inp_host.dtype} '
        f'size={inp_size}B | TRT io_tensors={n_io}',
        flush=True,
    )

    _use_v3 = hasattr(context, 'execute_async_v3') and hasattr(context, 'set_tensor_address')

    def _run_inference():
        if _use_v3:
            for name, d_buf in zip(tensor_names, device_bufs):
                context.set_tensor_address(name, int(d_buf))
            context.execute_async_v3(stream.handle)
        else:
            context.execute_async_v2(bindings=bindings, stream_handle=stream.handle)

    print(f'[trt-daemon] Warming up Ampere GPU ({WARMUP_N} inferences)...', flush=True)
    for _ in range(WARMUP_N):
        try:
            cuda.memcpy_htod_async(inp_dev, inp_host, stream)
            _run_inference()
            stream.synchronize()
        except Exception as exc:
            sys.stderr.write(f'[trt-daemon] Warmup inference error: {exc}\n')
            write_offline(f'Warmup failed: {exc!s:.200}')
            sys.exit(1)
    print('[trt-daemon] Warmup complete.', flush=True)

    tap_iface = find_tap_interface()
    raw_sock  = None
    try:
        raw_sock = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.ntohs(0x0003))
        raw_sock.bind((tap_iface, 0))
        raw_sock.settimeout(0.2)
        print(f'[trt-daemon] AF_PACKET socket bound on {tap_iface}', flush=True)
    except OSError as e:
        sys.stderr.write(
            f'[trt-daemon] Warning: cannot bind AF_PACKET on {tap_iface} ({e}). '
            f'Running in standby mode.\n'
        )

    total_inferences = 0
    window_latencies: list = []
    window_start_ns  = time.monotonic_ns()
    last_report_ns   = window_start_ns

    # Per-source-IP rate tracking (INV-2: integer arithmetic, monotonic ns).
    # Bounded to _RATE_WINDOW_CAP entries; oldest IP evicted when full to prevent
    # OOM under random-IP spoofing attacks.
    mac_window_start: dict[str, int] = {}   # keyed by src IP string
    mac_window_count: dict[str, int] = {}
    quarantined_macs: set[str] = set()      # IPs already quarantined (suppress repeats)
    idle_cycles = 0                         # recv() timeout counter for observability

    write_standby(total_inferences)

    def handle_shutdown(sig, frame):
        print(f'[trt-daemon] Received signal {sig}, shutting down.', flush=True)
        write_standby(total_inferences)
        if raw_sock:
            try:
                raw_sock.close()
            except OSError as e:
                sys.stderr.write(f'[trt-daemon] Notice: error closing raw socket: {e}\n')
        # Free device memory and delete TRT objects before pycuda.autoinit's atexit
        # pops the CUDA context — prevents SEGV from TRT C++ dtors running after
        # the context is gone.
        for d in device_bufs:
            try:
                d.free()
            except Exception as free_err:
                sys.stderr.write(f'[trt-daemon] Notice: CUDA free error: {free_err}\n')
        sys.exit(0)

    signal.signal(signal.SIGINT,  handle_shutdown)
    signal.signal(signal.SIGTERM, handle_shutdown)

    print('[trt-daemon] Entering wire-packet TRT GPU inference loop.', flush=True)

    while True:
        try:
            if raw_sock is not None:
                try:
                    frame = raw_sock.recv(65535)
                    if frame:
                        src_ip = parse_src_ip(frame)
                        t_recv = time.monotonic_ns()  # timestamp at drain time, not post-inference

                        # Align frame bytes to float32 boundary before view() to avoid dtype-divisor error
                        # on small/odd-length frames (e.g. 15-byte ARP keepalives).
                        elm_size = inp_host.dtype.itemsize  # 4 for float32
                        n_raw = min(len(frame), inp_size * elm_size)
                        n_aligned = (n_raw // elm_size) * elm_size
                        if n_aligned > 0:
                            inp_flat[:n_aligned // elm_size] = np.frombuffer(frame[:n_aligned], dtype=np.uint8).view(inp_host.dtype)
                        inp_flat[n_aligned // elm_size:] = 0

                        t0 = time.monotonic_ns()
                        cuda.memcpy_htod_async(inp_dev, inp_host, stream)
                        _run_inference()
                        stream.synchronize()
                        t1 = time.monotonic_ns()

                        window_latencies.append(t1 - t0)
                        total_inferences += 1

                        # Rate-anomaly: sliding window on IPv4 src IP (not MAC — see parse_src_ip docstring).
                        # Drain timestamp used so inference latency (~1ms) doesn't distort the window.
                        if src_ip and src_ip not in quarantined_macs:
                            # Evict oldest entry when the tracking table is full (bounded memory).
                            if len(mac_window_start) >= _RATE_WINDOW_CAP and src_ip not in mac_window_start:
                                oldest = next(iter(mac_window_start))
                                mac_window_start.pop(oldest, None)
                                mac_window_count.pop(oldest, None)
                            ws = mac_window_start.get(src_ip)
                            if ws is None or t_recv - ws >= RATE_WINDOW_NS:
                                mac_window_start[src_ip] = t_recv
                                mac_window_count[src_ip] = 1
                            else:
                                mac_window_count[src_ip] = mac_window_count.get(src_ip, 0) + 1
                                elapsed = t_recv - ws
                                if elapsed >= 500_000_000:  # require >=0.5 s of data before acting
                                    pps = (mac_window_count[src_ip] * 1_000_000_000) // elapsed
                                    if pps > QUARANTINE_THRESHOLD_PPS:
                                        print(
                                            f'[trt-daemon] [ALERT] {src_ip}: {pps} pps exceeds '
                                            f'threshold {QUARANTINE_THRESHOLD_PPS} pps -- quarantining',
                                            flush=True,
                                        )
                                        try_quarantine(src_ip, pps, quarantined_macs)
                except socket.timeout:
                    idle_cycles += 1
                except Exception as exc:
                    sys.stderr.write(f'[trt-daemon] Frame/inference warning: {exc}\n')
            else:
                time.sleep(0.2)

            now_ns = time.monotonic_ns()
            if now_ns - last_report_ns >= REPORT_INTERVAL_NS:
                elapsed_ns  = now_ns - window_start_ns
                sorted_lats = sorted(window_latencies)
                n           = len(sorted_lats)

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

                if _quarantine_drops > 0:
                    sys.stderr.write(f'[trt-daemon] Quarantine queue saturation: {_quarantine_drops} total drops\n')

                atomic_write_telemetry(TELEMETRY_FILE, {
                    'detected':               True,
                    'status':                 status,
                    'source':                 'jetson_trt_gpu',
                    'model':                  'MobileNet V2 224x224 INT8 (TensorRT Ampere GPU) — Wire Tap DPI',
                    'inferencesPerSecond':    inf_sec,
                    'totalInferences':        total_inferences,
                    'latencyP50Ns':           p50_ns,
                    'latencyP99Ns':           p99_ns,
                    'windowSampleCount':      n,
                    'quarantineQueueDrops':   _quarantine_drops,
                    'timestampNs':            now_ns,
                })

                window_latencies = []
                window_start_ns  = now_ns
                last_report_ns   = now_ns

        except Exception:
            err = traceback.format_exc()
            sys.stderr.write(f'[trt-daemon] ERROR in inference loop:\n{err}')
            write_offline(f'Inference loop error: {err[:200]}')
            time.sleep(2)


if __name__ == '__main__':
    main()
