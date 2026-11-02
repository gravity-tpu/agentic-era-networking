# The table-miss under other entries, other frame classes and load (2026-11-02)

Closes the three gaps the earlier 2026-11-02 runs listed as not validated, using the tooling of PR #196 and its pre-registration ([`../table-miss-extended/PREREGISTRATION.md`](../table-miss-extended/PREREGISTRATION.md), written before any session ran). Supervised, owner present, firmware 0.86, the second switch in the wire-campaign arrangement (VLAN 2 = ports 1 and 4, VLAN 1 = ports 2 and 5, VLAN 3 = port 3) and auto-repair off during the fault sessions (`ZODIAC_ISOLATION_REPAIR=0` as a later env line; restored afterwards). `results.jsonl` holds every script output in the order the runs were made, `journal-extract.txt` the bridge and watcher journal for 16:43 to 18:32 EST (no `OFPT_ERROR`, rejection or CoPP line appears in it), and `gate-audit-extract.jsonl` the fault records of the gate audit file. **These runs supersede the earlier traffic results that were flagged provisional** (`../table-miss-traffic-2026-11-02/`): every observer here had to prove it ran.

## Observers and what had to hold

A frame is counted at O3 (the Jetson NIC on the mirror of the Zodiac P2 link; the control, which must read 20), O2 (the tap, out of P3) and O4 (the workload side, out of P1). An observer counted only if its capture printed `listening on` before any frame was sent and its exit summary (`N packets captured`) was present, free of kernel drops and equal to the frame lines; otherwise the run said `observer_invalid`. It stopped or flagged three runs in this series that the earlier script would have recorded as zeros or errors (below).

## Results

**Frame classes (20 frames each, nine classes, one pass per session).** In all seven valid sessions the same picture:

| Session (table-miss state) | Mirror (control) | Tap (out of P3) | Workload side (out of P1) |
| -------------------------- | ---------------- | --------------- | ------------------------- |
| 1 normal DROP | 20 for 8 classes | 0 | 0 |
| 2 `unrecognised-write-empty` (WRITE_ACTIONS, empty set) | 20 for 8 classes | 0 | 0 |
| 3 `unrecognised-apply-pop-vlan` (APPLY_ACTIONS holding only POP_VLAN) | 20 for 8 classes | 0 | 0 |
| 4 `unrecognised-write-metadata` (WRITE_METADATA) | 20 for 8 classes | 0 | 0 |
| 5 `unrecognised-table-miss` (CLEAR_ACTIONS) | 20 for 8 classes | 0 | 0 |
| 6 `forward-to-tap` | 20 for 8 classes | **20 for 8 classes** | 0 |
| 7 `delete-table-miss` (absent) | 20 for 8 classes | 0 | 0 |

The eight classes with a valid control are experimental (0x88b5), IPv6, 802.1Q-tagged (VID 100), STP BPDU, an 18-byte runt (60 on the wire), a 1514-byte frame, IPv4 from the uplink to outside the segment, and an ARP request from the uplink. **LLDP never reached the P2 link (mirror 0 in every session), so it is invalid in every state and is not a result:** switch #2 consumes that link-local multicast. The BPDU and the tagged frame did reach it.

All three new unrecognised entries were **accepted by the firmware** (no `OFPT_ERROR` in any session; the readback reads each as `unrecognised`, "carries instructions or actions that could not be recognised as a drop") and none of them forwarded: with every one the usable classes were dropped.

**Load (unmatched frames at stepped rates, 10 s per step; the load pass counts rx_packets per NIC).**

| State | Rates run | Mirror | Tap | Workload side | Session, status | Verdict |
| ----- | --------- | ------ | --- | ------------- | --------------- | ------- |
| Normal DROP | 500 to 8,000 pps | all sent frames (within 0.1%, for example 80,027 at the 8,000 pps step) | 0 (3 at 500) | 0 (3 at 500) | `Connected`, `verified/drops` throughout | as predicted at all 5 steps |
| Unrecognised (CLEAR_ACTIONS) | 500 to 4,000 pps | all sent frames | 0 (3 at 1,000) | 0 (3 at 1,000) | `Connected`, `mismatch/unrecognised` | as predicted at all 4 steps |
| Absent | 500 to 2,000 pps | all sent frames | 0 (3 at 1,000) | 0 (3 at 1,000) | `Connected`, `mismatch/absent` | as predicted at all 3 steps |
| Forward-to-tap | 500 to 8,000 pps | all sent frames | **9, 22, 11, 11, 13** | 0, 3, 0, 0, 2 | `Connected`, `mismatch/forwards` | **`tap_path_lossy` at all 5 steps** |

No session was lost, no run aborted, no step was sender-limited (the sender kept within 1 pps of its target up to 7,999 pps), and no CoPP or error line appeared in the journal.

## What this shows

- **Fail-closed holds across the entries and frame classes tried.** An unmatched frame was never forwarded out of P1 and, in the four non-forwarding states and the three new entries, never out of P3. That covers the normal DROP, an absent table-miss, and four different unrecognised entries, over eight frame classes, and under load up to 8,000 pps (normal DROP), 4,000 (CLEAR_ACTIONS) and 2,000 (absent) with the OpenFlow session staying up and the status as expected.
- **A forwarding table-miss reaches the tap only, and only a trickle of it under load.** All 20 frames of every usable class reached the tap at about 10 frames per second (the class pass, including the classes predicted unlikely: tagged, BPDU, runt), but at 500 to 8,000 pps only 9 to 22 frames per 10 s step did, a few frames per step regardless of the rate. The forwarded table-miss path is therefore not a usable way to see unmatched traffic at those rates. **The pre-registered prediction (at least 97% at every rate, with 8,000 pps the likeliest to differ) was wrong at every rate.** Why is not known: a software slow path that drops under load and a rate limit both fit, and this run cannot separate them. The mirror shows the frames did reach the Zodiac's P2 link.
- The 3-frame counts at O2 and O4 (once per session at one step, including the normal-DROP session with no fault) are equal at both observers and appeared without any fault, so they are ambient traffic on the workload segment, which the tap mirrors and rpi-hailo sees; the load pass counts per NIC and cannot attribute frames to a source, so this is the likeliest reading, not a proof.
- Other predictions: the controls held as predicted except STP (predicted likely to fail; it passed switch #2), and the absent state cost no session and raised no CoPP line (the state with the most unknowns, estimated 80% to drop in hardware); the bridge's OpenFlow message count, which the load pass records but does not abort on, was not examined for it here, so a small number of punted frames is not excluded.

## What happened to the runs, and the limits

- **Three runs were stopped or flagged by the new checks:** a capture on `agentic-node-01` could not start because it has **no tcpdump** (and no internet to install one while its uplink NIC is isolated), so the workload side is observed on rpi-hailo alone (a frame forwarded out of P1 reaches it: the workload switch floods multicast and unknown unicast); an ssh to node-01 timed out once (transient); session 2's first pass was flagged invalid because the read raced the end of rpi-hailo's capture (the full summary appeared moments later), and the fixed wait was replaced by a wait for the capture's known end (#200); session 2 was rerun on the fixed code. Session 3's pre-armed pass timed out while the paste was pending and was run again immediately after the fault line appeared (its status already read `mismatch/unrecognised`). All of this is in `results.jsonl` (labels `s2-write-empty`, `s3-apply-pop-vlan` and `-late`).
- Between sessions the bridge was not restarted separately for clean-up: each session's restart rewrote the table from the policy and cancelled the previous fault; one clean-up restart ended the series (isolation `verified drops`, one repair line, no fault line).
- **Not covered:** one 20-frame sample per class and state; LLDP and any other class switch #2 eats; frames from P1 or P3 (every one matches a policy rule); loads above the caps (8,000 pps for the DROP and the forward, 4,000 for CLEAR_ACTIONS, 2,000 for absent: the cap for the last two was set low on purpose and not exceeded); the other two new entries under load (only CLEAR_ACTIONS ran the load pass, as planned); whether the forwarded path's loss under load is a rate limit or an overloaded slow path; behaviour under load with the OpenFlow controller doing other work; a firmware other than 0.86.
