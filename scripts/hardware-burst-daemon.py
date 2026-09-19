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
import re
import signal
import socket
import sys
import threading
import time
import urllib.request

MODEL_PATH = os.environ.get('CORAL_MODEL_PATH', '/home/zodiac/coral-models/mobilenet_v2_1.0_224_quant_edgetpu.tflite')
DEFAULT_LOG_PATH = os.environ.get('BURST_LOG_PATH', '/home/zodiac/burst-telemetry.log')
DEFAULT_SWITCH_IP = os.environ.get('ZODIAC_SWITCH_IP', '127.0.0.1')
DEFAULT_CTRL_IP = os.environ.get('SDN_CONTROLLER_IP', '0.0.0.0')
DEFAULT_WORKLOAD_IP = os.environ.get('RPI_WORKLOAD_IP', '127.0.0.1')
CUSTOM_BURST_CORAL_PATH = os.environ.get('BURST_CORAL_TELEMETRY_PATH')
CANDIDATE_BURST_DIRS = ['/run/zodiac', '/tmp']
BURST_TARGET_PATHS = tuple(
    [CUSTOM_BURST_CORAL_PATH]
    if CUSTOM_BURST_CORAL_PATH
    else [os.path.join(d, 'coral-burst-telemetry.json') for d in CANDIDATE_BURST_DIRS]
)

stop_event = threading.Event()
stats_lock = threading.Lock()

counters = {
    'coral_burst_inferences': 0,
    'zodiac_p3_frames': 0,
    'zodiac_p3_bytes': 0,
    'zodiac_p4_packets': 0,
    'zodiac_p4_bytes': 0,
    'rpi_packets': 0,
    'rpi_bytes': 0,
}


def log_message(msg: str, log_file: str):
    ts = time.strftime('%Y-%m-%d %H:%M:%S')
    line = f'[{ts}] {msg}'
    print(line, flush=True)
    if log_file:
        try:
            with open(log_file, 'a') as f:
                f.write(line + '\n')
                f.flush()
        except Exception:
            pass


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


def atomic_write_burst_coral_json(data: dict):
    last_err = None
    for target in BURST_TARGET_PATHS:
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
        sys.stderr.write(f'[burst-coral] Failed writing telemetry: {last_err}\n')


def cleanup_burst_coral_telemetry():
    for target in BURST_TARGET_PATHS:
        try:
            os.remove(target)
        except OSError as e:
            if e.errno != errno.ENOENT:
                sys.stderr.write(f'[burst-coral] Failed cleanup {target}: {e}\n')


def coral_tpu_worker(dev_spec: str, max_bytes: int = 0):
    """Drives continuous high-throughput INT8 inference on a dedicated Coral Edge TPU."""
    try:
        from pycoral.utils.edgetpu import make_interpreter
        import numpy as np

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

        while not stop_event.is_set():
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
                counters['coral_burst_inferences'] += batch_size

            now_ns = time.monotonic_ns()
            if now_ns - w_start_ns >= 1_000_000_000:
                elapsed_ns = now_ns - w_start_ns
                w_sorted = sorted(w_latencies)
                n = len(w_sorted)
                p50_ns = w_sorted[n // 2] if n > 0 else 0
                p99_ns = w_sorted[min(int(n * 0.99), n - 1)] if n > 0 else 0
                inf_sec = (n * 1_000_000_000) // elapsed_ns if elapsed_ns > 0 else 0

                atomic_write_burst_coral_json({
                    'detected': True,
                    'status': 'ACTIVE',
                    'model': f'MobileNet V2 INT8 (EdgeTPU {dev_spec}) - Burst Parallel',
                    'inferencesPerSecond': inf_sec,
                    'totalInferences': total_worker_inf,
                    'latencyP50Ns': p50_ns,
                    'latencyP99Ns': p99_ns,
                    'timestampNs': now_ns,
                })
                w_latencies = []
                w_start_ns = now_ns
    except Exception as e:
        sys.stderr.write(f'[coral_worker_{dev_spec}] Error: {e}\n')
        sys.stderr.flush()
    finally:
        cleanup_burst_coral_telemetry()


def find_tap_interface() -> str:
    """Finds the promiscuous ASIX USB GbE adapter (enx*)."""
    for iface in os.listdir('/sys/class/net'):
        if iface.startswith('enx'):
            return iface
    return 'enx9c69d39dd0a6'


def zodiac_p3_raw_worker(iface: str, max_bytes: int = 0):
    """Sends raw Ethernet frames directly into Zodiac Port 3 via the tap interface."""
    try:
        s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW)
        s.bind((iface, 0))

        dst_mac = bytes.fromhex('70b3d58740c9')
        try:
            with open(f'/sys/class/net/{iface}/address') as f:
                src_mac_str = f.read().strip().replace(':', '')
                src_mac = bytes.fromhex(src_mac_str)
        except Exception:
            src_mac = bytes.fromhex('9c69d39dd0a6')

        eth_type = b'\x08\x00'

        payload_sizes = [64, 256, 512, 1024, 1400]
        frames = []
        for sz in payload_sizes:
            pad_len = max(0, sz - 14)
            p = b'AGENTIC-BURST-TAP-' + os.urandom(max(0, pad_len - 18))
            frames.append(dst_mac + src_mac + eth_type + p[:pad_len])

        frame_idx = 0
        while not stop_event.is_set():
            if max_bytes > 0 and check_size_limit_reached(max_bytes):
                stop_event.set()
                break

            f = frames[frame_idx % len(frames)]
            frame_idx += 1
            s.send(f)
            with stats_lock:
                counters['zodiac_p3_frames'] += 1
                counters['zodiac_p3_bytes'] += len(f)
            time.sleep(0.001)
        s.close()
    except Exception as e:
        sys.stderr.write(f'[zodiac_p3_raw_worker] Error on {iface}: {e}\n')
        sys.stderr.flush()


def zodiac_p4_worker(target_ip: str = DEFAULT_SWITCH_IP, target_port: int = 9999, max_bytes: int = 0):
    """Sends high-rate UDP probes to Zodiac Port 4 via controller interface."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.bind((DEFAULT_CTRL_IP, 0))
        except Exception:
            pass

        target = (target_ip, target_port)
        payload = b'AGENTIC-BURST-OF-CTRL-' + (b'X' * 128)

        while not stop_event.is_set():
            if max_bytes > 0 and check_size_limit_reached(max_bytes):
                stop_event.set()
                break

            s.sendto(payload, target)
            with stats_lock:
                counters['zodiac_p4_packets'] += 1
                counters['zodiac_p4_bytes'] += len(payload)
            time.sleep(0.005)
        s.close()
    except Exception as e:
        sys.stderr.write(f'[zodiac_p4_worker] Error: {e}\n')
        sys.stderr.flush()


def rpi_workload_worker(target_ip: str = DEFAULT_WORKLOAD_IP, target_port: int = 9999, max_bytes: int = 0):
    """Sends probe bursts to the workload node."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        target = (target_ip, target_port)
        payload = b'AGENTIC-WORKLOAD-PROBE-' + (b'W' * 128)

        while not stop_event.is_set():
            if max_bytes > 0 and check_size_limit_reached(max_bytes):
                stop_event.set()
                break

            s.sendto(payload, target)
            with stats_lock:
                counters['rpi_packets'] += 1
                counters['rpi_bytes'] += len(payload)
            time.sleep(0.01)
        s.close()
    except Exception as e:
        sys.stderr.write(f'[rpi_workload_worker] Error: {e}\n')
        sys.stderr.flush()


def get_live_telemetry_summary() -> dict:
    try:
        req = urllib.request.Request('http://127.0.0.1:3003/api/zodiac', headers={'User-Agent': 'BurstRunner/2.0'})
        with urllib.request.urlopen(req, timeout=3.0) as resp:
            data = json.loads(resp.read().decode())
            p3 = next((p for p in data.get('ports', []) if p.get('port') == 3), {})
            p4 = next((p for p in data.get('ports', []) if p.get('port') == 4), {})
            coral = data.get('coral', {})
            jetson = data.get('jetson', {})
            return {
                'p3_rx_pkts': p3.get('rxPackets', '-'),
                'p4_rx_bytes': p4.get('rxBytes', '-'),
                'tpu0_inf_sec': coral.get('inferencesPerSecond', '-'),
                'jetson_temp_c': jetson.get('temperatures', {}).get('cpuC', '-'),
            }
    except Exception:
        return {}


def is_target_enabled(target_key: str, enabled_set: set) -> bool:
    if 'all' in enabled_set:
        return True
    if target_key in enabled_set:
        return True
    if target_key.startswith('zodiac') and ('zodiac' in enabled_set or 'switch' in enabled_set):
        return True
    if target_key.startswith('coral') and ('coral' in enabled_set or 'tpu' in enabled_set):
        return True
    if target_key == 'rpi' and ('rpi' in enabled_set or 'pi' in enabled_set or 'workload' in enabled_set):
        return True
    return False


def main():
    parser = argparse.ArgumentParser(description='Hardware-level Multi-Device Traffic & Inference Stress Burst')
    parser.add_argument('--duration', default='15m', help='Duration (e.g. 15m, 5m, 60s, 900)')
    parser.add_argument('--interval', type=int, default=15, help='Report interval in seconds')
    parser.add_argument('--target', '--device', default='all', help='Target device(s): all, zodiac, coral, rpi, jetson (comma-separated)')
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
        except Exception:
            pass

    size_label = f'{max_bytes / (1024*1024):.2f} MB' if max_bytes > 0 else 'Unlimited (Duration-based)'
    target_label = ', '.join(sorted(enabled_targets))

    log_message('======================================================================', log_file)
    log_message('🚀 AGENTIC-ERA NETWORKING: HARDWARE TRAFFIC & INFERENCE BURST ACTIVE', log_file)
    log_message(f'   Duration      : {total_duration_sec}s ({total_duration_sec // 60}m{total_duration_sec % 60:02d}s) | Reporting: every {report_interval_sec}s', log_file)
    log_message(f'   Target Filter : {target_label}', log_file)
    log_message(f'   Size Limit    : {size_label}', log_file)
    log_message(f'   Tap Interface : {tap_iface} (Zodiac Port 3)', log_file)
    log_message('======================================================================', log_file)

    threads = []

    # 1. Coral TPUs
    if is_target_enabled('coral', enabled_targets):
        active_tpu_devs = []
        try:
            from pycoral.utils.edgetpu import make_interpreter
            for dev in [':0', ':1']:
                try:
                    test_interp = make_interpreter(MODEL_PATH, device=dev)
                    active_tpu_devs.append(dev)
                    del test_interp
                except Exception:
                    pass
        except Exception:
            pass

        for dev in active_tpu_devs:
            t = threading.Thread(target=coral_tpu_worker, args=(dev, max_bytes), name=f'coral-burst-{dev}', daemon=True)
            threads.append(t)
            t.start()
            log_message(f'   [+] Spawned dedicated Edge TPU worker on {dev}', log_file)
        log_message('   [+] Companion Coral TPU active concurrently under central bridge daemon', log_file)
    else:
        log_message('   [-] Coral TPUs omitted by target filter', log_file)

    # 2. Zodiac Port 3
    if is_target_enabled('zodiac-p3', enabled_targets):
        t_p3 = threading.Thread(target=zodiac_p3_raw_worker, args=(tap_iface, max_bytes), name='zodiac-p3-raw', daemon=True)
        threads.append(t_p3)
        t_p3.start()
        log_message('   [+] Spawned Zodiac Port 3 raw frame burst worker', log_file)
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

    if not threads:
        log_message('⚠️ No workers active. Check --target selection.', log_file)
        return

    start_ns = time.monotonic_ns()
    last_report_ns = start_ns
    prev_counters = counters.copy()

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
                log_message(f'🎯 Target burst size reached ({tot_transferred / (1024*1024):.2f} MB >= {size_label}). Concluding burst...', log_file)
                break

            time.sleep(1.0)

            if (now_ns - last_report_ns) >= (report_interval_sec * 1_000_000_000):
                window_elapsed_sec = (now_ns - last_report_ns) / 1_000_000_000
                with stats_lock:
                    curr = counters.copy()

                d_coral = curr['coral_burst_inferences'] - prev_counters['coral_burst_inferences']
                d_p3_pkts = curr['zodiac_p3_frames'] - prev_counters['zodiac_p3_frames']
                d_p3_bytes = curr['zodiac_p3_bytes'] - prev_counters['zodiac_p3_bytes']
                d_p4_pkts = curr['zodiac_p4_packets'] - prev_counters['zodiac_p4_packets']
                d_rpi_pkts = curr['rpi_packets'] - prev_counters['rpi_packets']

                burst_coral_rate = int(d_coral / window_elapsed_sec)
                p3_pps = int(d_p3_pkts / window_elapsed_sec)
                p3_kbps = int((d_p3_bytes * 8) / (window_elapsed_sec * 1000))
                p4_pps = int(d_p4_pkts / window_elapsed_sec)
                rpi_pps = int(d_rpi_pkts / window_elapsed_sec)

                live = get_live_telemetry_summary()
                rem_sec = max(0, total_duration_sec - elapsed_sec)

                daemon_coral_rate = live.get('tpu0_inf_sec', '-')
                temp = live.get('jetson_temp_c', '-')
                p3_rx = live.get('p3_rx_pkts', '-')

                tot_bytes = curr['zodiac_p3_bytes'] + curr['zodiac_p4_bytes'] + curr['rpi_bytes']
                size_progress = f'{tot_bytes / (1024*1024):.1f}MB'
                if max_bytes > 0:
                    pct = min(100.0, (tot_bytes * 100.0) / max_bytes)
                    size_progress += f' / {max_bytes / (1024*1024):.1f}MB ({pct:.1f}%)'

                stat_parts = [f'[{elapsed_sec:03d}s/{total_duration_sec}s - {rem_sec//60}m{rem_sec%60:02d}s left]']
                if is_target_enabled('coral', enabled_targets):
                    stat_parts.append(f'Coral Daemon: {daemon_coral_rate}/s | Coral Burst: {curr["coral_burst_inferences"]} inf ({burst_coral_rate}/s)')
                if is_target_enabled('zodiac-p3', enabled_targets):
                    stat_parts.append(f'Zodiac P3: {p3_pps} pps ({p3_kbps} kbps, Rx {p3_rx} pkts)')
                if is_target_enabled('zodiac-p4', enabled_targets):
                    stat_parts.append(f'Zodiac P4: {p4_pps} pps')
                if is_target_enabled('rpi', enabled_targets):
                    stat_parts.append(f'RPi: {rpi_pps} pps')
                stat_parts.append(f'Transferred: {size_progress}')
                stat_parts.append(f'Jetson: {temp}°C')

                log_message(' | '.join(stat_parts), log_file)

                prev_counters = curr
                last_report_ns = now_ns

    finally:
        stop_event.set()
        for t in threads:
            t.join(timeout=2.0)

        cleanup_burst_coral_telemetry()

        total_elapsed_sec = (time.monotonic_ns() - start_ns) // 1_000_000_000
        tot_bytes = counters['zodiac_p3_bytes'] + counters['zodiac_p4_bytes'] + counters['rpi_bytes']

        log_message('\n======================================================================', log_file)
        log_message(f'✅ BURST COMPLETED: Total Run Time {total_elapsed_sec}s ({total_elapsed_sec//60}m{total_elapsed_sec%60:02d}s)', log_file)
        if is_target_enabled('coral', enabled_targets):
            log_message(f'   Coral Burst Inferences  : {counters["coral_burst_inferences"]:,}', log_file)
        if is_target_enabled('zodiac-p3', enabled_targets):
            log_message(f'   Zodiac Port 3 Frames    : {counters["zodiac_p3_frames"]:,} ({counters["zodiac_p3_bytes"] / (1024*1024):.2f} MB)', log_file)
        if is_target_enabled('zodiac-p4', enabled_targets):
            log_message(f'   Zodiac Port 4 Packets   : {counters["zodiac_p4_packets"]:,} ({counters["zodiac_p4_bytes"] / (1024*1024):.2f} MB)', log_file)
        if is_target_enabled('rpi', enabled_targets):
            log_message(f'   RPi 3B+ Workload Packets: {counters["rpi_packets"]:,} ({counters["rpi_bytes"] / (1024*1024):.2f} MB)', log_file)
        log_message(f'   Total Data Transferred  : {tot_bytes / (1024*1024):.2f} MB ({tot_bytes:,} bytes)', log_file)
        log_message('======================================================================\n', log_file)


if __name__ == '__main__':
    main()
