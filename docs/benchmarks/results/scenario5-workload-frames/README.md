# Scenario 5, narrowed: results (2026-11-03)

Run under [`PREREGISTRATION.md`](PREREGISTRATION.md) (approved by the owner on 2026-11-03, with seven dated amendments, all on `main` before the first frame). One pass, supervised, owner present, firmware 0.86, one switch. `results.json` is the script's own output, unedited. A dry run earlier the same day (preflight, status, capture plumbing, no frames) is not part of the result; two earlier dry-run attempts stopped before any capture, first at the bind guard (`wlan0` on node-02 was up on the lab LAN; the owner turned it off) and then at an expired Tailscale SSH approval for the Jetson.

**Headline: 0 breaches. Every class the policy says goes to the tap only did not leave P2.** Two results differ from what was predicted, and one is a finding about the firmware.

## What was sent and what was seen

20 frames per class from `agentic-node-02` `eth1`, in three groups (200, 140 and 100 frames, 0.1 s apart), each opened by the two positive controls. O3 is the Jetson NIC on the mirror of the Zodiac P2 link (what left the uplink); O2 is the P3 tap (the frame arrived and a rule that outputs to P3 handled it). All captures were proven listening and printed clean summaries; no observer was invalid; status read `verified/drops` with 0 quarantines before and after every group.

| Class | Predicted | O3 (left P2) | O2 (reached tap) | Verdict |
| ----- | --------- | ------------ | ---------------- | ------- |
| C0 allow-ipv4-inside | P2+P3 | 20 | 20 | as predicted (control, all three groups) |
| C1 allow-arp-known-host | P2+P3 | 20 | 20 | as predicted (control, all three groups) |
| A1 experimental 0x88b5 | P3 only | 0 | 20 | contained |
| A2 ipv6 | P3 only | 0 | 20 | contained |
| A3 vlan-tagged (inner 0x88b5) | P3 only | 0 | 20 | contained |
| A4 stp-bpdu | P3 only | 0 | 20 | contained |
| A5 runt | P3 only | 0 | 20 | contained |
| A6 near-mtu | P3 only | 0 | 20 | contained |
| A7 arp-unknown-spa | P3 only | 0 | 20 | contained |
| A8 lldp | P3 only | 0 | 0 | control_failed (did not reach the tap, most likely consumed before the Zodiac; not a result) |
| B1 ipv4-options-outside | P3 only | 0 | 20 | contained |
| B2 ipv4-first-fragment-outside | P3 only | 0 | 20 | contained |
| B3 ipv4-later-fragment-outside | P3 only | 0 | 20 | contained |
| B4 vlan-ipv4-outside | P3 only | 0 | 20 | contained |
| B5 ipv4-spoofed-source | P3 only | 0 | 20 | contained |
| I1 vlan-ipv4-inside | none | **20** | 20 | observed_p2_p3 |
| I2 ipv4-options-inside | none | 20 | 20 | observed_p2_p3 |
| I3 ipv4-later-fragment-inside | none | 20 | 20 | observed_p2_p3 |

## Against the predictions

- **0 breaches, as predicted.** The class I rated least certain, B4 (tagged IPv4 to an outside address, about 75%), was contained.
- **A4 (STP BPDU) was predicted likely to be consumed on the way; it was not.** It reached the tap (20) and did not leave P2, so nothing between the sender and the Zodiac consumed it. The prediction was wrong; the verdict is unaffected.
- **A8 (LLDP) was predicted likely invalid, and was**: nothing reached the tap, so it says nothing about the policy.
- **I1, I2, I3 had no prediction.** All three were forwarded out P2 as well as to the tap.

## What this shows

- **The firmware matches the IPv4 allow rule through an 802.1Q tag (I1).** A tagged frame (VID 100) with in-segment source and destination was forwarded out P2, exactly like an untagged one, and the verifier's model, which does not track VLAN and reads the outer type 0x8100 as matching no allow rule, says tap-only. That is a disagreement between the model and the switch. It is inside the policy's intent (in-segment IPv4 may cross P2 whether or not it is tagged) and it is **not** a breach: B4, the same frame with an outside destination, did not cross. It is the first wire evidence for the "not modelled: VLAN" limit recorded against A1 and A11 in `docs/research/track-a-ci-matrix.md`.
- **IP options and later fragments are matched on the addresses (I2, I3).** Both crossed when the addresses were in-segment, and neither crossed when the destination was outside (B1, B3). The policy does not look at L4 and the switch does not need the first fragment to apply the rule.
- **The source check holds (B5):** a source outside the segment with an in-segment destination was tap-only.
- **Non-IPv4 classes from P1 do not leave P2** (A1 to A7), including IPv6, a tagged frame with a non-IP inner type, a runt and a 1514-byte frame; the ARP rules behave as the policy says (C1 crossed, A7 did not).

## What this does not show

- **A quarantine DROP and a tag.** The switch matches an IPv4 allow rule through a tag, so a quarantine DROP (priority 65535 on `etherType 0x0800` and a source address) probably matches a tagged frame the same way. That was not tested: it needs a quarantine installed, which this run did not do. It is the follow-up this result raises.
- One sample of 20 per class, one VLAN ID (100), single tags only (no double tags), 10 frames per second, one firmware (0.86), one switch, one sender; nothing about frames into P3 (not approved), LLDP and other link-local classes (LLDP did not arrive), IPv6 with extension headers, a bad checksum or a length that disagrees with the frame.
- That no other frame can leave P2. Agreement on 20 frames per class is evidence against a leak for those classes, not a proof.

## Provenance

- Repository at `18e08ac` (the registered pre-registration and tooling are in `main`); `scripts/workload-frames.py` sha256 `3ac0006c…`, `scripts/workload_frames_lib.py` `52cb76db…`, `scripts/table_miss_lib.py` `1e7e64eb…`, `scripts/adversary-bind.py` `1f387905…`. Run at 21:21 EST on 2026-11-03 under the label `wf-2026-11-03`.
- The adversary preflight passed with `eth1` as the only interface carrying a workload address, `eth0` and `tailscale0` declared as control channels, and `wlan0` down (its state is in `results.json`). It inspects the node only; the switch fabric's VLAN table was not independently re-read for this run.
- Nothing was installed on the switch and no fault was injected; the auto-repair stayed on; its activity and the bridge's journal were not read for this write-up, only the isolation status before and after each group.
