# Packet-Rate Limits of an OpenFlow Edge Switch Under Rule-Table Load

## Bottlenecks and per-device throughput of the Zodiac lab infrastructure

| | |
| --- | --- |
| **Document** | Technical whitepaper, Zodiac Network Infrastructure benchmark archive |
| **Version** | 1.1, 2026-10-09 (measurements unchanged from 1.0, 2026-10-04) |
| **Status** | Final for the measurements listed in section 7; open items in section 6 |
| **Companion** | [Run breakdown and timeline](zodiac-benchmark-run-breakdown-2026-10-04.md); project goals in the [roadmap](../ROADMAP.md) |
| **Data** | `docs/benchmarks/results/` (physical-run artifacts), `docs/benchmarks/analysis/` (scripts and outputs) |

## Abstract

We measure how fast a Northbound Networks Zodiac FX OpenFlow 1.3 switch (firmware 0.86) forwards traffic as the number of quarantine rules in its flow table grows, and where the rest of the lab infrastructure sits relative to it. Forwarding cost is `38.5 µs + 34.8 ns per payload byte above 64 + 4.24 µs per rule` per packet: a packet-rate limit set by the switch's microcontroller, not by its 100 Mbit/s ports. The model predicts an independent test within about 1% at three rule depths. A 600-byte stream that a 100 Mbit/s port could carry at 19,600 packets/s is limited to about 17,800 with an empty table, 8,055 with 16 rules and 1,711 with 126. Installing the forwarding rules first and at the highest priority cuts the per-rule cost to 1.3 µs. Overload beyond about 1.3 to 2.3 times capacity makes the switch drop its OpenFlow session and its whole flow table. Over three full-hour working-window runs the switch was unavailable 0.05% to 0.17% of the time. The model is intended as the hardware half of a policy verifier: a rule set can be logically correct and still exceed what the switch can forward, so capacity is a property to check before installation (section 8).

## Executive summary

- **The bottleneck is the switch CPU, and it moves with the rule count.** Port speed (100 Mbit/s) only binds for large packets with almost no rules (up to 94.45 Mbit/s of 1470-byte UDP payload at 0 rules). For 600-byte traffic the rule-scan cost overtakes the fixed per-packet cost at about 13 rules.
- **Capacity at 600 bytes:** 17,800 pps (85 Mbit/s, modelled) at 0 rules; 8,055 pps (38.7 Mbit/s) at 16; 5,272 pps (25.3 Mbit/s) at 32; 3,091 pps (14.8 Mbit/s) at 64; 1,711 pps (8.2 Mbit/s) at 126. The roadmap's 20,800 pps budget is not reachable at any depth.
- **One layout change recovers 1.6x to 2.6x.** Forwarding rules installed first and at the highest priority: 12,693 / 10,000 / 7,078 / 4,497 pps at 16 / 32 / 64 / 126 rules. Either change alone does not help; `/16` prefixes cost the same per entry as `/32` hosts.
- **A 5-minute working window costs about half the headline bandwidth.** With rules ramping 0 to 24 per window, modelled capacity averages 49 Mbit/s (66 Mbit/s with the better layout) and ends at 31 Mbit/s (54).
- **The control plane is the fragile part.** At 1.3 to 2.3 times capacity the switch drops its session and its table; recovery takes about 2 to 3 s. Spontaneous losses also occurred below capacity (8 in 3 working-window hours, all below the modelled capacity). Under sustained overload the table could not be restored at all.
- **The other devices are not the limit.** The workload node offers at least 95,000 pps of small packets, the receiver path carried up to 94.45 Mbit/s, and the controller answers echoes in 0.7 ms (median).

## 1. Scope and system under test

This work is the measurement foundation of Zodiac, a real-hardware testbed and verifier for agent-proposed SDN policy (see the [roadmap](../ROADMAP.md)). Verifying a proposed rule set against a switch requires knowing what the switch does, so the programme asks one question: *what traffic can this infrastructure carry, and what limits it?* The device under test (DUT) is a Zodiac FX switch whose four 100BASE-TX ports are wired as shown. All traffic of interest enters Port 1 and leaves Port 2.

```text
  Raspberry Pi 3B+                                          Mac workstation (Apple M5 Pro)
  workload / traffic source                                 iperf3 receiver, inference host
  eth0 100 Mbit/s  10.0.2.50                                Wi-Fi 10.0.2.119 via extender
        |                                                            ^
     Port 1                                                       Port 2
        +------------------[ Zodiac FX, fw 0.86 ]--------------------+
                  KSZ8795 port fabric + SAM4E8E MCU (flow table)
                      Port 3 (mirror tap)          Port 4 (control)
                              |                         |
                    Jetson tap NIC (USB3)         Jetson Orin Nano Super
                                                  OpenFlow controller (TCP 6633)
                                                  enP8p1s0 100 Mbit/s 10.0.1.8
```

> **Note (2026-10-09).** This diagram shows the setup of the recorded runs, with the ISP extender on Zodiac Port 2. Since 2026-10-09 a second NETGEAR GS105Ev2 (uplink switch #2) sits between them. The measurements predate it.

Traffic was generated on the Raspberry Pi (`iperf3` and a small paced UDP sender), received on the Mac, and observed by the switch's own port counters read over its serial console. The controller on the Jetson installs and verifies flow rules (OpenFlow multipart readback) and records session events. Every artifact is stamped `origin: physical_bench_run` and uses 64-bit integer counters; there is no simulated data (the repository's integer-accounting and provenance invariants, see [1]).

## 2. Method in brief

1. **Rate ladder.** For each rule depth, a fixed offered packet rate is held for 45 s, then raised. Below capacity the switch forwards what it is offered; above it the forwarded rate flattens at the capacity. The climb stops after two saturated steps or a session loss.
2. **Working-window simulation.** Twelve 5-minute windows. In each, quarantine rules are added evenly up to a profile maximum (8, 24 or 126), the load is a fixed-rate 600-byte UDP stream plus a rate-capped TCP flow, and the table is flushed at the next window start.
3. **Blackout probe.** A 10 ms ping is run from the workload node across a flush and reinstall, against a no-flush control.
4. **Layouts tested** (600-byte packets): `base` (quarantine rules first, priority 65535; forwarding at 100), `fwdfirst`, `fwdabove` (priority only), `fwdinstall` (install order only), `net16` (`/16` prefixes), `distinct` (own priorities).

Throughput is read from the switch (Port 1 RX and Port 2 TX packet counters), not from the receiver. Full parameters, run order and defects are in [4].

## 3. Bottlenecks, ranked by measured impact

| Rank | Bottleneck | Evidence | Headroom behaviour |
| --- | --- | --- | --- |
| 1 | **Rule-table scan cost** on the switch MCU: 4.24 µs per rule per packet (1.3 µs with the forwarding-first layout) | Linear fit across 64 B, 572 B and 1470 B ladders; predicts the 1470 B ladder within 1% | Dominates beyond about 13 rules; capacity falls roughly as 1 / (56 µs + 4.2 µs x rules) |
| 2 | **Fixed per-packet cost**: 38.5 µs at 64 B plus 34.8 ns per extra payload byte (56 µs at 572 B) | 0-rule ladders; 25,995 pps at 64 B | Sets the ceiling of about 17,800 pps for 600-byte packets |
| 3 | **Control-plane stability** | Session lost at 1.3 to 2.3 times capacity in every base-layout ladder; 8 spontaneous losses in 3 working-window hours; one switch hang needing a power cycle | Each loss empties the table; recovery 2 to 3 s; table restore impossible under sustained overload |
| 4 | **Port speed**, 100 Mbit/s | 7,896 to 8,034 pps of 1470 B UDP at 0 rules (92.9 to 94.45 Mbit/s of payload; wire limit about 95.7) | Binds only for large packets with almost no rules |
| - | Workload node, receiver path, Jetson controller | Section 4 | Not limiting at any tested point |

The model, for a UDP payload of `B` bytes and `N` quarantine rules (base layout):

```text
  t_packet = 38.5 µs + 0.0348 µs x (B - 64) + 4.24 µs x N
  capacity = 1,000,000 / t_packet   packets per second
```

Validation: the equation was fitted on the 64-byte and 572-byte ladders only. It predicts the independent 1470-byte ladder at 16 / 32 / 64 rules to 6,441 / 4,484 / 2,789 pps against 6,387 / 4,444 / 2,758 measured (-0.8% / -0.9% / -1.1%), and all other saturated points within about 1%. With the forwarding-first layout the per-rule term is 1.3 µs and the fixed term is unchanged (58 µs at 572 B).

```text
  forwarded packets/s at 600 B (each # about 500 pps)

  0 rules      ###################################   17,800 (modelled)
  16 rules     ################                       8,055   base
               #########################             12,693   forwarding first
  32 rules     ##########                             5,272   base
               ####################                  10,000   forwarding first
  64 rules     ######                                 3,091   base
               ##############                         7,078   forwarding first
  126 rules    ###                                    1,711   base
               #########                              4,497   forwarding first
```

## 4. Per-device throughput and bandwidth

| Device | Role | Link | Measured throughput | Limit / note |
| --- | --- | --- | --- | --- |
| **Zodiac FX switch**, data plane | DUT | 4 x 100BASE-TX | 600 B: 8,055 pps (38.7 Mbit/s) at 16 rules, 1,711 pps (8.2) at 126; 64 B: 25,995 pps at 0 rules; 1470 B: 7,896 pps (92.9 Mbit/s of UDP payload) at 0 rules, 94.45 Mbit/s best case in the first benchmark | MCU per-packet cost (section 3); port speed only for large packets |
| **Zodiac FX switch**, control plane | OpenFlow 1.3 agent | Port 4, 100 Mbit/s | Echo RTT median 0.7 ms, p99 about 200 ms; re-sync of up to 24 rules after a session loss took 0.1 to 0.8 s | Starves under overload; session lost at 1.3 to 2.3 x capacity |
| **Raspberry Pi 3B+** | Traffic source | eth0 100 Mbit/s | Offered 94,958 pps of 64 B at line rate, 30,005 pps (64 B paced), 19,595 pps (600 B), 8,140 pps (1470 B); TCP 61.9 (rerun median) to 83.7 Mbit/s (first run) at 0 rules | Never the limit: offered above the switch's capacity at every point |
| **Mac workstation + Wi-Fi extender** | Receiver | Wi-Fi to Port 2 | Received up to 94.45 Mbit/s of 1470 B UDP at 0 rules (91.3 median in the rerun); constant 1.2 to 1.3% shortfall at every rate below saturation (also seen at the switch ingress) | Not limiting; extender and Mac are a confound only |
| **Jetson Orin Nano Super** | Controller, benchmark host | enP8p1s0 100 Mbit/s | Controller kept up with every flow-mod burst and echo | Not limiting |
| **Jetson**, inference | Qwen2.5 3B (Q4_K_M) via Ollama | Tailscale | 15.4 tok/s per request, 15.2 to 15.3 aggregate; 72 requests, 0 errors; GPU 96.5% load, 12.5 W mean (13.1 peak), 56 C mean (59.4 max), RAM 4.6 to 5.1 of 7.6 GB | GPU-bound; requests are served one at a time |
| **Mac**, inference | Gemma4 26B (Q4_K_M) via Ollama | Tailscale | 62.5 to 63.0 tok/s aggregate, 67.8 to 68.4 per request; 264 requests, 0 errors | Served one at a time (aggregate flat or falling with concurrency) |

Ollama throughput is independent of the switch results: the inference traffic rides the Tailscale overlay between the Mac and the Jetson, not the Zodiac data plane. Concurrency does not raise aggregate throughput on either model (Qwen 14.0 / 15.3 / 15.3 tok/s at 1 / 2 / 4 in flight; Gemma 54.1 / 49.8 / 38.6), so latency scales with queue depth. The Mac's Ollama reports a loaded size of 2.36 GB for a 25.2B-parameter model that is 18 GB on disk; that discrepancy is not explained, so the Mac's inference figures are measurements without a resource explanation.

The Coral TPU and Jetson GPU anomaly detector figures in the SENTINEL roadmap [3] were not measured in this programme and are not restated here.

## 5. Bandwidth envelope

### 5.1 Static capacity (600-byte packets)

| Quarantine rules | Base layout | Forwarding rules first and highest priority | Gain |
| --- | --- | --- | --- |
| 0 | about 17,800 pps / 85 Mbit/s (modelled; at least 14,807 measured) | about 17,200 pps / 83 Mbit/s (modelled) | - |
| 16 | 8,055 pps / 38.7 Mbit/s | 12,693 pps / 60.9 Mbit/s | 1.6x |
| 32 | 5,272 pps / 25.3 Mbit/s | 10,000 pps / 48.0 Mbit/s | 1.9x |
| 64 | 3,091 pps / 14.8 Mbit/s | 7,078 pps / 34.0 Mbit/s | 2.3x |
| 126 | 1,711 pps / 8.2 Mbit/s | 4,497 pps / 21.6 Mbit/s | 2.6x |

Mbit/s are IP-layer (600 bytes x 8 x pps). The original plan's 20,800 pps (100 Mbit/s at 600 bytes) ignores both framing (19,592 pps on the wire) and the switch CPU (17,800).

### 5.2 One working window (rules ramp from 0 to N over 5 minutes, then flush)

| Ramp | Layout | Capacity at start | Window average | End of window |
| --- | --- | --- | --- | --- |
| 0 to 8 rules | base | 17,794 pps | 13,956 pps (67.0 Mbit/s) | 11,146 pps (53.5) |
| 0 to 24 rules | base | 17,794 pps | 10,203 pps (49.0 Mbit/s) | 6,379 pps (30.6) |
| 0 to 24 rules | forwarding first | 17,241 pps | 13,797 pps (66.2 Mbit/s) | 11,211 pps (53.8) |
| 0 to 126 rules | base | 17,794 pps | 4,440 pps (21.3 Mbit/s) | 1,712 pps (8.2) |
| 0 to 126 rules | forwarding first | 17,241 pps | 8,192 pps (39.3 Mbit/s) | 4,509 pps (21.6) |

These are modelled from the fitted cost equation. The model's prediction for 24 rules (6,379 pps) matched an independent measurement: the overloaded 50% working-window run forwarded 6,325 pps at 24 to 27 rules.

### 5.3 Measured full-hour working windows (12 windows, flush every 5 minutes)

| Profile | Offered load | Throughput (Port 1 RX) | Session losses | Outage in the hour | Unavailable |
| --- | --- | --- | --- | --- | --- |
| Typical, 0 to 24 rules | 4,898 pps UDP (25%) + 5 Mbit/s TCP | 5,261 falling to 5,022 pps | 1 | 1.7 s | 0.05% |
| Low, 0 to 8 rules | 9,796 pps UDP (50%) + 5 Mbit/s TCP | 9,997 falling to 9,689 pps | 3 | 4.3 s | 0.12% |
| Worst case, 0 to 126 rules | 979 pps UDP (5%) + 2 Mbit/s TCP | 1,142 falling to 1,099 pps | 4 | 6.0 s | 0.17% |

Each run carried its offered load throughout. The 50% load on the typical profile (above capacity once the table passes about 12 rules) forwarded 10.0k pps falling to 6.3k at 24 rules and could not be completed: after a session loss the table could not be restored while the overload continued.

### 5.4 Operations

- **Flush cost.** A wipe-and-reinstall of the table adds about 0.1 s to the longest ping gap under 1,000 pps of load, and none at idle. A selective delete of 126 rules leaves forwarding intact but takes about 1.5 s under load. The baseline gap from the Wi-Fi path is about 130 ms.
- **Unbounded TCP is a saturating load.** An unbounded TCP flow alongside 25% UDP drove the switch to saturation and starved TCP once the table passed about 16 rules.

## 6. Limitations and open items

1. **Drop-path capacity is unmeasured.** The drop-hit ladders ran but the hit rule's packet counter stayed at 0 while traffic was dropped, and the session was lost in five of seven steps, 7 to 30 s in, at 500 pps. Whether this is firmware counter behaviour or a harness issue is unresolved; a mirror-port capture would settle it.
2. **Switch CPU is not measured directly.** "Software lookup on the MCU" is inferred from the linear per-rule cost, not observed.
3. **Spontaneous session losses are unexplained** (8 in the 3 working-window hours, one at a quarter of capacity in a ladder). The switch's network stack wedged once and needed a power cycle.
4. **Replication.** Layout ladders other than `base` and `fwdfirst` are single rounds; fits use 2 to 4 saturated points. One switch, one workload node, one receiver path.
5. **Overload behaviour is only partially characterised.** The 50% typical profile produced one usable window.
6. **One switch, one firmware.** The cost model is fitted to a single Zodiac FX on firmware 0.86; it should not be assumed to hold for other units or firmware versions.
7. **Not tested:** Ethernet pause frames (no `ethtool` on the Pi), `/16` rules matching real traffic, and the Jetson nftables offload recommendation.

## 7. Reproducibility

All claims trace to artifacts in `docs/benchmarks/results/` and are regenerated by the scripts in `docs/benchmarks/analysis/`. The harness is `scripts/zodiac-dataplane-bench.ts` with pure logic in `src/sdn/dataplane-depth.ts` (unit tests in `test/invariants/dataplane-depth.test.ts`). Commands, parameters and the run catalogue are in [4]. The benchmark must run on the isolated bench: it wipes the flow table, saturates Port 2 and requires the production bridge to be stopped.

## 8. Use as a verifier input

The cost model and layout result are written to be consumed by code, not only read. For a candidate rule set the verifier can compute, before anything is installed:

1. **Rule budget.** Rule count against the 128-rule table, leaving room for quarantine rules added at runtime.
2. **Modeled capacity.** `capacity = 1,000,000 / t_packet` for the declared packet size and rule count, compared with a stated target rate.
3. **Layout.** Whether forwarding rules sit first at the highest priority (1.3 µs per rule) or behind quarantine rules (4.24 µs per rule). The same rules can differ by up to 2.6x in capacity.
4. **Control-plane margin.** Offered load above about 1.3 times modeled capacity risks losing the session and the table, so a policy whose expected load approaches capacity should be rejected even if it is logically correct.

Layout caveat: the forwarding-first layout ranks forwarding rules above quarantine rules, so a quarantined source that also matches a forwarding rule would still be forwarded. The benchmark's quarantine rules match addresses that never appear on the wire, so the measurements are unaffected, but a verifier cannot accept that layout for real quarantine without resolving the conflict (roadmap A4 versus A9).

Status: these checks are specified in the roadmap (track A, properties A7 to A9; track B) and are not yet implemented. The model has been validated within about 1% on the measurements in section 5, on one switch; it has not been validated as a verifier input, and its prediction should be checked against the conformance probe (track B) before the verifier relies on it. Model-versus-wire disagreement is expected to occur, and each instance is a finding about the model or the firmware.

## References

1. Zodiac FX data-plane benchmark report: [`zodiac-fx-dataplane-report.md`](zodiac-fx-dataplane-report.md) (first three-depth run, 2026-10-03).
2. Design and runbook: `docs/design/zodiac-fx-dataplane-benchmark.md`.
3. SENTINEL roadmap, "Bandwidth & Bottleneck Analysis": `docs/SENTINEL-ROADMAP.md`.
4. Run breakdown and end-to-end timeline: [`zodiac-benchmark-run-breakdown-2026-10-04.md`](zodiac-benchmark-run-breakdown-2026-10-04.md).
5. Depth, layout and working-window analysis: [`zodiac-fx-depth-analysis-2026-10-04.md`](zodiac-fx-depth-analysis-2026-10-04.md).
6. Open Networking Foundation, *OpenFlow Switch Specification, Version 1.3.5*, 2015.
7. IEEE 802.3, Ethernet (frame, preamble and inter-frame gap overhead used for the framed line-rate figures).
8. ESnet, `iperf3` documentation, <https://software.es.net/iperf/>.
9. RFC 5737, IPv4 Address Blocks Reserved for Documentation (TEST-NET-2 sources used for quarantine rules).

## Glossary

- **Capacity**: the highest forwarded packet rate in a ladder step without a session loss, at which the forwarded rate flattened (saturated step).
- **Layout**: the order and priority of forwarding versus quarantine rules in the flow table.
- **Session loss**: the switch closing its OpenFlow TCP session, after which it clears its flow table.
- **Working window**: a 5-minute interval in which quarantine rules accumulate before the table is flushed.
- **pps**: packets per second. **Mbit/s** in this document is IP-layer unless stated.

## How to cite

Zodiac Network Infrastructure benchmark archive, *Packet-Rate Limits of an OpenFlow Edge Switch Under Rule-Table Load*, v1.0, 2026-10-04, `docs/benchmarks/zodiac-infrastructure-bandwidth-whitepaper-2026-10-04.md`. Measurements cite artifact names under `docs/benchmarks/results/`.

## Document history

| Version | Date | Change |
| --- | --- | --- |
| 1.0 | 2026-10-04 | First release. Measurement and analysis drafted with Claude Sonnet 5.5. |
| 1.1 | 2026-10-09 | Repositioned as the measurement foundation of a policy verifier and testbed: scope paragraph, abstract sentence, section 8 (verifier input), limitation 6. No measurements, figures or conclusions changed. |
