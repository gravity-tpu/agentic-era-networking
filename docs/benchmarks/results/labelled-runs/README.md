# Labelled runs and the first detector scores (2026-10-17)

Runs recorded with `scripts/labelled-runs.py` at the Jetson's Zodiac P3 tap, each one class and one sender, and
scored with `scripts/score-labelled-runs.py` (`python3 scripts/score-labelled-runs.py docs/benchmarks/results/labelled-runs`).
Each run is a gzipped capture plus a label file naming the sender; `scores-2026-10-17.txt` and `.json` are the output
recorded here.

| Run (repeats are `-r2`, `-r3`) | Class | What it is |
| :--- | :--- | :--- |
| `benign-ping-5pps` (x3), `benign-ping-5pps-node01`, `benign-ping-20pps` (x2) | benign | ping from `node-02` (and once `node-01`) at 5 or 20 per second |
| `benign-idle-60s` (x2) | benign | nothing sent for 60 s: the capture alone |
| `benign-http-5rps` (x3), `benign-http-20rps` (x2) | benign | small HTTP GETs to a local web server on the Mac, 30 s |
| `benign-udp-small-10pps` (x3), `benign-udp-small-50pps` (x2) | benign | 60 to 100 byte UDP datagrams to port 53 on the Mac, 30 s |
| `attack-synflood-200pps`, `attack-synflood-1000pps` | attack | `hping3` SYN flood from `node-01`, 30 s and 10 s |
| `attack-udpflood-500pps-1400b` | attack | `hping3` UDP flood, 1400-byte payloads, 500 pps, 10 s |
| `attack-portscan-fast`, `attack-portscan-slow` | attack | `nmap -sS -T4` ports 1 to 1000 (all sent in 0.36 s); `-T2` ports 1 to 200 (80 s) |

## Scores (23 runs: 18 benign, 5 attack)

| Detector | Attacks detected with the right sender | Benign runs with an alert (false positives) |
| :--- | :--- | :--- |
| Rate rule (the trt daemon: 10 pps per source, 5 s window, judged after 0.5 s) | 3 of 5 | **12 of 18** |
| GPU sentinel (the arithmetic of the deployed kernel, 0.15 base threshold with an adaptive baseline) | 5 of 5 | **11 of 18** |

Benign false positives by workload (runs with any alert / runs):

| Workload (all to the Mac's `10.0.2.119` alias) | Rate rule | Sentinel |
| :--- | ---: | ---: |
| HTTP polls, 5 and 20 requests per second | 5 of 5 | 1 of 5 |
| Small UDP datagrams, 10 and 50 per second | 5 of 5 | 4 of 5 |
| Ping, 5 and 20 per second | 2 of 6 | 6 of 6 |
| Idle (nothing sent) | 0 of 2 | 0 of 2 |

- **The rate rule's threshold is far below ordinary traffic.** One host making a few web requests a second sends more than
  10 frames per second (each request is about five frames), so every HTTP run, every UDP run and the 20 pps pings were
  flagged within about 0.5 s. It catches the floods, but it would also quarantine any chatty host.
- **The sentinel flags most benign traffic too**: every ping run, four of five small-UDP runs, and an occasional window in
  HTTP runs. It stays silent only on idle.
- **Neither detector separates attack from ordinary use on this data.** The two attack misses of the rate rule are
  structural (the fast scan finished in 0.36 s, before the rule's 0.5 s minimum; the slow scan ran at 2.5 pps), and the
  sentinel's five detections come with a high false-positive rate, so they are not evidence that it detects attacks.

## Correction to the earlier sentinel finding

`docs/benchmarks/results/sentinel-detection/` reported, from synthetic patterns, that the sentinel misses or barely
flags floods. The real `hping3` floods contradict that: it flags all three. The synthetic rows were my approximation of
the features (for example `hping3` increments the source port per packet, which is neither the fixed nor the random
pattern I used), and they were wrong about floods. What stands is the other half: it flags ping and every other benign
run, and it was never trained.

## Caveats

- 23 runs, up to three repeats of each benign workload and **one** of each attack, one host pair, short durations: a
  scored comparison, not a distribution. The attack runs were not repeated. Still missing: bulk TCP, ssh sessions, a
  browser-like mix, Tailscale-style traffic, ARP and address-spoofing attacks. A 100 Mbit lab segment limits rates.
- **Bulk TCP was not recorded.** The runs were attempted (iperf3, then a Python sender) and failed, and the rack's
  control plane died during the first attempt (see below), so they are not in the data. They must be re-recorded.
- **Traffic that does not cross the Zodiac is invisible to the tap.** `node-01`, `node-02` and the Pi 5 are behind the
  same switch; HTTP and iperf3 runs between them left 0 frames at the tap (measured), so the receivers run on the Mac,
  on the uplink side. The scorer marks a run INVALID and leaves it out of every rate if the sender is seen fewer than
  20 times.
- Timing comes from capture timestamps. The live trt daemon dropped 3,458 frames above about 300 per second (its
  per-frame GPU inference is the limit), which this replay does not model, so the rate rule scored here is generous at
  high rates.
- The run labels are per run: a benign alert means any alert in a run that contained only benign traffic from one
  sender plus a few background frames (about 5 in 60 s).
- The captures hold lab MAC and IP addresses.

## Rack incident during recording

At 22:20:25 on 2026-10-17 the controller logged `Dead peer detected (10.0.1.99): no OFPT_ECHO_REPLY within timeout`: the
Zodiac FX stopped answering on its control address and the data path stopped forwarding (ARP across it failed). The
last valid HTTP run ended at 22:20:12, 13 s earlier; the first bulk-TCP attempt started at about that moment. The
switch's firmware was still running (its serial-reported uptime kept advancing, 145 h at the time), so it had not
power-cycled; its IP and OpenFlow stack was unresponsive. The cause is unknown and the recorded traffic cannot be excluded
as a trigger. The bulk-TCP runs were captured during the outage and are excluded.

A review suggested the switch's CPU was starved by `OFPT_PACKET_IN` table-miss punts. The flow probe argues against that:
the table-miss entry (priority 0) has no actions, so unmatched frames are dropped, not sent to the controller, and the
isolation policy's rules output only to ports. That is evidence against one mechanism, not an explanation; the cause is
still unknown. The bulk sender also paces with the operating system's sleep, which is coarse, so it may send in small
bursts; it has not run successfully, so that is untested.
