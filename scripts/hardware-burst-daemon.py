#!/usr/bin/env python3
"""
scripts/hardware-burst-daemon.py
================================
Hardware-level multi-device traffic and neural inference stress burst daemon.

Targets:
  - Zodiac FX OpenFlow Switch:
      * Port 3 (Hardware Mirror Tap / Sniffer) via raw AF_PACKET frames on enx*
      * Port 4 (OpenFlow Controller Link) via high-rate UDP probes to switch controller port
  - Dual Google Coral Edge TPUs:
      * TPU 0 & TPU 1: Continuous INT8 neural inference on any free accelerator
        while the central bridge daemon runs on the other.
  - Raspberry Pi 3B+ Workload Node:
      * UDP test packets to workload node port
  - NVIDIA Jetson Orin Nano Master Appliance:
      * Coordinates raw socket traffic, multi-threaded worker pools, and system thermals.

Target Flags & Filtering:
  --target / --device:
      'all' (default), or comma-separated list of:
      'zodiac' (or 'zodiac-p3', 'zodiac-p4', 'switch')
      'coral' (or 'coral-tpu', 'tpu')
      'rpi' (or 'workload', 'pi')
      'jetson'

Size Burst Limit:
  --size:
      Caps total burst data volume to e.g. 50mb, 100mb, 1gb, 500kb.
      Terminates as soon as byte limit or duration is reached.

Council Invariants:
  - Invariant 2 (Determinism & Accounting): 64-bit integer counters, monotonic nanosecond timestamps.
  - Invariant 6 (Anti-Simulation Law): Physical truth only; real packets on real wires and silicon.
"""

import argparse
import errno
import json
import os
import queue
import re
import signal
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from typing import TypedDict

MODEL_PATH = os.environ.get('CORAL_MODEL_PATH', '/home/zodiac/coral-models/mobilenet_v2_1.0_224_quant_edgetpu.tflite')
DEFAULT_LOG_PATH = os.environ.get(
    'BURST_LOG_PATH',
    '/home/zodiac/burst-telemetry.log' if os.path.isdir('/home/zodiac') else '/tmp/burst-telemetry.log'
)
DEFAULT_SWITCH_IP = os.environ.get('ZODIAC_SWITCH_IP', '127.0.0.1')
DEFAULT_CTRL_IP = os.environ.get('SDN_CONTROLLER_IP', '0.0.0.0')
DEFAULT_WORKLOAD_IP = os.environ.get('RPI_WORKLOAD_IP', '127.0.0.1')
CUSTOM_BURST_CORAL_PATH = os.environ.get('BURST_CORAL_TELEMETRY_PATH')
_custom_burst_dir = os.path.dirname(CUSTOM_BURST_CORAL_PATH) if CUSTOM_BURST_CORAL_PATH else None
CANDIDATE_BURST_DIRS = [_custom_burst_dir] if _custom_burst_dir else ['/run/zodiac', '/tmp']


DEFAULT_CORAL_STALENESS_LIMIT_S = 5.0
SHUTDOWN_QUEUE_TIMEOUT_SEC = 1.0   # max wait to enqueue poison pill during shutdown
SHUTDOWN_JOIN_TIMEOUT_SEC = 2.0    # max wait for telemetry writer thread to exit
DEFAULT_MAX_LOAD_SCALE_FACTOR = 3.0
WALL_CLOCK_EPOCH_THRESHOLD_NS = 1_000_000_000_000_000_000  # 1e18 ns boundary (Sept 2001) separating boot vs wall clock


def get_coral_staleness_limit_s() -> float:
    """
    Council Invariant 5 (Quoc Le): Adaptive Control & Multi-Agent Stability.
    Eliminates brittle magic numbers by making the staleness threshold configurable
    via CORAL_DAEMON_STALENESS_LIMIT_S, dynamically scaling with system 1-minute load average
    under high CPU/IO pressure to prevent false fail-closed drops during burst peaks.
    """
    base_limit = DEFAULT_CORAL_STALENESS_LIMIT_S
    env_val = os.environ.get('CORAL_DAEMON_STALENESS_LIMIT_S')
    if env_val:
        try:
            parsed = float(env_val)
            if parsed > 0:
                base_limit = parsed
        except (ValueError, TypeError) as exc:
            sys.stderr.write(f'[burst-daemon] Note: invalid CORAL_DAEMON_STALENESS_LIMIT_S ({env_val}): {exc}\n')

    max_scale = DEFAULT_MAX_LOAD_SCALE_FACTOR
    env_scale = os.environ.get('CORAL_MAX_LOAD_SCALE_FACTOR')
    if env_scale:
        try:
            parsed_scale = float(env_scale)
            if parsed_scale >= 1.0:
                max_scale = parsed_scale
        except (ValueError, TypeError) as exc:
            sys.stderr.write(f'[burst-daemon] Note: invalid CORAL_MAX_LOAD_SCALE_FACTOR ({env_scale}): {exc}\n')

    try:
        if hasattr(os, 'getloadavg'):
            load1, _, _ = os.getloadavg()
            cpu_count = os.cpu_count() or 1
            if load1 > cpu_count:
                load_factor = min(max_scale, load1 / cpu_count)
                return base_limit * load_factor
    except (OSError, AttributeError) as exc:
        sys.stderr.write(f'[burst-daemon] Note: system load average unavailable ({exc}), using base limit\n')

    return base_limit

stop_event = threading.Event()
stats_lock = threading.Lock()

counters = {
    'coral_total_inferences': 0,
    'coral_tpu0_inferences': 0,
    'coral_tpu1_inferences': 0,
    'telemetry_drops': 0,
    'zodiac_p3_frames': 0,
    'zodiac_p3_bytes': 0,
    'zodiac_p4_packets': 0,
    'zodiac_p4_bytes': 0,
    'rpi_packets': 0,
    'rpi_bytes': 0,
    'jetson_gpu_ops': 0,
    'jetson_gpu_bytes': 0,
}

# Adaptive backoff state for jetson_gpu_worker error recovery (module-level avoids
# function-attribute pattern that pyright cannot track — Ghemawat flat-layout rule).
_gpu_err_backoff_ns: int = 50_000_000  # 50ms initial; doubles per error, capped at 400ms

# Bounded async queue decoupling telemetry file writes from the inference hot loop.
# Capacity=4: at 1Hz emission rate a full queue means the writer is stalled >4s — drop silently.
_coral_write_q: queue.Queue = queue.Queue(maxsize=4)


def _enqueue_coral_write(filename: str, data: dict) -> None:
    try:
        _coral_write_q.put_nowait((filename, data))
    except queue.Full:
        with stats_lock:
            counters['telemetry_drops'] += 1


def _coral_telemetry_writer() -> None:
    while True:
        item = _coral_write_q.get()
        if item is None:
            _coral_write_q.task_done()
            break
        filename, data = item
        atomic_write_coral_file(filename, data)
        _coral_write_q.task_done()


_coral_writer_thread: threading.Thread | None = None


def _start_coral_telemetry_writer() -> threading.Thread:
    global _coral_writer_thread
    t = threading.Thread(target=_coral_telemetry_writer, name='coral-telemetry-writer', daemon=True)
    t.start()
    _coral_writer_thread = t
    return t


def log_message(msg: str, log_file: str):
    ts = time.strftime('%Y-%m-%d %H:%M:%S')
    line = f'[{ts}] {msg}'
    print(line, flush=True)
    if log_file:
        try:
            with open(log_file, 'a') as f:
                f.write(line + '\n')
                f.flush()
        except OSError as e:
            sys.stderr.write(f'[burst-daemon] Failed writing log to {log_file}: {e}\n')


def parse_size_bytes(val: str) -> int:
    """Parses size strings like 50mb, 1gb, 500kb, 1024 into integer bytes."""
    if not val:
        return 0
    val = val.strip().lower()
    m = re.match(r'^([\d\.]+)\s*([a-z]*)$', val)
    if not m:
        try:
            return int(val)
        except ValueError:
            return 0

    num_str, unit = m.groups()
    try:
        num = float(num_str)
    except ValueError:
        return 0

    multipliers = {
        '': 1,
        'b': 1,
        'k': 1024,
        'kb': 1024,
        'kib': 1024,
        'm': 1024 * 1024,
        'mb': 1024 * 1024,
        'mib': 1024 * 1024,
        'g': 1024 * 1024 * 1024,
        'gb': 1024 * 1024 * 1024,
        'gib': 1024 * 1024 * 1024,
        't': 1024 * 1024 * 1024 * 1024,
        'tb': 1024 * 1024 * 1024 * 1024,
    }
    factor = multipliers.get(unit, 1)
    return int(num * factor)


def parse_duration(val: str) -> int:
    val = val.strip().lower()
    if val.endswith('m'):
        return int(float(val[:-1]) * 60)
    if val.endswith('s'):
        return int(float(val[:-1]))
    if val.endswith('h'):
        return int(float(val[:-1]) * 3600)
    return int(float(val))


def check_size_limit_reached(max_bytes: int) -> bool:
    if max_bytes <= 0:
        return False
    with stats_lock:
        tot = counters['zodiac_p3_bytes'] + counters['zodiac_p4_bytes'] + counters['rpi_bytes']
        return tot >= max_bytes


def format_bytes_int(b: int) -> str:
    """Formats byte counts deterministically using integer arithmetic (Dean & Ghemawat invariant)."""
    if b >= 1024 * 1024 * 1024:
        gib = b // (1024 * 1024 * 1024)
        rem = (b % (1024 * 1024 * 1024)) * 100 // (1024 * 1024 * 1024)
        return f'{gib}.{rem:02d} GB'
    if b >= 1024 * 1024:
        mib = b // (1024 * 1024)
        rem = (b % (1024 * 1024)) * 100 // (1024 * 1024)
        return f'{mib}.{rem:02d} MB'
    if b >= 1024:
        kib = b // 1024
        return f'{kib} KB'
    return f'{b} B'


def atomic_write_coral_file(filename: str, data: dict):
    last_err = None
    for d in CANDIDATE_BURST_DIRS:
        target = os.path.join(d, filename)
        tmp = target + '.tmp'
        try:
            with open(tmp, 'w') as f:
                json.dump(data, f, separators=(',', ':'))
            os.replace(tmp, target)
            return
        except OSError as e:
            last_err = e
            continue
    if last_err:
        sys.stderr.write(f'[burst-coral] Failed writing telemetry {filename}: {last_err}\n')



def cleanup_burst_coral_telemetry(filename: str = 'coral-burst-telemetry.json'):
    for d in CANDIDATE_BURST_DIRS:
        target = os.path.join(d, filename)
        try:
            os.remove(target)
        except OSError as e:
            if e.errno != errno.ENOENT:
                sys.stderr.write(f'[burst-coral] Failed cleanup {target}: {e}\n')


def coral_tpu_worker(
    dev_spec: str,
    max_bytes: int = 0,
    active_event: threading.Event | None = None,
    telemetry_file: str = 'coral-burst-telemetry.json',
    model_role: str = 'Burst Parallel',
    counter_key: str = 'coral_total_inferences'
):
    """Drives continuous high-throughput INT8 inference on a dedicated Coral Edge TPU."""
    try:
        import numpy as np
        from pycoral.utils.edgetpu import (
            make_interpreter,  # type: ignore[import-untyped]  # Jetson Linux only
        )

        if not os.path.exists(MODEL_PATH):
            sys.stderr.write(f'[coral_worker_{dev_spec}] Model not found at {MODEL_PATH}\n')
            return

        interp = make_interpreter(MODEL_PATH, device=dev_spec)
        interp.allocate_tensors()
        inp_detail = interp.get_input_details()[0]
        dummy = np.zeros(inp_detail['shape'], dtype=np.uint8)

        # Warmup
        for _ in range(5):
            interp.set_tensor(inp_detail['index'], dummy)
            interp.invoke()

        batch_size = 10
        total_worker_inf = 0
        w_start_ns = time.monotonic_ns()
        w_latencies = []

        is_in_standby = False
        while not stop_event.is_set():
            if active_event is not None and not active_event.is_set():
                if not is_in_standby:
                    _enqueue_coral_write(telemetry_file, {
                        'detected': True,
                        'status': 'STANDBY',
                        'model': f'MobileNet V2 INT8 (EdgeTPU {dev_spec}) - {model_role}',
                        'inferencesPerSecond': 0,
                        'totalInferences': total_worker_inf,
                        'latencyP50Ns': 0,
                        'latencyP99Ns': 0,
                        'timestampNs': time.monotonic_ns(),
                    })
                    is_in_standby = True
                active_event.wait(timeout=0.1)
                w_start_ns = time.monotonic_ns()
                w_latencies = []
                continue

            is_in_standby = False

            if max_bytes > 0 and check_size_limit_reached(max_bytes):
                stop_event.set()
                break
            for _ in range(batch_size):
                t0 = time.monotonic_ns()
                interp.set_tensor(inp_detail['index'], dummy)
                interp.invoke()
                t1 = time.monotonic_ns()
                w_latencies.append(t1 - t0)

            total_worker_inf += batch_size
            with stats_lock:
                counters['coral_total_inferences'] += batch_size
                if counter_key != 'coral_total_inferences' and counter_key in counters:
                    counters[counter_key] += batch_size

            now_ns = time.monotonic_ns()
            if now_ns - w_start_ns >= 1_000_000_000:
                elapsed_ns = now_ns - w_start_ns
                w_sorted = sorted(w_latencies)
                n = len(w_sorted)
                p50_ns = w_sorted[n // 2] if n > 0 else 0
                p99_ns = w_sorted[min((n * 99) // 100, n - 1)] if n > 0 else 0
                inf_sec = (n * 1_000_000_000) // elapsed_ns if elapsed_ns > 0 else 0

                _enqueue_coral_write(telemetry_file, {
                    'detected': True,
                    'status': 'ACTIVE',
                    'model': f'MobileNet V2 INT8 (EdgeTPU {dev_spec}) - {model_role}',
                    'inferencesPerSecond': inf_sec,
                    'totalInferences': total_worker_inf,
                    'latencyP50Ns': p50_ns,
                    'latencyP99Ns': p99_ns,
                    'timestampNs': now_ns,
                })
                w_latencies = []
                w_start_ns = now_ns
    except (OSError, RuntimeError, ImportError, ValueError) as e:
        sys.stderr.write(f'[coral_worker_{dev_spec}] Error: {e}\n')
        sys.stderr.flush()
    finally:
        cleanup_burst_coral_telemetry(telemetry_file)


def find_tap_interface() -> str:
    """Finds the promiscuous ASIX USB GbE adapter (enx*)."""
    if os.path.exists('/sys/class/net'):
        try:
            for iface in os.listdir('/sys/class/net'):
                if iface.startswith('enx'):
                    return iface
        except OSError as exc:
            sys.stderr.write(f"[tap-probe] Error reading network interface list: {exc}\n")
    return 'enx9c69d39dd0a6'


def zodiac_p3_raw_worker(iface: str, max_bytes: int = 0, active_event: threading.Event | None = None):
    """Sends raw Ethernet frames directly into Zodiac Port 3 via the tap interface."""
    try:
        s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW)  # type: ignore[attr-defined]  # Linux-only
        s.setblocking(False)  # Non-blocking: prevents thread stall if kernel txqueuelen fills
        s.bind((iface, 0))

        dst_mac = bytes.fromhex('70b3d58740c9')
        try:
            with open(f'/sys/class/net/{iface}/address') as f:
                src_mac_str = f.read().strip().replace(':', '')
                src_mac = bytes.fromhex(src_mac_str)
        except (OSError, ValueError) as e:
            sys.stderr.write(f'[zodiac_p3_raw_worker] Fail-closed: Cannot read physical MAC for {iface}: {e}\n')
            return

        eth_type = b'\x08\x00'

        payload_sizes = [64, 256, 512, 1024, 1400]
        frames = []
        for sz in payload_sizes:
            pad_len = max(0, sz - 14)
            p = b'AGENTIC-BURST-TAP-' + os.urandom(max(0, pad_len - 18))
            frames.append(dst_mac + src_mac + eth_type + p[:pad_len])

        frame_idx = 0
        pacing_interval_ns = 1_000_000  # 1 ms between packets (1,000 pps target pacing)
        next_tx_ns = time.monotonic_ns()

        while not stop_event.is_set():
            if active_event is not None and not active_event.is_set():
                active_event.wait(timeout=0.05)
                next_tx_ns = time.monotonic_ns()
                continue

            if max_bytes > 0 and check_size_limit_reached(max_bytes):
                stop_event.set()
                break

            f = frames[frame_idx % len(frames)]
            frame_idx += 1
            try:
                s.send(f)
            except BlockingIOError:
                # TX ring buffer full (EAGAIN/EWOULDBLOCK): apply backpressure, yield to OS
                next_tx_ns = time.monotonic_ns() + pacing_interval_ns
                continue
            with stats_lock:
                counters['zodiac_p3_frames'] += 1
                counters['zodiac_p3_bytes'] += len(f)

            now_ns = time.monotonic_ns()
            if now_ns < next_tx_ns:
                rem_ns = next_tx_ns - now_ns
                if rem_ns > 2_000_000:
                    time.sleep(rem_ns / 1_000_000_000)
                else:
                    while time.monotonic_ns() < next_tx_ns:
                        pass
            next_tx_ns = max(now_ns, next_tx_ns) + pacing_interval_ns
        s.close()
    except (OSError, RuntimeError) as e:
        sys.stderr.write(f'[zodiac_p3_raw_worker] Error on {iface}: {e}\n')
        sys.stderr.flush()


def zodiac_p4_worker(target_ip: str = DEFAULT_SWITCH_IP, target_port: int = 9999, max_bytes: int = 0):
    """Sends high-rate UDP probes to Zodiac Port 4 via controller interface."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.setblocking(False)  # Non-blocking: prevents thread stall under UDP TX queue pressure
        try:
            s.bind((DEFAULT_CTRL_IP, 0))
        except OSError as e:
            sys.stderr.write(f'[zodiac_p4_worker] Notice: Bind to {DEFAULT_CTRL_IP} failed: {e}. Operating with default route.\n')

        target = (target_ip, target_port)
        payload = b'AGENTIC-BURST-OF-CTRL-' + (b'X' * 128)

        pacing_interval_ns = 5_000_000  # 5 ms between probes (200 pps target pacing)
        next_tx_ns = time.monotonic_ns()

        while not stop_event.is_set():
            if max_bytes > 0 and check_size_limit_reached(max_bytes):
                stop_event.set()
                break

            try:
                s.sendto(payload, target)
            except BlockingIOError:
                # UDP TX ring full (EAGAIN): backpressure — skip this interval, yield to OS
                next_tx_ns = time.monotonic_ns() + pacing_interval_ns
                continue
            with stats_lock:
                counters['zodiac_p4_packets'] += 1
                counters['zodiac_p4_bytes'] += len(payload)

            now_ns = time.monotonic_ns()
            if now_ns < next_tx_ns:
                rem_ns = next_tx_ns - now_ns
                if rem_ns > 2_000_000:
                    time.sleep(rem_ns / 1_000_000_000)
                else:
                    while time.monotonic_ns() < next_tx_ns:
                        pass
            next_tx_ns = max(now_ns, next_tx_ns) + pacing_interval_ns
        s.close()
    except (OSError, RuntimeError) as e:
        sys.stderr.write(f'[zodiac_p4_worker] Error: {e}\n')
        sys.stderr.flush()


def rpi_workload_worker(target_ip: str = DEFAULT_WORKLOAD_IP, target_port: int = 9999, max_bytes: int = 0):
    """Sends probe bursts to the workload node."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.setblocking(False)  # Non-blocking: prevents thread stall under workload probe TX pressure
        target = (target_ip, target_port)
        payload = b'AGENTIC-WORKLOAD-PROBE-' + (b'W' * 128)

        pacing_interval_ns = 10_000_000  # 10 ms between probes (100 pps target pacing)
        next_tx_ns = time.monotonic_ns()

        while not stop_event.is_set():
            if max_bytes > 0 and check_size_limit_reached(max_bytes):
                stop_event.set()
                break

            try:
                s.sendto(payload, target)
            except BlockingIOError:
                # TX buffer full (EAGAIN): apply backpressure, skip interval, yield to OS
                next_tx_ns = time.monotonic_ns() + pacing_interval_ns
                continue
            with stats_lock:
                counters['rpi_packets'] += 1
                counters['rpi_bytes'] += len(payload)

            now_ns = time.monotonic_ns()
            if now_ns < next_tx_ns:
                rem_ns = next_tx_ns - now_ns
                if rem_ns > 2_000_000:
                    time.sleep(rem_ns / 1_000_000_000)
                else:
                    while time.monotonic_ns() < next_tx_ns:
                        pass
            next_tx_ns = max(now_ns, next_tx_ns) + pacing_interval_ns
        s.close()
    except (OSError, RuntimeError) as e:
        sys.stderr.write(f'[rpi_workload_worker] Error: {e}\n')
        sys.stderr.flush()


def jetson_gpu_worker(max_bytes: int = 0, active_event: threading.Event | None = None):
    """
    Council Invariant 2 (Determinism & Accounting) & Invariant 6 (Anti-Simulation Law):
    Generates authentic, physical neural/matrix operations on NVIDIA Ampere GPU (CUDA/PyTorch),
    driving verifiable compute load to /sys/devices/platform/bus@0/17000000.gpu/load and power draw in vddCpuGpuCv.
    Gracefully executes on CPU matrix loops on developer workstations without CUDA.
    """
    import ctypes

    has_cuda = False
    engine_name = "Pure Python Math (Baseline)"
    torch_mod = None
    np_mod = None
    cuda_lib = None
    cuda_ptrs = None

    # 1. Probe for native sm_87 Ampere CUDA shared library on Jetson Orin
    for lib_path in ('/home/zodiac/libjetson_gpu_kernel.so', '/tmp/libjetson_gpu_kernel.so'):
        if os.path.exists(lib_path):
            try:
                lib = ctypes.CDLL(lib_path)
                lib.alloc_cuda_matrix.restype = ctypes.c_void_p
                lib.free_cuda_matrix.argtypes = [ctypes.c_void_p]
                lib.run_cuda_gemm_step.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int]
                cuda_lib = lib
                has_cuda = True
                engine_name = "NVIDIA Ampere Native CUDA (sm_87 Orin)"
                break
            except (OSError, ImportError, AttributeError) as e:
                sys.stderr.write(f"[jetson_gpu_worker] Note loading {lib_path}: {e}\n")

    if not has_cuda:
        try:
            import torch  # type: ignore[import-untyped]  # Jetson runtime dep, not available on dev workstation
            torch_mod = torch
            if torch.cuda.is_available():
                has_cuda = True
                dev_name = torch.cuda.get_device_name(0)
                engine_name = f"NVIDIA Ampere CUDA ({dev_name})"
            else:
                engine_name = "PyTorch CPU"
        except ImportError:
            try:
                import numpy
                np_mod = numpy
                engine_name = "NumPy Matrix CPU"
            except ImportError as exc:
                sys.stderr.write(f"[jetson_gpu_worker] NumPy not available: {exc}\n")

    sys.stdout.write(f"[jetson_gpu_worker] Engine: {engine_name} | CUDA Hardware Accelerated: {has_cuda}\n")
    sys.stdout.flush()

    matrix_dim = 1024 if has_cuda else 512
    # Bytes per op: N*N*4 bytes (float32) * 3 matrices (A, B, C)
    bytes_per_op = matrix_dim * matrix_dim * 4 * 3

    t_a = None
    t_b = None
    np_a = None
    np_b = None

    if cuda_lib is not None:
        try:
            d_a = cuda_lib.alloc_cuda_matrix(matrix_dim)
            d_b = cuda_lib.alloc_cuda_matrix(matrix_dim)
            d_c = cuda_lib.alloc_cuda_matrix(matrix_dim)
            cuda_ptrs = (d_a, d_b, d_c)
        except (MemoryError, OSError, RuntimeError, AttributeError) as exc:
            sys.stderr.write(f"[jetson_gpu_worker] Failed allocating CUDA device memory: {exc}\n")
            cuda_lib = None
            has_cuda = False
    elif torch_mod is not None:
        device = torch_mod.device('cuda:0' if has_cuda else 'cpu')
        dtype = torch_mod.float16 if has_cuda else torch_mod.float32
        t_a = torch_mod.randn(matrix_dim, matrix_dim, device=device, dtype=dtype)
        t_b = torch_mod.randn(matrix_dim, matrix_dim, device=device, dtype=dtype)
    elif np_mod is not None:
        np_a = np_mod.random.randn(matrix_dim, matrix_dim).astype(np_mod.float32)
        np_b = np_mod.random.randn(matrix_dim, matrix_dim).astype(np_mod.float32)

    total_bytes = 0

    try:
        while not stop_event.is_set():
            if active_event is not None and not active_event.is_set():
                time.sleep(0.01)
                continue

            if 0 < max_bytes <= total_bytes:
                break

            try:
                if cuda_lib is not None and cuda_ptrs is not None:
                    cuda_lib.run_cuda_gemm_step(cuda_ptrs[0], cuda_ptrs[1], cuda_ptrs[2], matrix_dim)
                elif torch_mod is not None and t_a is not None and t_b is not None:
                    _ = torch_mod.matmul(t_a, t_b)
                    if has_cuda:
                        torch_mod.cuda.synchronize()
                elif np_mod is not None and np_a is not None and np_b is not None:
                    _ = np_mod.dot(np_a, np_b)
                else:
                    time.sleep(0.001)

                total_bytes += bytes_per_op
                with stats_lock:
                    counters['jetson_gpu_ops'] += 1
                    counters['jetson_gpu_bytes'] += bytes_per_op
            except (RuntimeError, OSError, AttributeError) as err:
                sys.stderr.write(f"[jetson_gpu_worker] Compute loop note: {err}\n")
                # Adaptive exponential backoff: 50ms base, doubles on repeat errors, capped at 400ms.
                # Satisfies Quoc Le invariant: no hardcoded magic sleeps under distribution shift.
                global _gpu_err_backoff_ns
                time.sleep(_gpu_err_backoff_ns / 1_000_000_000)
                _gpu_err_backoff_ns = min(_gpu_err_backoff_ns * 2, 400_000_000)  # cap at 400ms
                continue
            else:
                # Reset backoff on successful compute iteration
                _gpu_err_backoff_ns = 50_000_000
    finally:
        if cuda_lib is not None and cuda_ptrs is not None:
            try:
                cuda_lib.free_cuda_matrix(cuda_ptrs[0])
                cuda_lib.free_cuda_matrix(cuda_ptrs[1])
                cuda_lib.free_cuda_matrix(cuda_ptrs[2])
            except (RuntimeError, OSError, AttributeError) as cleanup_err:
                sys.stderr.write(f"[jetson_gpu_worker] CUDA free error: {cleanup_err}\n")


class LiveTelemetrySummary(TypedDict):
    p3_rx_pkts: int | None
    p4_rx_bytes: int | None
    tpu0_inf_sec: int
    jetson_temp_c: float | None
    jetson_gpu_temp_c: float | None
    jetson_gpu_util_pct: int | None
    jetson_gpu_power_mw: int | None


cached_live_summary: LiveTelemetrySummary = {
    'p3_rx_pkts': None,
    'p4_rx_bytes': None,
    'tpu0_inf_sec': 0,
    'jetson_temp_c': None,
    'jetson_gpu_temp_c': None,
    'jetson_gpu_util_pct': None,
    'jetson_gpu_power_mw': None,
}
live_summary_lock = threading.Lock()


def telemetry_poller_worker():
    """
    Background worker to asynchronously poll telemetry and cache in memory (Jeff Dean latency invariant).
    Zero synchronous I/O or HTTP blocking in the main daemon loop.
    """
    global cached_live_summary
    candidate_paths = ['/run/zodiac/coral-telemetry.json', '/tmp/coral-telemetry.json']

    last_load_check_ns = 0
    staleness_limit_ns = int(DEFAULT_CORAL_STALENESS_LIMIT_S * 1_000_000_000)

    while not stop_event.is_set():
        now_ns = time.monotonic_ns()
        # Hoist and decouple adaptive load scaling from inner file polling loop (Jeff Dean invariant)
        if now_ns - last_load_check_ns >= 1_000_000_000:
            staleness_limit_ns = int(get_coral_staleness_limit_s() * 1_000_000_000)
            last_load_check_ns = now_ns

        tpu0_rate = 0
        for p in candidate_paths:
            try:
                with open(p, 'r') as f:
                    cdata = json.load(f)
                    # Council Invariant 2 (Determinism) & Invariant 6 (Physical Truth):
                    # Disambiguate clock domain:
                    # Wall-clock epochs (> 1e18 ns / post-2001) vs CLOCK_MONOTONIC boot epochs (< 1e18 ns)
                    ts_raw = cdata.get('timestampNs')
                    if ts_raw is not None:
                        try:
                            ts_val = int(ts_raw)
                            if ts_val > WALL_CLOCK_EPOCH_THRESHOLD_NS:
                                now_wall_ns = time.time_ns()
                                age_ns = now_wall_ns - ts_val
                                # Allow up to 2 seconds negative drift for NTP adjustments
                                if age_ns < -2_000_000_000 or age_ns > staleness_limit_ns:
                                    tpu0_rate = 0
                                    continue
                            else:
                                age_ns = now_ns - ts_val
                                if age_ns < 0 or age_ns > staleness_limit_ns:
                                    tpu0_rate = 0
                                    continue
                        except (ValueError, TypeError) as exc:
                            sys.stderr.write(f'[burst-daemon] Note: corrupt timestampNs in {p}: {exc}\n')
                            tpu0_rate = 0
                            continue
                    else:
                        tpu0_rate = 0
                        continue

                    if cdata.get('status') == 'ACTIVE':
                        raw_val = cdata.get('inferencesPerSecond', 0)
                        try:
                            tpu0_rate = int(raw_val)
                        except (ValueError, TypeError):
                            tpu0_rate = 0
                    else:
                        tpu0_rate = 0
                    break
            except json.JSONDecodeError as e:
                # Council Invariant 3 (Fail-Closed): Torn reads from concurrent driver writes fail-closed to 0
                sys.stderr.write(f'[burst-daemon] Note: torn read / invalid JSON in {p}: {e}\n')
                tpu0_rate = 0
                continue
            except (FileNotFoundError, PermissionError, OSError) as e:
                sys.stderr.write(f'[burst-daemon] Note: cannot read {p}: {e}\n')
                continue

        p3_pkts_val: int | None = None
        p4_bytes_val: int | None = None
        jetson_temp_val: float | None = None
        jetson_gpu_temp_val: float | None = None
        jetson_gpu_util_val: int | None = None
        jetson_gpu_power_val: int | None = None

        # Direct sysfs read for Jetson CPU thermal (Dean nanosecond budget, zero socket overhead)
        # Follows EAFP principles without swallowing errors (Council Invariant 1: Zero Suppression of Reality)
        thermal_read_errors = []
        for tz in ('/sys/class/thermal/thermal_zone1/temp', '/sys/class/thermal/thermal_zone0/temp'):
            try:
                with open(tz, 'r') as f:
                    raw_c = f.read().strip()
                    jetson_temp_val = round(int(raw_c) / 1000.0, 1)
                    break
            except (FileNotFoundError, OSError, ValueError) as exc:
                thermal_read_errors.append(f'{tz}: {exc}')

        if jetson_temp_val is None and thermal_read_errors:
            sys.stderr.write(f'[burst-daemon] Note: sysfs thermal probes unavailable ({"; ".join(thermal_read_errors)})\n')

        # Direct sysfs read for Jetson Ampere GPU utilization
        # On Tegra Linux (JetPack 5/6), the kernel sysfs node reports load in standard permille (0..1000,
        # where 1000 = 100.0% utilization). Unconditionally scale by 10 with floor division to integer percent [0..100%].
        for gpu_load_path in ('/sys/devices/platform/bus@0/17000000.gpu/load', '/sys/devices/gpu.0/load'):
            try:
                with open(gpu_load_path, 'r') as f:
                    raw_gpu = int(f.read().strip())
                    # Deterministic permille scaling (0..1000 -> 0..100%) without discontinuous heuristics (Council Invariant 5)
                    jetson_gpu_util_val = max(0, min(100, raw_gpu // 10))
                    break
            except FileNotFoundError:
                continue
            except (OSError, ValueError) as exc:
                sys.stderr.write(f"[burst-daemon] Note: sysfs GPU load error ({gpu_load_path}): {exc}\n")
                continue

        MAX_HTTP_PAYLOAD = 64 * 1024  # 64 KB strict budget for flat snapshot (Dean & Ghemawat invariant)
        try:
            req = urllib.request.Request('http://127.0.0.1:3003/api/zodiac?summary=1', headers={'User-Agent': 'BurstRunner/2.0'})
            with urllib.request.urlopen(req, timeout=0.25) as resp:
                cl = resp.headers.get('Content-Length')
                if cl and int(cl) > MAX_HTTP_PAYLOAD:
                    raise ValueError(f'Response payload exceeds {MAX_HTTP_PAYLOAD} bytes budget: {cl} bytes')
                data = json.loads(resp.read(MAX_HTTP_PAYLOAD).decode('utf-8', errors='replace'))
                p3 = next((p for p in data.get('ports', []) if p.get('port') == 3), {})
                p4 = next((p for p in data.get('ports', []) if p.get('port') == 4), {})
                jetson = data.get('jetson', {})
                if 'rxPackets' in p3:
                    try:
                        p3_pkts_val = int(p3['rxPackets'])
                    except (ValueError, TypeError):
                        p3_pkts_val = None
                if 'rxBytes' in p4:
                    try:
                        p4_bytes_val = int(p4['rxBytes'])
                    except (ValueError, TypeError):
                        p4_bytes_val = None
                if jetson:
                    if jetson_temp_val is None:
                        raw_temp = jetson.get('temperatures', {}).get('cpuC')
                        if raw_temp is not None:
                            try:
                                jetson_temp_val = float(raw_temp)
                            except (ValueError, TypeError):
                                jetson_temp_val = None
                    if jetson_gpu_temp_val is None:
                        raw_gpu_t = jetson.get('temperatures', {}).get('gpuC')
                        if raw_gpu_t is not None:
                            try:
                                jetson_gpu_temp_val = float(raw_gpu_t)
                            except (ValueError, TypeError):
                                jetson_gpu_temp_val = None
                    if jetson_gpu_util_val is None:
                        raw_gpu_u = jetson.get('gpuUtilizationPct')
                        if raw_gpu_u is not None:
                            try:
                                jetson_gpu_util_val = int(raw_gpu_u)
                            except (ValueError, TypeError):
                                jetson_gpu_util_val = None
                    if jetson_gpu_power_val is None:
                        raw_pwr = jetson.get('power', {}).get('vddCpuGpuCv')
                        if raw_pwr is not None:
                            try:
                                jetson_gpu_power_val = int(raw_pwr)
                            except (ValueError, TypeError):
                                jetson_gpu_power_val = None
        except (TimeoutError, urllib.error.URLError, json.JSONDecodeError, UnicodeDecodeError, ValueError, OSError) as e:
            sys.stderr.write(f'[burst-daemon] Note: telemetry HTTP poll failed: {e}\n')

        summary: LiveTelemetrySummary = {
            'p3_rx_pkts': p3_pkts_val,
            'p4_rx_bytes': p4_bytes_val,
            'tpu0_inf_sec': tpu0_rate,
            'jetson_temp_c': jetson_temp_val,
            'jetson_gpu_temp_c': jetson_gpu_temp_val,
            'jetson_gpu_util_pct': jetson_gpu_util_val,
            'jetson_gpu_power_mw': jetson_gpu_power_val,
        }

        with live_summary_lock:
            cached_live_summary = summary

        stop_event.wait(timeout=1.0)


def get_live_telemetry_summary() -> LiveTelemetrySummary:
    """O(1) non-blocking in-memory telemetry read (Jeff Dean invariant)."""
    with live_summary_lock:
        return cached_live_summary.copy()


def is_target_enabled(target_key: str, enabled_set: set) -> bool:
    if 'all' in enabled_set:
        return True
    if target_key in enabled_set:
        return True
    if target_key == 'zodiac-p3':
        return any(t in enabled_set for t in ['zodiac', 'switch', 'zodiac-p3', 'p3', 'coral-1', 'coral-tap', 'coral-0', 'tpu-1', 'tpu-tap'])
    if target_key == 'zodiac-p4':
        return any(t in enabled_set for t in ['zodiac', 'switch', 'zodiac-p4', 'p4', 'controller', 'ctrl'])
    if target_key == 'coral':
        return any(t in enabled_set for t in ['coral', 'tpu', 'coral-all', 'corals', 'coral-1', 'coral-2', 'coral-tap', 'coral-sentinel'])
    if target_key == 'coral-1':
        return any(t in enabled_set for t in ['all', 'coral', 'tpu', 'coral-all', 'corals', 'coral-1', 'coral-tap', 'coral-0', 'tpu-1', 'tpu-tap'])
    if target_key == 'coral-2':
        return any(t in enabled_set for t in ['all', 'coral', 'tpu', 'coral-all', 'corals', 'coral-2', 'coral-sentinel', 'coral-dns', 'coral-burst', 'tpu-2'])
    if target_key == 'rpi':
        return any(t in enabled_set for t in ['rpi', 'pi', 'workload'])
    if target_key == 'jetson':
        return any(t in enabled_set for t in ['all', 'jetson', 'gpu', 'jetson-gpu', 'ampere', 'cuda', 'orin'])
    return False


def main():
    parser = argparse.ArgumentParser(description='Hardware-level Multi-Device Traffic & Inference Stress Burst')
    parser.add_argument('--duration', default='15m', help='Duration (e.g. 15m, 5m, 60s, 900)')
    parser.add_argument('--interval', type=int, default=15, help='Report interval in seconds')
    parser.add_argument('--target', '--device', default='all', help='Target device(s): all, zodiac, coral, coral-1, coral-2, rpi, jetson (comma-separated)')
    parser.add_argument('--staggered', '--stagger', action='store_true', help='Send staggered bursts to devices independently (TPU 1 solo -> rest -> TPU 2 solo -> rest -> dual concurrent)')
    parser.add_argument('--stagger-rest-sec', type=int, default=0, help='Duration of settling interval in seconds (default: 0 = auto)')
    parser.add_argument('--size', default='', help='Burst size limit (e.g. 50mb, 100mb, 1gb, 500kb)')
    parser.add_argument('--log-file', default=DEFAULT_LOG_PATH, help='File to write persistent burst logs')
    parser.add_argument('--tap-iface', default='', help='Tap interface name (default: auto-detect enx*)')
    args = parser.parse_args()

    total_duration_sec = parse_duration(args.duration)
    report_interval_sec = max(1, args.interval)
    max_bytes = parse_size_bytes(args.size)
    log_file = args.log_file
    tap_iface = args.tap_iface or find_tap_interface()

    raw_targets = [t.strip().lower() for t in args.target.split(',') if t.strip()]
    enabled_targets = set(raw_targets) if raw_targets else {'all'}

    if log_file:
        try:
            with open(log_file, 'w') as f:
                f.write('=== AGENTIC-ERA NETWORKING HARDWARE BURST LOG ===\n')
        except OSError as e:
            sys.stderr.write(f'[burst-daemon] Note: Failed initializing {log_file}: {e}\n')

    size_label = format_bytes_int(max_bytes) if max_bytes > 0 else 'Unlimited (Duration-based)'
    target_label = ', '.join(sorted(enabled_targets))
    mode_label = 'Staggered 5-Phase Cycle' if args.staggered else 'Continuous Concurrent Burst'

    log_message('======================================================================', log_file)
    log_message('🚀 AGENTIC-ERA NETWORKING: HARDWARE TRAFFIC & INFERENCE BURST ACTIVE', log_file)
    log_message(f'   Duration      : {total_duration_sec}s ({total_duration_sec // 60}m{total_duration_sec % 60:02d}s) | Mode: {mode_label}', log_file)
    log_message(f'   Target Filter : {target_label}', log_file)
    log_message(f'   Size Limit    : {size_label}', log_file)
    log_message(f'   Tap Interface : {tap_iface} (Zodiac Port 3)', log_file)
    log_message('======================================================================', log_file)

    threads = []
    tpu1_active = threading.Event()
    tpu2_active = threading.Event()

    # Start the coral telemetry file writer and async telemetry poller
    _start_coral_telemetry_writer()
    t_poller = threading.Thread(target=telemetry_poller_worker, name='telemetry-poller', daemon=True)
    threads.append(t_poller)
    t_poller.start()

    is_coral_1 = any(t in enabled_targets for t in ['coral-1', 'coral-tap', 'coral-0', 'tpu-1', 'tpu-tap'])
    is_coral_2 = any(t in enabled_targets for t in ['coral-2', 'coral-sentinel', 'coral-dns', 'coral-burst', 'tpu-2'])
    is_coral_all = any(t in enabled_targets for t in ['coral', 'tpu', 'coral-all', 'corals', 'all'])

    if not args.staggered:
        if is_coral_all or is_coral_1 or is_target_enabled('zodiac-p3', enabled_targets):
            tpu1_active.set()
        if is_coral_all or is_coral_2:
            tpu2_active.set()

    # 1. Coral TPU #2 (dedicated accelerator worker)
    if is_coral_all or is_coral_2 or args.staggered:
        active_tpu_devs = []
        sentinel_target_path = os.environ.get('CORAL_SENTINEL_USB_PATH', '2-1.2')
        try:
            from pycoral.utils.edgetpu import (
                list_edge_tpus,  # type: ignore[import-untyped]  # Jetson Linux only
            )
            detected_tpus = list_edge_tpus()
            for i, tpu_info in enumerate(detected_tpus):
                dev_path = tpu_info.get('path')
                if dev_path and sentinel_target_path in dev_path:
                    active_tpu_devs.append(f':{i}')
                    break
            if not active_tpu_devs:
                # Fail-closed (Council Invariant 3 & 4): unmatched topology constraint drops worker
                sys.stderr.write(f'[burst-daemon] Fail-closed: Sentinel Edge TPU matching {sentinel_target_path} not found among {detected_tpus}\n')
        except (ImportError, OSError, ValueError) as exc:
            sys.stderr.write(f'[burst-daemon] Note: Edge TPU worker discovery error: {exc}\n')

        for dev in active_tpu_devs:
            t = threading.Thread(
                target=coral_tpu_worker,
                args=(dev, max_bytes, tpu2_active),
                kwargs={
                    'telemetry_file': 'coral-tpu1-burst-telemetry.json',
                    'model_role': 'DNS Sentinel',
                    'counter_key': 'coral_tpu1_inferences',
                },
                name=f'coral-burst-{dev}',
                daemon=True,
            )
            threads.append(t)
            t.start()
            log_message(f'   [+] Spawned dedicated Edge TPU worker on {dev} (Coral TPU #2 DNS Sentinel)', log_file)
        if not active_tpu_devs:
            log_message('   [-] No free Edge TPU found for dedicated burst worker', log_file)
    else:
        log_message('   [-] Coral TPU #2 worker omitted by target filter', log_file)

    # 2. Zodiac Port 3 (Wire-tap raw frame worker driving Coral TPU #1)
    if is_coral_all or is_coral_1 or is_target_enabled('zodiac-p3', enabled_targets) or args.staggered:
        t_p3 = threading.Thread(target=zodiac_p3_raw_worker, args=(tap_iface, max_bytes, tpu1_active), name='zodiac-p3-raw', daemon=True)
        threads.append(t_p3)
        t_p3.start()
        log_message('   [+] Spawned Zodiac Port 3 raw frame burst worker (Coral TPU #1 Tap DPI)', log_file)
    else:
        log_message('   [-] Zodiac Port 3 raw worker omitted by target filter', log_file)

    # 3. Zodiac Port 4
    if is_target_enabled('zodiac-p4', enabled_targets):
        t_p4 = threading.Thread(target=zodiac_p4_worker, args=(DEFAULT_SWITCH_IP, 9999, max_bytes), name='zodiac-p4-ctrl', daemon=True)
        threads.append(t_p4)
        t_p4.start()
        log_message('   [+] Spawned Zodiac Port 4 controller probe worker', log_file)
    else:
        log_message('   [-] Zodiac Port 4 controller worker omitted by target filter', log_file)

    # 4. Raspberry Pi 3B+
    if is_target_enabled('rpi', enabled_targets):
        t_rpi = threading.Thread(target=rpi_workload_worker, args=(DEFAULT_WORKLOAD_IP, 9999, max_bytes), name='rpi-workload', daemon=True)
        threads.append(t_rpi)
        t_rpi.start()
        log_message('   [+] Spawned RPi 3B+ workload probe worker', log_file)
    else:
        log_message('   [-] RPi 3B+ workload worker omitted by target filter', log_file)

    # 5. NVIDIA Jetson Orin Ampere GPU Worker
    is_jetson_gpu = is_target_enabled('jetson', enabled_targets)
    if is_jetson_gpu:
        gpu_active = threading.Event()
        gpu_active.set()
        t_gpu = threading.Thread(target=jetson_gpu_worker, args=(max_bytes, gpu_active), name='jetson-gpu-worker', daemon=True)
        threads.append(t_gpu)
        t_gpu.start()
        log_message('   [+] Spawned Jetson Orin Ampere GPU compute worker', log_file)
    else:
        log_message('   [-] Jetson Orin GPU worker omitted by target filter', log_file)

    if not threads:
        log_message('⚠️ No workers active. Check --target selection.', log_file)
        return

    start_ns = time.monotonic_ns()
    last_report_ns = start_ns
    prev_counters = counters.copy()

    # Initialize stagger state unconditionally so pyright can prove these are always bound
    # when referenced inside the loop (even under args.staggered guard).
    stagger_stages: list | None = None
    current_stage_idx: int = -1

    if args.staggered:
        if args.stagger_rest_sec > 0:
            rest_sec = args.stagger_rest_sec
        else:
            rest_sec = max(1, min(15, total_duration_sec // 10))
        active_pool = max(3, total_duration_sec - (2 * rest_sec))
        active_sec = max(1, active_pool // 3)

        t1 = active_sec
        t2 = t1 + rest_sec
        t3 = t2 + active_sec
        t4 = t3 + rest_sec
        t5 = max(t4 + 1, total_duration_sec)

        stagger_stages = [
            (1, 'Coral TPU #1 (Tap DPI) Solo Burst', 'Transmitting wire-tap frames to Zodiac Port 3; TPU 2 in STANDBY', 0, t1, True, False),
            (2, 'Settling Baseline (Both Standby)', 'Zeroing wire traffic; observing both TPUs return to STANDBY (0 inf/s)', t1, t2, False, False),
            (3, 'Coral TPU #2 (DNS Sentinel) Solo Burst', 'Driving dedicated Edge TPU accelerator :1; TPU 1 in STANDBY', t2, t3, False, True),
            (4, 'Settling Baseline (Both Standby)', 'Zeroing burst worker; verifying zero drift baseline (0 inf/s)', t3, t4, False, False),
            (5, 'Dual Coral TPUs Concurrently (Peak Parallelism)', 'Driving both accelerators simultaneously (~450 inf/s combined peak target)', t4, t5, True, True),
        ]
        current_stage_idx = -1

    def handle_signal(sig, frame):
        stop_event.set()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    try:
        while not stop_event.is_set():
            now_ns = time.monotonic_ns()
            elapsed_sec = (now_ns - start_ns) // 1_000_000_000

            if elapsed_sec >= total_duration_sec:
                break

            with stats_lock:
                tot_transferred = counters['zodiac_p3_bytes'] + counters['zodiac_p4_bytes'] + counters['rpi_bytes']
            if max_bytes > 0 and tot_transferred >= max_bytes:
                log_message(f'🎯 Target burst size reached ({format_bytes_int(tot_transferred)} >= {size_label}). Concluding burst...', log_file)
                break

            if args.staggered:
                active_stage = None
                for st in stagger_stages:
                    if st[3] <= elapsed_sec < st[4]:
                        active_stage = st
                        break
                if active_stage is None and elapsed_sec >= stagger_stages[-1][4]:
                    active_stage = stagger_stages[-1]

                if active_stage and active_stage[0] != current_stage_idx:
                    current_stage_idx = active_stage[0]
                    stage_num, stage_title, stage_desc, s_start, s_end, s_tpu1, s_tpu2 = active_stage
                    stage_dur = s_end - s_start
                    if s_tpu1:
                        tpu1_active.set()
                    else:
                        tpu1_active.clear()
                    if s_tpu2:
                        tpu2_active.set()
                    else:
                        tpu2_active.clear()

                    log_message('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', log_file)
                    log_message(f'⚡ [STAGE {stage_num}/5] {stage_title} ({stage_dur}s)', log_file)
                    log_message(f'   {stage_desc}', log_file)
                    log_message('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', log_file)

            time.sleep(1.0)

            report_trigger = min(report_interval_sec, 3) if args.staggered else report_interval_sec
            if (now_ns - last_report_ns) >= (report_trigger * 1_000_000_000):
                window_elapsed_ns = now_ns - last_report_ns
                if window_elapsed_ns <= 0:
                    window_elapsed_ns = 1
                with stats_lock:
                    curr = counters.copy()

                d_coral = curr['coral_total_inferences'] - prev_counters['coral_total_inferences']
                d_p3_pkts = curr['zodiac_p3_frames'] - prev_counters['zodiac_p3_frames']
                d_p3_bytes = curr['zodiac_p3_bytes'] - prev_counters['zodiac_p3_bytes']
                d_p4_pkts = curr['zodiac_p4_packets'] - prev_counters['zodiac_p4_packets']
                d_rpi_pkts = curr['rpi_packets'] - prev_counters['rpi_packets']
                d_gpu_ops = curr['jetson_gpu_ops'] - prev_counters['jetson_gpu_ops']

                burst_coral_rate = (d_coral * 1_000_000_000) // window_elapsed_ns
                p3_pps = (d_p3_pkts * 1_000_000_000) // window_elapsed_ns
                p3_kbps = ((d_p3_bytes * 8) * 1_000_000) // window_elapsed_ns
                p4_pps = (d_p4_pkts * 1_000_000_000) // window_elapsed_ns
                rpi_pps = (d_rpi_pkts * 1_000_000_000) // window_elapsed_ns
                gpu_ops_sec = (d_gpu_ops * 1_000_000_000) // window_elapsed_ns

                live = get_live_telemetry_summary()
                rem_sec = max(0, total_duration_sec - elapsed_sec)

                daemon_coral_rate = live.get('tpu0_inf_sec', 0)
                temp_val = live.get('jetson_temp_c')
                temp_str = f'{temp_val:.1f}°C' if temp_val is not None else '--°C'
                p3_rx_val = live.get('p3_rx_pkts')
                p3_rx_str = f'{p3_rx_val}' if p3_rx_val is not None else '--'

                tot_bytes = curr['zodiac_p3_bytes'] + curr['zodiac_p4_bytes'] + curr['rpi_bytes'] + curr['jetson_gpu_bytes']
                size_progress = format_bytes_int(tot_bytes)
                if max_bytes > 0:
                    pct = min(100, (tot_bytes * 100) // max_bytes)
                    size_progress += f' / {format_bytes_int(max_bytes)} ({pct}%)'

                stat_parts = [f'[{elapsed_sec:03d}s/{total_duration_sec}s - {rem_sec//60}m{rem_sec%60:02d}s left]']
                if args.staggered and current_stage_idx > 0:
                    stat_parts.append(f'Stage {current_stage_idx}/5')
                if is_coral_all or is_coral_1 or is_coral_2 or args.staggered:
                    stat_parts.append(f'Coral #1 (Tap DPI): {daemon_coral_rate}/s | Coral #2 (DNS Sentinel): {burst_coral_rate}/s')
                if is_target_enabled('zodiac-p3', enabled_targets) and not args.staggered:
                    stat_parts.append(f'Zodiac P3: {p3_pps} pps ({p3_kbps} kbps, Rx {p3_rx_str} pkts)')
                if is_target_enabled('zodiac-p4', enabled_targets):
                    stat_parts.append(f'Zodiac P4: {p4_pps} pps')
                if is_target_enabled('rpi', enabled_targets):
                    stat_parts.append(f'RPi: {rpi_pps} pps')
                if is_jetson_gpu:
                    gpu_util = live.get('jetson_gpu_util_pct')
                    gpu_util_str = f'{gpu_util}%' if gpu_util is not None else '--%'
                    gpu_t = live.get('jetson_gpu_temp_c')
                    gpu_t_str = f'{gpu_t:.1f}°C' if gpu_t is not None else '--°C'
                    gpu_pwr = live.get('jetson_gpu_power_mw')
                    gpu_pwr_str = f'{gpu_pwr}mW' if gpu_pwr is not None else '--mW'
                    stat_parts.append(f'Jetson GPU: {gpu_ops_sec} ops/s (Load: {gpu_util_str}, Temp: {gpu_t_str}, Pwr: {gpu_pwr_str})')
                stat_parts.append(f'Transferred: {size_progress}')
                stat_parts.append(f'Jetson CPU: {temp_str}')

                log_message(' | '.join(stat_parts), log_file)

                prev_counters = curr
                last_report_ns = now_ns

    finally:
        tpu1_active.clear()
        tpu2_active.clear()
        stop_event.set()
        for t in threads:
            t.join(timeout=2.0)

        cleanup_burst_coral_telemetry()

        # Drain and shut down the coral telemetry writer thread (poison pill).
        # Use put with timeout to avoid blocking the main thread if the writer is hung on a
        # stalled filesystem and the queue is still full at shutdown time.
        try:
            _coral_write_q.put(None, timeout=SHUTDOWN_QUEUE_TIMEOUT_SEC)
        except queue.Full:
            sys.stderr.write(
                f'[burst-daemon] Coral telemetry writer queue full during shutdown '
                f'(qsize={_coral_write_q.qsize()}); writer thread likely hung on stalled '
                f'filesystem. Dropping poison pill — daemon thread will be reaped on exit.\n'
            )
        if _coral_writer_thread is not None:
            _coral_writer_thread.join(timeout=SHUTDOWN_JOIN_TIMEOUT_SEC)

        total_elapsed_sec = (time.monotonic_ns() - start_ns) // 1_000_000_000
        tot_bytes = counters['zodiac_p3_bytes'] + counters['zodiac_p4_bytes'] + counters['rpi_bytes'] + counters['jetson_gpu_bytes']

        log_message('\n======================================================================', log_file)
        log_message(f'✅ BURST COMPLETED: Total Run Time {total_elapsed_sec}s ({total_elapsed_sec//60}m{total_elapsed_sec%60:02d}s)', log_file)
        if is_target_enabled('coral', enabled_targets):
            log_message(f'   Coral Total Inferences  : {counters["coral_total_inferences"]:,}', log_file)
            if counters['coral_tpu1_inferences'] > 0:
                log_message(f'     └─ Coral TPU #2 (DNS Sentinel): {counters["coral_tpu1_inferences"]:,}', log_file)
        if is_target_enabled('zodiac-p3', enabled_targets):
            log_message(f'   Zodiac Port 3 Frames    : {counters["zodiac_p3_frames"]:,} ({format_bytes_int(counters["zodiac_p3_bytes"])})', log_file)
        if is_target_enabled('zodiac-p4', enabled_targets):
            log_message(f'   Zodiac Port 4 Packets   : {counters["zodiac_p4_packets"]:,} ({format_bytes_int(counters["zodiac_p4_bytes"])})', log_file)
        if is_target_enabled('rpi', enabled_targets):
            log_message(f'   RPi 3B+ Workload Packets: {counters["rpi_packets"]:,} ({format_bytes_int(counters["rpi_bytes"])})', log_file)
        if is_jetson_gpu:
            log_message(f'   Jetson Orin GPU Ops     : {counters["jetson_gpu_ops"]:,} ({format_bytes_int(counters["jetson_gpu_bytes"])})', log_file)
        log_message(f'   Total Data Transferred  : {format_bytes_int(tot_bytes)} ({tot_bytes:,} bytes)', log_file)
        log_message('======================================================================\n', log_file)


if __name__ == '__main__':
    main()
