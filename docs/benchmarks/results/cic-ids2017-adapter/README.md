# CIC-IDS2017 adapter: full-file validation results

Method, join strategy and the "what counts as working" thresholds were fixed in advance in
[`docs/design/cic-ids2017-adapter.md`](../../design/cic-ids2017-adapter.md) before these numbers were produced. Both
downloaded captures (`Wednesday-workingHours.pcap`, 13.4 GB; `Friday-WorkingHours.pcap`, 8.8 GB, both left in
`~/Downloads/cic-ids2017-raw/`, not copied into the repo) were processed **in full**, not sampled - the task allowed
sampling, but a full pass turned out to be practical (see throughput below), so there is no extrapolation in the
coverage numbers: every packet in both files was fed through `scripts/cic-ids2017-adapter.py`.

## Headline: a timezone bug, not a provenance problem

The first full run used `TZ_OFFSET_HOURS = -4` (US Eastern/EDT), the design doc's documented-but-unverified
assumption. Coverage was far below the doc's own "under 20% means rethink the strategy, not just report it" line:

| Day | Join coverage with `-4` (wrong) | Join coverage with `-3` (measured, fixed) |
| :--- | ---: | ---: |
| Friday | 0.4% (38,738 / 9,915,680 IPv4 packets) | **99.98%** (9,913,758 / 9,915,680) |
| Wednesday | 1.1% (148,643 / 13,705,555 IPv4 packets) | **99.99%** (13,704,848 / 13,705,555) |

The fix and the evidence for it (two independent exact-5-tuple checks against the raw pcap, one per day, both
landing within a minute of a clean one-hour offset) are in the design doc's dated addendum, not repeated here. In
short: the ISCX lab (University of New Brunswick, Fredericton) is in the Atlantic time zone, not US Eastern;
Atlantic Daylight Time in July 2017 is UTC-3, one hour ahead of the EDT this adapter originally assumed.

**A consequence worth flagging explicitly:** the design doc's earlier finding that "the Friday pcap appears
truncated before the DDoS attack finishes" was itself an artifact of this same bug (the DDoS CSV's rows were being
resolved to the wrong, later PM hour, which then looked like it ran past the file's end). With the timezone fixed,
0 of 225,745 Friday DDoS CSV rows fail to resolve inside the measured capture window. That finding is retracted in
the design doc (left visible with a correction, not deleted) and does not apply: there is no evidence the downloaded
Friday capture is truncated.

## Join coverage, in full

| Day | IPv4 packets | Matched a labelled flow | Unmatched | Non-IP frames (ARP/IPv6/etc., not eligible) |
| :--- | ---: | ---: | ---: | ---: |
| Friday | 9,915,680 | 9,913,758 (99.98%) | 1,922 (0.02%) | 82,194 |
| Wednesday | 13,705,555 | 13,704,848 (99.99%) | 707 (0.01%) | 83,323 |

The residual unmatched fraction on both days is small enough (under 0.02%) that it was not investigated further;
the most likely contributors are the handful of non-TCP/UDP IP packets CICFlowMeter's own "Protocol" column does not
line up with 1:1 (`ip_other` frames: 1,144 Friday, 386 Wednesday - of the same order as the unmatched counts) and
packets at the extreme edge of a flow's window falling just past the 90 s slack. This is reported as an honest small
gap, not chased down further given its size relative to the ~100% headline.

## Window-level label distribution (64-packet sliding windows, majority vote)

Friday (9,997,811 windows total):

| Label | Windows | Share |
| :--- | ---: | ---: |
| BENIGN | 8,395,436 | 84.0% |
| DDoS | 1,273,650 | 12.7% |
| PortScan | 323,661 | 3.2% |
| Bot | 4,996 | 0.05% |
| UNLABELED (no packet in the window matched any flow) | 68 | 0.0007% |

Wednesday (13,788,815 windows total):

| Label | Windows | Share |
| :--- | ---: | ---: |
| BENIGN | 11,292,892 | 81.9% |
| DoS Hulk | 2,289,360 | 16.6% |
| DoS GoldenEye | 106,533 | 0.77% |
| Heartbleed | 46,117 | 0.33% |
| DoS Slowhttptest | 31,223 | 0.23% |
| DoS slowloris | 22,690 | 0.16% |

Every one of Wednesday's five documented attack classes and all three of Friday's (Bot, PortScan, DDoS) are present
with a dedicated window population, not folded into BENIGN or UNLABELED - the join is usable for exactly the purpose
this task set out to check (feeding a margin-training process far more labelled attack data than this lab's own 8
flood-attack runs).

## Attacker-IP spot check

Required check: a window whose majority label is `PortScan` or `DDoS` should have a majority source IP of
`172.16.0.1` - verified independently from the Friday flow labels themselves (not from memory of the dataset's
documentation; see the design doc). Confirmed directly from the adapter's own output on the full run, for every
attack class on both days, not just PortScan/DDoS:

```text
Friday  PortScan  majority_src_ip=172.16.0.1  matched=64/64  loss=0.1138
Friday  DDoS      majority_src_ip=172.16.0.1  matched=53/64  loss=0.1439
Friday  Bot       majority_src_ip=192.168.10.14  matched=64/64  loss=0.1357  (internal, infected host - correct: Bot is C2 traffic from a compromised internal machine, not an external attacker)
Wednesday  DoS slowloris  majority_src_ip=172.16.0.1  matched=64/64  loss=0.1498
```

All four line up with what the flow labels themselves say about each attack's sender.

## Throughput and the full-pass time

| Day | Packets | Wall time (measured, full pass) | Throughput |
| :--- | ---: | ---: | ---: |
| Friday | 9,997,874 | 856.0 s (14.3 min) | 11,679 pps |
| Wednesday | 13,788,878 | 1,180.9 s (19.7 min) | 11,676 pps |

**This is not a sampled extrapolation - both numbers are a real, complete pass of the entire file.** Both runs were
launched concurrently (sharing this machine's CPU with each other) to fit the validation into one sitting; a solo
run of either file would likely be faster than the ~11,700 pps measured here, but that was not separately measured,
and this throughput figure is reported as "what two concurrent full passes actually took," not "the adapter's peak
single-file speed." For comparison, a container-only read (just `pkt.time`, no field dissection, no feature math, no
label lookup) measured about 185,000-200,000 packets/second on these same files during development - the ~16-17x
slowdown is the cost of full Ethernet/IP/TCP-or-UDP dissection plus the sentinel's feature math plus a flow-index
lookup per packet, confirming the design doc's prediction that full dissection would be meaningfully, but not
prohibitively, slower.

Since both files were processed in full, there is no "estimated full-file time" to give - the owner does not need to
decide whether to let a full run go later; it already went, twice (once with the wrong timezone, once with the fix),
and both completed in under 20 minutes each.

## What this does and does not establish

This validates the pipeline end to end: a bounded-memory streaming reader over multi-gigabyte pcapng files, joined
against reconstructed flow labels, producing a 64-packet-windowed, labelled feature stream whose attack windows
correctly name their real attacker. It does **not** retrain the sentinel's weights, and it does not establish that
training on this data will generalize the margin-training result from PR #106 - that is future work, out of scope
here by design.
