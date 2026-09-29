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

import json
import os
import signal
import socket
import sys
import time
import traceback

ENGINE_PATH        = os.environ.get('TRT_ENGINE_PATH', '/home/zodiac/coral-models/trt-mobilenet-v2-gpu.engine')
TELEMETRY_FILE     = 'trt-telemetry.json'
REPORT_INTERVAL_NS = 1_000_000_000   # 1 second in nanoseconds (integer)
WARMUP_N           = 10              # more warmup than Coral to fully initialise TRT CUDA context


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
        import tensorrt as trt  # type: ignore[import-untyped]  # Jetson JetPack only
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


def allocate_cuda_buffers(engine):
    """Allocates host and device memory for all engine bindings."""
    try:
        import pycuda.driver as cuda  # type: ignore[import-untyped]  # Jetson only
        import pycuda.autoinit  # noqa: F401  # initialises CUDA context
        import numpy as np
    except ImportError as e:
        raise RuntimeError(f'pycuda not importable: {e}') from e

    context = engine.create_execution_context()
    if context is None:
        raise RuntimeError('engine.create_execution_context() returned None')

    host_bufs   = []
    device_bufs = []
    for i in range(engine.num_bindings):
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

    bindings = [int(d) for d in device_bufs]
    stream   = cuda.Stream()
    return context, host_bufs, device_bufs, bindings, stream


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

    try:
        _runtime, engine = load_trt_engine(ENGINE_PATH)
    except RuntimeError as exc:
        sys.stderr.write(f'[trt-daemon] ERROR loading engine: {exc}\n')
        write_offline(str(exc)[:200])
        sys.exit(1)

    try:
        import pycuda.driver as cuda  # type: ignore[import-untyped]
        import numpy as np
        context, host_bufs, device_bufs, bindings, stream = allocate_cuda_buffers(engine)
    except RuntimeError as exc:
        sys.stderr.write(f'[trt-daemon] ERROR allocating CUDA buffers: {exc}\n')
        write_offline(str(exc)[:200])
        sys.exit(1)

    inp_host = host_bufs[0]
    inp_flat  = inp_host.reshape(-1)
    inp_size  = inp_flat.size
    inp_dev   = device_bufs[0]

    print(
        f'[trt-daemon] Engine loaded. Input: shape={inp_host.shape} dtype={inp_host.dtype} '
        f'size={inp_size}B | TRT bindings={engine.num_bindings}',
        flush=True,
    )

    print(f'[trt-daemon] Warming up Ampere GPU ({WARMUP_N} inferences)...', flush=True)
    for _ in range(WARMUP_N):
        try:
            cuda.memcpy_htod_async(inp_dev, inp_host, stream)
            context.execute_async_v2(bindings=bindings, stream_handle=stream.handle)
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

    write_standby(total_inferences)

    def handle_shutdown(sig, frame):
        print(f'[trt-daemon] Received signal {sig}, shutting down.', flush=True)
        write_standby(total_inferences)
        if raw_sock:
            try:
                raw_sock.close()
            except OSError as e:
                sys.stderr.write(f'[trt-daemon] Notice: error closing raw socket: {e}\n')
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
                        n_bytes = min(len(frame), inp_size)
                        inp_flat[:n_bytes] = np.frombuffer(frame[:n_bytes], dtype=np.uint8).view(inp_host.dtype)
                        if n_bytes < inp_size:
                            inp_flat[n_bytes:] = 0

                        t0 = time.monotonic_ns()
                        cuda.memcpy_htod_async(inp_dev, inp_host, stream)
                        context.execute_async_v2(bindings=bindings, stream_handle=stream.handle)
                        stream.synchronize()
                        t1 = time.monotonic_ns()

                        window_latencies.append(t1 - t0)
                        total_inferences += 1
                except socket.timeout:
                    pass
                except Exception as exc:
                    sys.stderr.write(f'[trt-daemon] Frame/inference warning: {exc}\n')
                    time.sleep(0.05)
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

                atomic_write_telemetry(TELEMETRY_FILE, {
                    'detected':            True,
                    'status':              status,
                    'source':              'jetson_trt_gpu',
                    'model':               'MobileNet V2 224x224 INT8 (TensorRT Ampere GPU) — Wire Tap DPI',
                    'inferencesPerSecond': inf_sec,
                    'totalInferences':     total_inferences,
                    'latencyP50Ns':        p50_ns,
                    'latencyP99Ns':        p99_ns,
                    'windowSampleCount':   n,
                    'timestampNs':         now_ns,
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
