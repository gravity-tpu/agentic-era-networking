# Smoke tests: depth / blackout / working-window harness (2026-10-04)

Purpose: validate the new `sweep`, `blackout` and `workday` commands on the physical bench before the full runs.
The numbers below are single trials or two short windows. They show the harness works and point at what to measure; they are not results.

## Harness status

| Command | Result |
| --- | --- |
| `sweep` (depth 2 + depth 4 variants, 1 round) | 9 conditions installed and verified, all 12 trials valid. The firmware accepted `/16` masked matches and hit rules and reported them back, so match content was verified. |
| `blackout` (depths 0 and 126, idle) | Works. Max ping gap 77-118 ms across all modes including the no-flush control, so a flush/reinstall is not distinguishable from Wi-Fi jitter at idle (reinstall verified in ~100-150 ms). |
| `workday` (2 x 60 s, typical profile) | Works after fixes below. |

Bugs found and fixed during the smoke tests:

1. The workday iperf3 server probe ran before forwarding rules were installed (empty table is default-drop), so it hung. Probe now runs after the table reset.
2. A switch-initiated session loss aborted the run. The workday now waits for the reconnect, re-syncs all rules and continues, recording each loss.
3. The 15 s built-in heartbeat is too sparse to see CPU stalls. The harness now sends an echo every second and records the round trip.
4. "Silence" events (no message for >1 s) are not a stall signal: the switch is quiet between heartbeats by design. Use echo latency and missing echoes instead.

## Observations to test properly (n=1 or n=2, not conclusions)

- Per-packet cost looks size-dependent as well as rule-dependent. Depth 2: about 21.2k pps at 64 B, 15.1k pps at 600 B (offered 30k and 19.6k).
- Receiver goodput was lower than the Port 2 TX rate in several 600 B trials (for example depth 4 `/16`: Port 2 TX implies ~61 Mbit/s, receiver measured ~34 Mbit/s), so loss is occurring after the switch (Wi-Fi extender / Mac). The receiver cannot be used as the switch limit, and a rate-ladder control is needed.
- Drop path: with all traffic hitting a DROP rule at depth 4, Port 1 RX was ~19k pps but the hit rule counted only ~5-6k pps.
- Rule priority/install order: at depth 4, forwarding rules both above the quarantine rules in priority and installed first gave 15.8k pps against ~13.4k for the other layouts. Neither change alone helped. Consistent with a scan that stops at the first match; needs replication.
- Working-window ramp (UDP 9.8k pps of 600 B plus TCP, rules ramping to 24 in 60 s), identical in both windows:

  | Rules | Port 1 RX pps |
  | --- | --- |
  | 4 | ~10.0-10.3k |
  | 8 | ~9.8k |
  | 12 | ~9.3k |
  | 16 | ~8.0k |
  | 20 | ~6.9-7.2k |

  TCP delivered 10-12 MB, then 5-6 MB, then 1-2 MB per 10 s, then 0 from about 16 rules. UDP lost 23% and 31% of packets.

- Control-plane stalls: echo RTT is normally 0.6-1.5 ms but the switch went silent for 8-12 s around 14-20 rules in both windows. With the production 8 s dead-peer rule the controller cut the session, the switch dropped its table, and the harness reconnected in ~2 s and restored the table in 0.1-0.8 s. With the dead-peer rule extended to 60 s the switch itself closed the session at ~52 s. Switch uptime was 222 h, so it did not reboot.
- It is not yet known whether the stalls are triggered by rule count or by sustained overload (offered load above capacity). The full runs are designed to separate these.

## Not testable on this bench

- Ethernet pause frames: the Pi has no `ethtool`, and nothing was installed.
- Switch CPU load is not measured directly; echo latency is the proxy.

## Files

`depth-sweep-*.json`, `depth-blackout-*.json`, `depth-workday-typical-*.json` (several, from the iterations above) and the matching `smoke-*.log` files.

## Rate-ladder control (added after the smoke tests)

`ladder` holds a fixed offered 600 B UDP packet rate at each rule depth and climbs (500 ... 15000 pps), stopping a depth when the switch saturates twice or loses its session. After each step it waits for the switch to answer an echo (or lose its session), so a stall that surfaces after the load ends is still caught, and the time to the first echo is recorded as control-plane recovery time.

Validation runs (12 s steps; indicative only):

- Depth 0: 2000 and 10000 pps offered were forwarded at 98.8% (1977 and 9872 pps) in every run. The receiver reported a constant ~1.2-1.3% loss at both rates and at depth 32 below saturation, so that offset is a measurement artifact (the switch ingress count is short of the nominal rate by the same amount), not downstream loss.
- Depth 32: 2000 pps forwarded cleanly; 10000 pps offered was forwarded at 5300 pps (5300 and 5299 in two runs), and the switch lost its OpenFlow session within ~10 s of that sustained overload. The harness recovered and continued.
- Fixes made during validation: the loss check now waits for the control plane to answer after each step; after a loss the harness pauses 6 s so the iperf3 server resets; a single retry on "server is busy".
