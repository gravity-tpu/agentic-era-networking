# Zodiac FX: bandwidth vs flow-table depth, layout and working-window behaviour (2026-10-04)

Companion to [`zodiac-fx-dataplane-report.md`](zodiac-fx-dataplane-report.md). That report measured three rule depths; this one measures capacity as a function of depth, rule layout and packet size, tests the roadmap's 20,800 pps figure, and replays a 1-hour working window with a 5-minute flush.
Raw artifacts: `results/ladder-2026-10-04/` and `results/full-2026-10-04/`. Every table below is produced by `analysis/analyze_depth.py` (output saved in `analysis/analysis-output-2026-10-04.txt`). Harness: `scripts/zodiac-dataplane-bench.ts` (`ladder`, `workday`, `blackout`, `sweep`), unit tests in `test/invariants/dataplane-depth.test.ts`.

## 1. Bottom line

- **The roadmap's 20,800 pps (100 Mbit/s at 600 B) is not reachable, even with an empty table.** The switch costs about 56 µs per 600-byte packet before any rule is counted, which is about 17,800 pps (85 Mbit/s), and every quarantine rule adds about 4.2 µs per packet on top. The port speed is not the limit; the switch CPU is.
- **Capacity at 600 B (measured, 45 s steps):** 8,055 pps (38.7 Mbit/s) at 16 rules, 5,272 pps (25.3 Mbit/s) at 32, 3,091 pps (14.8 Mbit/s) at 64, 1,711 pps (8.2 Mbit/s) at 126.
- **Fixing the layout helps a lot, but only one layout.** Installing the two forwarding rules *first* **and** at a *higher priority* than the quarantine rules cuts the per-rule cost from 4.2 µs to 1.3 µs: 12,693 / 10,000 / 7,078 / 4,497 pps at 16 / 32 / 64 / 126 rules (1.6x to 2.6x better). Raising their priority alone does nothing, installing them first alone is worse, `/16` prefixes cost the same per entry as `/32` hosts, and distinct priorities change nothing.
- **Packet size barely matters once the table has rules.** At 16-126 rules, 64-byte and 572-byte payloads forward the same packets per second (7,907 vs 8,055 at 16; 1,731 vs 1,711 at 126). At 0 rules 64-byte packets reach 25,995 pps (about 37 ns less per byte). So bandwidth scales with packet size and is a packets-per-second limit.
- **Typical working window (rules ramp 0 to 24 over 5 minutes, then flush):** the modelled capacity falls from 17.8k to 6.4k pps (87 to 31 Mbit/s of 600-byte packets), averaging about 10.2k pps (49 Mbit/s) across the window with the base layout, or 13.8k pps (66 Mbit/s) with the better layout. A worst-case window ramping to 126 rules averages 4.4k pps (21 Mbit/s) and ends at 1.7k (8 Mbit/s).
- **Measured over full hours (12 windows, flush every 5 minutes):** typical 25% load carried its offered load throughout with 1 session loss and 1.7 s of outage in the hour; low 50% load (8 rules) had 3 losses and 4.3 s; worst case at 5% load (all 126 rules) had 4 losses and 6.0 s. That is 0.05% to 0.17% of the hour unavailable.
- **Overload is more than slow: it costs the control session.** The switch drops its OpenFlow session (and its whole flow table) when offered load reaches roughly 1.3 to 2.3 times capacity. Recovery takes about 2 s to reconnect and 0.1 to 0.8 s to restore rules. Session losses also happened below capacity (section 6).
- **A 5-minute flush is cheap.** Wiping and reinstalling the table adds about 0.1 s to the longest ping gap (section 5).

## 2. What was run and how complete it is

| Experiment | Status |
| --- | --- |
| Rate ladder, 600 B, base and forwarding-first layouts (2 rounds each) | Complete |
| Rate ladder, 64 B and 1470 B, base layout | Complete |
| Rate ladder, layouts `fwdabove`, `fwdinstall`, `net16`, `distinct` (600 B) | Complete (1 round) |
| Working-window runs (12 x 5 min, rules ramp, flush each window) | **Complete, 12/12 windows (a full hour) for typical 25% (24 rules), low 50% (8 rules) and worst-case 5% (126 rules).** Typical 50% (above capacity) could not complete: only 1 window was recorded (section 7). |
| Flush / reinstall blackout probe | Complete (3 repetitions per cell) |
| Drop-hit ladders (traffic matching a DROP rule) | **Inconclusive**, not interpreted (section 7) |
| Depth/size sweep with saturating loads | Superseded by the ladders. Saturating loads kept knocking the session out and invalidated most trials (23 of 55 flagged), so its numbers are not used. |

All figures are single or double rounds on one switch, one workload node and one Wi-Fi receiver path. Treat them as measurements of this bench, not as a distribution.

## 3. Capacity by rule depth (600 B, packets per second)

Highest forwarded rate in any step without a session loss; `*` marks a saturated step (a true capacity); `[x]` is the lowest offered rate at which the session was lost.

| layout | payload B | 0 | 16 | 32 | 64 | 126 | fit: fixed µs + per-rule µs |
| --- | --- | --- | --- | --- | --- | --- | --- |
| base | 64 | 25995 | 7907 [12000] | 5700* [12000] | 3201* [8000] | 1731* [4000] | 38.5 + 4.28 x rules (n=3) |
| base | 572 | 14807 | 8055* [12000] | 5272* [8000] | 3091* [4000] | 1711* [4000] | 56.2 + 4.19 x rules (n=4) |
| base | 1470 | 7896 | 6387 [8000] | 4444* | 2758 [4000] | 988 [2000] | n/a |
| distinct | 572 | - | 8076* | 5224* [8000] | - | 1708* [4000] | 56.9 + 4.20 x rules (n=3) |
| fwdabove | 572 | - | 8075* | 5225* [8000] | - | 1712* [4000] | 57.2 + 4.18 x rules (n=3) |
| fwdfirst | 572 | 14798 [4000] | 12693* | 10000* [2000] | 7078* [8000] | 4497* [8000] | 58.0 + 1.30 x rules (n=4) |
| fwdinstall | 572 | - | 7439* [12000] | 4724* [8000] | - | 989 [2000] | 57.2 + 4.83 x rules (n=2) |
| net16 | 572 | - | 7882* | 5118* | - | 1643* [4000] | 55.9 + 4.39 x rules (n=3) |

Layout names: `base` = quarantine DROP rules installed first at priority 65535 with forwarding at 100 (production worst case, as in the first benchmark). `fwdfirst` = forwarding rules at the highest priority and installed first. `fwdabove` = forwarding rules at the highest priority only. `fwdinstall` = forwarding rules installed first only. `net16` = `/16` quarantine matches. `distinct` = each quarantine rule at its own priority.

How to read the cost model: forwarded rate is `1 / (fixed + per_rule x rules)`. The fits use only three or four saturated points each, so the exact intercepts are approximate. The slope is consistent everywhere it was measured (4.2 µs for 64 B and 572 B payloads, 4.4 µs for `/16`), and the model predicted an independent result: it gives 6,379 pps at 24 rules, and the overloaded typical-50% working-window run forwarded 6,325 pps at 24 to 27 rules.

The 0-rule row is a lower bound for 572 B (the ladder stopped at 15,000 pps, still clean); the model puts the true ceiling near 17.8k pps. The `fwdfirst` 0-rule step lost its session at 4,000 pps, far below capacity, so that cell is not a capacity measurement.

## 4. Typical working window (1 h, 5-minute windows, flush each window)

Load: 600 B UDP at a percentage of the framed 600 B line rate (19,592 pps) plus a rate-limited TCP flow. Rules were added evenly across each 5-minute window and removed by a selective flush at the start of the next. Throughput is the switch's own Port 1 RX rate (median over 10 s samples).

| profile | UDP load | TCP cap | windows done | session losses | outage s | p1 RX pps by rules installed |
| --- | --- | --- | --- | --- | --- | --- |
| low (8 rules) | 50% = 9,796 pps | 5 Mbit/s | 12/12 | 3 | 4.3 | 9,997 at 0-3, 9,812 at 4-7, 9,689 at 8-11 |
| typical (24 rules) | 25% = 4,898 pps | 5 Mbit/s | 12/12 | 1 | 1.7 | 5,261 at 0-3 falling to 5,022 at 24-27 |
| typical (24 rules) | 50% = 9,796 pps | 5 Mbit/s | 1/12 (see section 7) | 1 | 0.9 | 9,997 at 0-3, 8,242 at 12-15, 6,325 at 24-27 |
| worst (126 rules) | 5% = 979 pps | 2 Mbit/s | 12/12 | 4 | 6.0 | about 1,140 at 4-7 falling to about 1,100 at 120-123 |

Reading it:

- **Under capacity, the switch carries the offered load throughout the window.** Low-50% (about 47 Mbit/s of IP traffic) and worst-5% at all 126 rules both held their offered rate, and typical-25% only slipped 5%.
- **Over capacity, throughput tracks the falling capacity.** Typical-50% followed the model down from 10.0k to 6.3k pps as rules accumulated.
- **A TCP flow with no rate limit saturates the switch by itself.** An earlier typical-25% run with unbounded TCP forwarded 7,576 pps at the start of the window falling to 5,040 and lost sessions, and in the 60-second smoke test the TCP flow delivered nothing once the table passed about 16 rules. Use a rate-limited TCP flow when modelling a bounded working load.
- **Outages are short.** The three complete hours had 3, 1 and 4 session losses and 4.3, 1.7 and 6.0 s of total outage (0.05% to 0.17% of the hour). Every loss was recovered by the harness in about 2 to 3 s, and each run carried its offered load otherwise. The losses happened well below capacity, so they are the unexplained spontaneous losses of section 6, not overload.

Typical-50% could not complete: its offered load is above capacity once the table passes about 12 rules, and the table could not be restored after a session loss (section 7).

## 5. Flush and reinstall blackout

Ping every 10 ms from the workload node during a flush. "No flush" rows are the control: the baseline longest gap on this path is about 130 ms, which is Wi-Fi jitter on the receiver side, not the switch.

| depth | flush mode | load | n | median max ping gap ms | median flush-to-verified ms |
| --- | --- | --- | --- | --- | --- |
| 0 | none | idle | 3 | 130 | - |
| 0 | none | 1,000 pps | 3 | 128 | - |
| 0 | wipe | idle | 3 | 150 | 253 |
| 0 | wipe | 1,000 pps | 3 | 222 | 199 |
| 126 | none | idle | 3 | 131 | - |
| 126 | none | 1,000 pps | 3 | 130 | - |
| 126 | selective | idle | 3 | 132 | 110 |
| 126 | selective | 1,000 pps | 3 | 131 | 1,498 |
| 126 | wipe | idle | 3 | 135 | 107 |
| 126 | wipe | 1,000 pps | 3 | 263 | 515 |

- A full wipe-and-reinstall costs about 0.1 s of extra path outage when traffic is flowing and is invisible at idle. A selective delete of 126 quarantine rules leaves forwarding intact (no extra gap) but takes about 1.5 s to complete under load.
- A flush every 5 minutes is therefore negligible compared with the capacity effects above.

## 6. Control-plane stability

- Echo round trips to the switch are normally about 0.7 ms (median across artifacts); the 99th percentile is about 200 ms because of occasional stalls.
- **Overload loses the session.** In the base-layout ladders, the first step at roughly 1.3 to 2.3 times capacity ended with the switch dropping its OpenFlow session; the switch silently clears its flow table when that happens. The production bridge's 8 s dead-peer rule can also cut the session when the switch is silent that long.
- **Spontaneous losses also occur below capacity.** One at 4,000 pps with 0 rules (a quarter of capacity) in the forwarding-first ladder, three losses over eight typical-25% windows (offered about 5.3k pps against about 6.4k capacity), and four in the worst-5% hour. The cause is not known. The switch did not reboot in any of these cases.
- A production controller must therefore expect to re-synchronise every rule after a reconnect. The harness does this and the outage is about 2 to 3 s.

## 7. Open items and limits

- **The switch wedged once (about 16:53 UTC) and needed a power cycle.** During the first low-50% attempt its management network stopped responding (10.0.1.99 unreachable, ARP failing, no OpenFlow dial) while its serial console stayed alive (uptime 236 h, ports up). You power-cycled it and the final runs completed on the rebooted switch. A serial restart was blocked by the permission system and not attempted. The wedge followed a flow-table readback timeout, so overload with a starved control plane is the suspected trigger (not proven).
- **Typical-50% (overload) did not complete.** Offered load (about 9.8k pps plus TCP) exceeds capacity once the table passes about 12 rules. Only window 1 was recorded (10.0k pps falling to 6.3k at 24 rules). In reruns the harness could not restore the table after a session loss, because the switch stopped answering flow-table requests while the overload continued: six bounded attempts of about 75 s each timed out. In effect the control plane could not be reconfigured while the switch was overloaded. Two reruns were stopped (one interrupted after 13 silent minutes, one aborted after the retries), and the data of those partial windows was not saved.
- **Drop-hit ladders are inconclusive.** After a bug fix they now drop traffic, but the hit rule's packet counter stayed at 0 and sessions dropped at about 7 s into steps at 500 pps. Whether this is firmware counter behaviour or a harness issue is unresolved. A mirror-port capture would settle it. The earlier smoke test at 4 rules did count hits.
- **Single rounds.** Layout ladders other than `base` and `fwdfirst` have one round each; fits use 2 to 4 points.
- **Receiver path.** The receiver sits behind a Wi-Fi extender and the Mac; switch counters (Port 1 RX / Port 2 TX) are the primary measure. A constant 1.2-1.3% receiver-side shortfall appears at every rate below saturation and matches the switch's own ingress shortfall, so it is a measurement offset, not downstream loss.
- **No direct CPU measurement** of the switch. Echo latency and session loss are the proxies, and the "software lookup on the MCU" explanation remains an inference from the linear per-rule cost.
- **Not tested:** Ethernet pause frames (no `ethtool` on the workload node), `/16` rules matching real traffic, and the Jetson nftables offload recommendation.
- **First report corrections.** The TCP penalty percentages in the first report (92.0% and 94.6%) are not stable (the rerun gave about 94% and 97%), and TCP goodput mostly measures TCP's own behaviour under a saturated CPU; see `results/rerun-2026-10-04/COMPARISON.md`. The roadmap's "20,800 pps" budget and its "128 rules is only a capacity cap" framing are contradicted by section 3.

## 8. Recommendations

1. **Install the forwarding rules first and at the highest priority.** This is the only layout change that helped (1.6x to 2.6x). Do it before anything else.
2. **Budget by packets per second, not megabits.** With the current layout, plan on about `1,000,000 / (56 + 4.2 x rules)` packets per second (or `1,000,000 / (58 + 1.3 x rules)` with the better layout) at 600 B, and keep sustained load below about 80% of that.
3. **Keep the quarantine rule count low, and aggregate to reduce count.** A `/16` rule costs the same as a `/32`, so aggregation helps only by reducing the number of entries. The roadmap's high-water mark of 102 rules (80% of the table) is far beyond what the switch can carry at working loads; 32 rules already reduces capacity to about 5.3k pps (25 Mbit/s) with the base layout.
4. **Design the controller for session loss.** Resynchronise all rules on reconnect, expect about 2 to 3 s outages, and treat the OpenFlow session as fragile whenever load approaches capacity.
5. **Flush on a schedule if needed.** A 5-minute wipe or selective flush is cheap; the cost is the lost enforcement during reinstall, not the path.
6. **Offload deep rule sets elsewhere** (for example nftables on the Jetson) once rule counts exceed what the capacity budget allows. This was not tested here.

## 9. Reproducing

```bash
# on the Jetson, with zodiac-bridge.service stopped and iperf3 receivers running on the workload path
npm run build:server
npm run bench:dataplane -- plan
npm run bench:dataplane -- ladder  --server 10.0.2.119 --pi-ssh agent@10.0.0.45 --pi-ip 10.0.2.50 --layout base
npm run bench:dataplane -- workday --server 10.0.2.119 --pi-ssh agent@10.0.0.45 --pi-ip 10.0.2.50 --profile typical --udp-load-percent 25 --tcp-mbps 5
npm run bench:dataplane -- blackout --server 10.0.2.119 --pi-ssh agent@10.0.0.45 --pi-ip 10.0.2.50
python3 docs/benchmarks/analysis/analyze_depth.py docs/benchmarks/results/ladder-2026-10-04 docs/benchmarks/results/full-2026-10-04
```

Run it only on the isolated bench: the commands wipe the switch's flow table and saturate the Port 2 path, and the production bridge must be stopped so the benchmark is the switch's only controller.
