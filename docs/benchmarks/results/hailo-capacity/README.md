# Hailo-8 capacity baseline (2026-10-16)

First measured ceiling for the Hailo-8 on `rpi-hailo` (Pi 5, HailoRT 4.20.0), from the service's own
`POST /benchmark` (native `hailortcli` streaming benchmark, 10 s per run, model `yolov8s_h8.hef`, the model the
service loads today). Raw responses are the two JSON files in this directory.

| Run | Frames | Duration | Result | Chip temperature |
| :--- | :--- | :--- | :--- | :--- |
| Throughput (`measure_latency: false`) | 3081 | 10.24 s | 300.8 frames/s | 42.2 to 56.9 C (avg 51.9) |
| Latency (`measure_latency: true`) | 963 | 10.20 s | 94.4 frames/s, 6.66 ms hardware latency | 53.1 to 55.0 C |

## What this is and is not

- It is a **saturated ceiling for one image-detection model**: the most the Hailo does when it is never idle.
  Utilization under real traffic is a fraction of this and has not been measured.
- It is **not** a traffic-classification result. `yolov8s_h8.hef` detects objects in images; the Hailo has no
  traffic-classifier model yet (see the Hailo-8 entry criteria in `docs/ROADMAP.md`).
- One run of 10 s each, a single board, no repeats: treat the figures as a first reading, not a distribution.
  Temperature rose about 15 C in the 10 s saturation run; sustained-load thermals are unmeasured.
- Utilization cannot be read from the running service today: `hailortcli monitor` only reports for a process
  that has `HAILO_MONITOR=1` in its environment, and the `hailo-inference` unit does not set it.

## Through the service: 10-minute sustained run (2026-10-16)

`hailo-inference` was restarted with `HAILO_MONITOR=1` (systemd drop-in
`/etc/systemd/system/hailo-inference.service.d/monitor.conf`), then loaded for 600 s by `scripts/hailo-10m-test.py`
(3 workers, `bus_640.jpg`, localhost) while `scripts/hailo-utilization-sampler.py` logged `hailortcli monitor` and the
chip temperatures about every 3 s (the shortest possible: each monitor read lasts its full 3 s timeout; the first run of
the sampler was invoked with a 2 s interval it could not honour, and the script now refuses intervals under 3 s). Raw samples: `service-sustained-600s-2026-10-16.jsonl`; the load client's own
summary: `service-sustained-600s-load-summary-2026-10-16.txt`.

| Measure | Result |
| :--- | :--- |
| Inferences | 32,990 in 600.1 s (54.97 per second), 0 errors |
| Hailo utilization (200 samples) | median 37.6%, max 41.8%; the one 0% sample is the last, after the load ended |
| Model FPS reported by `hailortcli monitor` | median 55.9, max 61.9 |
| Chip temperature | 47.8 C at the start, peak 53.1 C |
| DMA time / HTTP round trip | 11.19 ms / 54.50 ms average |

Reading: through the real service path the Hailo reaches about 55 inferences per second and a median 37.6%
utilization, against the 300.8 frames/s the same model reaches in the native benchmark above. The host pipeline (HTTP,
JPEG decode, post-processing on the Pi 5's CPU, one uvicorn worker) is the limit, not the accelerator. The temperature
settled near 50 C with no throttling or errors. This is one run with one client configuration (3 workers); more workers
or a different client were not tried, so the 37.6% is "this pipeline as deployed", not the most the service can do.
