# Does a quarantine DROP match a tagged frame? Results (2026-11-04)

Run under [`PREREGISTRATION.md`](PREREGISTRATION.md) (approved by the owner on 2026-11-04, on `main` before the run, with six dated build-time amendments). One run, supervised, owner present, firmware 0.86, one switch. The owner gave the go for the install in so many words, and the script was invoked with `--owner-go-for-install`. `results.json` is the script's own output, unedited. A dry run just before it (preflight, status gate, mode read, capture plumbing; nothing installed or sent) was clean.

**Headline: 0 evaded. A tag does not get a frame past a quarantine.** The quarantine DROP matched tagged frames from the quarantined source for both VLAN IDs tried, as predicted.

## What was done

One quarantine of 10.0.2.101 was installed on the live bridge (mode `propose`: proposed, then approved by the script on the owner's go), shown on the switch as exactly one quarantine rule before any frame was sent (priority 65535, DROP, `openFlowInstalled`, the bridge's `expiresInMs` 300000), held while 100 frames were sent from `agentic-node-02` `eth1` (20 for each of five classes, 0.1 s apart, interleaved), and released at once afterwards. The status read `verified/drops` with 0 quarantines before, exactly 1 quarantine during the send, and 0 after the release (`release.clean` true). O3 (the mirror of the Zodiac P2 link: what left the uplink) and O2 (the P3 tap) were both proven listening and printed clean summaries (40 and 40); no observer was invalid.

| Class | Predicted | O3 (left P2) | O2 (reached tap) | Verdict |
| ----- | --------- | ------------ | ---------------- | ------- |
| QC0 untagged, allowed source 10.0.2.52 | crosses | 20 | 20 | as predicted (control) |
| QC1 802.1Q VID 100, allowed source | crosses | 20 | 20 | as predicted (control) |
| Q0 untagged, quarantined source 10.0.2.101 | dropped | 0 | 0 | as predicted (control: the quarantine was effective) |
| **Q1 802.1Q VID 100, quarantined source** | dropped (about 90%) | 0 | 0 | **dropped** |
| Q2 802.1Q VID 200, quarantined source | dropped (about 85%) | 0 | 0 | **dropped** |

## What this shows

- **The quarantine DROP matches through an 802.1Q tag**, for VID 100 and VID 200 alike: 40 tagged frames from the quarantined address reached neither P2 nor the tap, while tagged frames from an allowed address crossed in the same window (QC1, 20 of 20). The firmware reads the IPv4 fields of a tagged frame for the DROP as it does for the allow rule (scenario 5 results, I1), and the higher priority wins, as for an untagged frame.
- **The follow-up scenario 5 raised is closed for these cases:** a tag is not a way around a quarantine, so no new verifier property comes from it.
- **The controls did their job:** Q0 shows the quarantine was installed and effective on the wire (an untagged frame from the quarantined address read 0 at both observers), so the zeros for Q1 and Q2 are the DROP and not an absent rule. The quarantine DROP has no output, so a matched frame reaches neither observer, which is what was read.
- **The predictions held** (Q1 and Q2 dropped); this run adds no surprise.

## What this does not show

- **Other tagged forms:** double tags (QinQ), priority-tagged frames (VID 0), other VLAN IDs, and tags with a non-IPv4 inner type were not sent. Two VLAN IDs, single tags only.
- **A quarantine by MAC**, or an address other than 10.0.2.101; a quarantine installed while allow rules are in the table (the earlier allow-rule runs measured cost, not this behaviour).
- One sample of 20 per class; 10 frames per second; one firmware (0.86); one switch; one sender; a quarantine held only for the install, its status checks and the 10 s send (the hold was not timed), not for the envelope's full time limit.
- That no frame from a quarantined source can leave P2 by some other path: only the classes above were sent.
- The bridge's own audit log and journal for the install and the release were not read for this write-up; the evidence is the script's status reads and API responses in `results.json`.

## Provenance

- Repository at `9bee7f9` (the registered pre-registration and tooling are in `main`); sha256 of `scripts/tag-quarantine.py` `6e516e9c…`, `scripts/tag_quarantine_lib.py` `8b13b703…`, `scripts/workload-frames.py` `3ac0006c…`, `scripts/workload_frames_lib.py` `52cb76db…`, `scripts/table_miss_lib.py` `1e7e64eb…`. Run at 21:41 EST on 2026-11-03 (2026-11-04 UTC) under the label `tq-2026-11-04`.
- The adversary preflight passed with `eth1` as the only workload interface, `eth0` and `tailscale0` declared as control channels and `wlan0` down. It inspects the node only; the switch fabric's VLAN table was not independently re-read.
- The auto-repair stayed on and the isolation status read `verified/drops` throughout; its activity was not read separately.
