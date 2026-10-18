# Labelled traffic runs

Purpose: score any detector (the GPU sentinel, the trt daemon's rate rule, anything built next) on traffic whose class
is known. Until now no detector in the repository has been scored: `docs/benchmarks/results/sentinel-detection/` shows
the sentinel's arithmetic is untrained, and its precision and recall are unmeasured.

## Method

`scripts/labelled-runs.py` records the Jetson's Zodiac P3 tap (`enx9c69d39dd0a6`) once per run, each run being one
class and one sender:

- **Benign** runs: ping at 5 and 20 packets per second (from `agentic-node-02` and once `agentic-node-01`), idle (nothing sent), small HTTP GETs at 5 and 20 per second to a local web server on the Mac, small UDP datagrams at 10 and 50 per second, and a rate-limited bulk TCP stream; most with repeats.
- **Attack** runs, only from the adversary `agentic-node-01`, only to the Mac's `10.0.2.119` alias: SYN floods at 200 and
  1000 packets per second, a UDP flood with 1400-byte payloads, a fast and a slow port scan.

A run is the unit of labelling (the pcap is the run, the label file names the sender), so no clock alignment between
machines is needed. A detector is scored per run: did it alert (and, for attacks, did it name the attacker) and how long
after the first attacker frame.

Still missing: ssh sessions and a browser-like mix, Tailscale-style traffic, repeats of the attack runs, and ARP and
address-spoofing attacks. Traffic only reaches the tap if it crosses the Zodiac: the nodes and the Pi 5 sit behind the same
switch, so every receiver is on the Mac's uplink-side `10.0.2.119` alias (the web server and TCP sink are started by the
harness on that machine, bound to the alias).

## Safety bounds

All of these are named constants at the top of the script and are checked, with every reason reported, before a
packet is sent; `test/invariants/labelled-runs.test.ts` covers each refusal.

| Bound | Value |
| :--- | :--- |
| Longest run | 120 s |
| Highest rate | 2000 packets per second |
| Most packets in a run | 20,000 |
| Largest payload | 1400 bytes |
| Attack senders | `agentic-node-01` only |
| Targets | `10.0.2.119` (Mac alias), `10.0.2.51` (Pi 5) only |
| nmap timing | 2 to 4, at most 2000 ports |
| Ping | at most 20 per second |
| HTTP polls | at most 20 per second, two fixed paths, one target |
| Small UDP | at most 50 per second, 20 to 200 byte payloads |
| Bulk TCP | at most 20 Mbit per second |

Every remote command is built from a fixed template (no free text), runs under `timeout` (as root inside `sudo` for
`hping3` and `nmap`), and nothing runs without `--execute`. The rack's quarantine mode is `propose`, so a detector that
reacts to a run can only record a proposal.

## One-time setup

On the Jetson, once, as root: `sudo setcap cap_net_raw,cap_net_admin=eip /usr/bin/tcpdump`. It lets the `zodiac` user
capture the tap without root; it also lets any process running as `zodiac` sniff that interface (the trt daemon already
does). `--execute` refuses to start if it is missing.

## Status

23 runs recorded and scored (results in `docs/benchmarks/results/labelled-runs/`). The bulk-TCP runs failed and are not
in the data; they need re-recording once the rack is healthy again.
