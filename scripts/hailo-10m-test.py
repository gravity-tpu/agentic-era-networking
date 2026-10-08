#!/usr/bin/env python3
"""
scripts/hailo-10m-test.py
=========================
Continuous 10-minute neural inference stress test for Raspberry Pi 5 + Hailo-8 M.2 (26 TOPS).
Sends continuous hardware inference requests to http://10.0.0.179:8000/infer (or 10.0.2.51:8000).

Council Invariants:
- INV-1 (Zero Suppression of Reality): Explicit socket and HTTP error handling.
- INV-2 (Determinism & Precision): Pure monotonic nanosecond accounting (time.perf_counter_ns()).
- INV-6 (Goodhart's Law & Epistemic Provenance): Physical Hailo-8 NPU DMA execution with live silicon thermals.

Usage:
  python3 scripts/hailo-10m-test.py                   # 10 minutes (600s) default
  python3 scripts/hailo-10m-test.py --duration 600    # Explicit 600s
  python3 scripts/hailo-10m-test.py --host 10.0.0.179 --workers 2
"""

import argparse
import base64
import http.client
import json
import os
import signal
import sys
import threading
import time
from typing import Optional

STATUS_FILE = "/tmp/hailo-load-status.json"

stop_requested = threading.Event()


def handle_sigint(signum, frame):
    sys.stdout.write("\n[!] Cancellation requested. Stopping inference workers cleanly...\n")
    stop_requested.set()


signal.signal(signal.SIGINT, handle_sigint)
signal.signal(signal.SIGTERM, handle_sigint)


class StatsCollector:
    def __init__(self):
        self.lock = threading.Lock()
        self.total_frames = 0
        self.total_dma_ns = 0
        self.total_roundtrip_ns = 0
        self.errors = 0
        self.last_chip_temp_c: Optional[float] = None
        self.window_frames = 0
        self.window_start_ns = time.perf_counter_ns()

    def record_success(self, roundtrip_ns: int, dma_ns: int, chip_temp_c: Optional[float]):
        with self.lock:
            self.total_frames += 1
            self.window_frames += 1
            self.total_roundtrip_ns += roundtrip_ns
            self.total_dma_ns += dma_ns
            if chip_temp_c is not None:
                self.last_chip_temp_c = chip_temp_c

    def record_error(self):
        with self.lock:
            self.errors += 1

    def get_window_rate(self) -> float:
        with self.lock:
            now_ns = time.perf_counter_ns()
            dt_sec = (now_ns - self.window_start_ns) / 1e9
            rate = (self.window_frames / dt_sec) if dt_sec > 0 else 0.0
            self.window_frames = 0
            self.window_start_ns = now_ns
            return rate

    def snapshot(self):
        with self.lock:
            return {
                "total_frames": self.total_frames,
                "total_dma_ms": (self.total_dma_ns / 1e6 / self.total_frames) if self.total_frames > 0 else 0.0,
                "avg_roundtrip_ms": (self.total_roundtrip_ns / 1e6 / self.total_frames) if self.total_frames > 0 else 0.0,
                "errors": self.errors,
                "last_chip_temp_c": self.last_chip_temp_c,
            }


def worker_loop(worker_id: int, host: str, port: int, payload: bytes, stats: StatsCollector):
    headers = {
        "Content-Type": "application/json",
        "Connection": "keep-alive",
        "User-Agent": f"ZodiacHailoLoadClient/{worker_id}",
    }

    conn: Optional[http.client.HTTPConnection] = None

    def get_connection():
        return http.client.HTTPConnection(host, port, timeout=10)

    try:
        conn = get_connection()
        while not stop_requested.is_set():
            t0 = time.perf_counter_ns()
            try:
                conn.request("POST", "/infer", body=payload, headers=headers)
                resp = conn.getresponse()
                body = resp.read()
                t1 = time.perf_counter_ns()

                if resp.status == 200:
                    data = json.loads(body.decode("utf-8"))
                    dma_ns = data.get("timing", {}).get("inference_ns", 0)
                    chip_temp = data.get("chip_temp_c")
                    stats.record_success(t1 - t0, dma_ns, chip_temp)
                else:
                    stats.record_error()
                    time.sleep(0.05)
            except (http.client.HTTPException, ConnectionError, OSError, TimeoutError):
                stats.record_error()
                try:
                    conn.close()
                except Exception:
                    pass
                time.sleep(0.1)
                conn = get_connection()
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass


def main():
    parser = argparse.ArgumentParser(description="Send 10-minute continuous inference workload to Hailo-8 NPU")
    parser.add_argument("--host", default="10.0.0.179", help="Target host IP (default: 10.0.0.179)")
    parser.add_argument("--port", type=int, default=8000, help="Target port (default: 8000)")
    parser.add_argument("--duration", type=int, default=600, help="Test duration in seconds (default: 600s = 10 min)")
    parser.add_argument("--workers", type=int, default=2, help="Parallel worker threads (default: 2)")
    parser.add_argument("--image", default="services/hailo-inference/bus_640.jpg", help="Path to input test image")
    args = parser.parse_args()

    # Verify input image
    image_path = args.image
    if not os.path.exists(image_path):
        fallback = "services/hailo-inference/bus.jpg"
        if os.path.exists(fallback):
            image_path = fallback
        else:
            sys.stderr.write(f"Error: test image {image_path} not found\n")
            sys.exit(1)

    with open(image_path, "rb") as f:
        img_b64 = base64.b64encode(f.read()).decode("ascii")

    payload = json.dumps({
        "image_b64": img_b64,
        "confidence_threshold": 0.3,
        "render_annotated": False,
    }).encode("utf-8")

    sys.stdout.write("========================================================================\n")
    sys.stdout.write("  ZODIAC HAILO-8 CONTINUOUS INFERENCE WORKLOAD INJECTION\n")
    sys.stdout.write("========================================================================\n")
    sys.stdout.write(f"  Target NPU Host : http://{args.host}:{args.port}/infer\n")
    sys.stdout.write(f"  Duration        : {args.duration}s ({args.duration/60:.1f} minutes)\n")
    sys.stdout.write(f"  Worker Threads  : {args.workers} concurrent keep-alive streams\n")
    sys.stdout.write(f"  Payload Size    : {len(payload)//1024} KB per frame ({os.path.basename(image_path)})\n")
    sys.stdout.write(f"  Dashboard Link  : http://localhost:3000/#sec-rpi5\n")
    sys.stdout.write("========================================================================\n\n")

    stats = StatsCollector()
    workers = []
    for w_id in range(args.workers):
        t = threading.Thread(
            target=worker_loop,
            args=(w_id + 1, args.host, args.port, payload, stats),
            daemon=True,
        )
        t.start()
        workers.append(t)

    t_start = time.time()
    t_end = t_start + args.duration

    try:
        while time.time() < t_end and not stop_requested.is_set():
            time.sleep(5.0)
            elapsed = time.time() - t_start
            pct = min(100.0, (elapsed / args.duration) * 100.0)
            rate = stats.get_window_rate()
            snap = stats.snapshot()

            mins_el = int(elapsed // 60)
            secs_el = int(elapsed % 60)
            mins_tot = int(args.duration // 60)
            secs_tot = int(args.duration % 60)

            temp_str = f"{snap['last_chip_temp_c']:.1f}°C" if snap["last_chip_temp_c"] is not None else "--°C"

            log_line = (
                f"[{mins_el:02d}:{secs_el:02d}/{mins_tot:02d}:{secs_tot:02d} ({pct:4.1f}%)] "
                f"Inferences: {snap['total_frames']:,} | "
                f"Rate: {rate:5.1f} inf/s | "
                f"DMA Latency: {snap['total_dma_ms']:.2f} ms | "
                f"RTT: {snap['avg_roundtrip_ms']:.1f} ms | "
                f"Temp: {temp_str} | "
                f"Errors: {snap['errors']}"
            )
            sys.stdout.write(log_line + "\n")
            sys.stdout.flush()

            # Write status to file for local UI / external monitors
            try:
                status_payload = {
                    "running": True,
                    "elapsed_sec": round(elapsed, 1),
                    "duration_sec": args.duration,
                    "percent_complete": round(pct, 1),
                    "total_frames": snap["total_frames"],
                    "current_rate_fps": round(rate, 1),
                    "avg_dma_latency_ms": round(snap["total_dma_ms"], 2),
                    "avg_roundtrip_ms": round(snap["avg_roundtrip_ms"], 1),
                    "chip_temp_c": snap["last_chip_temp_c"],
                    "timestamp": time.time(),
                }
                with open(STATUS_FILE, "w") as sf:
                    json.dump(status_payload, sf)
            except Exception:
                pass
    finally:
        stop_requested.set()
        for t in workers:
            t.join(timeout=2.0)

        elapsed_total = time.time() - t_start
        final_snap = stats.snapshot()
        avg_rate = (final_snap["total_frames"] / elapsed_total) if elapsed_total > 0 else 0.0

        sys.stdout.write("\n========================================================================\n")
        sys.stdout.write("  HAILO-8 INFERENCE STRESS TEST SUMMARY\n")
        sys.stdout.write("========================================================================\n")
        sys.stdout.write(f"  Total Duration   : {elapsed_total:.1f}s ({elapsed_total/60:.2f} minutes)\n")
        sys.stdout.write(f"  Total Inferences : {final_snap['total_frames']:,} frames\n")
        sys.stdout.write(f"  Average Velocity : {avg_rate:.2f} inferences/second\n")
        sys.stdout.write(f"  Average DMA Time : {final_snap['total_dma_ms']:.2f} ms\n")
        sys.stdout.write(f"  Average HTTP RTT : {final_snap['avg_roundtrip_ms']:.2f} ms\n")
        sys.stdout.write(f"  Peak Silicon Temp: {final_snap['last_chip_temp_c']}°C\n")
        sys.stdout.write(f"  Total Errors     : {final_snap['errors']}\n")
        sys.stdout.write("========================================================================\n")

        try:
            with open(STATUS_FILE, "w") as sf:
                json.dump({"running": False, "total_frames": final_snap["total_frames"], "summary": "completed"}, sf)
        except Exception:
            pass


if __name__ == "__main__":
    main()
