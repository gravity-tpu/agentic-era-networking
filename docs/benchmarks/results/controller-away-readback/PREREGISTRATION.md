# What does the Zodiac FX do to its flow table when its controller goes away? Pre-registration

Written 2026-11-02, before the probe has touched the switch. Results go in `README.md` next to this file; this file is not edited afterwards except to add a line saying what changed and why.

## The question

On 2026-11-02 (run of 2026-11-01 ET, [`../controller-outage-2026-11-01/README.md`](../controller-outage-2026-11-01/README.md)) the bridge was stopped for 60 s and 0 of 48,000 workload frames on the tap path were delivered (23,689 of 24,000 before, 23,690 of 24,000 after, 98.7%). The frames were matched by `p1-default-tap-only` (priority 150, in_port 1, output P3). The bridge cannot say why: it cannot read the table while it is down, and when it returns it re-sends the whole table (the `ready` handler in `src/sdn/zodiac-bridge-server.ts`) before it reads anything back.

| | Explanation | Table when a controller reconnects | Delivery of the same frame class |
| --- | --- | --- | --- |
| H1 | The switch CLEARED its flow table when the controller session ended. | empty | none until a controller installs a table |
| H2 | The switch KEPT its table but does not forward while it has no controller (a fail-secure style mode). | the policy, unchanged | resumes once a controller session exists, even one that installs nothing |
| H2b | The switch KEPT its table, and a session alone does not restore forwarding: something a full controller does (re-send the table, the table-miss DROP) is needed. A refinement of H2, named so a null result under H2 has a place to go. | the policy, unchanged | stays at zero while the probe is connected |
| H3 | The switch KEPT its table and forwards only some classes while the controller is away. | the policy, unchanged | this class is not forwarded; other classes might be (not observed here) |

## What is built

1. **The probe** (`src/sdn/controller-away-probe.ts`, CLI `src/sdn/controller-away-probe-cli.ts`, tests `test/invariants/controller-away-probe.test.ts`). While the bridge is stopped, it listens on the bridge's OpenFlow port (6633; the bind address is `SDN_CONTROLLER_IP` as for the bridge), lets the switch reconnect and complete the handshake, reads the flow table with the bridge's own `readFlowStats` (one OFPMP_FLOW request) a bounded number of times, prints each entry (priority, match, output ports and other instructions via `flow-actions.ts`, packet and byte counters) and the isolation comparison (`verifyIsolationReadback`), and exits.
2. **The orchestrator** (`scripts/controller-away-run.py`). It does not stop or start the bridge. It sets up and removes the sender neighbor entry and the promiscuous tap capture, measures the traffic in four states, starts and bounds the probe, and records everything in `OUT_PREFIX.json` and `.log`.

### Read-only, and what that does and does not mean

- The probe wraps the `OpenFlowServer` in a hard-private field (`ReadOnlySwitchSession`). The wrapper exposes `listen`, `close`, a flow-stats read, `state`, a packet-in count and event subscriptions. No write method of the server is reachable through it, and a test fails if the member list changes.
- The one raw-write path the readback needs goes through `readOnlyViolation`, an allowlist: hello, features request, echo request and reply, and a multipart request of type flow-stats. Flow-mod (add, modify, delete), table-miss, group, port, table, meter-style multipart types, packet-out, set-config, barrier, any unknown type, and any malformed frame are refused. The tests make each of those fail.
- A test runs the real `OpenFlowServer` against a fake switch socket and asserts every byte the probe sends is one of those five message types, with no flow-mod and no packet-out, including when the switch sends a packet-in (the probe counts it and never answers). A source scan asserts neither file names a write method.
- **What this proves:** the probe's own code never emits a message that adds, changes or removes switch state. **What it does not prove:** that the switch is unchanged by a controller connecting to it. A session is itself a state change on the switch's side (it may start punting packets, restart a timer, or start forwarding). That is the point of the experiment, and the outcomes below say what each change would mean.
- Fixtures in the tests are built from the controller's own encoding; none is a capture from the switch. The tests prove the probe's behaviour, not the firmware's.

## What is predicted

All observations use the earlier frame class: 2,000 pps of 572 B UDP from `agentic-node-01` (10.0.2.50, `eth0`) towards 10.0.0.119 for 12 s, counted on the Jetson tap NIC (`enx9c69d39dd0a6`, the P3 link), idle-corrected, ratio = delivered over sent. Four states:

- **A. baseline**, bridge up. Known: about 0.987.
- **B. no controller before the probe**: the bridge is gone, the probe has not started. Known from the earlier run: 0.
- **C. probe connected**: the switch has a session with the probe; the probe has installed nothing.
- **D. after the bridge is back**, after its 10 s settle and a `verified` isolation status. Known: about 0.987.

"Zero" means a ratio under 0.02 (the earlier zeros were exactly 0; a trickle from ARP or noise stays under this). "Resumed" means a ratio of at least 0.90, the baseline floor the script itself enforces. In between is reported as partial and not forced into a hypothesis.

Table counters. Before the outage the script reads the switch's counters through the bridge's existing read-only route (`GET /api/zodiac/flows/probe`), call it N0 for `p1-default-tap-only`. The probe reads them at connect (read 1) and 20 s later (read 2).

| | Read 1 (table at connect) | Counter of `p1-default-tap-only` | B | C | D |
| --- | --- | --- | --- | --- | --- |
| H1 | 0 entries, outcome `empty`, exit 3 | none to read | zero | zero (an empty table with a session; see the surprising cases) | resumed |
| H2 | the policy plus one table-miss entry, outcome `equals_policy`, exit 0 | read 1 at least N0 | zero | resumed; counter delta between reads about the frames delivered in C (about 23,700) | resumed |
| H2b | `equals_policy` | read 1 at least N0 | zero | zero | resumed |
| H3 | `equals_policy` | read 1 at least N0 | zero | not separable from H2 or H2b with one frame class | resumed |

The counter at read 1 adds a second axis for a retained table: read 1 minus N0 is about the frames matched during B (about 24,000 if the switch still looks up and matches but suppresses output; about 0 if the datapath does not look frames up at all without a controller). A few hundred of other workload traffic (ARP, a ping) is expected in either case, so the two readings are 24,000 against a few hundred, not an exact count.

Prior, stated so it can be wrong: I expect H1 or H2 and put H3 lowest, but I have no measurement that favours either, and nothing in this repository says which the firmware does. (From memory, not checked: the Zodiac FX command line has a fail state setting, secure or safe. If the switch is configured for one of them, that setting is a better explanation than any hypothesis here, and reading it before interpreting the result would be sensible. I have not verified that the setting exists or what each value does.)

## What each combination of outcomes would mean

| Read 1 | C | Reading |
| --- | --- | --- |
| `empty` | zero | **H1.** The table is gone when a controller reconnects, so the earlier zero was an empty table. Caveat that stays: the probe cannot tell "cleared when the old session ended" from "cleared when any new session starts". Operationally the same (the bridge re-sends everything), but it is not the same fact. |
| `empty` | resumed | **Surprising.** Frames are delivered through an empty table with a session open. The switch has a default behaviour (flood, normal learning, or a built-in rule) that the table does not show. First check the baseline and D (is the measurement itself sound), then the packet-in count, then say this is a firmware default that the readback hides. It would also mean traffic can leave the segment by a path the verifier does not model. |
| `equals_policy` | resumed | **H2.** The table is retained and forwarding is gated by having a controller session, even a read-only one. The earlier zero was the missing session, not an empty table. Does not exclude H3. |
| `equals_policy` | zero | **H2b** (or H3 for this class). Retained table, session alone does not restore it. Read the counters: read 1 minus N0 near 24,000 means frames are matched and output is suppressed; near zero means they are not looked up. The next experiment would give the probe write power (a different, separately approved test), and it is not part of this one. |
| `differs` | any | The switch held part of the table, or entries the policy does not have. Read the entry list: lost entries and which ones (H3-like, or a firmware timeout), extra entries (something other than the bridge installed them), or counters reset to zero on a policy-shaped table (the table was rewritten by something other than this probe). Classify from the printed entries, not from this table. |
| any | not zero in B | The earlier zero is **not reproduced**. Nothing about H1 to H3 follows until the difference is explained (for example, B began after the switch had already reconnected somewhere, or the earlier run's zero was a property of the first seconds of an outage). Report as a failure to replicate. |
| `never_reconnected` (exit 4) | n/a | The switch did not reach the probe within 35 s, so the table is unread. B and D still stand. It is information about the switch's reconnect behaviour (for example a retry interval longer than the bound) and about nothing else. A longer wait is not available inside the blackout limit. |
| `readback_failed` (exit 5) | any | A session was established but the flow-stats request got no usable answer. The readback path works when the bridge uses it, so something differs about a session with no table (the switch may not answer, or answers with an error reply, which the log records). C is still valid as an observation of a session held by a controller that sends nothing. |
| `bind_failed` (exit 7) | n/a | The bridge (or something) still holds 6633. Nothing was sent. The run is void; check why the stop did not release the port. |
| any | a second handshake, entries appearing or vanishing between read 1 and read 2, counters that go down, or a packet-in count above 0 | **The probe's own session changed the switch** (or the switch was changing independently). The summary flags `tableChangedDuringSession`, `handshakes` above 1 and `packetIns`. Whatever the first read says is then a state after the probe connected, and the combined reading above is weaker. Packet-ins mean the switch is asking a controller what to do with frames; the probe does not answer, so those frames are not delivered by this path. |
| any | D not about 0.987, or isolation status not `verified` after | **Recovery was disturbed.** The run is an incident first and a measurement second: stop, read the bridge log, and do not repeat until understood. |

One more way the result is limited: only one frame class is observed. H2 and H3 differ in what other classes do, and this run does not send any. A second run would send, for example, intra-segment IPv4 matched by the priority-200 rule to P2 and P3, and an ARP frame.

## Timeline (durations are bounds, not measurements, except where marked)

Computed by `scripts/controller-away-run.py` (`--plan` prints it without touching anything). T is the moment the owner presses enter; D is when the script sees the bridge unreachable (within about 5 s of T).

| When | What | Bound |
| --- | --- | --- |
| before T | preflight, setup, baseline A (12 s of traffic plus sampler lead-in), counters read | about 1 minute; nothing disturbed |
| T | owner's command stops the bridge | |
| D to D+18 | B, no controller: 12 s of traffic plus sampler lead-in and ssh calls | the probe must start by D+25 or it is not started |
| D+18 | probe starts on the Jetson; binds 6633; waits for the switch | at most 35 s (switch reconnect time unmeasured) |
| P+r | the switch connects, read 1; C starts: 12 s of traffic | each readback at most 8 s |
| P+r+20 | read 2, the probe exits, the session closes | the probe's own hard limit is 65 s from its start, its backstop timer 5 s later, a `timeout -s KILL` on the Jetson at 72 s |
| T+110 | the owner's command starts the bridge | the probe is dead by D+97 at the latest, so the bridge never finds the port taken |
| T+116 | bridge answering (restart time is an allowance of 6 s, not a measurement) | |
| T+126 | 10 s settle, isolation status read, D: 12 s of traffic | |

Expected, if the switch reconnects in a few seconds: the probe is finished about D+45. The sleep is fixed, so the blackout is about 116 s whether or not the probe finishes early. That is under the isolation watcher's alert (3 polls of 60 s, so 150 s at the earliest), and at most two polls land in it. The watcher should not push; if it does, note it. The segment is a blackout for that whole time (the earlier run measured the same: workload traffic stops when the bridge stops).

## Abort conditions

The script aborts or skips as follows. None needs the owner except the last.

- Preflight fails (no ssh, no passwordless sudo on either host, a probe process already running, the probe CLI missing on the Jetson, isolation not `verified`, quarantines active, not exactly one listener on 6633): nothing is touched.
- Baseline ratio under 0.90: the neighbor entry or tap capture is not holding. Stops before READY; nothing is disturbed.
- No outage within 300 s of READY: gives up, nothing disturbed.
- Bridge already back when B ends, or B ended later than D+25: the probe is not started; B and D are still recorded.
- The probe never prints a first readback line within 48 s: C is skipped, the probe's lines are recorded.
- The bridge is still down 240 s after the probe finished: the script says so loudly and exits 2. Owner: `systemctl status zodiac-bridge`, then `sudo systemctl start zodiac-bridge`.
- Ctrl-C or any error: the probe is killed (local and `pkill` on the Jetson), the tap capture is stopped and the neighbor entry removed. It does not start the bridge, because it cannot (sudo); the owner's single command already does, at T+110.
- The owner may end the outage early: first `pkill -f controller-away-probe-cli` on the Jetson (the bridge cannot bind 6633 while the probe holds it), then `sudo systemctl start zodiac-bridge`.

## Preconditions

- The branch is built and the two new files, `dist/sdn/controller-away-probe.js` and `dist/sdn/controller-away-probe-cli.js`, are on the Jetson under `~/agentic-era-networking/dist/sdn/`. They import only existing modules (`openflow-server`, `openflow-types`, `flow-readback`, `dataplane-benchmark`, `flow-actions`, `port1-isolation` and what those import), so no other file on the Jetson changes. Smoke test that loads the modules and binds nothing: `node ~/agentic-era-networking/dist/sdn/controller-away-probe-cli.js --readbacks 99` must print `FATAL: --readbacks must be between 1 and 6, got 99` and exit 1.
- The bridge is up, isolation `verified`, no quarantines, one listener on 6633. Owner present, the other task's sessions on the shared hardware paused for the outage (about 2 minutes of blackout).
- Passwordless `sudo -n` on `agentic-node-01` (neighbor entry) and the Jetson (tap capture). Otherwise the script stops in preflight and prints the manual command.
- The two setup items the earlier outage run needed, created and removed by the script with the commands that worked in the layout-capacity runs: a permanent neighbor entry for 10.0.0.119 on `agentic-node-01` `eth0` (`ip neigh replace 10.0.0.119 lladdr 02:00:00:00:00:77 dev eth0 nud permanent`, the MAC is locally administered and no rule matches a MAC), and a background `tcpdump -i enx9c69d39dd0a6 -w /dev/null` on the Jetson that keeps the tap NIC promiscuous (without it the NIC drops unicast frames not addressed to it and the counter reads zero even when frames arrive, the failure of the first live-policy attempt). The script checks promiscuity after starting the capture and refuses to measure if it is 0, and reports it after teardown.
- The probe compares against the bridge's policy, so the script reads `ZODIAC_UPLINK_ARP_PEERS` and `SDN_CONTROLLER_IP` from `/etc/zodiac/zodiac-bridge.env` (only those two keys are read, with `grep`) and passes them to the probe. If the file is unreadable the script stops and asks for `AWAY_ZODIAC_UPLINK_ARP_PEERS` and `AWAY_SDN_CONTROLLER_IP`. A wrong peer list would make `equals_policy` impossible, which the entry listing makes visible.

## Owner steps

1. Lead, on the Mac, once: copy the two files to the Jetson and run the smoke test above.

   ```text
   scp dist/sdn/controller-away-probe.js dist/sdn/controller-away-probe-cli.js jetson:agentic-era-networking/dist/sdn/
   ssh jetson 'node ~/agentic-era-networking/dist/sdn/controller-away-probe-cli.js --readbacks 99; echo exit $?'
   ```

2. Lead, on the Mac: start the orchestrator and wait for `READY`.

   ```text
   python3 scripts/controller-away-run.py /tmp/zodiac-controller-away-$(date +%Y%m%dT%H%M%S)
   ```

3. Owner, on the Jetson, when READY is printed (the line is repeated in the log): paste exactly this one line. It stops the bridge, waits, and starts it again, so the bridge returns whatever else happens.

   ```text
   sudo sh -c 'systemctl stop zodiac-bridge; sleep 110; systemctl start zodiac-bridge'
   ```

4. Nobody touches the switch, the bridge or the Jetson for the next 2 minutes. The script prints each observation and the probe's lines as they happen and ends with `finished`.
5. Owner, on the Jetson, afterwards: confirm the bridge is back and verified, and that nothing is left running.

   ```text
   systemctl is-active zodiac-bridge
   curl -s localhost:3003/api/zodiac/flows | grep -o '"state":"[a-z_]*"'
   pgrep -fl 'controller-away-probe|tcpdump' || echo nothing left
   ```

6. Lead: copy `OUT_PREFIX.json`, `.log` and `.provenance.json` into this directory with a `README.md` of results.

## What the run cannot show

- The table **before the probe connects.** The switch may keep or clear its table at any time between the bridge's stop and the probe's connection, and the probe sees only the state after. Read 1 is "the table when a controller reconnects", not "the table during the outage".
- Whether the switch behaves differently when a controller reconnects than when it does not. If the table is retained and delivery resumes in C, that is consistent with the switch gating forwarding on a session, and equally with the probe's own connection changing its mode.
- Which of H2 and H3 is true, because only one frame class is sent.
- Why, in firmware terms. The run observes the table and one delivery path; it reads no switch configuration and no logs.
- The reconnect time of the switch (r is observed, once), the switch's behaviour after a different outage length, or after a longer one (a longer outage than 116 s would trip the isolation watcher).
- That the result holds on another firmware, another switch, or when the bridge dies abnormally instead of being stopped by systemd (a stop closes the TCP session cleanly; a power cut or a kill might not).
- Anything about uplink-side (P2) traffic or ARP; nothing is sent that the table should drop, so it says nothing about whether a dropped frame stays dropped during an outage.

## Risks

- **The probe holds the switch's one controller connection** while the bridge is away. The bridge is stopped, so nothing is displaced, and the probe exits at least 13 s before the bridge starts. The residual risk is that the switch reconnects to the bridge more slowly after a session ended by the probe than after one ended by a bridge restart (restarts were seen to reconnect within a few seconds; the time after a probe session is not measured). If the bridge's isolation status is not `verified` within a minute of its return, treat it as the incident case above.
- **The blackout** is about 116 s of no workload connectivity through the switch, longer than the earlier 60 s run, and the isolation watcher will see "bridge unreachable" for two of its three polls.
- **A second controller session may change the switch.** It may clear or reset entries, reset counters, send packet-ins, or switch modes. All of these are what the summary flags; none can be undone by the probe, and all are undone by the bridge's table rewrite on return.
- **Frames to an empty table.** If the empty table with a session (H1 case) makes the switch flood, up to 24,000 frames of 572 B to a locally administered MAC could reach the uplink segment. The uplink has been a dead-end VLAN since 2026-10-25, so nothing answers, and the earlier outage showed no delivery to P3; whether anything leaves by P2 is not observed (no capture on P2 in this run).
- **A port clash.** If the bridge started while the probe still held 6633 it could fail to bind. The timing above prevents it (probe dead by D+97, bridge starts at T+110, D at most 5 s after T) and the probe's own bind failure exits with code 7 if the bridge is still up. What the bridge does after a failed bind has not been read for this run.

## Probe exit codes

| Code | Outcome | Meaning |
| --- | --- | --- |
| 0 | `equals_policy` | exactly the policy rules plus one table-miss entry, nothing else |
| 2 | `differs` | a table that is not the policy |
| 3 | `empty` | no flow entries |
| 4 | `never_reconnected` | no completed handshake within the bounded wait |
| 5 | `readback_failed` | connected, but no readback succeeded |
| 6 | `overall_timeout` | the hard limit ended the run before a readback |
| 7 | `bind_failed` | could not listen (the bridge is probably up); nothing sent |
| 1 | fatal | bad arguments or an unexpected error |

The first successful readback decides the outcome. What `equals_policy` proves: every policy rule is present once with the same priority and match fields, there is one priority-0 wildcard entry and nothing else. It says nothing about forwarding unless the printed action status is `confirmed`, and nothing about counters.

## Limits (Invariant 5)

All named in `PROBE_LIMITS` (probe) and at the top of `scripts/controller-away-run.py` (orchestrator), each configurable and bounded.

| Limit | Value used | Bound |
| --- | --- | --- |
| probe overall time | 65 s | 10 s to 150 s (default 120 s) |
| wait for the switch | 35 s | 5 s to 100 s (default 60 s) |
| one readback | 8 s | 1 s to 30 s (default 10 s) |
| readbacks | 2 | 1 to 6 (default 3) |
| spacing between readbacks | 20 s | 5 s to 60 s (default 10 s) |
| probe start after the bridge is seen down | 25 s | fixed in the script |
| traffic | 2,000 pps, 12 s per state, four states | as the earlier run; about 96,000 frames in all |
| owner's sleep | 110 s | derived: start deadline + remote kill + detection slack + margin |
