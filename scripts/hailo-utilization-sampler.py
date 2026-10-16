#!/usr/bin/env python3
"""
scripts/hailo-utilization-sampler.py
====================================
Samples Hailo-8 utilization during a load run on the Pi 5 and writes one JSON object per sample to a file (JSONL).

Utilization comes from `hailortcli monitor`, which only reports for a process started with HAILO_MONITOR=1 (the
hailo-inference unit sets it through /etc/systemd/system/hailo-inference.service.d/monitor.conf). Each sample is a
short, bounded `hailortcli monitor` read plus the service's own /health chip temperatures. A sample that cannot be
read is written with `error` set and null values, never filled in or dropped (Invariant 6). Timestamps are monotonic
nanoseconds (Invariant 2); utilization and FPS are tenths, kept as integers.

Usage: python3 hailo-utilization-sampler.py --out run.jsonl --duration 120 [--interval-s 2] [--health http://127.0.0.1:8000/health]
"""

import argparse
import json
import re
import subprocess
import sys
import time
import urllib.request

MONITOR_TIMEOUT_S = 3
HEALTH_TIMEOUT_S = 2
ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]")
DEVICE_ROW = re.compile(r"^\s*([0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f])\s+(\d+(?:\.\d+)?)\s+(\S+)")
MODEL_ROW = re.compile(r"^\s*(\S+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+)\s*$")


def tenths(text: str) -> int:
    whole, _, frac = text.partition(".")
    return int(whole) * 10 + (int(frac[0]) if frac else 0)


def read_monitor() -> dict:
    try:
        proc = subprocess.run(
            ["hailortcli", "monitor"], capture_output=True, text=True, timeout=MONITOR_TIMEOUT_S, check=False
        )
        out = proc.stdout
    except subprocess.TimeoutExpired as e:
        # hailortcli monitor is a TUI that never exits on its own: the timeout is the normal end of a read.
        out = (e.stdout.decode("utf-8", "replace") if isinstance(e.stdout, bytes) else e.stdout) or ""
    except OSError as e:
        return {"error": f"hailortcli not runnable: {e}"}
    device = model = None
    for line in ANSI.sub("", out).splitlines():
        if device is None:
            m = DEVICE_ROW.match(line)
            if m:
                device = {"id": m.group(1), "util_tenths_pct": tenths(m.group(2)), "arch": m.group(3)}
                continue
        m = MODEL_ROW.match(line)
        if m and model is None:
            model = {"name": m.group(1), "util_tenths_pct": tenths(m.group(2)), "fps_tenths": tenths(m.group(3)), "pid": int(m.group(4))}
    if device is None:
        return {"error": "no device row in hailortcli monitor output (is HAILO_MONITOR=1 set on the service?)"}
    return {"device": device, "model": model}


def read_health(url: str) -> dict:
    try:
        with urllib.request.urlopen(url, timeout=HEALTH_TIMEOUT_S) as r:
            h = json.loads(r.read().decode("utf-8"))
        return {"chip_ts0_milli_c": round(float(h["chip_ts0_c"]) * 1000), "chip_ts1_milli_c": round(float(h["chip_ts1_c"]) * 1000)}
    except (OSError, ValueError, KeyError) as e:
        return {"health_error": str(e)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--duration", type=int, required=True, help="seconds")
    ap.add_argument("--interval-s", type=int, default=2)
    ap.add_argument("--health", default="http://127.0.0.1:8000/health")
    a = ap.parse_args()
    if not 1 <= a.duration <= 7200 or not 1 <= a.interval_s <= 60:
        sys.stderr.write("duration must be 1..7200 s and interval 1..60 s\n")
        return 2
    start = time.monotonic_ns()
    deadline = start + a.duration * 1_000_000_000
    n = bad = 0
    with open(a.out, "w", encoding="utf-8") as f:
        while time.monotonic_ns() < deadline:
            tick = time.monotonic_ns()
            row = {"t_ns": tick - start, **read_monitor(), **read_health(a.health)}
            n += 1
            bad += 1 if "error" in row else 0
            f.write(json.dumps(row) + "\n")
            f.flush()
            rest = a.interval_s * 1_000_000_000 - (time.monotonic_ns() - tick)
            if rest > 0:
                time.sleep(rest / 1e9)
    sys.stderr.write(f"{n} samples, {bad} unreadable\n")
    return 0 if bad < n else 1


if __name__ == "__main__":
    sys.exit(main())
