# What a frame that matches no rule does in each table-miss state, and the unrecognised class end to end (2026-11-02)

Closes the two classes the earlier 2026-11-02 runs left open ([`../isolation-watch-fault-2026-11-02/`](../isolation-watch-fault-2026-11-02/README.md) and [`../isolation-watch-fault-modes-2026-11-02/`](../isolation-watch-fault-modes-2026-11-02/README.md)): real traffic through the switch while the table-miss is wrong, and an unrecognised table-miss. Supervised, owner present, firmware 0.86. Not pre-registered: the expectation for each state is stated below the table. `results.jsonl` holds the script's own output, `journal-extract.txt` the bridge and watcher journal for 14:24 to 14:35 (EST) and `gate-audit-extract.jsonl` the fault and repair lines of the gate audit file.

## Method

`scripts/table-miss-traffic.py` sends 20 raw Ethernet frames, 0.1 s apart, from `agentic-node-01`'s uplink NIC (`eth1`) into the Zodiac's port 2. The frames carry the IEEE 802 local experimental ethertype 0x88b5 (neither IPv4 nor ARP), so no rule of the isolation policy matches them and they reach the table-miss. The switch had to be put in the wire-campaign arrangement for this (switch #2: VLAN 2 = port 1 (node-01) and port 4 (Zodiac P2), VLAN 1 = ports 2 and 5, VLAN 3 = port 3, the mirror); the normal arrangement was restored afterwards. Four observers count the frames: **O3** (the Jetson NIC on the mirror of the Zodiac P2 link: the control, which must read 20 or the run is invalid), **O2** (the Jetson NIC on the Zodiac P3 tap: a frame forwarded out of port 3), and the workload side (`agentic-node-01` `eth0` and `rpi-hailo` `eth0`: a frame forwarded out of port 1). For each fault the script waited for the bridge's "TEST FAULT ACTIVE" line and sent within about 10 seconds, before the bridge's recheck (59 s) or the repair (about 3 minutes) could change anything.

## Results (frames seen, of 20 sent)

| Table-miss state | O3, the P2 link (control) | O2, tap (out of P3) | Workload side (out of P1) | What the bridge's readback said afterwards |
| ---------------- | ------------------------- | ------------------- | ------------------------- | ------------------------------------------ |
| Normal DROP | 20 | 0 | 0 | `verified`, drops |
| Forward to the tap (`forward-to-tap`) | 20 | **20** | 0 | `mismatch`, forwards (the earlier runs) |
| Absent (`delete-table-miss`) | 20 | 0 | 0 | `mismatch`, absent (14:27:49, `6 switch entries`) |
| Unrecognised (`unrecognised-table-miss`, a CLEAR_ACTIONS-only entry) | 20 | 0 | 0 | `mismatch`, unrecognised (14:29:47, `7 switch entries`) |

Expected beforehand: the DROP and the CLEAR_ACTIONS entry (which clears the action set and outputs nothing) drop; the forward reaches P3 only; an absent table-miss drops under the OpenFlow 1.3 default but was not known for this firmware.

## What this shows

- **Every state failed closed except the one that was built to forward, and that one only reached the tap.** With the table-miss removed, Zodiac FX 0.86 still dropped every unmatched frame (the OpenFlow 1.3 default holds on this firmware for this frame class), and the CLEAR_ACTIONS entry dropped too. The forwarding table-miss sent all 20 frames to P3 and none to the workload side, so the fault opens no path to the workload.
- The control read 20 in every valid run, so the frames were on the link and the zeros are real drops, not frames that never arrived.
- The status the script read at send time still said `verified` in all three fault runs, because the bridge's recheck had not run yet (it ran 59 s after each injection). The traffic results are therefore tied to the fault, not to the status, by the journal: the fault was active at injection and the recheck reported the matching class afterwards (`journal-extract.txt`).

## The unrecognised class, end to end (injected 14:28:48)

| Time | Event |
| ---- | ----- |
| 14:29:47 | Recheck: `MISMATCH (7 switch entries)`, 59 s after injection |
| 14:30:24, 14:31:24 | Watcher: "state mismatch, table-miss unrecognised -> critical" |
| 14:31:25.6 | `sent alert: Zodiac isolation: CRITICAL` (2 min 37 s) |
| 14:31:47 | Bridge repair after 3 readings (2 min 59 s), trigger `unrecognised`; `repair` audit line |
| 14:32:25.9 | `sent repair: Zodiac isolation: the bridge re-sent the default DROP` |
| 14:32:47 | `verified` again, 6/6 rules (3 min 59 s) |
| 14:34:26.3 | `sent recovered` (5 min 38 s) |

The class is detected by the readback, classified critical by the watcher, pushed, repaired by the bridge by re-sending the DROP (an ADD at priority 0 replaces the CLEAR_ACTIONS entry), and recovery is announced, with the same timings as the other classes (recheck at +0:59, repair at +2:59, `verified` at +3:59).

## What this does not show

- One run per state and one frame class (a non-IP experimental ethertype from the uplink side). IPv4 or ARP frames from the uplink are matched by policy rules, not by the table-miss, and a frame from the workload side matches `p1-default-tap-only`, so no other ordinary traffic reaches the table-miss on this policy; whether a different unmatched class behaves differently was not tried.
- 20 frames per state, 0.1 s apart: this says nothing about behaviour under load (the switch's table-miss path under a flood was not measured).
- The unrecognised fault is one specific unrecognised entry (CLEAR_ACTIONS only). Other instruction types the parser does not recognise were not tried, and a table-miss that really changes behaviour (rather than dropping) was exercised only through the forwarding fault.
- **Phone delivery:** the owner confirmed that all three pushes of the unrecognised run arrived in the ntfy app, and read their times at one-minute resolution: CRITICAL at 2:31 pm (accepted by ntfy at 14:31:25.6), "re-sent the default DROP" at 2:32 pm (14:32:25.9) and recovered at 2:34 pm (14:34:26.3). Each showed in the same clock minute it was sent, so the delay from ntfy accepting a message to the phone showing it was **under 34 seconds** for all three (under 34.4, 34.1 and 33.7 s). The exact delay was not read to the second, and three pushes on one day is a small sample; the earlier rough estimate of 35 to 50 seconds for one push (`../isolation-watch-fault-2026-11-02/README.md`) was made from a looser report and is superseded by this bound.
- The first two baseline attempts were invalid and are kept in `invalid-attempts.txt`: the counting of capture lines was wrong, and the switch was set with the wrong pair of ports because `.agents/network-context.md` had node-01 and node-02 swapped on switch #2 (corrected in the same change).
