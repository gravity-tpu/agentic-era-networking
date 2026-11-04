# Does a quarantine DROP match a tagged frame? Pre-registration

**Status: approved by the owner on 2026-11-04, all five points as drafted, and on `main` since PR #213 (2026-11-04 02:32 UTC), before any quarantine was installed for it. The install itself still needs the owner's explicit go at the moment it happens (approval 1).** After this it is edited only to add dated lines saying what changed and why. The tooling is built and tested offline (`scripts/tag-quarantine.py`, `scripts/tag_quarantine_lib.py`, `test/invariants/tag-quarantine.test.ts`); nothing has been run on the hardware. Build-time amendments are at the end.

## What it closes

The [scenario 5 results](../scenario5-workload-frames/README.md) found that the switch matches an IPv4 allow rule through an 802.1Q tag: an in-segment frame with a VLAN 100 tag crossed P2 like an untagged one (I1), although the verifier's model does not track VLAN. That left one question open, recorded in [`docs/research/track-a-closeout-plan.md`](../../../research/track-a-closeout-plan.md) section 6: **does a quarantine DROP match a tagged frame from the quarantined source?** If it did not, adding a tag would be a way around a quarantine, and that would be a new verifier property (the Track C exit rule). Everything below is about that one question.

## Why it matters, and what the rules are

A quarantine (`src/sdn/zodiac-bridge-server.ts`, installed through `POST /api/sdn/quarantine` and approved with `/api/sdn/quarantine/approve`) is a flow with **priority 65535, match `etherType 0x0800` and `srcIp <address>/32`, no ingress port, no output (a DROP)**, and a switch-side hard timeout equal to the envelope's time limit. The allow rules are at priority 200. For an untagged frame from the quarantined address the DROP wins, because the priority is higher. The question is only whether the firmware's matcher reaches the IPv4 fields of a tagged frame for the DROP as it evidently does for the allow rule.

## The experiment

One quarantine of **10.0.2.101** (an address in the workload segment that no testbed host uses; it is the first of the unused addresses `scripts/layout-capacity-run.py` has quarantined on the live bridge before), installed through the normal routes, held for one capture window and released. Five classes, 20 frames each, sent as in the scenario 5 run (node-02 `eth1`, through the bind guard, 0.1 s apart, interleaved, each class with its own source MAC `02:00:00:00:00:A0` onward, counted per source MAC at O3 and O2, same observer rules). Destination IP 10.0.2.50; every IPv4 packet is the scenario 5 UDP packet.

| Id | Class | Prediction | Role |
| -- | ----- | ---------- | ---- |
| QC0 | untagged, source 10.0.2.52 | crosses: O3 20, O2 20 | Control: allowed traffic still crosses while the quarantine is installed |
| QC1 | 802.1Q VID 100, source 10.0.2.52 | crosses: O3 20, O2 20 | Control: a tag crosses in this run (as I1 did) |
| Q0 | untagged, source 10.0.2.101 | dropped: O3 0, O2 0 | Control: the quarantine is installed and effective |
| Q1 | 802.1Q VID 100, source 10.0.2.101 | dropped: O3 0, O2 0 | **The question** |
| Q2 | 802.1Q VID 200, source 10.0.2.101 | dropped: O3 0, O2 0 | Whether the VLAN ID matters |

A DROP has no output, so a matched frame reaches neither the tap nor P2: a quarantined class reads 0 at both observers.

## Verdict rules (fixed in advance), in this order

1. `observer_invalid`: an observer's evidence is incomplete (the observer rules of `scripts/table_miss_lib.py`, as before). The run is void; nothing is concluded.
2. The run is **void** unless the three controls hold: QC0 and QC1 read exactly 20 at O3 and at O2, and Q0 reads exactly 0 at both. A void run is repeated at most once, after the owner has seen why it failed; a quarantine that is not shown effective on untagged frames says nothing about tagged ones.
3. Q1 and Q2, each: **`dropped`** if O3 and O2 both read 0; **`evaded`** if O3 reads more than 0 (frames from the quarantined source left P2 despite the quarantine); `reached_tap_only` if O3 reads 0 and O2 more than 0 (neither the DROP nor the allow rule matched as expected; reported with the counts, not explained); `partial` otherwise.

**The headline is the number of `evaded` verdicts.** One is a finding, not a failure of the experiment: the run ends, the quarantine is released, and the owner decides whether it becomes a verifier property.

## Predictions, written before any run

- QC0, QC1, Q0: as in the table. Confidence high; QC1 repeats the scenario 5 result I1, and Q0 is the quarantine's intended behaviour; whether an installed quarantine drops an untagged frame on the wire is not something I can cite a measurement for, so this control checks it here rather than assuming it, and a run where Q0 fails is void.
- **Q1: `dropped`, about 90%.** The allow rule matched through the tag, and both rules read the same header fields in the same lookup, so a DROP at a higher priority should match the same frame first. The 10% is for a matcher that treats the rules differently, which I have no evidence for.
- **Q2: `dropped`, about 85%.** The tag's VLAN ID is unlikely to matter to an IPv4 match; VID 200 is untested.
- Expected headline: **0 evaded.**

## Safety, stopping rules and limits

- **One quarantine, one address, one window.** The envelope's time limit and the switch-side hard timeout remove it on their own if the script dies; the script also releases it (`POST /api/sdn/release`) on every exit path, then reads the status and refuses to finish "ok" unless `quarantines` is back to 0 and isolation is `verified/drops`. A release that fails stops everything and is reported at once; the owner removes the rule by hand.
- **Before installing:** the adversary bind-guard preflight passes (as in scenario 5, with `wlan0` down), the status is `verified/drops` with 0 quarantines, every capture is proven listening, the bridge's quarantine mode is read (`propose` or `enforce`) and recorded, and the owner says go for the install at that moment (Invariant 4: a person approves the install).
- **The install must be shown on the switch** (the bridge reports exactly 1 installed quarantine rule) before any frame is sent; if it is not, nothing is sent and the quarantine is released.
- **Stop at once** on a refused install, an observer that is not listening, a status other than `verified/drops` between the install and the release (other than the one quarantine), a second quarantine appearing (the detectors see the tap; a pass during which one appears is void), or a failed release.
- Nothing else changes on the switch. The auto-repair stays on.
- Time: about 30 s of capture and about a minute with the install and the release; one session with the owner present.
- **Not shown even if everything passes:** that every tagged form is matched (double tags, other VLAN IDs, QinQ, priority-tagged frames with VID 0); behaviour for a quarantine by MAC; that a quarantine of an address other than 10.0.2.101 behaves the same; anything at rates above 10 frames per second; any firmware other than 0.86; one sample of 20 per class.

## What gets built, with tests first

Five classes, a judge and a run choreography (install, verify on the switch, send, read, release, verify clean) added beside the scenario 5 tooling, with the same independence of the tests from the code: frame bytes written out by hand in the test; the judge's verdicts including cases that can fail (a tagged quarantined class with one frame at O3 is `evaded`; a failed control voids the run); and a scripted-ssh selftest in which a refused install sends nothing, an error after the install still releases, a failed release is reported and not hidden, and the run is not "ok" unless the final status is clean. Run with a stub `ssh` first on `PATH`; no test touches a host.

## Approvals needed from the owner before this is registered

1. **One quarantine of 10.0.2.101 on the live bridge**, installed through the normal propose-then-approve routes for about a minute, with your explicit go at the moment of install (the install is not covered by approving this document alone).
2. **Forged-source frames**: source IP 10.0.2.101 and a VLAN 200 tag, in addition to what the scenario 5 approval covered (forged source MACs, a forged source IP, VLAN 100).
3. **10.0.2.101 is unused.** It is in the range the capacity harness has used; confirm nothing on your side uses it.
4. **Detector enforcement stays as it is**, with a pass during which a second quarantine appears voided (the same stance as scenario 5).
5. **Prerequisites at run time**: `wlan0` on node-02 down (it is) and a current Tailscale SSH approval for the Jetson.

## Amendments (2026-11-04, written while building the tooling, before any run)

1. **`partial` cannot occur.** Rule 3 listed `partial` as "otherwise". For Q1 and Q2 the cases are exhaustive without it: O3 above 0 is `evaded`; with O3 at 0, O2 above 0 is `reached_tap_only` and O2 at 0 is `dropped`. The judge has three outcomes and a test pins that.
2. **Frames at O3 in a void run are shown.** If a control fails the run is void and Q1 and Q2 are `void`, but any frames at O3 for them are recorded (`o3_frames`), not hidden.
3. **The install must show on the switch, with a bounded wait.** The status is read up to 3 times, 2 s apart, for exactly one quarantine rule to appear (the flow readback can lag the install by a moment); if it never does, nothing is sent and the quarantine is released.
4. **A status check during the send.** After the frames are sent, before the release, the status must read exactly our one quarantine with `verified/drops`; anything else (a second quarantine, a changed table-miss) voids the run and the verdicts are `void`.
5. **The owner's go is a command-line flag.** The script refuses to install anything unless it is given `--dry-run` or `--owner-go-for-install`, and the second is passed only after the owner has said go for this install in so many words. A dry run does the preflight, the status gate, the mode read and the capture plumbing with nothing installed and nothing sent.
6. **Capture window.** The captures start before the install, so the window is 4 s, 15 s for the install and its checks, the send time and 8 s of margin (about 37 s); the quarantine is released as soon as the send ends, not at the end of the window, so it is held for roughly the install, the checks and the 10 s send.
