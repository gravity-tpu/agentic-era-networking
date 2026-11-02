# The table-miss, extended: pre-registration

Written 2026-11-02, before anything was run, and committed before the first session. Results go in a `README.md` and a `results.jsonl` in this directory after the sessions; this file is not edited afterwards except to add a dated line saying what was changed and why. Nothing here has been run against hardware: the code and the unit tests were written and run offline.

## What it closes

[`docs/design/isolation-watch.md`](../../../design/isolation-watch.md) lists three gaps under "Not validated", and the [2026-11-02 traffic run](../table-miss-traffic-2026-11-02/README.md) names them under "What this does not show":

1. **Other kinds of unrecognised table-miss entry.** Only a CLEAR_ACTIONS-only entry was tried.
2. **Other unmatched frame classes.** Only one (ethertype 0x88b5, 60 bytes, 20 frames) was sent.
3. **The table-miss under load.** 20 frames 0.1 s apart say nothing about a flood.

## What is built, and what each check proves

| Piece | Where | What it proves | What it does not |
| ----- | ----- | -------------- | ---------------- |
| Four non-forwarding table-miss entries (new fault modes) | `src/sdn/openflow-types.ts` (`buildOfpTableMissVariant`, `assertNoForwardingInstructions`), `src/sdn/table-miss-fault.ts`, `injectTableMissFaultOnce` | The bytes are exactly those written out by hand in the tests; none carries an OUTPUT, GROUP or experimenter action (a guard that rejects those, tested to reject, runs before any byte is returned); each is read back by the parser as `unrecognised` | What the firmware does with the entry: it may reject it, normalise it or report it differently |
| Nine frame classes, each with its own source MAC and filter | `scripts/table_miss_lib.py`, `scripts/table-miss-traffic.py --classes` | The Python frames equal frames built independently in the test from the standards; each filter names its own MAC and protocol; the counting reads `tcpdump -e` text per source MAC | That a frame reaches the switch: the O3 control per class says so at run time |
| The judge | `table_miss_lib.judge` | The verdict rules below, including that a control which is not exact makes a class invalid | Why a count differs from the prediction |
| The load test and its abort logic | `scripts/table-miss-load.py`, `table_miss_lib.Monitor` | Each listed sign of trouble, fed to the monitor as a sample, stops the run with its reason; a plan outside the limits is refused before any ssh | Trouble with no sign in the API or journal it reads, or between two polls |

Unit tests: `test/invariants/table-miss-fault.test.ts` (existing tests unchanged except the list of modes, now seven) and `test/invariants/table-miss-extended.test.ts`.

## Part 1: the unrecognised variants

All four are an ADD at priority 0 with an empty match, so they replace the DROP in place (as the CLEAR_ACTIONS entry did on 2026-11-02, when the repair's DROP replaced it in turn). None can forward: the guard allows only instruction types WRITE_METADATA, WRITE_ACTIONS, APPLY_ACTIONS and CLEAR_ACTIONS, and only the POP_VLAN action. GOTO_TABLE and METER were left out on purpose: on a one-table switch they ask for something that does not exist and the likely answer is a rejection that tells us nothing new.

| Mode | Entry (instruction bytes) | What the parser records | Why this one |
| ---- | ------------------------- | ----------------------- | ------------ |
| `unrecognised-table-miss` (existing) | CLEAR_ACTIONS, 8 bytes | `otherInstructionTypes [5]` | Measured on 2026-11-02; the control for the others |
| `unrecognised-write-empty` | WRITE_ACTIONS with an empty action set, 8 bytes | `otherInstructionTypes [3]` | A different instruction type that also executes as a drop (the action set stays empty); tests that the detection is not specific to CLEAR_ACTIONS |
| `unrecognised-apply-pop-vlan` | APPLY_ACTIONS holding only POP_VLAN, 16 bytes | `otherActionTypes [18]`, `outputPorts []` | The other branch of the parser: the instruction type is the one the controller itself uses, only the action inside is unfamiliar; the entry changes the packet and outputs nothing |
| `unrecognised-write-metadata` | WRITE_METADATA with metadata 0 and mask 0, 24 bytes | `otherInstructionTypes [2]` | A third instruction type, a no-op by construction (it writes no bits); the one most likely to be rejected by a firmware without metadata support |

Not tried, and why: an incomplete instruction block (`complete=false`) and two priority-0 entries cannot be produced through a flow-mod the switch accepts; an APPLY_ACTIONS with no action at all would read back as a bare DROP (`drops`), which is not unrecognised.

### What a rejection would look like, and mean

The bridge logs a switch error loudly. A rejected variant shows, right after the `TEST FAULT ACTIVE` line, a line `Switch rejected message — OFPT_ERROR xid N: type T, code C` (the fault's raw xid is not tied to an isolation rule, so the isolation status itself does not record the error). Expected shapes if the firmware rejects: type 3 (BAD_INSTRUCTION) code 1 (UNSUP_INST) for WRITE_ACTIONS or WRITE_METADATA; type 2 (BAD_ACTION) code 0 (BAD_TYPE) for POP_VLAN. The meaning is: the firmware does not support that instruction. The DROP is then still in the table, the isolation status stays `verified` with table-miss `drops` at the recheck, and any traffic sent in that session measured a normal DROP, not the variant. Such a session is recorded as "rejected" and its traffic counts are not read as evidence about the variant.

## Part 2: the frame classes

All are sent from agentic-node-01 `eth1` into the Zodiac P2, 20 per class, interleaved by round, 0.1 s apart (180 frames, about 18 s). With the isolation policy only IPv4 destined to 10.0.2.0/24 matches a rule from P2, and the uplink ARP peer list is empty, so every class below reaches the table-miss. Each class has its own source MAC (`02:00:00:00:00:7N`) and filter; the capture on each observer is the OR of the filters, with the `vlan` filter last because libpcap's `vlan` primitive shifts the decoding offsets of what follows it.

| Class | Frame | Filter | Control may fail because |
| ----- | ----- | ------ | ------------------------ |
| `experimental` | ethertype 0x88b5, 60 bytes (measured 2026-11-02) | `ether proto 0x88b5` | |
| `ipv6` | 0x86dd, 62 bytes, next header none | `ether proto 0x86dd` | |
| `vlan-tagged` | 802.1Q VID 100, inner 0x88b5, 60 bytes | `vlan 100` | switch #2 may drop or untag a tagged frame at ingress |
| `lldp` | 0x88cc to 01:80:c2:00:00:0e, 60 bytes | `ether proto 0x88cc` | a bridge need not forward that group address |
| `stp-bpdu` | 802.3 + LLC BPDU to 01:80:c2:00:00:00, priority 61440 (never a root), 60 bytes | `ether dst 01:80:c2:00:00:00` | a bridge must not forward that group address |
| `runt` | 0x88b5 with a 4-byte payload, 18 bytes before padding | `ether proto 0x88b5` | the NIC or switch #2 may pad (the observed length at O3 says) or discard it |
| `near-mtu` | 0x88b5, 1514 bytes | `ether proto 0x88b5` | |
| `ipv4-outside-segment` | UDP 192.0.2.77 to 198.51.100.7 (RFC 5737 test ranges), 60 bytes | `ip dst 198.51.100.7` | |
| `arp-request` | who-has 192.0.2.78 tell 192.0.2.77, broadcast, 60 bytes | `arp` | |

### Verdict rules (fixed in advance)

Per class, in this order: `control_failed` if O3 (the mirror of the P2 link) does not read exactly 20 (the class did not reach the switch intact, so nothing else about it counts); `workload_reach` if any frame came out of P1 (O4: node-01 eth0 or rpi-hailo eth0), in any state; `leak` if any frame came out of P3 (O2) in a state that does not forward; `forwarding_differs` if the state forwards and O2 is not 20 (a finding, not a breach); otherwise `as_predicted`. `workload_reach` and `leak` are breaches: the run stops and the owner is told.

### Predictions (frames seen of 20)

| State | O3 (control) | O2 (tap, out of P3) | O4 (workload side, out of P1) |
| ----- | ------------ | ------------------- | ----------------------------- |
| Normal DROP, absent, and every unrecognised entry (all four) | 20 for each valid class | **0** for every class | **0** for every class |
| Forwards (`forward-to-tap`) | 20 for each valid class | **20** for each valid class | **0** for every class |

Reasoning. The DROP and the unrecognised entries output nothing by construction; an absent table-miss dropped the 0x88b5 class on 2026-11-02 (the OpenFlow 1.3 default holds on this firmware for that class); the forward goes to P3 only, as measured, and P1 is never an output of any table-miss state. Confidence in the forwarding row: high for `experimental`; medium for `ipv6`, `near-mtu`, `ipv4-outside-segment`, `arp-request` (the firmware could treat a class specially, which was not seen for the one class tried); low for `vlan-tagged`, `lldp`, `stp-bpdu`, `runt` (firmware or NIC special handling is plausible). These confidence levels are my estimates, not measurements.

Predicted controls (estimates): exact 20 for `experimental`, `ipv6`, `near-mtu`, `ipv4-outside-segment`, `arp-request`; likely exact for `runt` with an observed length of 60 (the sending NIC pads); uncertain for `vlan-tagged` (about even odds); likely to fail for `lldp` (switch #2 may consume it) and most likely for `stp-bpdu`. A class whose control fails is reported invalid in that session and is not a result; the first session (normal DROP) says which controls hold, and the same ones are expected to hold in the others.

What outcomes would mean. All valid classes drop in the three non-forwarding states: the fail-closed property of the table-miss does not depend on the frame class, within the nine tried. A frame out of P3 in a non-forwarding state (`leak`): the entry or the absent default does not drop that class, and the isolation claim for that class is false; stop and report. A frame out of P1 in any state (`workload_reach`): a path from the uplink to the workload that no rule of the policy grants; stop and report at once. A forwarding state where a valid class does not reach the tap (`forwarding_differs`): the firmware treats that class specially (for example consumes a link-local frame); this says nothing about isolation.

Not covered: whether any frame was punted to the controller (no observer sees the OpenFlow channel in this pass; the load pass reads the bridge's message count and CoPP lines), frames from P1 or P3, and one 20-frame sample per class per state.

## Part 3: the table-miss under load

DANGEROUS. The switch has lost its OpenFlow session at 1.3 to 2.3 times its forwarding capacity ([layout-capacity](../layout-capacity/README.md)). Supervised only, owner present, workload idle.

### Plan and limits (named constants in `scripts/table_miss_lib.py`)

- Frames: the `experimental` class, from node-01 `eth1` into P2, at 500, 1000, 2000, 4000, 8000 pps, 10 s per step, 3 s pause, stepped up only.
- Limits: at most 8000 pps in any state (`MAX_PPS_HARD`), and per state `drop` 8000, `forwards` 8000, `unrecognised` 4000, `absent` 2000 (lower where the switch's cost per frame is unmeasured); a step of 5 to 10 s; at most 6 steps; at most 120 s of wall time for the steps, overhead and pauses included. A plan outside these is refused before any ssh (tested). The plan above is 5 x (10 + 8) + 4 x 3 = 102 s; with the idle measurement about 110 s.
- Why 8000 and not more: this sender (a Python raw-socket loop on node-01) was not measured; the UDP sender of `layout-capacity-run.py` offered up to 14,856 pps in the 2026-10-20 run and was flagged sender-limited only below 97% of target. 8000 pps is 0.63 of the 12,662 pps the switch forwarded on the live policy at k = 0, and by the linear model (58 µs + 4.24 µs per rule) a frame that walks all seven entries costs more than the measured path, so the modelled capacity of the table-miss path is nearer 10,000 pps (modelled, not measured). The sender is checked at run time: a step below 97% of its target rate ends the run as `sender_limited`.
- Counting: rx_packets deltas on each NIC (a sampler 1 s before the sender and 1 s after it ends), less the idle rate of that NIC measured for 4 s just before, integers throughout. O3 is the control: below 97% of the frames sent the step is invalid. Allowance for noise: 3 frames at an observer that must read zero.

### What it reads, and when it stops

One ssh poll of the Jetson every 2 s during each step (`POLL_COMMAND`): the bridge's isolation status (state, table-miss class, age of the reading), the OpenFlow session status and the count of OpenFlow messages received, and the bridge's own journal for this process (switch sessions, OFPT_ERROR lines, CoPP rate-limit lines, the fault's active and ended lines). It stops at the first of these, stops the sender through a stop file the sender checks every 50 ms (the sender also has a `timeout`), and prints why in `stopReason`:

| Code | Sign |
| ---- | ---- |
| `poll_failed` | two polls in a row could not read the bridge |
| `session_not_connected` | the OpenFlow session status is not `Connected` |
| `session_restarted` | the bridge logged a new switch session (the session was lost and re-made; a new session also re-sends the DROP and ends the fault) |
| `switch_error` | a new OFPT_ERROR |
| `packet_in_flood` | a CoPP rate-limit line: the switch is sending unmatched frames to the controller |
| `fault_ended` | the bridge says the fault ended or was cancelled |
| `isolation_unexpected` | a status other than the pair expected for the state: `verified/drops` always allowed (the status is re-read from the switch only every 60 s, so it still says that until the first recheck after an injection), plus `mismatch/forwards` (state forwards), `mismatch/absent` or `mismatch/unrecognised`; anything else, such as `readback_failed`, stops the run |
| `fault_time_low` | under 30 s of the fault's time limit would remain |
| `frame_where_none_may_appear` | O4 above 3 frames in any state, or O2 above 3 in a non-forwarding state |
| `sender_limited` | the sender did not reach 97% of the target rate |
| `no_fault` / `idle_unmeasured` | refused to start: no active fault in the journal, or an idle rate could not be read |

What this proves: at each 2 s poll none of those signs was present. What it does not: a session loss repaired between two polls without a log line; and the isolation status is up to 60 s old. The status flows through `GET localhost:3003/api/zodiac/flows` and the OpenFlow session through `GET localhost:3003/api/zodiac?summary=true`, as `scripts/labelled-runs.py` reads them.

### Predictions (stated in advance)

1. **Normal DROP, 500 to 8000 pps:** O3 at least 97% of the sent frames at every rate; O2 and O4 within 3 frames of zero; `verified/drops` throughout; no new session, no OFPT_ERROR, no CoPP line; the sender reaches 97% of its target at every rate (unmeasured, so a `sender_limited` stop at 8000 would not surprise me). The drop path is no more expensive per frame than the forward path.
2. **Forwarding table-miss, 500 to 8000 pps:** O2 at least 97% of the frames sent at every rate (modelled capacity of this path about 10,000 pps), O4 zero, status `verified/drops` then `mismatch/forwards` after the first recheck, no session loss. The step most likely to differ is 8000 pps: a `tap_path_lossy` verdict there would be a measured capacity of the P2 to P3 table-miss path below 8000 pps, which is a finding, not a failure of the isolation property.
3. **Unrecognised (CLEAR_ACTIONS), 500 to 4000 pps:** as the DROP: O2 and O4 zero, status `mismatch/unrecognised` after the recheck, no session loss.
4. **Absent, 500 to 2000 pps:** O2 and O4 zero and no session loss. This is the state with the most unknown: if this firmware punts unmatched frames to the controller when no table-miss entry exists, the message count would rise by about the number of frames and a CoPP line or a session loss would follow. The 0x88b5 frames of 2026-11-02 were dropped, but nothing observed whether they were also sent to the controller. My estimate is that the firmware drops in hardware (about 80%).

Meaning of the outcomes. A clean run: the table-miss path, in that state, held to the stated rate without disturbing the control channel, within a 2 s sampling of the signs above. An abort with `session_restarted` or `session_not_connected` at some rate: the switch loses its session at that rate of unmatched frames in that state, and that rate is the finding (the previous step is the last one known good). `packet_in_flood`: the firmware punts to the controller in that state. `tap_path_lossy`: a capacity, not a breach. `frame_where_none_may_appear`: stop and report; the isolation claim for that state is false at that rate.

## Session plan

Seven sessions, one at a time, lowest risk first. Each fault session is one bridge restart with the fault set (600 s limit, repair off), the class pass, optionally the load pass, a read of the isolation status at least 65 s after the injection, and a clean-up restart that removes the fault. Durations are estimates from the code and from the 2026-11-02 sessions (a recheck at +59 s), not measured.

| # | Label | Fault mode | Class pass state | Load pass | Estimated duration |
| - | ----- | ---------- | ---------------- | --------- | ------------------ |
| 1 | `s1-drop` | none (no restart) | `drop` | `drop`, 500 to 8000 pps (102 s) | 4 min |
| 2 | `s2-write-empty` | `unrecognised-write-empty` | `unrecognised` | none | 5 min |
| 3 | `s3-apply-pop-vlan` | `unrecognised-apply-pop-vlan` | `unrecognised` | none | 5 min |
| 4 | `s4-write-metadata` | `unrecognised-write-metadata` | `unrecognised` | none | 5 min |
| 5 | `s5-clear-actions` | `unrecognised-table-miss` | `unrecognised` | `unrecognised`, 500 to 4000 pps (81 s) | 7 min |
| 6 | `s6-forward` | `forward-to-tap` | `forwards` | `forwards`, 500 to 8000 pps (102 s) | 8 min |
| 7 | `s7-absent` | `delete-table-miss` | `absent` | `absent`, 500 to 2000 pps (60 s) | 6 min |

About 40 min plus pauses and the setup. If a session ends in an abort or a breach the series stops there and the owner and lead decide whether to continue. Nothing is repeated automatically; one run per cell, so a surprising cell is a candidate for a repeat, not a conclusion.

### Time budget inside a 600 s fault

Timed from the `TEST FAULT ACTIVE` line: the class pass about 50 s (4 s listening, 18 s sending, 8 s settling, reading the captures), the isolation status read at 70 s or later (the recheck runs 59 s after the injection), the load pass starts at about 80 to 100 s and takes 60 to 110 s, so the last frame is sent at about 210 s at the latest, leaving about 390 s of the limit unused. The load script refuses to start with less than the plan, the idle measurement and 30 s of reserve left, and checks the time left at every poll. The clean-up restart ends the fault early (a new session re-sends the DROP; with the variables removed nothing is injected again).

## Owner steps

The lead runs the scripts from the Mac (they use ssh to `jetson`, `agentic-node-01` and `rpi-hailo`). The owner does the switch and the Jetson shell.

### Once, before session 1: switch #2

1. Put switch #2 in the wire-campaign arrangement used on 2026-11-02: VLAN 2 = port 1 (node-01) and port 4 (Zodiac P2); VLAN 1 = ports 2 and 5; VLAN 3 = port 3 (the mirror of the P2 link). Tell the lead.
2. Session 1 needs nothing else on the Jetson: the bridge keeps its current configuration (repair on, no fault).

### Once, after session 1: the Jetson shell

Paste these in a Jetson shell. The backup and the repair line are done once; the repair line is a later line, so it wins over the existing `ZODIAC_ISOLATION_REPAIR=1` and is removed at the very end. The functions are used in every later step.

```bash
F=/etc/zodiac/zodiac-bridge.env
[ -e $F.bak-before-table-miss-extended ] || sudo cp -p $F $F.bak-before-table-miss-extended
printf 'ZODIAC_ISOLATION_REPAIR=0\n' | sudo tee -a $F >/dev/null
setkey() { sudo sed -i "/^$1=/d" $F; printf '%s=%s\n' "$1" "$2" | sudo tee -a $F >/dev/null; }
iso() { curl -s -m 8 localhost:3003/api/zodiac/flows | python3 -c "import json,sys; d=json.load(sys.stdin)['port1Isolation']; print(d['state'], (d.get('actions') or {}).get('tableMiss'), d.get('checkedAgeMs'))"; }
grep -n 'ZODIAC_ISOLATION_REPAIR' $F
```

Expected: two lines, `=1` then `=0`.

### Each fault session (2 to 7): replace MODE with the session's mode

1. The lead starts the class pass first, so that it is already waiting: `python3 scripts/table-miss-traffic.py LABEL --classes all --state STATE --wait-for-fault` (it waits up to 240 s for the bridge's `TEST FAULT ACTIVE` line). The lead says go.
2. The owner pastes, in the Jetson shell:

   ```bash
   setkey ZODIAC_FAULT_TABLE_MISS MODE
   setkey ZODIAC_FAULT_TABLE_MISS_ACK I-ACCEPT-A-BOUNDED-FORWARDING-TABLE-MISS
   setkey ZODIAC_FAULT_TABLE_MISS_SECONDS 600
   sudo systemctl restart zodiac-bridge; date +%T
   ```

3. The class pass runs by itself when the line appears and prints one JSON line. For sessions 5 to 7 the lead then runs the load pass at once, while the fault is active (no restart in between): `python3 scripts/table-miss-load.py LABEL-load --state STATE --fault-seconds 600` with `--rates 500,1000,2000,4000` in session 5 and `--rates 500,1000,2000` in session 7 (the default rates are refused above the state's limit).
4. At least 65 s after the injection the lead reads the status and the fault lines: `ssh jetson 'journalctl -u zodiac-bridge --no-pager --since "10 min ago" | grep -E "Fault|OFPT_ERROR|Switch rejected|MISMATCH|CoPP"'` and the status line from `iso`. Expected after the recheck: `mismatch unrecognised` (sessions 2 to 5), `mismatch forwards` (6), `mismatch absent` (7). `verified drops` means the variant was rejected or normalised (see above); an `OFPT_ERROR` line says which.
5. When the lead says the session is done, the owner ends the fault and restores the DROP:

   ```bash
   sudo sed -i '/^ZODIAC_FAULT_TABLE_MISS/d' $F; sudo systemctl restart zodiac-bridge; date +%T; sleep 25; iso
   ```

   Expected: `verified drops` and an age of a few seconds. Do not start the next session until it says so.

Mode and state by session: 2 `unrecognised-write-empty` / `unrecognised`; 3 `unrecognised-apply-pop-vlan` / `unrecognised`; 4 `unrecognised-write-metadata` / `unrecognised`; 5 `unrecognised-table-miss` / `unrecognised`; 6 `forward-to-tap` / `forwards`; 7 `delete-table-miss` / `absent`.

### Session 1 (no fault)

1. The lead runs `python3 scripts/table-miss-traffic.py s1-drop --classes all --state drop`, then `python3 scripts/table-miss-load.py s1-drop-load --state drop`. The first poll must say `verified drops` and the session `Connected`, or the script refuses to start.

### At the very end

1. Remove the repair override and restart, then check the repair line is back to `=1` only and the status verified:

   ```bash
   sudo sed -i '/^ZODIAC_ISOLATION_REPAIR=0$/d' $F; sudo systemctl restart zodiac-bridge; date +%T; sleep 25; iso; grep -n 'ZODIAC_FAULT\|ZODIAC_ISOLATION_REPAIR' $F
   ```

   Expected: `verified drops`, one `ZODIAC_ISOLATION_REPAIR=1` line and no `ZODIAC_FAULT` line.
2. Restore switch #2 to its normal VLAN arrangement and tell the lead.

## Abort and safety summary

- No variant can forward: the bytes are guarded and the guard is tested to reject outputs, groups, experimenter actions, goto-table and meters.
- Every fault ends at its time limit (600 s), at the next switch session, or at the clean-up restart; the DROP is re-sent each time.
- The load pass stops at the first sign above, refuses plans above the limits, and never runs without a fault that the journal shows active (except in the `drop` state, which needs no fault).
- Repair is off for the fault sessions on purpose and is restored at the end; the state left behind by an interrupted series is the DROP after the next restart, because no fault variable survives the clean-up.

## What this will not show

One run per cell, 20 frames per class and state, nine classes, one switch with firmware 0.86, one sender NIC. Load only for the `experimental` class and only to 8000 pps; the table-miss under a flood of the other classes, or above the switch's capacity, was deliberately not tried. Unmatched frames from P1 or P3 do not reach the table-miss on this policy and are not tested. Whether a firmware that accepts one of the variants executes it as a drop is inferred from the traffic counts, not read from the switch.
