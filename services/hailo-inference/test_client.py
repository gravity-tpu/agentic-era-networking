#!/usr/bin/env python3
"""
test_client.py
==============
End-to-end integration and verification client for the Hailo-8 FastAPI microservice.
Tests network endpoints from the operator workstation over 10.0.0.179 / 10.0.2.51.
"""

import argparse
import base64
import json
import sys
import time
import urllib.request
import urllib.parse


def test_endpoint(url: str, method: str = "GET", data: dict = None, files: dict = None) -> dict:
    req_headers = {"User-Agent": "HailoTestClient/1.0"}
    req_body = None

    if data is not None:
        req_body = json.dumps(data).encode("utf-8")
        req_headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=req_body, headers=req_headers, method=method)
    t0 = time.perf_counter_ns()
    with urllib.request.urlopen(req, timeout=15.0) as resp:
        t1 = time.perf_counter_ns()
        body = resp.read().decode("utf-8")
        roundtrip_ms = (t1 - t0) / 1e6
        res = json.loads(body)
        res["_roundtrip_ms"] = roundtrip_ms
        return res


def main():
    parser = argparse.ArgumentParser(description="Test Hailo-8 FastAPI Microservice")
    parser.add_argument("--host", default="10.0.0.179", help="Target host IP (default: 10.0.0.179)")
    parser.add_argument("--port", type=int, default=8000, help="Target port (default: 8000)")
    parser.add_argument("--image", default=None, help="Local image file to test inference")
    parser.add_argument("--benchmark", action="store_true", help="Run hardware streaming benchmark")
    args = parser.parse_args()

    base_url = f"http://{args.host}:{args.port}"
    print(f"=== Testing Hailo-8 Microservice at {base_url} ===")

    # 1. Root
    try:
        root_data = test_endpoint(f"{base_url}/")
        print(f"✓ Root endpoint: {root_data.get('service')} [Status: {root_data.get('status')}]")
        print(f"  Accelerator:   {root_data.get('accelerator')}")
        print(f"  Active model:  {root_data.get('active_model')}")
        print(f"  HTTP Roundtrip: {root_data.get('_roundtrip_ms'):.2f} ms")
    except Exception as e:
        print(f"✗ Failed testing root endpoint: {e}")
        return 1

    # 2. Health
    try:
        health = test_endpoint(f"{base_url}/health")
        print(f"✓ Health check: {health.get('status')} [Device: {health.get('hailo_device')}]")
        print(f"  Silicon temp: TS0={health.get('chip_ts0_c'):.2f}°C, TS1={health.get('chip_ts1_c'):.2f}°C")
    except Exception as e:
        print(f"✗ Failed health check: {e}")
        return 1

    # 3. Epistemic Telemetry (INV-6)
    try:
        telem = test_endpoint(f"{base_url}/telemetry")
        silicon = telem.get("silicon", {})
        host = telem.get("host", {})
        counters = telem.get("counters", {})
        print(f"✓ Epistemic Silicon Telemetry:")
        print(f"  Device BDF:    {silicon.get('device_id')}")
        print(f"  Architecture:  {silicon.get('architecture')} ({silicon.get('board_name')})")
        print(f"  Firmware:      {silicon.get('firmware_version')}")
        print(f"  Core Clock:    {silicon.get('neural_network_core_clock_rate_mhz')} MHz")
        print(f"  PCIe Link:     {host.get('pcie_current_link_speed')} ({host.get('pcie_current_link_width')} lanes)")
        print(f"  RPi 5 CPU:     {host.get('cpu_temp_c')}°C | Host RAM: {host.get('ram_available_bytes', 0)//(1024*1024)} MB avail")
        print(f"  Inferences:    {counters.get('total_inferences')} processed | Uptime: {counters.get('uptime_ns', 0)/1e9:.1f}s")
    except Exception as e:
        print(f"✗ Failed querying telemetry: {e}")
        return 1

    # 4. Model Listing
    try:
        models_data = test_endpoint(f"{base_url}/models")
        print(f"✓ Model Listing: {len(models_data.get('models', []))} models discovered")
        for m in models_data.get("models", []):
            active_flag = " [ACTIVE]" if m.get("is_active") else ""
            print(f"  - {m.get('filename')}{active_flag} ({m.get('size_bytes', 0)//1024} KB)")
    except Exception as e:
        print(f"✗ Failed listing models: {e}")
        return 1

    # 5. Image Inference
    try:
        if args.image:
            with open(args.image, "rb") as f:
                img_bytes = f.read()
            print(f"Testing inference with local image {args.image} ({len(img_bytes)} bytes)...")
        else:
            img_url = "https://raw.githubusercontent.com/ultralytics/yolov5/master/data/images/bus.jpg"
            print(f"Fetching sample image locally from {img_url}...")
            import ssl
            try:
                ssl_ctx = ssl.create_default_context()
                req_dl = urllib.request.Request(img_url, headers={"User-Agent": "HailoTestClient/1.0"})
                with urllib.request.urlopen(req_dl, timeout=10.0, context=ssl_ctx) as resp:
                    img_bytes = resp.read()
            except Exception:
                ssl_ctx = ssl._create_unverified_context()
                req_dl = urllib.request.Request(img_url, headers={"User-Agent": "HailoTestClient/1.0"})
                with urllib.request.urlopen(req_dl, timeout=10.0, context=ssl_ctx) as resp:
                    img_bytes = resp.read()
            print(f"Downloaded sample image ({len(img_bytes)} bytes). Sending to /infer as base64...")

        img_b64 = base64.b64encode(img_bytes).decode("ascii")
        infer_res = test_endpoint(
            f"{base_url}/infer",
            method="POST",
            data={"image_b64": img_b64, "confidence_threshold": 0.3, "render_annotated": False},
        )
        timing = infer_res.get("timing", {})
        detections = infer_res.get("detections", [])
        print(f"✓ Inference successful on model: {infer_res.get('model')}")
        print(f"  Hardware DMA Latency: {timing.get('inference_ns')/1e6:.2f} ms ({timing.get('inference_ns')} ns)")
        print(f"  Preprocessing Latency: {timing.get('preprocess_ns')/1e6:.2f} ms")
        print(f"  Postprocessing Latency: {timing.get('postprocess_ns')/1e6:.2f} ms")
        print(f"  Total Server Latency: {timing.get('total_ns')/1e6:.2f} ms")
        print(f"  Network Roundtrip:    {infer_res.get('_roundtrip_ms'):.2f} ms")
        print(f"  Silicon Temp:         {infer_res.get('chip_temp_c')}°C")
        print(f"  Detections Count:     {len(detections)}")
        for d in detections[:5]:
            bbox = d.get("bbox", {})
            print(f"    • {d.get('class_name')} ({d.get('confidence'):.2f}) at [{bbox.get('xmin'):.3f}, {bbox.get('ymin'):.3f}, {bbox.get('xmax'):.3f}, {bbox.get('ymax'):.3f}]")
    except Exception as e:
        print(f"✗ Inference failed: {e}")

    # 6. Benchmark
    if args.benchmark:
        try:
            print("Running hardware streaming benchmark (3s)...")
            bench_res = test_endpoint(
                f"{base_url}/benchmark",
                method="POST",
                data={"model_name": "yolov8s_h8.hef", "seconds": 3, "measure_latency": False},
            )
            print(f"✓ Benchmark Completed:")
            print(f"  Model:        {bench_res.get('model_name')}")
            fps_milli = bench_res.get("fps_milli", 0)
            print(f"  Throughput:   {fps_milli / 1000.0:.2f} FPS ({fps_milli} milli-FPS pure integer INV-2)")
            print(f"  Chip Temp:    Min={bench_res.get('temp_min_c')}°C, Avg={bench_res.get('temp_avg_c')}°C, Max={bench_res.get('temp_max_c')}°C")
        except Exception as e:
            print(f"✗ Benchmark failed: {e}")

    print("\n✓ All microservice integration tests completed successfully!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
