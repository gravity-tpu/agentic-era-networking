# CIC-IDS2017 adapter: design, join strategy and its limits

Written while building `scripts/cic-ids2017-adapter.py` and `scripts/cic-ids2017-labels.py`, before the large-scale
validation run whose numbers are in
[`docs/benchmarks/results/cic-ids2017-adapter/README.md`](../benchmarks/results/cic-ids2017-adapter/README.md).
Unlike this repo's hardware pre-registrations, this was not written fully blind: building the join required
iterating against small samples of the real CSVs and pcaps to find the two data-quality problems described below
(the AM/PM ambiguity and the truncated Friday capture). Those are reported as findings, not predictions. What
follows is fixed before the full-scale throughput/coverage run: the join algorithm, the slack values, and what
would count as the join "working" versus "too lossy to use."

## Why this exists

`feat/sentinel-margin-training` (PR #106, unmerged) added a margin term to the sentinel's weight training using
labelled flood-attack runs from this lab's own rig, and partially worked, but the flood class has only 3 patterns
across 8 runs (`docs/benchmarks/results/labelled-runs/`) - too little to know if it generalizes. CIC-IDS2017 is a
published, widely-used intrusion-detection benchmark with DoS/DDoS/PortScan traffic recorded at packet level, which
could supply far more labelled attack and benign data for the same training approach. This task builds the
ingestion pipeline only - it does not retrain anything.

Two raw pcapng files were downloaded (outside the repo, left in place per instructions) from a public Hugging Face
mirror of the dataset (`bencorn/CICIDS2017`): `Wednesday-workingHours.pcap` (13.4 GB, DoS Hulk/GoldenEye/
Slowloris/Slowhttptest/Heartbleed) and `Friday-WorkingHours.pcap` (8.8 GB, Botnet in the morning, PortScan and DDoS
in the afternoon).

## What the existing parsers cannot do, and why this is a new module

- `scripts/sentinel-replay.py`'s `parse_pcap` and `scripts/portscan-rule-detector.py`'s `parse_pcap_frames` read a
  classic-pcap global header plus flat 16-byte-record layout. Both downloaded files are **pcapng**, confirmed by
  byte-order magic `0x1a2b3c4d`, not `0xa1b2c3d4`/`0xa1b23c4d` - those parsers cannot read them at all (not a bug to
  fix, a different container format).
- Both of those parsers call `fh.read()` once; `sentinel-replay.py`'s cap (`MAX_PCAP_BYTES = 64 MiB`) is a
  deliberate refusal to load more than that into memory, correct for this lab's own small captures. The CIC files
  are 130-200x over that cap. Raising the cap would defeat its purpose; this module streams instead, one packet at
  a time, via `scapy.utils.PcapNgReader`, which decodes pcapng blocks from the file incrementally. Memory use is
  bounded by one packet plus a 64-packet sliding window, not by file size.
- The feature math itself (`Extractor.feed`, `kernel_loss`, `WIN = 64`) is reused unmodified from
  `sentinel-replay.py` via `importlib` (the same pattern `scripts/score-labelled-runs.py` already uses to import a
  hyphenated-filename module) - this adapter does not reimplement it, so it cannot silently drift from what the
  deployed sentinel and its replica actually compute.

`scapy`'s correctness on these specific files was spot-checked before committing to this approach: 200k sampled
packets from Friday were 97.8% plain Ethernet II + IPv4 + TCP/UDP with internal `192.168.10.x` addresses matching
CIC's documented lab subnet - exactly the frame shape the feature math expects. The remainder (ARP/IPv6/CDP) is
handled the same way `sentinel-replay.py` already handles unrecognized EtherTypes: no features, no crash (proto=0,
ports=0, no source IP).

## Label source: which zip, verified

The Hugging Face mirror hosts two label archives. Both were downloaded and their headers compared directly (not
assumed):

- `GeneratedLabelledFlows.zip` (284 MB): header starts `Flow ID, Source IP, Source Port, Destination IP,
  Destination Port, Protocol, Timestamp, Flow Duration, ...`. Has everything needed to join to a raw packet.
- `MachineLearningCSV.zip` (235 MB): header starts `Destination Port, Flow Duration, ...` (a leading-space column
  name in the original) - no Flow ID, no IP addresses, no Protocol, no Timestamp. This is confirmed to be the
  stripped, ML-ready export; it cannot be used for this join at all.

Only `GeneratedLabelledFlows.zip` is used. `scripts/cic-ids2017-labels.py` raises on load if a required column is
missing, so accidentally pointing it at the wrong archive fails loudly rather than silently labelling nothing.

## Join strategy

A packet is matched to a label by 5-tuple (source IP, destination IP, source port, destination port, IP protocol
number), checked in both directions (a packet can arrive from either end of a bidirectional flow), against a
flow's `[start, start + Flow Duration]` interval with a slack window added on both sides
(`DEFAULT_LABEL_SLACK_S = 90s`, named and in one place, not buried). A window of 64 packets (the sentinel's own
window size) is labelled by majority vote over the packets inside it that matched a flow at all; a window with no
matched packets is `UNLABELED`, not guessed as benign.

### Two data-quality problems found while building this, both measured and disclosed, not assumed away

**1. The Timestamp column has no AM/PM marker and no seconds.** Every sampled row across both days matches the
literal shape `D/M/YYYY H:MM` with `H` in 1-12. Within the single whole-day Wednesday file, a morning attack
(`DoS slowloris`, literal `10:00`) and an afternoon one (`Heartbleed`, literal `3:12`, i.e. really 15:12) sit in the
same CSV with no way to tell them apart from the string alone. This is resolved by `disambiguate_12h`: build both
readings (`H` as-is, and `H+12`), convert each to an epoch assuming US/Eastern daylight time (`TZ_OFFSET_HOURS =
-4`, which is itself a measured fit - see below, not a documented assumption), and keep whichever one falls inside
that file's own observed `[first packet, last packet]` epoch window (plus slack) - a window that is independently
measured from the raw pcapng file itself by a single bounded-memory streaming pass
(`scan_capture_window`), not taken from any published schedule. This only works because each day's observed window
is under 12 hours wide, so the two 12-hour-apart readings cannot both land inside it except at the margins
(tracked separately as `ambiguous_both`).

The `-4` (EDT) offset was not assumed: `scan_capture_window` on Friday reports a first packet at `2017-07-07
11:59:39 UTC`; read as EDT that is `07:59:39` local, i.e. file open about 8 minutes before working hours typically
start - exactly the kind of number that confirms the offset rather than merely being consistent with it. Wednesday
shows the same pattern (file opens `2017-07-05 11:42:42 UTC` = `07:42:42` EDT).

**Added after the first full-scale run: `-4` was wrong by exactly one hour; the real offset is `-3`.** The window-fit
check above only proves a timezone guess is *plausible* (the file opens near the start of a working day either way);
it cannot rule out a guess that is wrong by exactly one hour, because shifting both AM and PM candidates by one hour
usually still leaves one of them inside an 8-hour window. The tell was the label join's own coverage: with
`TZ_OFFSET_HOURS = -4`, only 38,738/9,915,680 (0.4%) of Friday's IPv4 packets and 148,643/13,705,555 (1.1%) of
Wednesday's matched a labelled flow at all - far under this doc's own "under 20% means rethink the strategy" line.
Rather than loosen the slack to paper over it (which would just start matching unrelated flows), the fix was to find
one labelled flow on each day, take its *exact* 5-tuple, and search the raw pcap for that exact tuple regardless of
timestamp:

- Friday: `172.16.0.1:43959 -> 192.168.10.50:5357` (TCP, a PortScan-labelled flow). Two matching packets were found
  in the raw file at `1499450881.75`, which is `-3598.2s` from the CSV's disambiguated start (`1499454480.0`) -
  about one hour early, not the ±90s slack was built for.
- Wednesday: `172.16.0.1:50748 -> 192.168.10.50:80` (TCP, a DoS Hulk-labelled flow, picked independently on a
  different day and attack type). 165 matching packets were found starting at `1499262203.19`, `-3576.8s` from the
  CSV's start (`1499265780.0`) - again about one hour early (the small additional slop past a clean -3600s, 1.8s and
  23.2s respectively, is consistent with the CSV's own minute-only resolution, not a second error).

Both land within a minute of a clean one-hour offset, on two different days and attack types - not a coincidence.
The ISCX lab that generated CIC-IDS2017 is at the University of New Brunswick in Fredericton, which is in the
**Atlantic**, not US Eastern, time zone; Atlantic Daylight Time in July 2017 is UTC-3, exactly one hour ahead of the
EDT this file originally assumed. `TZ_OFFSET_HOURS` is now `-3`; see `scripts/cic-ids2017-labels.py` for the same
note next to the constant, and the results note for the coverage this produced on the full re-run. The investigation
that found this is recorded in full in the PR discussion, not reproduced here; the two 5-tuple checks above are
exactly reproducible from the CSVs and the raw pcap and are the load-bearing evidence, not the timezone story about
*why* - this file does not need to be right about the "why" for the fix to be right.

**2. (Retracted below - keeping the original reasoning visible, not deleting it.) The downloaded Friday pcap appears
to be truncated before the DDoS attack finishes.** The DDoS sub-CSV's own labelled rows run from literal `3:xx` to
`4:59` (15:xx-16:59 PM), but the raw Friday capture's own last packet, independently measured, is at `16:02:41` EDT.
A disambiguated-timestamp breakdown by minute confirms this is not a disambiguation bug: every `3:xx` (15:xx) DDoS
row resolves fine (comfortably before the file's end), and the `4:xx` (16:xx) rows split cleanly at the few minutes
past the file's own last-packet time - rows at `4:00`-`4:04`ish resolve, rows past that do not, because there are no
packets left in the file after that point, not because the timestamp failed to parse. Roughly 55% of DDoS-labelled
flow starts in that CSV fall after the file's last packet. **This means only the first several minutes of the
documented ~62-minute DDoS attack window are present in this particular downloaded capture** - a scope limitation of
the dataset mirror, disclosed here and in the results note, not something this task fixes (re-downloading or
sourcing a second copy of the file is out of scope for this task).

**Retracted after the timezone fix below: this was the same `-4` vs. `-3` bug, not a truncated capture.** Once
`TZ_OFFSET_HOURS` was corrected to `-3`, the Friday DDoS CSV's `neither_fits` count on a full reload went from
129,544/225,745 rows to **0/225,745** - every row resolves inside the measured capture window with no special
pleading. The "16:xx rows past the file's end" pattern above was real, but it was an artifact of resolving those
rows to the *wrong* PM hour (one hour later than their true time) under the wrong timezone, not evidence the capture
was short. The Friday capture is not known to be truncated; no finding here survives past this paragraph. This is
left in instead of deleted because the reasoning above was a reasonable reading of the evidence *available at the
time* (a window-fit check alone cannot distinguish "truncated" from "off by exactly one hour") - the lesson is that a
single corroborating signal (window-fit) is not enough to accept a root-cause story; the coverage number and the
exact-5-tuple check below are what actually settled it.

## What would count as "working" (fixed before the full validation run)

- **Join coverage:** most IPv4/TCP or UDP packets inside a labelled flow's time range should match (CICFlowMeter is
  not expected to cover 100% of traffic - some flows are dropped by its own heuristics, and ICMP/other non-TCP/UDP
  protocols are a tiny fraction of CICFlowMeter's own "Protocol" column, measured at 54/225,745 rows, about 0.02%,
  in the Friday DDoS CSV alone). A coverage figure anywhere from roughly 40% to the high 90s would still be a usable
  join, reported honestly either way; under perhaps 20% would mean the join strategy itself needs rethinking, not
  just reporting.
- **Attacker IP spot check:** a window whose majority label is `PortScan` or `DDoS` should have a majority source IP
  of `172.16.0.1` - verified independently from the flow labels themselves (not from memory of the dataset's
  documentation): filtering the Friday PortScan and DDoS CSVs to their attack-labelled rows shows source IP
  `172.16.0.1` in 100% of them (158,930/158,930 PortScan rows; 128,024/128,027 DDoS rows, the other 3 being the
  reverse direction of the same flows).
- **Throughput:** full dissection (Ethernet/IP/TCP-or-UDP field extraction plus the sentinel's feature math and a
  flow-index lookup) is expected to be meaningfully slower than a container-only read (measured at roughly
  185,000-200,000 packets/second with `pkt.time`-only access across both files). An order of magnitude slower
  (high-10,000s to low-20,000s pps) would still make a full pass of either file (on the order of 10-14 million
  packets measured by a full streaming scan) take single-digit minutes, not hours - that is the threshold for
  calling a full run practical versus something to defer.

## What this task explicitly does not do

No retraining. No changes to `scripts/sentinel-replay.py`, `scripts/portscan-rule-detector.py`, or either training
PR (#105, #106). No modification of the downloaded pcap files. The adapter's streaming container reader and the
label reconstruction are two separate, independently testable modules (`test/invariants/cic-ids2017-adapter.test.ts`
covers the pure-function parts - timestamp disambiguation and the flow index - without needing the multi-gigabyte
files present).
