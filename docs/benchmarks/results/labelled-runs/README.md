# Labelled runs and the first detector scores (2026-10-17)

Eight runs recorded with `scripts/labelled-runs.py` at the Jetson's Zodiac P3 tap, each one class and one sender, and
scored with `scripts/score-labelled-runs.py` (`python3 scripts/score-labelled-runs.py docs/benchmarks/results/labelled-runs`).
Each run is a gzipped capture plus a label file naming the sender; `scores-2026-10-17.txt` and `.json` are the output
recorded here.

| Run | Class | Sender frames | What it is |
| :--- | :--- | ---: | :--- |
| `benign-ping-5pps` | benign | 300 | `node-02` pings the Mac alias at 5 per second for 60 s |
| `benign-ping-5pps-node01` | benign | 300 | the same from `node-01` |
| `benign-ping-20pps` | benign | 600 | `node-02`, 20 per second for 30 s |
| `attack-synflood-200pps` | attack | about 6000 | `hping3` SYN flood, 200 pps, 30 s |
| `attack-synflood-1000pps` | attack | about 9900 | the same at 1000 pps, 10 s |
| `attack-udpflood-500pps-1400b` | attack | about 4900 | `hping3` UDP flood, 1400-byte payloads, 500 pps, 10 s |
| `attack-portscan-fast` | attack | 987 | `nmap -sS -T4`, ports 1 to 1000 (all sent in 0.36 s) |
| `attack-portscan-slow` | attack | 200 | `nmap -sS -T2`, ports 1 to 200 (one every 0.4 s, 80 s) |

## Scores

| Detector | Attacks detected with the right sender | Benign runs with an alert (false positives) |
| :--- | :--- | :--- |
| Rate rule (the trt daemon: 10 pps per source, 5 s window, judged after 0.5 s) | 3 of 5 | 1 of 3 |
| GPU sentinel (the arithmetic of the deployed kernel, 0.15 base threshold with an adaptive baseline) | 5 of 5 | 3 of 3 |

- **The rate rule** detected all three floods, 0.5 s after the first frame (its minimum evidence), and named the right
  host every time. It missed both port scans for structural reasons: the fast scan finished all 987 frames in 0.36 s,
  before the rule's 0.5 s minimum, so it never ruled on it; the slow scan ran at 2.5 packets per second, under the
  10 pps threshold. It also flagged the 20 pps ping (a benign run) because 20 is above 10.
- **The sentinel** alerted in every run, including all three benign pings (first alert 3 to 12 s in): it does not
  discriminate. Its detections of attacks are therefore not evidence that it detects attacks.

## Correction to the earlier sentinel finding

`docs/benchmarks/results/sentinel-detection/` reported, from synthetic patterns, that the sentinel misses or barely
flags floods. The real `hping3` floods contradict that: it flags all three. The synthetic rows were my approximation of
the features (for example `hping3` increments the source port per packet, which is neither the fixed nor the random
pattern I used), and they were wrong about floods. What stands is the other half: it flags ping and every other benign
run, and it was never trained.

## Caveats

- Eight runs, one repeat each, one host pair, short durations: a first scored comparison, not a distribution. Benign
  coverage is thin (ping only: no ssh, bulk TCP, web, DNS or Tailscale mixes), attacks are four patterns from one
  adversary, there are no ARP or address-spoofing attacks, and a 100 Mbit lab segment limits rates.
- Timing comes from capture timestamps. The live trt daemon dropped 3,458 frames above about 300 per second (its
  per-frame GPU inference is the limit), which this replay does not model, so the rate rule scored here is generous at
  high rates.
- The run labels are per run: a benign alert means any alert in a run that contained only benign traffic from one
  sender plus a few background frames (about 5 in 60 s).
- The captures hold lab MAC and IP addresses.
