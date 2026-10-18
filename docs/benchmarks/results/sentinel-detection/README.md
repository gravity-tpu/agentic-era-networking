# GPU sentinel detection quality (2026-10-17)

What `gpu-sdn-sentinel.service` (`scripts/gpu-sdn-anomaly-sentinel.py`, native kernel `src/gpu/gpu_anomaly_kernel.cu`)
actually detects, measured by replaying captured frames and synthetic traffic patterns through an offline replica of
its arithmetic. Reproduce with `python3 scripts/sentinel-replay.py docs/benchmarks/results/sentinel-detection`
(needs numpy); the output of the run recorded here is `replay-output-2026-10-17.txt`.

## What the detector is

- On the Jetson it runs the **native CUDA kernel** (`build/libgpu_anomaly.so`). Its "autoencoder" is ten scalar
  constants hard-coded in the C source (`0.20, 0.30, 0.25, 0.25, 0.05, 0.50, 0.02, 0.85, 1.50, 0.40`). The Python never
  loads weights (`load_cuda_model_weights` is declared and never called), and the PyTorch fallback builds a randomly
  initialised network and loads nothing either. **Nothing in the repository trains it**, so it has no learned notion of
  normal traffic: it is a fixed arithmetic function of four per-packet features (log inter-arrival time, frame length
  relative to the largest seen, a protocol/flags value, and the distance between source and destination port).
- It reports an anomaly when the reconstruction error of a 64-packet window reaches a threshold (0.15, with an
  exponential moving baseline fed only by non-anomalous windows).
- The replica reproduces the real kernel: on the Jetson, 300 windows through `libgpu_anomaly.so` and through the
  replica differed by at most 3e-8 (losses are 0.08 to 0.25). The replica's constants are held equal to the CUDA source
  by `test/invariants/sentinel-replay.test.ts`.

## What it responds to

| Traffic (64-packet windows) | Windows | Loss min / median / max | At or above 0.15 |
| :--- | ---: | :--- | ---: |
| **Captured:** idle segment, a dev server polling the nodes | 317 | 0.108 / 0.123 / 0.141 | 0% |
| **Captured:** 5 pps ping plus a Tailscale burst | 62 | 0.196 / 0.206 / 0.226 | 100% |
| Synthetic benign: ICMP echo, 5 pps | 537 | 0.236 / 0.236 / 0.237 | 100% |
| Synthetic benign: DNS-like UDP | 537 | 0.172 / 0.184 / 0.199 | 100% |
| Synthetic benign: TCP bulk ACKs, 1500 B | 537 | 0.080 / 0.080 / 0.082 | 0% |
| Synthetic benign: TCP web mix | 537 | 0.138 / 0.157 / 0.174 | 85% (adaptive baseline flags none) |
| Synthetic attack: SYN flood, random source ports | 537 | 0.141 / 0.154 / 0.166 | 82% (adaptive baseline flags 9) |
| Synthetic attack: SYN flood, fixed ports | 537 | 0.139 / 0.139 / 0.141 | 0% |
| Synthetic attack: UDP flood, 1400 B | 537 | 0.131 / 0.143 / 0.153 | 4% (adaptive flags none) |
| Synthetic attack: port scan (10 ms, and 500 ms) | 537 | 0.198 / 0.198 / 0.201 | 100% |
| Synthetic attack: ARP flood | 537 | 0.241 / 0.241 / 0.242 | 100% |

Reading: the loss is high for **small frames and non-TCP traffic** and low for **large frames**. A benign ping
(0.236) scores higher than a SYN flood (0.139 to 0.154) or a UDP flood (0.143), so the detector flags ping and DNS
traffic and misses or barely flags floods. The two captured rows match what the deployed sentinel did: it stayed quiet
on idle polling and flagged the ping sources (38 anomalies and quarantines in one evening).

## Correction (real flood runs, 2026-10-17)

The synthetic rows above predicted that floods are missed. The labelled runs in `../labelled-runs/` contradict that: on real
`hping3` SYN and UDP floods the sentinel alerts in every run, and it also alerts in all three benign ping runs. The
synthetic rows were approximations of the features and were wrong about floods; what the real runs confirm is that it does
not discriminate, and it was never trained.

## Caveats

- The synthetic rows are approximations of attacks built from the same feature formulas, not recorded attack traffic.
  They show what the arithmetic does with those feature patterns; real precision and recall need labelled attack runs
  (roadmap Track C).
- The replay times frames by capture timestamps. The live sentinel times each frame when its Python loop dequeues it,
  which is more distorted by bursty delivery.
- The sentinel also picks the **offender** as the most frequent source IP in the last 64 packets, whatever the
  window's span (minutes on a quiet segment), so even a correct alert can name a bystander.
- Two small captures are included so the run can be repeated; they hold lab traffic (MAC and IP addresses).
