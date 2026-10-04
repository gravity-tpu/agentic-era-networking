# Rerun vs original: Zodiac FX data-plane benchmark

- Original: `../dataplane-2026-10-03T23-26-49-149Z.json` (40 trials, 4+3+3 valid per cell at most)
- Rerun: `dataplane-2026-10-04T00-59-15-248Z.json` (60 trials, `--trials 5 --gap-seconds 2 --skip-tap`)
- Rerun script: `scripts/zodiac-dataplane-bench.ts` sha256 `25eaf8a9...` (adds `--gap-seconds`; commit `76f2549`, dirty).
- Medians over valid trials, recomputed from the raw artifacts with the same code for both.

| Cell | Valid orig / rerun | Goodput Mbit/s orig -> rerun | Port 1 RX pps orig -> rerun |
| :--- | :--- | :--- | :--- |
| q0 tcp | 3/4, 4/5 | 83.68 -> 61.87 | 7236 -> 5357 |
| q0 udp_mtu | 3/4, 5/5 | 94.45 -> 91.29 | 8034 -> 8034 |
| q0 udp_small | 2/4, 0/5 | 12.58 -> n/a | 24669 -> n/a |
| q32 tcp | 2/3, 5/5 | 6.66 -> 3.67 | 584 -> 322 |
| q32 udp_mtu | 2/3, 5/5 | 52.27 -> 52.25 | 4450 -> 4451 |
| q32 udp_small | 0/3, 0/5 | n/a | n/a |
| q128 (126 installed) tcp | 1/3, 5/5 | 4.51 -> 2.10 | 394 -> 185 |
| q128 (126 installed) udp_mtu | 1/3, 1/5 | 18.14 -> 18.44 | 1601 -> 1594 |
| q128 (126 installed) udp_small | 0/3, 0/5 | n/a | n/a |

## Reproduced

- UDP MTU forwarding pps at q0, q32 and q126: 8034/4451/1594 vs 8034/4450/1601, within 0.5%. Monotone degradation with table depth.
- Zero forwarding deficit in every valid traffic trial (original and rerun). All 126-rule readbacks verified, quarantine packet hits 0.
- q128 clamps to 126 installed rules.

## Not reproduced / differs

- TCP goodput is lower at every depth in the rerun (-26%, -45%, -53%) and highly variable (q0 per-trial range 17.0-80.6 Mbit/s). Original n was 1-3. The ordering is the same, but the absolute TCP numbers and the exact penalty percentages (92.0% / 94.6% in the report) are not stable; rerun penalties from its own q0 are 94.1% (q32) and 96.6% (q126).
- `udp_small`: 0 of 15 valid in the rerun, so the ~25k pps ceiling is not reproduced.
- The "iperf3 server busy" rejections disappeared (12 in the original, 0 in the rerun), confirming the 2s gap addresses them.
- All 20 rerun rejections are "client has terminated". The runner wraps the client in `timeout durationS+25`, so these are clients that did not finish within 35s. This hits every `udp_small` trial plus 4 q126 `udp_mtu` trials and 1 q0 tcp trial. The cause is not established; one candidate is the iperf3 control connection stalling on the congested path.
- No OpenFlow disconnect occurred in the 22-minute rerun, which ran 5 blocks at 126 rules. The original report's disconnect finding was not reproduced.
- Idle trials show a 1-packet deficit at every depth (original: 0, 1, 4 at q32), so "exactly 0 deficit" holds for traffic trials only.
- The original's 40 trials were fewer than the 60 planned.
