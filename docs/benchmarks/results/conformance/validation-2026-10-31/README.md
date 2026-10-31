# Validation of the conformance harness on the real switch (2026-10-31)

**These are validation runs of the harness, not results of plan section 16.** They exist to show that the harness observes what it claims to observe before any rule set beyond the 8 references goes on the switch (the smoke gate of the unattended campaign). Evidence for the findings below is kept here; the section 16 results are reported separately.

| Run | What | Flows | M1 disagreements | M2 non-compliant | Reading |
| :--- | :--- | ---: | ---: | ---: | :--- |
| `first-smoke` (18:16Z) | the 8 references, first hardware run | 28 | 11 | 4 | the gate stopped the campaign as designed |
| `smoke-fixed-capture` | same, after the capture fix | 28 | 4 | 4 | all 4 are one flow: a self-addressed IPv4 frame |
| `diagnostic-self-addressed` | one reference (port1-isolation), 3 self-addressed frames from different hosts and 2 normal frames | 5 | 3 | not computed | the 3 self-addressed frames are not forwarded; the 2 normal frames agree |
| `smoke-final` | the 8 references, after excluding self-addressed frames | 28 | 0 | 0 | the gate passes |

## Harness defects found (fixed, with tests)

1. **`-p` on the Jetson captures.** The first runs passed `tcpdump -p`, so tcpdump did not set promiscuous mode. The O2 NIC (`enx9c69d39dd0a6`) had promiscuity 0 (the O3 NIC had 2), and without it dropped every unicast frame not addressed to it: every IPv4 tap copy was missed while broadcast ARP showed up. 11 disagreements became 4 once removed. The 2026-10-20 run did not use `-p`. `captureShell` now builds the command, with a test that forbids the flag.
2. **Flat evidence directory.** All sets wrote their captures to one directory, so the same flow in different sets overwrote the earlier set's files; `first-smoke/results.json` is complete but its raw captures were lost. Evidence is now kept per set (`setDirName`).

## Finding F1 (about the switch path, not the harness)

An IPv4 frame whose source and destination address are identical is **not forwarded** to port 2 or port 3: nothing was seen on O2 or O3, while the verifier's model predicts forwarding by the intra-segment rule. Observed for 10.0.2.50, 10.0.2.51 and 10.0.2.52 as the shared address (diagnostic) and for the 4 references that happened to include the 10.0.2.50 case (first runs); the frames between the same hosts with different source and destination addresses agreed with the model (`[2,3]` observed, `[2,3]` predicted). The direction is the safe one (the hardware forwards less than the model says). It looks like land-attack protection. **Where the frame is dropped is not established**: the sender's NIC, the lab-side NETGEAR switch or the Zodiac; the only evidence is that it never appears on O2 or O3. The model has no such rule, so the verifier over-predicts forwarding for these frames; they are excluded from the candidate flows (a degenerate packet is not a gate flow) and the finding is carried into the results.

## What this does not show

Anything about the other 124 rule sets, the uplink side, or the cause of F1. One switch, firmware 0.86.
