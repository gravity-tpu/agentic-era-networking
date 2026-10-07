"""
benchmark.py
============
Hardware streaming benchmark runner using hailortcli.

Council Invariants:
- INV-1 (Anti-Shortcut Law): Explicit process status verification, capturing stdout/stderr.
- INV-2 (Determinism): Real time elapsed in monotonic nanoseconds, integer frame counters.
- INV-6 (Epistemic Provenance): Pure physical execution on Hailo-8 silicon, capturing real thermals.
"""

import os
import re
import subprocess
import time
from typing import Optional
from schemas import BenchmarkResponse


def run_hardware_benchmark(
    hef_path: str,
    seconds: int = 3,
    measure_latency: bool = False,
) -> BenchmarkResponse:
    """
    Executes native hailortcli hardware benchmark on specified HEF file.
    Returns BenchmarkResponse with parsed metrics and raw CLI stdout.
    """
    if not os.path.exists(hef_path):
        raise FileNotFoundError(f"HEF model path not found: {hef_path}")

    cmd = ["hailortcli", "run", hef_path, "--time-to-run", str(seconds), "--measure-temp"]
    if measure_latency:
        cmd.append("--measure-latency")

    env_timeout = os.environ.get("HAILO_BENCHMARK_TIMEOUT_SEC")
    timeout_sec = min(int(env_timeout) if env_timeout and env_timeout.isdigit() else max(seconds * 2, seconds + 5), 60)
    t_start = time.perf_counter_ns()
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            shell=False,
        )
    except subprocess.TimeoutExpired as e:
        raise TimeoutError(f"hailortcli benchmark timed out after {timeout_sec}s: {e}")
    t_end = time.perf_counter_ns()
    duration_ns = t_end - t_start

    stdout = proc.stdout
    stderr = proc.stderr

    if proc.returncode != 0:
        raise RuntimeError(f"hailortcli benchmark failed with code {proc.returncode}: {stderr or stdout}")

    # Parse metrics from stdout using pure integer accounting (INV-2 Determinism)
    frames_count = 0
    hw_latency_ns: Optional[int] = None
    temp_min_c: Optional[float] = None
    temp_avg_c: Optional[float] = None
    temp_max_c: Optional[float] = None

    m_frames = re.search(r"Frames count:\s*(\d+)", stdout)
    if m_frames:
        frames_count = int(m_frames.group(1))

    # Calculate throughput in milliframes per second using pure integer arithmetic (INV-2)
    fps_milli = 0
    if frames_count > 0 and duration_ns > 0:
        fps_milli = (frames_count * 1_000_000_000_000) // duration_ns
    else:
        m_fps = re.search(r"FPS:\s*(\d+)(?:\.(\d+))?", stdout)
        if m_fps:
            whole = int(m_fps.group(1))
            frac_str = (m_fps.group(2) or "0")[:3].ljust(3, "0")
            fps_milli = whole * 1000 + int(frac_str)

    m_lat = re.search(r"HW Latency:\s*(\d+)(?:\.(\d+))?\s*ms", stdout)
    if m_lat:
        whole_ms = int(m_lat.group(1))
        # Pure integer conversion without float arithmetic (1 ms = 1,000,000 ns)
        frac_ms_str = (m_lat.group(2) or "0")[:6].ljust(6, "0")
        hw_latency_ns = whole_ms * 1_000_000 + int(frac_ms_str)

    m_tmin = re.search(r"Minimum chip temperature:\s*([\d\.]+)C", stdout)
    if m_tmin:
        temp_min_c = float(m_tmin.group(1))

    m_tavg = re.search(r"Average chip temperature:\s*([\d\.]+)C", stdout)
    if m_tavg:
        temp_avg_c = float(m_tavg.group(1))

    m_tmax = re.search(r"Maximum chip temperature:\s*([\d\.]+)C", stdout)
    if m_tmax:
        temp_max_c = float(m_tmax.group(1))

    return BenchmarkResponse(
        source="rpi5_hailo8_npu",
        model_name=os.path.basename(hef_path),
        frames_count=frames_count,
        duration_ns=duration_ns,
        fps_milli=fps_milli,
        hw_latency_ns=hw_latency_ns,
        temp_min_c=temp_min_c,
        temp_avg_c=temp_avg_c,
        temp_max_c=temp_max_c,
        raw_output=stdout,
    )
