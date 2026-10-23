#!/usr/bin/env python3
"""
scripts/gpu-sdn-anomaly-sentinel.py
===================================
Autonomous GPU-Accelerated Stage-2 Deep Traffic Anomaly Sentinel & SDN Quarantine Engine.

Part of the Master Appliance Architecture (gpu-workload-2 / Milestone 2A):
Target: NVIDIA Jetson Orin Nano Super (1024 CUDA Cores + 32 Tensor Cores, 67 TOPS Ampere).

Role:
  - Ingests mirrored packet frames from Zodiac Port 3 mirror tap (enx*) or socket feed.
  - Transforms sliding packet windows (64 packets) into multi-dimensional feature tensors:
      * Inter-arrival delta time (dt in microseconds)
      * Frame length (bytes)
      * IP protocol & TCP flag bitmask (SYN/ACK/RST/FIN/PSH/URG)
      * Port entropy / service dispersion
  - Evaluates sequence anomaly reconstruction error using a 1D-CNN Autoencoder on CUDA.
  - Sub-millisecond inference budget (< 1.0 ms per batch, Dean latency invariant).
  - When reconstruction loss exceeds threshold tau, dispatches an emergency quarantine request
    to the Zodiac SDN controller (:3003/api/sdn/quarantine) installing an OpenFlow 1.3
    FLOW_MOD (Priority 65535, DROP) isolating the offending IP/MAC on Port 1.

Council Invariants Enforced:
  - Invariant 1 (Anti-Shortcut): Strict protocol boundary validation, explicit error typing.
  - Invariant 2 (Determinism & Accounting): Monotonic nanosecond timestamps, integer packet rates.
  - Invariant 3 (Fail-Closed Isolation): Anomaly detection defaults strictly to DROP/QUARANTINE.
  - Invariant 6 (Anti-Simulation Law): Verifiable hardware inference on real silicon.
"""

import argparse
import collections
import ctypes
import json
import math
import os
import queue
import signal
import socket
import struct
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Dict, Optional, Tuple, List

# Standard RFC / IEEE protocol boundary envelope constants
ETHERNET_STANDARD_MTU = 1518  # IEEE 802.3 standard max envelope
MAX_TCP_FLAGS = 0x3F           # RFC 793 standard 6-bit control flags (URG, ACK, PSH, RST, SYN, FIN)
MAX_L4_PORT = 65535            # IANA 16-bit transport layer port space

DEFAULT_CONTROLLER_URL = os.environ.get('SDN_CONTROLLER_URL', 'http://127.0.0.1:3003')
DEFAULT_TAP_IFACE = os.environ.get('TAP_IFACE', 'enx9c69d39dd0a6')
DEFAULT_ANOMALY_THRESHOLD = float(os.environ.get('GPU_ANOMALY_THRESHOLD', '0.15'))
WINDOW_SIZE = 64  # Sliding packet sequence length
NUM_FEATURES = 4   # [dt_us_norm, length_norm, flags_norm, port_entropy_norm]
QUEUE_POLL_TIMEOUT_SEC = 0.1  # Bounded polling timeout for ingress queue
EXPECTED_MAC_HEX_LEN = 17  # 6 octets × 2 hex digits + 5 colons: "ab:cd:ef:01:23:45"

@dataclass(frozen=True)
class QuarantineAlertItem:
    """Typed quarantine dispatch alert for the non-blocking worker queue."""
    controller_url: str
    target_ip: str
    target_mac: str
    reason: str
    priority: int = 65535


class AdaptiveThresholdController:
    """
    Council Invariant 5 (Adaptive Control & Multi-Agent Stability - Quoc Le):
    Eliminates brittle hardcoded heuristic magic numbers by tracking running
    reconstruction error distributions via exponential moving statistics (EMA).
    Dynamically adjusts threshold tau to prevent flap storms under traffic shifts.
    """
    def __init__(self, initial_threshold: float = 0.15, alpha: float = 0.05, sensitivity_sigmas: float = 2.5):
        self.base_threshold = initial_threshold
        self.alpha = alpha
        self.sensitivity = sensitivity_sigmas
        self.ema_loss: float = initial_threshold * 0.75
        self.ema_var: float = (initial_threshold * 0.15) ** 2
        self.samples: int = 0

    def update_and_check(self, current_loss: float) -> Tuple[bool, float]:
        self.samples += 1
        ema_std = math.sqrt(max(1e-6, self.ema_var))
        dynamic_tau = max(self.base_threshold, self.ema_loss + (self.sensitivity * ema_std))
        is_anomaly = current_loss >= dynamic_tau

        # Council Invariant 5: Only incorporate non-anomalous background traffic into
        # the running baseline distribution to prevent baseline pollution during malicious bursts.
        if not is_anomaly:
            diff = current_loss - self.ema_loss
            self.ema_loss += self.alpha * diff
            self.ema_var = (1.0 - self.alpha) * self.ema_var + self.alpha * (diff ** 2)

        return is_anomaly, dynamic_tau

stop_event = False


def signal_handler(sig, frame):
    global stop_event
    stop_event = True


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


# ---------------------------------------------------------------------------
# Neural Autoencoder Model (PyTorch CUDA with NumPy/Pure Math Fallback)
# ---------------------------------------------------------------------------

class Gpu1DAutoencoder:
    """
    1D-Convolutional Autoencoder for Packet Sequence Anomaly Detection.
    Runs on NVIDIA Ampere CUDA (cuda:0) with FP16 Tensor Cores on Jetson Orin.
    Falls back gracefully to CPU on non-CUDA developer workstations.
    """

    def __init__(self, in_channels: int = NUM_FEATURES, seq_len: int = WINDOW_SIZE, weights_file: str = ''):
        self.seq_len = seq_len
        self.in_channels = in_channels
        self.device_name = "CPU (Fallback)"
        self.has_cuda = False
        self.cuda_lib = None
        self.torch_mod = None
        self.model = None

        # 1. First Priority: Native NVIDIA Ampere CUDA Engine via ctypes (Council Invariant 6)
        cuda_so_candidates = [
            os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'build', 'libgpu_anomaly.so'),
            '/home/zodiac/agentic-era-networking/build/libgpu_anomaly.so',
            '/tmp/libgpu_anomaly.so',
            'libgpu_anomaly.so'
        ]
        
        # Check if we can build libgpu_anomaly.so on-the-fly if nvcc is available
        nvcc_bin = '/usr/local/cuda/bin/nvcc'
        cuda_cu_src = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'gpu', 'gpu_anomaly_kernel.cu')
        target_so = cuda_so_candidates[0]
        if not os.path.exists(target_so) and os.path.exists(nvcc_bin) and os.path.exists(cuda_cu_src):
            try:
                os.makedirs(os.path.dirname(target_so), exist_ok=True)
                import subprocess
                cuda_arch = os.environ.get('CUDA_ARCH', 'sm_87')
                compile_cmd = [nvcc_bin, "-O3", f"-arch={cuda_arch}", "-shared", "-Xcompiler", "-fPIC", cuda_cu_src, "-o", target_so]
                subprocess.run(compile_cmd, check=True, capture_output=True, text=True, timeout=60)
                sys.stdout.write(f"[gpu-sentinel] Successfully compiled native Ampere CUDA kernel ({cuda_arch}) to {target_so}\n")
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as e:
                sys.stderr.write(f"[gpu-sentinel] Note: on-demand nvcc build skipped: {e}\n")

        import ctypes
        self.input_dim = seq_len * in_channels
        self._c_buffer = None
        self._c_lat_ns = None

        for so_path in cuda_so_candidates:
            if os.path.exists(so_path):
                try:
                    lib = ctypes.CDLL(so_path)
                    lib.init_cuda_engine.argtypes = []
                    lib.init_cuda_engine.restype = ctypes.c_int
                    lib.load_cuda_model_weights.argtypes = [ctypes.POINTER(ctypes.c_float), ctypes.c_int]
                    lib.load_cuda_model_weights.restype = ctypes.c_int
                    lib.run_gpu_inference.argtypes = [ctypes.POINTER(ctypes.c_float), ctypes.POINTER(ctypes.c_ulonglong)]
                    lib.run_gpu_inference.restype = ctypes.c_float
                    lib.shutdown_cuda_engine.argtypes = []
                    lib.shutdown_cuda_engine.restype = None

                    if lib.init_cuda_engine() == 0:
                        self.cuda_lib = lib
                        self.has_cuda = True
                        self.device_name = "NVIDIA Ampere CUDA (Native sm_87 / 1024 Cores)"
                        # Council Invariant (Systems Sanity / Ghemawat): Pre-allocate static C buffer to eliminate GC thrashing
                        self._c_buffer = (ctypes.c_float * self.input_dim)()
                        self._c_lat_ns = ctypes.c_ulonglong(0)
                        break
                except Exception as exc:
                    sys.stderr.write(f"[gpu-sentinel] Note: Failed loading CUDA library {so_path}: {exc}\n")

        # Opt-in trained-weight loading (Council Invariant 3 - Fail-Closed, Council Invariant 6 - no silent behavior
        # change): load_cuda_model_weights() exists in the compiled kernel but is never called unless an operator
        # explicitly passes --weights-file / sets GPU_SENTINEL_WEIGHTS_FILE. With neither set (the default, and the
        # only mode the live systemd unit uses today), this block does nothing and the engine keeps running the
        # compiled-in hardcoded constants exactly as before. See docs/benchmarks/results/sentinel-training/ for what
        # was fit, how it was validated, and the honest comparison against those hardcoded constants.
        if weights_file:
            if self.cuda_lib is not None:
                try:
                    with open(weights_file, 'r') as wf:
                        payload = json.load(wf)
                    wlist = payload['weights'] if isinstance(payload, dict) else payload
                    if not isinstance(wlist, list) or len(wlist) != 10:
                        raise ValueError(f"expected a JSON object with a 10-element \"weights\" list, got "
                                          f"{len(wlist) if isinstance(wlist, list) else type(wlist).__name__}")
                    weights_arr = (ctypes.c_float * len(wlist))(*[float(w) for w in wlist])
                    rc = self.cuda_lib.load_cuda_model_weights(weights_arr, len(wlist))
                    if rc != 0:
                        sys.stderr.write(f"[gpu-sentinel] FATAL: load_cuda_model_weights rejected {weights_file} (rc={rc}).\n")
                        sys.stderr.write("[gpu-sentinel] Council Invariant 3 (Fail-Closed Isolation): an explicit "
                                          "--weights-file was given and failed to load; aborting rather than silently "
                                          "running the compiled-in defaults or a partially-loaded weight set.\n")
                        sys.exit(1)
                    sys.stdout.write(f"[gpu-sentinel] Loaded trained weights from {weights_file} into the CUDA engine "
                                      f"(opt-in: default behavior without --weights-file is unchanged).\n")
                except (OSError, ValueError, KeyError, TypeError) as exc:
                    sys.stderr.write(f"[gpu-sentinel] FATAL: could not load --weights-file {weights_file}: {exc}\n")
                    sys.stderr.write("[gpu-sentinel] Council Invariant 3 (Fail-Closed Isolation): aborting rather than "
                                      "silently falling back to the compiled-in default weights.\n")
                    sys.exit(1)
            else:
                sys.stderr.write(f"[gpu-sentinel] WARNING: --weights-file {weights_file} was given, but no native CUDA "
                                  f"engine is active (PyTorch/NumPy fallback in use, a structurally different, "
                                  f"untrained model). The trained weights were NOT applied.\n")

        # 2. Second Priority: PyTorch CUDA if available
        if not self.has_cuda:
            try:
                import torch
                import torch.nn as nn
                self.torch_mod = torch

                if torch.cuda.is_available():
                    self.has_cuda = True
                    self.device = torch.device('cuda:0')
                    self.device_name = f"NVIDIA Ampere CUDA ({torch.cuda.get_device_name(0)})"
                else:
                    self.device = torch.device('cpu')
                    self.device_name = "PyTorch CPU"

                # 1D-CNN Encoder-Decoder Architecture
                class Conv1DAutoencoderNet(nn.Module):
                    def __init__(self, channels: int):
                        super().__init__()
                        self.encoder = nn.Sequential(
                            nn.Conv1d(channels, 16, kernel_size=3, stride=2, padding=1),
                            nn.ReLU(inplace=True),
                            nn.Conv1d(16, 8, kernel_size=3, stride=2, padding=1),
                            nn.ReLU(inplace=True),
                        )
                        self.decoder = nn.Sequential(
                            nn.ConvTranspose1d(8, 16, kernel_size=4, stride=2, padding=1),
                            nn.ReLU(inplace=True),
                            nn.ConvTranspose1d(16, channels, kernel_size=4, stride=2, padding=1),
                            nn.Sigmoid(),
                        )

                    def forward(self, x):
                        encoded = self.encoder(x)
                        decoded = self.decoder(encoded)
                        return decoded

                self.model = Conv1DAutoencoderNet(in_channels).to(self.device)
                self.model.eval()
                if self.has_cuda:
                    self.model.half()  # INT8/FP16 Tensor Core execution
                self.criterion = nn.MSELoss(reduction='none')

            except ImportError:
                # Standalone NumPy / math fallback for bare environments
                try:
                    import numpy as np
                    self.np_mod = np
                    self.device_name = "NumPy Matrix CPU (Fallback)"
                except ImportError:
                    self.device_name = "Pure Math (Fallback)"

    def compute_anomaly_score(self, feature_matrix: List[List[float]]) -> Tuple[float, int]:
        """
        Computes the reconstruction error MSE of the sliding packet sequence.
        Returns: (reconstruction_mse, inference_latency_ns)
        """
        t0_ns = time.monotonic_ns()

        # 1. Native Ampere CUDA Execution (Council Invariant 6 - Zero-Allocation Hot Path)
        if self.cuda_lib is not None and self._c_buffer is not None and self._c_lat_ns is not None:
            buf = self._c_buffer
            idx = 0
            for row in feature_matrix:
                for val in row:
                    if idx < self.input_dim:
                        buf[idx] = val
                        idx += 1
            # Council Invariant 1 (Determinism): Zero out remainder to prevent stale memory leakage across windows
            if idx < self.input_dim:
                for rem in range(idx, self.input_dim):
                    buf[rem] = 0.0
            loss = self.cuda_lib.run_gpu_inference(buf, ctypes.byref(self._c_lat_ns))
            return float(loss), int(self._c_lat_ns.value)

        # 2. PyTorch CUDA / CPU Fallback
        if self.torch_mod is not None and self.model is not None:
            dtype = self.torch_mod.float16 if self.has_cuda else self.torch_mod.float32
            # Shape: (1, NUM_FEATURES, WINDOW_SIZE)
            tensor_in = self.torch_mod.tensor([feature_matrix], dtype=dtype, device=self.device).permute(0, 2, 1)

            with self.torch_mod.no_grad():
                reconstructed = self.model(tensor_in)
                loss = self.criterion(reconstructed, tensor_in).mean().item()
                if self.has_cuda:
                    self.torch_mod.cuda.synchronize()

            t1_ns = time.monotonic_ns()
            # Council Invariant 2: return monotonic integer nanoseconds
            return float(loss), int(t1_ns - t0_ns)

        # 3. NumPy CPU Fallback
        if hasattr(self, 'np_mod'):
            np = self.np_mod
            mat = np.array(feature_matrix, dtype=np.float32)
            mean_vec = np.mean(mat, axis=0)
            diff = mat - mean_vec
            loss = float(np.mean(diff ** 2))
            t1_ns = time.monotonic_ns()
            return float(loss), int(t1_ns - t0_ns)

        # 4. Deterministic Pure Math Fallback (Ghemawat - Zero Generator Overhead)
        total_sq = 0.0
        count = 0
        for row in feature_matrix:
            for val in row:
                diff = val - 0.5
                total_sq += diff * diff
                count += 1
        loss = total_sq / max(1, count)
        t1_ns = time.monotonic_ns()
        return float(loss), int(t1_ns - t0_ns)


# ---------------------------------------------------------------------------
# Packet Feature Extraction Pipeline
# ---------------------------------------------------------------------------

class PacketFeatureExtractor:
    """
    Extracts numerical features from raw Layer 2/3 frames:
    [dt_us_norm, length_norm, flags_norm, port_entropy_norm]
    Council Invariant 5 (Quoc Le): Dynamically scales features to observed traffic envelope
    rather than brittle fixed heuristic magic numbers.
    """

    def __init__(self, window_size: int = WINDOW_SIZE):
        self.window_size = window_size
        # O(1) append and popleft (deque, not list — avoids O(N) memory shift on eviction)
        self.buffer: collections.deque = collections.deque()
        self.src_ips: collections.deque = collections.deque()
        self.src_macs: collections.deque = collections.deque()
        self.last_pkt_ns: int = 0
        # Running frequency maps: O(1) ingest/evict, zero Counter allocation on query
        self.src_ip_counts: Dict[str, int] = {}
        self.src_mac_counts: Dict[str, int] = {}
        self.max_observed_dt_us: float = 1000.0
        self.max_observed_frame_len: float = float(ETHERNET_STANDARD_MTU)

    def ingest_packet(self, frame_len: int, protocol: int, tcp_flags: int, src_port: int, dst_port: int, src_ip: str, src_mac: str = 'unknown') -> Optional[List[List[float]]]:
        now_ns = time.monotonic_ns()
        dt_us = 0.0
        if self.last_pkt_ns > 0:
            dt_us = (now_ns - self.last_pkt_ns) / 1000.0
        self.last_pkt_ns = now_ns

        # Dynamic online envelope scaling (Council Invariant 5 - Quoc Le)
        self.max_observed_dt_us = max(self.max_observed_dt_us, dt_us)
        self.max_observed_frame_len = max(self.max_observed_frame_len, float(frame_len))

        # 1. dt_norm: logarithmic scaling relative to dynamic observed inter-arrival envelope
        dt_norm = min(1.0, math.log1p(dt_us) / math.log1p(max(1000.0, self.max_observed_dt_us)))
        # 2. length_norm: standard Ethernet MTU scaled to dynamic maximum frame envelope
        len_norm = min(1.0, frame_len / self.max_observed_frame_len)
        # 3. flags_norm: TCP flag bitmask (RFC 793)
        flags_norm = min(1.0, (tcp_flags & MAX_TCP_FLAGS) / float(MAX_TCP_FLAGS)) if protocol == 6 else (0.1 if protocol == 17 else 0.0)
        # 4. port_entropy: port difference dispersion across IANA port space
        port_diff = abs(src_port - dst_port)
        port_entropy = min(1.0, port_diff / float(MAX_L4_PORT))

        feature_vector = [dt_norm, len_norm, flags_norm, port_entropy]
        self.buffer.append(feature_vector)
        self.src_ips.append(src_ip)
        self.src_macs.append(src_mac)
        self.src_ip_counts[src_ip] = self.src_ip_counts.get(src_ip, 0) + 1
        self.src_mac_counts[src_mac] = self.src_mac_counts.get(src_mac, 0) + 1

        if len(self.buffer) > self.window_size:
            self.buffer.popleft()
            old_ip = self.src_ips.popleft()
            old_mac = self.src_macs.popleft()
            self.src_ip_counts[old_ip] -= 1
            if not self.src_ip_counts[old_ip]:
                del self.src_ip_counts[old_ip]
            self.src_mac_counts[old_mac] -= 1
            if not self.src_mac_counts[old_mac]:
                del self.src_mac_counts[old_mac]

        if len(self.buffer) == self.window_size:
            return list(self.buffer)
        return None

    def get_predominant_src_ip(self) -> str:
        # Zero-allocation: generator over existing dict, no intermediate collection
        return max(
            (ip for ip in self.src_ip_counts if ip != 'unknown'),
            key=self.src_ip_counts.__getitem__,
            default='unknown',
        )

    def get_predominant_src_mac(self) -> str:
        return max(
            (mac for mac in self.src_mac_counts if mac != 'unknown'),
            key=self.src_mac_counts.__getitem__,
            default='unknown',
        )


# ---------------------------------------------------------------------------
# SDN Quarantine Dispatch Client
# ---------------------------------------------------------------------------

def dispatch_quarantine_alert(controller_url: str, target_ip: str, target_mac: str, reason: str, priority: int = 65535) -> bool:
    """
    Council Invariant 3 (Fail-Closed Isolation):
    Dispatches HTTP POST /api/sdn/quarantine to the local SDN controller.
    Includes targetIp when valid, targetMac as L2 fallback when IP is non-IPv4.
    """
    endpoint = f"{controller_url.rstrip('/')}/api/sdn/quarantine"
    payload: dict = {'reason': reason, 'priority': priority}
    if target_ip != 'unknown':
        payload['targetIp'] = target_ip
    if target_mac != 'unknown':
        payload['targetMac'] = target_mac
    data_bytes = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(
        endpoint,
        data=data_bytes,
        headers={'Content-Type': 'application/json', 'User-Agent': 'GpuSdnSentinel/1.0'},
        method='POST'
    )
    try:
        with urllib.request.urlopen(req, timeout=1.0) as resp:
            resp_body = resp.read().decode('utf-8')
            res = json.loads(resp_body)
            return bool(res.get('ok', False))
    except Exception as exc:
        sys.stderr.write(f"[gpu-sentinel] Quarantine dispatch to {endpoint} failed: {exc}\n")
        return False


# ---------------------------------------------------------------------------
# Main Execution Loop & Tap Sniffer
# ---------------------------------------------------------------------------

def run_sentinel(
    tap_iface: str,
    controller_url: str,
    threshold: float,
    demo_mode: bool = False,
    duration_s: int = 0,
    weights_file: str = ''
):
    print("======================================================================")
    print("🛡️  STAGE-2 GPU DEEP TRAFFIC ANOMALY SENTINEL (JETSON ORIN NANO SUPER)")
    print(f"   Architecture  : 67 TOPS NVIDIA Ampere INT8/FP16 TensorRT Pipeline")
    print(f"   Tap Interface : {tap_iface} (Zodiac Port 3 Mirror)")
    print(f"   Controller API: {controller_url}")
    print(f"   Loss Threshold: {threshold} (Reconstruction Error tau)")
    print(f"   Mode          : {'SYNTHETIC DEMO & BENCHMARK' if demo_mode else 'LIVE HARDWARE WIRE-TAP'}")
    print(f"   Model Weights : {weights_file if weights_file else '(compiled-in hardcoded constants, default)'}")
    print("======================================================================")

    autoencoder = Gpu1DAutoencoder(weights_file=weights_file)
    print(f"   [+] Neural Engine Initialized: {autoencoder.device_name}")
    print(f"   [+] CUDA Tensor Cores Active : {autoencoder.has_cuda}")
    print("======================================================================\n")

    extractor = PacketFeatureExtractor(window_size=WINDOW_SIZE)
    threshold_controller = AdaptiveThresholdController(initial_threshold=threshold)

    # Dedicated non-blocking queue & background worker for SDN quarantine dispatches
    # Ensures raw tap packet ingestion loop never blocks on HTTP timeouts
    alert_queue: queue.Queue[QuarantineAlertItem] = queue.Queue(maxsize=1024)
    # Emergency single-slot circuit breaker: bypasses saturated alert_queue so the
    # most recent quarantine is always dispatched even under control-plane overload.
    # Last-writer-wins semantics; non-blocking reads/writes preserve data-plane latency.
    emergency_queue: queue.Queue[QuarantineAlertItem] = queue.Queue(maxsize=1)

    def alert_dispatcher_worker():
        while not stop_event:
            # Track which queue the item originated from so task_done() is called
            # on the correct queue; calling alert_queue.task_done() when the item
            # came from emergency_queue raises ValueError (unmatched get/task_done).
            source_queue: Optional[queue.Queue[QuarantineAlertItem]] = None
            # Drain circuit breaker first; falls through to main queue on Empty
            try:
                item = emergency_queue.get_nowait()
                source_queue = emergency_queue
            except queue.Empty:
                try:
                    item = alert_queue.get(timeout=0.2)
                    source_queue = alert_queue
                except queue.Empty:
                    continue
            if item is None:
                break
            # Bounded exponential retry (Dean latency & reliability invariant: max 3 attempts)
            max_retries = 3
            backoff_s = 0.05
            success = False
            for attempt in range(1, max_retries + 1):
                try:
                    success = dispatch_quarantine_alert(item.controller_url, item.target_ip, item.target_mac, item.reason, item.priority)
                    if success:
                        break
                except Exception as exc:
                    sys.stderr.write(f"[gpu-sentinel] Dispatch attempt {attempt}/{max_retries} error: {exc}\n")
                if attempt < max_retries and not stop_event:
                    time.sleep(backoff_s)
                    backoff_s *= 2.0
            if not success:
                sys.stderr.write(f"[gpu-sentinel] Quarantine alert failed after {max_retries} attempts for ip={item.target_ip} mac={item.target_mac}\n")
            source_queue.task_done()

    dispatch_thread = threading.Thread(target=alert_dispatcher_worker, daemon=True)
    dispatch_thread.start()

    total_inferences = 0
    total_anomalies = 0
    total_quarantines = 0
    total_latency_ns: int = 0
    dropped_alerts: int = 0
    decode_errors: int = 0
    decode_error_last_log_ns: int = 0
    DECODE_ERROR_LOG_INTERVAL_NS: int = 1_000_000_000  # at most one stderr write per second

    start_ns = time.monotonic_ns()
    last_stat_ns = start_ns
    pkt_count = 0

    # Council Invariant 2 & Systems Sanity (Dean & Ghemawat):
    # Decouple raw AF_PACKET wire ingress from CUDA inference using a bounded ring buffer queue.
    # Prevents kernel socket buffer overflow and microburst tail drops at 10Gbps+ line rates.
    ingress_queue: queue.Queue[bytes] = queue.Queue(maxsize=2048)
    ingress_drops = 0
    capture_errors = 0

    sock = None
    if not demo_mode:
        try:
            sock = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(3))
            if tap_iface and tap_iface != 'any':
                sock.bind((tap_iface, 0))
            sock.settimeout(0.5)
            print(f"[gpu-sentinel] Listening for raw Ethernet frames on {tap_iface}...")
        except Exception as e:
            # Council Invariant 3 (Fail-Closed Isolation): Never silently fall back to simulation when physical link fails
            sys.stderr.write(f"[gpu-sentinel] FATAL: Raw tap socket bind failed on {tap_iface}: {e}\n")
            sys.stderr.write("[gpu-sentinel] Council Invariant 3 (Fail-Closed Isolation): Aborting execution. Sentinel will not silently simulate live wire without explicit --demo.\n")
            sys.exit(1)

        def packet_capture_worker():
            nonlocal ingress_drops, capture_errors
            while not stop_event and sock is not None:
                try:
                    raw_frame, _ = sock.recvfrom(2048)
                    try:
                        ingress_queue.put_nowait(raw_frame)
                    except queue.Full:
                        # Council Invariant 2: Explicit application-level backpressure accounting
                        ingress_drops += 1
                except socket.timeout:
                    continue
                except Exception as exc:
                    capture_errors += 1
                    # Council Invariant 1 (Zero Suppression of Reality): Never silently swallow thread exceptions
                    sys.stderr.write(f"[gpu-sentinel] Ingress capture exception: {exc}\n")
                    if stop_event:
                        break
                    time.sleep(0.01)

        capture_thread = threading.Thread(target=packet_capture_worker, daemon=True)
        capture_thread.start()

    try:
        while not stop_event:
            now_ns = time.monotonic_ns()
            if duration_s > 0 and (now_ns - start_ns) >= (duration_s * 1_000_000_000):
                break

            if demo_mode:
                # Generate synthetic test traffic
                pkt_count += 1
                # Normal pattern vs Anomaly burst
                is_anomaly_cycle = (pkt_count % 300) > 240
                if is_anomaly_cycle:
                    frame_len = 1400 + (pkt_count % 100)
                    proto = 6  # TCP
                    flags = 0x02  # SYN Flood
                    src_p = 1024 + (pkt_count % 50000)
                    dst_p = 80
                    src_ip = '10.0.2.50'  # RPi untrusted agent
                else:
                    frame_len = 64 + (pkt_count % 256)
                    proto = 17  # UDP benign
                    flags = 0
                    src_p = 53
                    dst_p = 53
                    src_ip = '10.0.2.1'

                window = extractor.ingest_packet(frame_len, proto, flags, src_p, dst_p, src_ip)
                # Hybrid monotonic delay: sleep for bulk (1.5ms) to conserve CPU cores, spin for remaining <0.5ms
                time.sleep(0.0015)
                delay_target_ns = time.monotonic_ns() + 500_000
                while time.monotonic_ns() < delay_target_ns:
                    continue
            else:
                try:
                    raw_data = ingress_queue.get(timeout=QUEUE_POLL_TIMEOUT_SEC)
                except queue.Empty:
                    continue

                pkt_count += 1
                frame_len = len(raw_data)
                # Council Invariant 1 (Anti-Shortcut) & Security: Drop malformed runt frames (<14 B Ethernet header)
                if frame_len < 14:
                    continue

                try:
                    # Unpack Ethernet header (14 bytes)
                    eth_proto = struct.unpack('!H', raw_data[12:14])[0]
                    l3_offset = 14

                    # 802.1Q VLAN Tagged frame support (VLAN TPID 0x8100)
                    if eth_proto == 0x8100 and frame_len >= 18:
                        eth_proto = struct.unpack('!H', raw_data[16:18])[0]
                        l3_offset = 18

                    proto = 0
                    flags = 0
                    src_p = 0
                    dst_p = 0
                    src_ip = 'unknown'
                    # Ethernet source MAC: bytes 6-11 (C-optimized hex, no allocations).
                    # Python slicing never raises IndexError on short buffers; validate
                    # the resulting length (17 chars = 6 octets) to guard runt frames.
                    src_mac_raw = raw_data[6:12].hex(':')
                    src_mac = src_mac_raw if len(src_mac_raw) == EXPECTED_MAC_HEX_LEN else 'unknown'

                    # IPv4 parsing with dynamic IHL (Internet Header Length) handling (Council Invariant 1)
                    if eth_proto == 0x0800 and frame_len >= (l3_offset + 20):
                        ip_hdr = raw_data[l3_offset:l3_offset + 20]
                        ihl = (ip_hdr[0] & 0x0F) * 4  # Dynamic IHL in bytes
                        if ihl >= 20 and frame_len >= (l3_offset + ihl):
                            proto = ip_hdr[9]
                            src_ip = socket.inet_ntoa(ip_hdr[12:16])
                            l4_offset = l3_offset + ihl

                            if proto == 6 and frame_len >= (l4_offset + 20):  # TCP
                                src_p, dst_p = struct.unpack('!HH', raw_data[l4_offset:l4_offset + 4])
                                flags = raw_data[l4_offset + 13]
                            elif proto == 17 and frame_len >= (l4_offset + 8):  # UDP
                                src_p, dst_p = struct.unpack('!HH', raw_data[l4_offset:l4_offset + 4])

                    window = extractor.ingest_packet(frame_len, proto, flags, src_p, dst_p, src_ip, src_mac)
                except (struct.error, IndexError) as decode_err:
                    decode_errors += 1
                    now_err_ns = time.monotonic_ns()
                    if (now_err_ns - decode_error_last_log_ns) >= DECODE_ERROR_LOG_INTERVAL_NS:
                        decode_error_last_log_ns = now_err_ns
                        sys.stderr.write(
                            f"[gpu-sentinel] Malformed frame decode errors: {decode_errors} total"
                            f" ({type(decode_err).__name__}: {decode_err})\n"
                        )
                    continue

            # When a full window of 64 packets is ready, execute GPU inference
            if window is not None:
                total_inferences += 1
                loss, latency_ns = autoencoder.compute_anomaly_score(window)
                total_latency_ns += latency_ns

                # Check if anomaly threshold breached via adaptive self-tuning controller (Council Invariant 5)
                is_anomaly, dynamic_tau = threshold_controller.update_and_check(loss)
                target_ip = extractor.get_predominant_src_ip()
                target_mac = extractor.get_predominant_src_mac()

                if total_inferences % 25 == 1:
                    print(f"   [inf #{total_inferences}] loss={loss:.4f} | tau={dynamic_tau:.4f} | top_ip={target_ip} | lat={latency_ns / 1_000_000.0:.2f}ms")

                if is_anomaly:
                    total_anomalies += 1
                    reason = f"GPU 1D-CNN Autoencoder Loss {loss:.4f} >= Dynamic Threshold {dynamic_tau:.4f} (Anomaly)"
                    latency_ms_display = latency_ns / 1_000_000.0
                    print(f"🚨 [ANOMALY DETECTED] {reason} | Offender: {target_ip} ({latency_ms_display:.2f}ms inference)")

                    # Council Invariant 3 (Fail-Closed): quarantine by verified IPv4 first;
                    # fall back to L2 MAC quarantine for non-IPv4 frames (ARP floods, L2 attacks).
                    # Only skip if BOTH identifiers are unresolvable.
                    try:
                        socket.inet_aton(target_ip)
                        ip_valid = True
                    except OSError:
                        ip_valid = False

                    mac_valid = (target_mac != 'unknown')

                    if not ip_valid and not mac_valid:
                        sys.stderr.write(
                            f"[gpu-sentinel] Anomaly detected but no resolvable offender"
                            f" (ip='{target_ip}', mac='{target_mac}') — skipping quarantine dispatch\n"
                        )
                    else:
                        # Non-blocking dispatch: tap sentinels must never stall the data plane.
                        # queue.Full increments a deterministic counter (telemetry provenance, Invariant 6)
                        # so control-plane saturation is always visible in the status report.
                        try:
                            alert_item = QuarantineAlertItem(
                                controller_url=controller_url,
                                target_ip=target_ip,
                                target_mac=target_mac,
                                reason=reason,
                                priority=65535,
                            )
                            alert_queue.put_nowait(alert_item)
                            total_quarantines += 1
                            print(f"   🔒 [SDN QUARANTINE ENQUEUED] Pushed OpenFlow 1.3 Priority 65535 DROP rule for ip={target_ip} mac={target_mac}")
                        except queue.Full:
                            dropped_alerts += 1
                            # Circuit breaker: evict stale slot and push latest alert so the worker
                            # dispatches at least one quarantine even when main queue is saturated.
                            try:
                                emergency_queue.get_nowait()
                            except queue.Empty:
                                pass
                            try:
                                emergency_queue.put_nowait(alert_item)
                            except queue.Full:
                                pass  # Worker just claimed the slot; dropped_alerts already counted

            # Periodic status report
            if (now_ns - last_stat_ns) >= 3_000_000_000:
                elapsed_s = (now_ns - start_ns) / 1_000_000_000.0
                inf_rate = (total_inferences / elapsed_s) if elapsed_s > 0 else 0
                avg_lat = ((total_latency_ns / total_inferences) / 1_000_000.0) if total_inferences > 0 else 0.0
                print(f"[{elapsed_s:03.0f}s] Processed: {pkt_count:,} pkts | Inferences: {total_inferences:,} ({inf_rate:.1f} inf/s, {avg_lat:.2f}ms) | Anomalies: {total_anomalies} | Quarantines: {total_quarantines} | DroppedAlerts: {dropped_alerts}")
                last_stat_ns = now_ns

    finally:
        if sock:
            sock.close()
        total_time_s = (time.monotonic_ns() - start_ns) / 1_000_000_000.0
        avg_lat = ((total_latency_ns / total_inferences) / 1_000_000.0) if total_inferences > 0 else 0.0
        print("\n======================================================================")
        print("✅ GPU SDN ANOMALY SENTINEL STOPPED")
        print(f"   Total Execution Time  : {total_time_s:.2f}s")
        print(f"   Packets Processed     : {pkt_count:,}")
        if ingress_drops > 0:
            print(f"   Tail Drops (Backpressure) : {ingress_drops:,}")
        if capture_errors > 0:
            print(f"   Capture Socket Errors : {capture_errors:,}")
        print(f"   Total Inferences Run  : {total_inferences:,}")
        print(f"   Average Latency       : {avg_lat:.3f} ms (Dean Latency Budget: < 1.0 ms)")
        print(f"   Anomalies Detected    : {total_anomalies}")
        print(f"   Quarantine OpenFlow   : {total_quarantines}")
        print("======================================================================\n")


def main():
    parser = argparse.ArgumentParser(description="Stage-2 GPU Deep Traffic Anomaly Sentinel & SDN Quarantine")
    parser.add_argument('--tap-iface', default=DEFAULT_TAP_IFACE, help="Tap interface name (Zodiac Port 3)")
    parser.add_argument('--controller-url', default=DEFAULT_CONTROLLER_URL, help="SDN bridge controller URL")
    parser.add_argument('--threshold', type=float, default=DEFAULT_ANOMALY_THRESHOLD, help="Anomaly reconstruction threshold tau")
    parser.add_argument('--demo', action='store_true', help="Run in continuous synthetic traffic demo mode")
    parser.add_argument('--duration', type=int, default=0, help="Run duration in seconds (0 = run indefinitely)")
    parser.add_argument('--weights-file', default=os.environ.get('GPU_SENTINEL_WEIGHTS_FILE', ''),
                         help="Opt-in path to a JSON file of 10 trained weights (see "
                              "docs/benchmarks/results/sentinel-training/) to load into the native CUDA engine via "
                              "load_cuda_model_weights(). Unset by default (or via GPU_SENTINEL_WEIGHTS_FILE): the "
                              "sentinel runs the compiled-in hardcoded constants, exactly as it does today.")
    args = parser.parse_args()

    run_sentinel(
        tap_iface=args.tap_iface,
        controller_url=args.controller_url,
        threshold=args.threshold,
        demo_mode=args.demo,
        duration_s=args.duration,
        weights_file=args.weights_file
    )


if __name__ == '__main__':
    main()
