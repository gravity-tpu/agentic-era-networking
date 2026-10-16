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
