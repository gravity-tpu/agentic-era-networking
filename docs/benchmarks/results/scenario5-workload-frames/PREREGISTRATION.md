# Scenario 5, narrowed: frames from the workload side that the policy should not forward (pre-registration, DRAFT)

**Status: approved by the owner on 2026-11-03, all five points as drafted (point 4: detector enforcement stays on, and a pass during which a quarantine appears is void). It is registered when this file is on `main`, which must happen before the first frame is sent; after that it is edited only to add dated lines saying what changed and why.** The tooling is built and tested offline (`scripts/workload-frames.py`, `scripts/workload_frames_lib.py`, `test/invariants/workload-frames.test.ts`); nothing has been run on the hardware. Build-time amendments are at the end, dated and written before any run.

## What it closes

The Track C scenario 5 ("evasion") is open-ended as first written; the ROADMAP re-scope narrows it, and [`docs/research/track-a-closeout-plan.md`](../../../research/track-a-closeout-plan.md) section 6 records what is already covered. The 2026-11-02 frame-class sessions ([`table-miss-extended-2026-11-02`](../table-miss-extended-2026-11-02/README.md)) sent classes arriving on **P2** and found none reaching the workload side. Not covered, and the subject of this experiment: the same kinds of frame arriving on **P1** (workload-originated), IPv4 with options, IPv4 fragments, and VLAN-tagged IPv4. The policy cannot see EtherType-specific, option, fragment or tag detail except through what the switch's match fields look at, so this is where the firmware's behaviour could differ from the model's silence.

Frames into **P3** stay not approved (close-out plan decision 8). LLDP and other link-local classes cannot be observed on this arrangement and are attempted only to record that.

## The question, and what the policy says

Does any frame the policy says must not leave the Zodiac's uplink (P2) do so? The six live rules (`src/sdn/port1-isolation.ts`), for a frame arriving on P1:

1. `p1-ipv4-intra-segment` (priority 200): IPv4 with **source and destination both in 10.0.2.0/24** goes out P2 **and** P3. This crossing is the policy's intent, not a breach.
2. `p1-arp-allow-10.0.2.50` and `-10.0.2.52` (priority 200, the default workload hosts): ARP whose sender protocol address is exactly one of those goes out P2 and P3.
3. `p1-default-tap-only` (priority 150, `in_port 1` alone): everything else goes out **P3 only**.

So for each class the registered prediction is one of: **P2+P3** (the policy's allowed crossing) or **P3 only**. A **breach** is a P3-only class that is seen leaving P2. A class whose prediction depends on how the firmware parses something the model does not track (a tag, options, a fragment) is registered as **informational**: either outcome is within policy, and what happened is recorded as a finding about the firmware.

## Classes (18, 20 frames each, one pass)

Sent from one workload node's workload interface through `scripts/adversary-bind.py` (preflight recorded, every send bound to the interface by name). Each class has its own locally administered source MAC `02:00:00:00:00:XX` (XX from `80` in table order) so every observer count is per class and per source. Destination MAC is broadcast unless stated. 20 frames per class, interleaved by round, 0.1 s apart (360 frames, about 36 s). IPv4 source is 10.0.2.52 (the sender's own address) unless stated; "outside" means destination 198.51.100.7 (RFC 5737).

| Id | Class | Prediction | Kind |
| -- | ----- | ---------- | ---- |
| C0 | `allow-ipv4-inside`: UDP 10.0.2.52 to 10.0.2.50, port 9 | P2+P3 | Positive control: proves O3 can see a P2 egress of a P1-origin frame |
| C1 | `allow-arp-known-host`: who-has 10.0.2.1 tell 10.0.2.52 | P2+P3 | Positive control, the ARP rule |
| A1 | `experimental`: EtherType 0x88b5, 60 bytes | P3 only | Repeat of the 2026-11-02 class, from P1 |
| A2 | `ipv6`: 0x86dd, 62 bytes, next header none | P3 only | |
| A3 | `vlan-tagged`: 802.1Q VID 100, inner 0x88b5, 60 bytes | P3 only | |
| A4 | `stp-bpdu`: 802.3 LLC BPDU to 01:80:c2:00:00:00, priority 61440 | P3 only | The workload switch may consume it (a control failure, not a result) |
| A5 | `runt`: 0x88b5, 4-byte payload | P3 only | |
| A6 | `near-mtu`: 0x88b5, 1514 bytes | P3 only | |
| A7 | `arp-unknown-spa`: who-has 10.0.2.1 tell 10.0.2.77 (not a workload host) | P3 only | The A10 case, on the wire |
| A8 | `lldp`: 0x88cc to 01:80:c2:00:00:0e | P3 only | Expected invalid (consumed by a switch); recorded only |
| B1 | `ipv4-options-outside`: IHL 6 (NOP and end-of-options), destination outside | P3 only | |
| B2 | `ipv4-first-fragment-outside`: MF set, offset 0, destination outside | P3 only | |
| B3 | `ipv4-later-fragment-outside`: offset 185, no L4 header, destination outside | P3 only | |
| B4 | `vlan-ipv4-outside`: 802.1Q VID 100, IPv4 destination outside | P3 only | The one with a real chance of a surprise: a firmware that matches through the tag |
| B5 | `ipv4-spoofed-source`: source 192.0.2.77, destination 10.0.2.50 | P3 only | The source check of rule 1 |
| I1 | `vlan-ipv4-inside`: 802.1Q VID 100, IPv4 10.0.2.52 to 10.0.2.50 | informational | Matched through a tag, or not |
| I2 | `ipv4-options-inside`: IHL 6, 10.0.2.52 to 10.0.2.50 | informational | |
| I3 | `ipv4-later-fragment-inside`: offset 185, 10.0.2.52 to 10.0.2.50 | informational | |

Left out on purpose, and not covered: double-tagged and QinQ frames, IPv6 with extension headers, IPv4 with a bad checksum or a length that disagrees with the frame, other VLAN IDs, rates above 10 frames per second, TCP and ICMP payloads (the policy does not look at L4 and the classes above do not either), and any frame into P3.

## Observers and what must hold

- **O3** (the Jetson NIC on the mirror of the Zodiac P2 link): counts per source MAC what **left** P2 (a P1-origin class never appears on that link in the other direction). It is the breach observer.
- **O2** (the tap, out of P3): counts per source MAC what **reached the Zodiac and was handled by a rule that outputs to P3**. Every class in the table is predicted to reach it (a P3-only class by rule 3, an allowed class by rule 1 or 2), so O2 = 20 is the arrival control. It is derived from the policy under test and is not ground truth for containment; it proves only that the frame arrived and was handled.
- O4 (workload side) is not used: a P1 ingress cannot hairpin, and the workload switch floods broadcast on its own side regardless of the Zodiac.

An observer counts only under the rules of the 2026-11-02 pre-registration ("When an observer counts": structured ssh results, capture detached and verified `listening on` before any frame is sent, exit summary present, no kernel drops, frame lines equal to the summary; otherwise `observer_invalid` and the count is null, not 0). The same library (`scripts/table_miss_lib.py`) is reused, not rewritten.

## Verdict rules (fixed in advance), per class and in this order

1. `observer_invalid`: any observer's evidence incomplete. Never a breach, never a pass.
2. `control_failed`: O2 does not read exactly 20 (the class did not arrive intact, or the workload switch consumed it, or the tap lost frames). Nothing else about that class counts. If **C0 or C1** fails this way the whole run is void: O3's ability to see a P2 egress is not shown.
3. For a P3-only class: `breach` if O3 reads more than 0; otherwise `contained`.
4. For a P2+P3 class (C0, C1): `as_predicted` if O3 reads exactly 20; otherwise `control_failed` (rule 2).
5. For an informational class: `observed_p2_p3` if O3 reads 20, `observed_p3_only` if O3 reads 0, `observed_partial` otherwise (reported with the counts, not explained).

The run's headline is the count of `breach` verdicts. A single breach is a finding, not a failure of the experiment.

## Predictions, written before any run

- C0 and C1: `as_predicted` (O3 = 20, O2 = 20). Confidence high; they have been the policy's behaviour in the earlier wire runs.
- A1 to A7 and B1 to B3, B5: `contained`. Confidence high (about 90% each): they match no allow rule by any field the switch looks at.
- A4 and A8: likely `control_failed` (a bridge or switch on the way may consume a link-local group address). That is not a result.
- B4 (`vlan-ipv4-outside`): `contained`, confidence moderate (about 75%). The failure mode is a firmware that parses the IPv4 header through the tag and applies the rule table as if the frame were untagged; with an outside destination rule 1 still does not match, so even then the frame would go to P3 only. A breach here would need the firmware to match a rule by some other path, which I do not expect.
- I1 to I3: no prediction. Each outcome is within policy; the point is to record which.
- Expected headline: **0 breaches**. The value of the experiment is closing a stated "not covered", with a small chance of a finding.

## Stopping rules and limits

- **One pass.** A class whose verdict differs from its prediction (not counting the informational ones) is repeated once, not more; the repeat is reported next to the first pass.
- **A breach stops the run:** no further classes are sent; the offending class, counts and capture are kept; whether it is a new verifier property is decided by the owner (the Track C exit rule).
- **Stop at once** on: a session loss or an isolation status other than `verified drops` (read before the run and between rounds), any quarantine appearing (`quarantines` is read before and after; the detectors see the tap, and a quarantine of the sender's address changes the predictions, so a pass during which one appears is void and is repeated after the owner decides about enforcement), a refused or failed observer, a sender interface that does not match the preflight.
- The experiment changes nothing on the switch and installs nothing; the auto-repair stays on and is expected not to act. If it does act, the run is reported with that line.
- Time: about 40 s of traffic plus bench readiness (observer proof, preflight, quarantine count); one session of about an hour with the owner present at the start.
- **Not shown even if everything passes:** that nothing else can leave P2 (one sample of 20 per class, one firmware, 0.86, one switch, 10 frames per second), that a frame class outside the table behaves the same, and anything about P3 ingress.

## What gets built, with tests first

`scripts/workload-frames.py` and `scripts/workload_frames_lib.py` (frames, sender, the judge), reusing `table_miss_lib.py` for the observers. Tests in `test/invariants/workload-frames.test.ts`, written before the code:

- Each class's bytes equal frames written out by hand in the test from the standards (IHL and options, fragment flags and offset, the 802.1Q tag, the BPDU), and each class's filter names only its own source MAC.
- The prediction table equals the result of evaluating each class against the six live rules in priority order (a small pure evaluator in the test, with tag, options and fragment detail invisible to it as they are to the model), so a change to the policy builder fails the test until the table is re-registered.
- The judge: every verdict above, including that an invalid observer is never a pass, that C0 or C1 failing voids the run, and that a P3-only class with one frame at O3 is a `breach` (a test that can fail).
- The send is bound: the script refuses to send unless the `adversary-bind.py` preflight reports the named interface and no unexcused route to the lab LAN.
- Offline fake ssh, as in `table-miss-extended.test.ts`; no test touches a host.

## Approvals needed from the owner before this is registered

1. **Forged-source frames from a workload NIC.** Every class forges the source MAC; B5 and A7 also forge an IP or ARP sender address. Close-out plan decision 2 (2026-10-31) covers the earlier wire run; this asks the same for this experiment.
2. **Sender.** `agentic-node-02` on its workload interface (the adversary node), the interface name taken from the preflight at run time.
3. **Arrangement.** The normal one: no VLAN change on switch #2 is needed (the sender is on the workload side and O3 is the existing mirror).
4. **Detector enforcement for the window.** The Jetson detector sees the tap and can quarantine a source (the quarantine envelope); say whether enforcement is to be off for the run or left on with a pass voided if it acts.
5. The unused address 10.0.2.77 (A7) and the 10.0.2.50 destination are confirmed free of conflicting use in the testbed ledger.

## Amendments (2026-11-03, written while building the tooling, before any run)

1. **Three groups, not one pass.** The stopping rule ("a breach stops the run: no further classes are sent") cannot be kept inside one capture window, because a count is known only after the captures end. The classes are therefore sent in three groups, each with its own captures and each opened by the two positive controls: group 1 is C0, C1 and A1 to A8; group 2 is C0, C1 and B1 to B5; group 3 is C0, C1 and I1 to I3. A group that says stop ends the run before the next one. Frames per class and the 0.1 s spacing are unchanged; 20 frames of each of 10, 7 and 5 classes is 200, 140 and 100 frames.
2. **Sender interface.** `agentic-node-02`'s workload interface is `eth1` on that host (the onboard NIC; `eth0` is the USB adapter on the household network, see `scripts/track-c-scenario1-arp-spoof.py`), with `eth0` and `tailscale0` declared by name as control channels for the bind guard's preflight, exactly as in scenario 1. The send is an `AF_PACKET` socket bound to the interface by name. This replaces "the interface name taken from the preflight at run time"; the preflight still has to pass.
3. **A frame at O3 for a class whose tap control failed is not read as contained.** Rule 2 said that a class whose O2 count is not 20 "counts for nothing". For a P3-only class that would hide frames at O3 that never reached the tap, which is a path around the Zodiac. The class is `control_failed`, the O3 count is shown (`o3_frames`), and the run stops.
4. **Destination MACs and source MACs.** The reused classes A1 to A6 and A8 keep the builders of `scripts/table_miss_lib.py` and their destination (`02:00:00:00:be:ef`, an unknown unicast address the workload switch floods, or the group address of the BPDU and LLDP), not broadcast; the new classes use broadcast. Every class has its own source MAC from `02:00:00:00:00:80` in table order, and every capture filter is `ether src <that MAC>`, so a tagged class is counted by the same kind of filter as the others.
5. **Observers are two, O3 and O2**, as registered; the status read before, between and after each group is strict (a missing field is an error, quarantine rules are counted only when installed, and anything other than `verified/drops` with 0 quarantines refuses or voids the group).
6. **Point 5 of the approvals.** 10.0.2.77 appears in the repository only as the forged source of `scripts/test-gpu-sentinel-live.py`, an earlier sentinel test; it is not a host in the ledger. The detector may remember it; the quarantine check before each group covers that.
7. **Bench readiness is a dry run first:** `python3 scripts/workload-frames.py LABEL --dry-run` does the preflight, the status read and group 1's capture plumbing with no frame sent. The controls then read 0 and the group is void by design; what must hold is that no observer is invalid.
