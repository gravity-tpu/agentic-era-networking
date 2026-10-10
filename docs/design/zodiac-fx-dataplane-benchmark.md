# Zodiac FX Data-Plane Benchmark

**Status: PHYSICAL HARDWARE RUN RECORDED (`2026-10-03T23:26:49.149Z`).** Telemetry gathered from live bare-metal silicon across Port 1 (RPi 3B+) ⟷ Port 2 (Transit to Mac). Full architectural findings and CCIE analysis are cataloged in [Physical Data-Plane Benchmark Results & Architectural Findings](../benchmarks/zodiac-fx-dataplane-report.md) and raw artifact [dataplane-2026-10-03T23-26-49-149Z.json](../benchmarks/results/dataplane-2026-10-03T23-26-49-149Z.json). No figure in this document is an estimate, extrapolation, or datasheet number presented as a measurement.

> **Update 2026-10-09.** This is the runbook and the first three-depth run. The 2026-10-04 depth, layout and working-window campaign extends it and fits a cost model; see the [whitepaper](../benchmarks/zodiac-infrastructure-bandwidth-whitepaper-2026-10-04.md). The model is the hardware input to the policy verifier described in the [roadmap](../ROADMAP.md).

Governing invariants: repository invariants 1, 2, 3, 4, 6 ([AGENTS.md](../../AGENTS.md)) and NET-002, NET-004, NET-005 ([network-engineering-principles.md](../../.agents/rules/network-engineering-principles.md)).

---

## 1. Question

1. How do throughput, packets-per-second and loss of the Port 1 to Port 2 data plane change as the OpenFlow flow table fills with 0, 32 and 128 quarantine rules?
2. With the Port 3 mirror enabled, at what offered load does the tap begin to lose frames, as observed in the switch port counters?

## 2. Topology under test

```text
 RPi 3B+ eth0 10.0.2.50 ── Port 1 ┐
                                  │  Zodiac FX (SAM4E8E + KSZ8795)   Port 2 ── Wi-Fi extender ── iperf3 server
 Jetson tap NIC (promisc) ─ Port 3 ┤  VLAN 100 (OpenFlow)
 Jetson enP8p1s0 10.0.1.8 ─ Port 4 ┘  VLAN 200 (OpenFlow control, 6633)
```

> **Note (2026-10-09).** This diagram shows the setup of the recorded runs, with the ISP extender on Zodiac Port 2. Since 2026-10-09 a second NETGEAR GS105Ev2 (uplink switch #2) sits between them. The measurements predate it.

Management of the workload is out of band: the Jetson reaches the Pi over `wlan0` (10.0.0.45) via SSH, so benchmark control traffic never crosses the switch under test.

## 3. Method

### 3.1 Controller model

The script is the switch's **only** OpenFlow controller for the duration of the run. `zodiac-bridge.service` must be stopped first (the script refuses to start if port 6633 is bound). It starts from a wildcard `OFPFC_DELETE`, installs a declared plan, and **reads the table back from the switch** with `OFPMP_FLOW` before measuring. Rule residency is therefore observed, not assumed. If the switch cannot answer the readback the run aborts (fail-closed) unless `--unverified-flow-table` is given, which stamps every result `flowTableVerified: false` and prints a warning banner.

### 3.2 Conditions

| Condition | Flow table contents | Purpose |
| :--- | :--- | :--- |
| `q0` | 2 forwarding rules | Control for the rule-depth effect |
| `q32` | 32 quarantine DROP + 2 forwarding | Mid occupancy (below the 102-rule high-water mark) |
| `q128` | as many quarantine DROP as fit + 2 forwarding | Maximum occupancy |
| `tap-mirror` | 2 forwarding rules, Port 1 ingress output to `[2, 3]` | Tap-drop sweep |

**Requested 128 quarantine rules cannot be installed as such.** The hardware ceiling is 128 entries in total (NET-002), and the benchmark needs two forwarding rules (Port 1 to 2 and Port 2 to 1) so that traffic exercises the rule path rather than the controller punt path. The `q128` condition therefore installs 126 quarantine rules. This is recorded as `quarantineRequested: 128, quarantineInstalled: 126, clamped: true` in the artifact and surfaced in the results table. The plan never exceeds the table, because overflowing a 128-entry MCU table risks silent rule loss or a driver fault (NET-002 forbids both).

Design choices that make the rule-depth comparison meaningful:

- **Quarantine priority 65535, forwarding priority 100.** This mirrors production (quarantine above everything) and is the worst case if the firmware scans in priority order: every packet is checked against every quarantine rule before it reaches its forwarding rule.
- **Quarantine matches use `198.51.100.1` onward (RFC 5737 TEST-NET-2).** They fill the table without ever matching benchmark traffic. After each block the script re-reads the per-flow packet counts and **invalidates the run** if any quarantine rule matched a packet.
- **No table-miss rule.** All benchmark traffic is covered by `in_port` rules; absent a table-miss entry OpenFlow 1.3 drops (fail-closed). This also keeps the production punt-to-controller path out of the measurement.
- **Admissibility check first.** Every plan is run through `verifyPlanAdmissible` (table budget, no hairpin, DROP semantics for quarantine) before any message is sent to the switch (Invariant 4). Runs recorded before 2026-10-09 used a cycle check over fixed hop lists instead; it could not fail and was removed.

### 3.3 Tests per trial

| Test | iperf3 invocation (on the Pi, bound to 10.0.2.50) | Reports |
| :--- | :--- | :--- |
| `tcp` | `-t D` | Goodput, retransmits |
| `udp_mtu` | `-u -l 1470 -b <payload line rate>` | Goodput, iperf loss, pps |
| `udp_small` | `-u -l 64 -b <payload line rate for 64 B>` | pps stress (the Pi is the limiting generator; offered pps is measured, not assumed) |
| `idle` | no traffic, same window | Background packet noise floor |

The UDP offered rate is computed, not tuned: `100 Mbit/s x payload / (payload + 66)` where 66 B is UDP, IPv4, Ethernet, FCS, preamble and inter-frame gap.

Trials are **interleaved** by default (`q0, q32, q128, q0, ...`) so slow drift in the Wi-Fi extender path is spread across conditions rather than aliased onto one. Each cell is reported as min / median / max over valid trials; rejected trials are listed with the reason.

### 3.4 Metrics and arithmetic

All counters are `BigInt`. All durations come from `process.hrtime.bigint()`. iperf3 emits floating-point fields (`bits_per_second`, `seconds`, `lost_percent`); the parser does not read them. Every rate is re-derived from integer byte or packet counts:

- `goodput bit/s = received bytes x 8 x 10^9 / window ns` (UDP: delivered datagrams x payload bytes).
- `pps = counter delta x 10^9 / window ns`, from the switch counters for Port 1 RX, Port 2 TX and Port 3 TX, and from the workload NIC for offered pps.
- `loss ppm = lost x 10^6 / offered`, from iperf3 (end to end, includes the Wi-Fi extender) and from the switch (`Port 1 RX - Port 2 TX`, isolates the switch).

The rate denominator is the nominal iperf3 window (`-t D`). The wall-clock of the iperf3 process is recorded per trial and must be at least the nominal window or the trial is rejected.

### 3.5 Tap-drop threshold

With the mirror rule installed, Port 1 ingress is copied to Port 3. For each offered UDP rate the script reads the switch counters and computes:

- **Hard drop**: `Port 3 TX Dropped` increased.
- **Soft loss**: the mirror deficit `Port 1 RX - Port 3 TX` in ppm exceeds the **noise floor**, defined as the largest deficit seen across the calibration trials at the lowest rate. There is no hardcoded tolerance (Invariant 5).

The sweep ascends a grid (10% to 100% of payload line rate by default) until the first lossy rate, then bisects between the last clean and first lossy rate down to `--tap-resolution-mbps`. A rate is lossy if **any** valid trial at that rate detects loss. The reported outcome is one of `bracketed`, `not_reached` (threshold above range), `below_range` (loss at the lowest rate) or `aborted`. A threshold is never extrapolated. Every probe appears in the table, since the response is not assumed to be monotonic.

When `--tap-iface` is supplied the Jetson tap NIC `rx_packets` and `rx_dropped` are recorded as an independent end-to-end cross-check (Clark).

## 4. Provenance (Invariant 6)

Each run writes a JSON artifact (`docs/benchmarks/results/dataplane-<UTC>.json`) with `origin: "physical_bench_run"`. It contains:

- Switch identity from the live OpenFlow handshake (datapath ID, peer address), serial path, firmware version.
- Workload host kernel, iperf3 version, interface, address, plus the verified route.
- Script SHA-256, git commit, dirty flag, controller host, Node version.
- Raw `show ports` text before and after every trial, and a SHA-256 of every raw iperf3 JSON.
- The switch-side flow readback per condition.

The renderer refuses any artifact whose origin is not `physical_bench_run`. The script refuses to run if `MOCK_SERIAL` is set and has no simulation mode.

Preconditions are attested before the first measurement: Port 1 and 2 links UP, the workload NIC owns 10.0.2.50, and `ip route get <server> from 10.0.2.50` egresses via that NIC. The last check matters because the Pi is dual-homed (`wlan0` carries the default route per the network context); without it iperf3 could traverse `wlan0` and measure nothing about the switch.

## 5. Known confounds (read before interpreting results)

1. **The Wi-Fi extender is in the path.** End-to-end goodput and iperf loss are bounded by it and are noisy. Switch-isolating evidence is the switch-counter loss (`Port 1 RX - Port 2 TX`), Port 1/2 drop counters, and the comparison across rule counts on the same path. Interleaving and repeated trials mitigate drift but do not remove it.
2. **The Raspberry Pi 3B+ is the traffic generator.** Its USB2-attached NIC and CPU cap offered pps, especially for `udp_small`. Offered pps is taken from the Pi NIC's own counters.
3. **Where the flow table executes is unverified here.** The repo documents hardware-speed forwarding, but the Zodiac FX runs its OpenFlow table on the SAM4E8E MCU with the KSZ8795 as the port fabric. If so, rule count and per-packet CPU cost are directly coupled and the 100 Mbit/s port rate is not the only ceiling. This benchmark exists partly to settle that; the results must decide it, not this paragraph.
4. **`show ports` is the counter source.** Whether the firmware reads these from KSZ8795 MIB registers is firmware-defined. Hence the cross-checks against workload-NIC and tap-NIC sysfs counters. A counter that regresses (wrap or reset) rejects the whole window; the script never guesses.
5. **Counter reads go over a slow serial CLI** (seconds per read). Windows are bracketed by reads taken before and after the traffic, with a matching idle window to quantify background chatter.
6. **Exact-match rules only.** `buildOfpFlowMod` encodes IPv4 source addresses without masks, so quarantine rules here are `/32`-equivalent regardless of the CIDR in the rule struct. This measures table depth, not the supernet aggregation NET-002 prescribes. Testing masked rules needs OXM mask support in `openflow-types.ts`.
7. **Production mirror differs slightly.** The bridge installs a separate priority-1 mirror rule (Port 1 to 3, plus Port 3 to 1). In this benchmark the mirror is folded into the priority-100 forwarding rule (`[2, 3]`), because a higher-priority forwarding rule would otherwise shadow a lower-priority mirror and Port 3 would see nothing. `--tap-return-path` adds the Port 3 to 1 rule.
8. **Port 4 stays on VLAN 200** and is not exercised.

## 6. Runbook

Run on the Jetson, with the Pi reachable over SSH key auth and `iperf3 -s` running on the Mac operator workstation behind the extender.

### Workstation Setup (Behind Port 2 Transit)

```bash
# Add data-plane IP alias on Mac Wi-Fi interface (en0)
sudo ifconfig en0 alias 10.0.2.119 netmask 255.255.255.0

# Bind 10.0.2.0/24 subnet directly to physical link en0 (bypassing default gateway and overlay routes)
sudo route add -net 10.0.2.0/24 -link -iface en0

# Start iperf3 server daemon on the data-plane IP
iperf3 -s -B 10.0.2.119
```

### Benchmark Execution on Jetson Appliance

```bash
sudo systemctl stop zodiac-bridge.service
npm run build:server

# Read-only preflight attestation
npm run bench:dataplane -- preflight \
  --server 10.0.2.119 \
  --pi-ssh agent@10.0.0.45 \
  --pi-ip 10.0.2.50 \
  --tap-iface enx9c69d39dd0a6

# Full benchmark execution across conditions (q0, q32, q128) and tap sweep
npm run bench:dataplane -- run \
  --server 10.0.2.119 \
  --pi-ssh agent@10.0.0.45 \
  --pi-ip 10.0.2.50 \
  --tap-iface enx9c69d39dd0a6

sudo systemctl start zodiac-bridge.service   # restores production rules
```

`preflight` is read-only: it checks serial, link state, workload addressing and routing, waits for the switch's OpenFlow handshake, and reports whether `OFPMP_FLOW` readback works. It installs nothing and generates no traffic. Use it first. If the readback is not supported by the firmware, decide deliberately whether to accept `--unverified-flow-table`.

`render <artifact.json>` regenerates the Results section from a stored artifact. The script also flushes its own flow table (default-drop) on exit or `SIGINT`.

Useful flags: `--rules 0,32,128`, `--duration 10`, `--trials 5`, `--order interleaved|sequential`, `--tap-rates-mbps 10,20,...`, `--tap-trials 3`, `--tap-resolution-mbps 1`, `--skip-dataplane`, `--skip-tap`.

## 7. Design audit (historical)

Recorded before the 2026-10-09 refocus. The loop-freedom line reflects a cycle check that could not fail; it is superseded by `verifyPlanAdmissible` (see section 3).

```text
══════════════════════════════════════════════════════════════════════
  Network engineering audit: Zodiac FX data-plane benchmark
══════════════════════════════════════════════════════════════════════

1. Physical & Layer Separation:
   - Data Plane Placement: Switch silicon/MCU flow table under test; no kernel path involved
   - Control Plane Decoupling: PASS (benchmark control over wlan0, OpenFlow over Port 4)

2. Silicon & Table Budget Accounting:
   - TCAM / Flow Table Consumption: q0 = 2/128, q32 = 34/128, q128 = 128/128 (126 quarantine + 2 forwarding)
   - Prefix Aggregation: NOT EXERCISED (exact-match rules; see confound 6)

3. Transport & Buffer Dynamics:
   - TCP Congestion & ACK-Clocking Impact: measured via goodput and retransmits
   - Drop Point Efficiency: switch-side (Port counters) separated from path-side (iperf3 loss)

4. Loop-Freedom & Convergence:
   - Plan admissibility: checked per plan (verifyPlanAdmissible) before install; earlier runs used a cycle check that could not fail
   - Flap Prevention (Hysteresis): N/A (static plans; no dynamic quarantine engine involved)

5. Verdict:
   DESIGN APPROVED. RESULTS PENDING PHYSICAL RUN.
══════════════════════════════════════════════════════════════════════
```

Note the 128/128 occupancy in `q128` exceeds the 102-rule (80%) high-water mark by design: it measures the failure edge, so it must only be run on the isolated bench, never against production traffic.

## 8. Results

Generated by `npm run bench:dataplane -- run` or `render`. Do not edit between the markers.

<!-- BENCH-RESULTS:BEGIN -->

### Run 2026-10-03T23:26:49.149Z

| Field | Value |
| :--- | :--- |
| Provenance origin | `physical_bench_run` (physical bench run, schema `zodiac-dataplane-bench/v1`) |
| Switch datapath ID | `0x70b3d58740c9` via OpenFlow peer `10.0.1.99` |
| Switch firmware | `0.86` on `/dev/ttyACM0` |
| Counter source | Zodiac FX serial CLI `show ports` (Port RX/TX packets, bytes, dropped, CRC). Whether firmware sources these from KSZ8795 MIB registers is firmware-defined and is cross-checked here against workload-NIC and tap-NIC sysfs counters. |
| Workload | `agent@10.0.0.45` `eth0` `10.0.2.50`, Linux 6.18.50+rpt-rpi-v8, iperf 3.18 (cJSON 1.7.15) |
| iperf3 server | `10.0.2.119` |
| Tap NIC cross-check | `enx9c69d39dd0a6` |
| Tool | script sha256 `dbd4babd04fdd766`, git `be2e719` (dirty tree) |
| Monotonic span | 433627406766 ns |
| Params | 10s/test, 5 trials, interleaved, UDP offered 95703125 bit/s |

> [!NOTE]
> The 128-entry table must also hold the mandatory forwarding rules, so these conditions installed fewer quarantine rules than requested: 128 requested / 126 installed.

#### Quarantine-depth data plane (Port 1 to Port 2, mirror off)

Each cell is min / median / max over valid trials. Throughput is receiver goodput in bit/s from integer byte counts over the nominal test window.

| Quarantine rules (req/inst) | Table verified | Test | Valid/total | Goodput bit/s | Goodput Mbit/s (median, floor) | Switch P1 RX pps | Switch P2 TX pps | iperf loss ppm | Switch fwd loss ppm | Retransmits | P1 RX drop | P2 TX drop |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 0/0 | yes | tcp | 3/4 | 82942361 / 83676364 / 84724940 | 83 | 7173 / 7236 / 7326 | 7173 / 7236 / 7326 | n/a | 0 / 0 / 0 | 274 / 317 / 477 | 0 / 0 / 0 | 0 / 0 / 0 |
| 0/0 | yes | udp_mtu | 3/4 | 94431624 / 94450440 / 94451616 | 94 | 8034 / 8034 / 8035 | 8034 / 8034 / 8035 | 13183 / 13186 / 13195 | 0 / 0 / 0 | n/a | 0 / 0 / 0 | 0 / 0 / 0 |
| 0/0 | yes | udp_small | 2/4 | 12577075 / 12577407 / 12577740 | 12 | 24669 / 24669 / 24670 | 24669 / 24669 / 24670 | 741174 / 741232 / 741291 | 0 / 0 / 0 | n/a | 0 / 0 / 0 | 0 / 0 / 0 |
| 0/0 | yes | idle (noise floor) | 4/4 | n/a | n/a | 0 / 0 / 1 | 0 / 0 / 1 | n/a | n/a | n/a | n/a | n/a |
| 32/32 | yes | tcp | 2/3 | 6501171 / 6658457 / 6815744 | 6 | 570 / 584 / 598 | 570 / 584 / 598 | n/a | 0 / 0 / 0 | 284 / 292 / 300 | 0 / 0 / 0 | 0 / 0 / 0 |
| 32/32 | yes | udp_mtu | 2/3 | 52252032 / 52274964 / 52297896 | 52 | 4450 / 4450 / 4451 | 4450 / 4450 / 4451 | 453592 / 453831 / 454071 | 0 / 0 / 0 | n/a | 0 / 0 / 0 | 0 / 0 / 0 |
| 32/32 | yes | udp_small | 0/3 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| 32/32 | yes | idle (noise floor) | 3/3 | n/a | n/a | 0 / 0 / 1 | 0 / 0 / 1 | n/a | n/a | n/a | n/a | n/a |
| 128/126 | yes | tcp | 1/3 | 4508876 / 4508876 / 4508876 | 4 | 394 / 394 / 394 | 394 / 394 / 394 | n/a | 0 / 0 / 0 | 338 / 338 / 338 | 0 / 0 / 0 | 0 / 0 / 0 |
| 128/126 | yes | udp_mtu | 1/3 | 18142152 / 18142152 / 18142152 | 18 | 1601 / 1601 / 1601 | 1601 / 1601 / 1601 | 810448 / 810448 / 810448 | 0 / 0 / 0 | n/a | 0 / 0 / 0 | 0 / 0 / 0 |
| 128/126 | yes | udp_small | 0/3 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| 128/126 | yes | idle (noise floor) | 3/3 | n/a | n/a | 0 / 1 / 1 | 0 / 1 / 1 | n/a | n/a | n/a | n/a | n/a |

#### Rejected trials

| Ordinal | Condition | Test | Reason |
| :--- | :--- | :--- | :--- |
| 3 | q0 | udp_small | iperf3 reported an error: interrupt - the client has terminated |
| 5 | q32 | tcp | iperf3 reported an error: the server is busy running a test. try again later |
| 6 | q32 | udp_mtu | iperf3 reported an error: the server is busy running a test. try again later |
| 7 | q32 | udp_small | iperf3 reported an error: the server is busy running a test. try again later |
| 11 | q128 | udp_small | iperf3 reported an error: interrupt - the client has terminated |
| 13 | q0 | tcp | iperf3 reported an error: the server is busy running a test. try again later |
| 14 | q0 | udp_mtu | iperf3 reported an error: the server is busy running a test. try again later |
| 15 | q0 | udp_small | iperf3 reported an error: the server is busy running a test. try again later |
| 19 | q32 | udp_small | iperf3 reported an error: interrupt - the client has terminated |
| 21 | q128 | tcp | iperf3 reported an error: the server is busy running a test. try again later |
| 22 | q128 | udp_mtu | iperf3 reported an error: the server is busy running a test. try again later |
| 23 | q128 | udp_small | iperf3 reported an error: the server is busy running a test. try again later |
| 31 | q32 | udp_small | iperf3 reported an error: interrupt - the client has terminated |
| 33 | q128 | tcp | iperf3 reported an error: the server is busy running a test. try again later |
| 34 | q128 | udp_mtu | iperf3 reported an error: the server is busy running a test. try again later |
| 35 | q128 | udp_small | iperf3 reported an error: the server is busy running a test. try again later |

<!-- BENCH-RESULTS:END -->
