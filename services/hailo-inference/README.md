# Zodiac Hailo-8 Neural Inference Microservice

Neural inference microservice exposing the **Raspberry Pi 5 + Hailo-8 M.2 (26 TOPS NPU)** accelerator over the network (`http://10.0.0.179:8000` and `http://10.0.2.51:8000`).

---

## 1. Repository Invariants

The microservice strictly enforces the governing principles defined in [`AGENTS.md`](file:///Users/andymorven/git/agentic-era-networking/AGENTS.md):

1. **No suppression of errors (INV-1)**:
   All errors (corrupted images, missing model files, hardware PCIe timeouts) are handled deterministically at protocol boundaries and mapped to explicit HTTP status codes (`400`, `404`, `500`, `503`). No empty exception handlers.
2. **Determinism in Telemetry & Metering (Dean & Ghemawat / INV-2)**:
   Timing instrumentation uses monotonic nanosecond precision (`time.perf_counter_ns()`, `time.monotonic_ns()`). Packet counters, frame counts, and latencies use integer arithmetic. Floating-point numbers are banished from accounting accumulators.
3. **Fail-Closed Isolation & Default-Drop (Ghemawat & Hassabis / INV-3)**:
   All endpoints enforce strict Pydantic schema validation. Malformed tensors, unrecognized parameters, or out-of-bound thresholds are rejected immediately with `400 Bad Request`.
4. **Adaptive Control & Concurrency Stability (Le & Vinyals / INV-5)**:
   Hardware DMA streaming channels on PCIe bus `0001:01:00.0` are protected by a thread synchronization lock to prevent channel corruption across concurrent HTTP requests.
5. **Goodhart's Law & Epistemic Telemetry Provenance (Anti-Simulation Law / INV-6)**:
   All reported silicon telemetry (`source: 'rpi5_hailo8_npu'`) is queried directly from physical Hailo-8 control registers via `target.control.get_chip_temperature()` and Linux sysfs nodes (`/sys/bus/pci/devices/0001:01:00.0/`). Synthetic simulation is never permitted.

---

## 2. API Endpoints

| Method | Path | Description | Request / Query | Response Model |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/` | Root service metadata & status | None | Service metadata |
| `GET` | `/health` | Liveness & physical NPU connectivity | None | Hardware connectivity & thermals |
| `GET` | `/telemetry` | Epistemic hardware telemetry | None | `FullTelemetryResponse` |
| `GET` | `/models` | Available HEF compiled models | None | `ModelListResponse` |
| `POST` | `/models/load` | Dynamically switch active model | `{"model_name": "yolov6n_h8.hef"}` | `LoadModelResponse` |
| `POST` | `/infer` | JSON single-frame inference | `image_b64` (base64 string) | `InferResponse` |
| `POST` | `/infer/upload` | Multipart image file upload | Form file upload (`file=@image.jpg`) | `InferResponse` |
| `POST` | `/benchmark` | Hardware streaming benchmark | `{"seconds": 3, "measure_latency": false}` | `BenchmarkResponse` |

---

## 3. Physical Silicon Telemetry (`GET /telemetry`)

Returns epistemic provenance metadata satisfying INV-6:

```json
{
  "source": "rpi5_hailo8_npu",
  "timestamp_ns": 1728276241000000000,
  "silicon": {
    "device_id": "0001:01:00.0",
    "board_name": "Hailo-8",
    "architecture": "HAILO8",
    "firmware_version": "4.20.0",
    "neural_network_core_clock_rate_mhz": 400.0,
    "boot_source": "PCIE",
    "ts0_temp_c": 43.84,
    "ts1_temp_c": 43.79,
    "temp_sample_count": 15420
  },
  "host": {
    "hostname": "rpi-hailo",
    "cpu_temp_c": 47.4,
    "load_avg_1m": 0.12,
    "pcie_current_link_speed": "8.0 GT/s PCIe",
    "pcie_current_link_width": "1",
    "ram_available_bytes": 3894456320
  },
  "counters": {
    "uptime_ns": 24500000000,
    "total_inferences": 142,
    "total_inference_ns": 1483900000,
    "active_model": "yolov8s_h8.hef"
  }
}
```

---

## 4. Hardware Inference Example (`POST /infer`)

Single-frame request with COCO object detection via base64 or multipart upload:

```bash
# Option A: JSON with Base64 Encoded Image
curl -X POST http://10.0.0.179:8000/infer \
  -H "Content-Type: application/json" \
  -d '{
    "image_b64": "'$(base64 -i bus.jpg | tr -d '\n')'",
    "confidence_threshold": 0.3
  }'

# Option B: Multipart Stream Upload
curl -X POST http://10.0.0.179:8000/infer/upload \
  -F "file=@bus.jpg" \
  -F "confidence_threshold=0.3"
```

Response includes exact nanosecond timing breakdown:

```json
{
  "success": true,
  "model": "yolov8s_h8.hef",
  "source": "rpi5_hailo8_npu",
  "timestamp_ns": 1728276241250123000,
  "timing": {
    "preprocess_ns": 16620000,
    "inference_ns": 10445833,
    "postprocess_ns": 400000,
    "total_ns": 27465833
  },
  "chip_temp_c": 43.84,
  "detections": [
    {
      "class_id": 0,
      "class_name": "person",
      "confidence": 0.9139,
      "bbox": {
        "ymin": 0.3704,
        "xmin": 0.0639,
        "ymax": 0.8373,
        "xmax": 0.3022,
        "ymin_px": 400,
        "xmin_px": 51,
        "ymax_px": 904,
        "xmax_px": 244
      }
    },
    {
      "class_id": 5,
      "class_name": "bus",
      "confidence": 0.8758,
      "bbox": {
        "ymin": 0.2113,
        "xmin": 0.0017,
        "ymax": 0.6915,
        "xmax": 0.9994,
        "ymin_px": 228,
        "xmin_px": 1,
        "ymax_px": 746,
        "xmax_px": 809
      }
    }
  ]
}
```

---

## 5. Streaming Hardware Benchmark (`POST /benchmark`)

Measures sustained PCIe DMA streaming throughput using `hailortcli run`:

```bash
curl -X POST http://10.0.0.179:8000/benchmark \
  -H "Content-Type: application/json" \
  -d '{"model_name": "yolov8s_h8.hef", "seconds": 3}'
```

Result:

- **Throughput**: **306.7 FPS**
- **PCIe DMA Rate**: **3.02 Gbps**
- **Silicon Execution**: Hailo-8 M.2 (PCIe Gen 3.0 x1)

---

## 6. Service Deployment & Lifecycle Management

Managed via `systemd` on Raspberry Pi 5 (`rpi-hailo`):

```bash
# Check service status
ssh agent@10.0.0.179 "sudo systemctl status hailo-inference.service"

# View live service logs
ssh agent@10.0.0.179 "journalctl -u hailo-inference.service -f"

# Redeploy / update service
./deploy/rpi5/deploy-hailo-service.sh 10.0.0.179 agent
```
