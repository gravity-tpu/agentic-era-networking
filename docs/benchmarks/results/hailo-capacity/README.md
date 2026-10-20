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

## Saturated native load: 9 minutes, stopped early (2026-10-19)

The service path above leaves the chip mostly idle, so this run removes it: `scripts/hailo-saturation-soak.py` called
`POST /benchmark` back to back (30 s per call, the endpoint's cap, `measure_latency: false`, model `yolov8s_h8.hef`) so the
accelerator was never idle, after the same two short passes as the baseline (10 s throughput, 5 s latency). A sampler read
the Pi's SoC temperature, throttle flags and ARM clock every 10 s over ssh. Raw files are in `saturated-2026-10-19/`:
`soak-calls.json` (18 calls), `short-throughput-10s.json`, `short-latency-5s.json`, `pi-samples.jsonl` (56 samples),
`meta.json`, `driver-log.txt`. Times are US Eastern (12:49 to 12:59).

| Measure | Result |
| :--- | :--- |
| Throughput over 18 calls (548 s) | 302.6 to 306.7 frames/s, mean 305.2; no downward trend |
| Short passes (cool chip) | 301.5 frames/s (10 s); 6.66 ms hardware latency, 97.2 frames/s (5 s, latency mode) |
| Chip temperature, per-call average | 70.1 C (call 1) rising to 94.5 C (call 10), then falling to 91.1 C (call 18) |
| Chip temperature, highest single reading | 95.4 C (call 9, about 4.5 minutes in) |
| Time above 85 C | first reading above it in call 3 (85.7 C, about 90 s in), then above it to the stop: about 7.5 of the 9 minutes |
| Pi 5 SoC temperature | 49.4 to 71.4 C; `get_throttled` was `0x0` in all 56 samples |

Reading, and what it does not show:

- **No throughput loss was visible at 91 to 95 C.** Frames per second stayed within 1% of the mean across the whole
  run, including the hottest calls. This says nothing about whether the chip's own protection would have acted at a higher
  temperature, or about its lifetime at these temperatures.
- **The chip ran above 85 C, the limit shown on the owner's dashboard, for most of the run.** The driver's abort limit was
  set to 100 C without checking that figure, so it did not stop the run. The owner noticed on the dashboard, and the run was
  stopped by hand at call 18 of a planned 30 (548 s of 900 s). The committed script now defaults to an 85 C abort limit
  (`ABORT_C`); the run itself used `ABORT_C=100`. Where the dashboard's 85 C comes from is not recorded in this repository
  (the only 85 values in the source are clamps on simulated demo data), so it is not claimed here to be a datasheet limit.
- **The temperature had stopped rising and was slowly falling at the stop** (94.5 C average at call 10 to 91.1 C at call 18
  under unchanged load). This shows a plateau was reached, not what held it there; the cooling hardware and the ambient
  temperature were not recorded.
- The planned post-soak latency pass did not run because the run was stopped early, so there is no hot-chip latency figure.
  `meta.json` has no `finished_et` for the same reason, and its `pcie_link` field is empty (`lspci` printed nothing over
  ssh). The per-call `raw_output` text is dropped from `soak-calls.json` (the structured fields carry the same numbers); the
  two short-pass files keep it.
- One run, one board, one model, no repeats. Not a traffic-classification result (same caveat as the baseline above).

## Held under 80 C by duty cycling: two 12-minute runs (2026-10-19)

After the run above, the owner asked for the same test kept under 80 C. `POST /benchmark` cannot be rate-limited, so
`scripts/hailo-thermal-capped-soak.py` duty-cycles it: it polls `/health` every 2 s, starts a 4 s saturated burst only when
the hotter chip sensor reads at or below `START_C`, and would stop the whole run if any reading reached `HARD_C` = 80 C.
The stop never fired in either run. Times are US Eastern; raw files are in `capped-start66-2026-10-19/` and
`capped-start72-2026-10-19/` (`bursts.json` per burst, `temp-trace.jsonl` rest and burst readings, `meta.json`,
`driver-log.txt`). The second run started with the chip still warm from the first (65 C), after about 45 seconds of rest.

| | Run 1 (`START_C` 66, 13:28 to 13:40) | Run 2 (`START_C` 72, 13:41 to 13:53) |
| :--- | :--- | :--- |
| Bursts, frames | 103, 126,832 | 114, 140,414 |
| Duty cycle (busy time / wall time) | 60.0% | 66.5% |
| Sustained throughput over wall time | 175.7 frames/s | 194.9 frames/s |
| Throughput inside a burst (mean, range) | 292.7 (283.1 to 296.0) | 293.1 (287.1 to 296.5) |
| Highest chip reading | 71.0 C | 75.3 C |
| Highest reading in each minute, once settled | 70.8 to 71.0 C | 74.4 to 75.3 C |
| Chip between bursts (after minute 2) | 63.9 to 70.9 C | 69.1 to 75.3 C |

Reading, and what it does not show:

- **Under the cap the chip settles instead of climbing.** Each run reached a flat plateau within about 3 minutes and held it
  for the remaining 9, at 71 C and 75 C. Together with the saturated run (about 94 C at 100% duty) this gives three points:
  60% duty at 71 C, 66.5% at 75.3 C, 100% at about 94 C. A straight line through the first two points reaches 80 C near
  73% duty, about 220 frames/s sustained. **That is an extrapolation, not a measurement**, and the saturated point shows the
  relationship is not guaranteed to be linear, so it needs its own run before it is quoted.
- **In-burst throughput is about 293 frames/s here against 305 in the 30 s calls.** The 4 s calls include start-up time in
  their duration, which probably accounts for the gap; that was not tested. The 175.7 and 194.9 figures are wall-clock
  averages and include the rest periods.
- The duty cycle is set by the controller's thresholds (and the 2 s polling and per-call overhead), not by a property of the
  chip. A different burst length or threshold gives a different pair of duty and temperature.
- No cooling hardware, ambient temperature or fan state was recorded, and the Pi's own throttle flags were not sampled in
  these two runs. One board, one model, one run per setting.
