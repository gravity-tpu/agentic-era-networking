# Isolation watcher and repair against the real switch: the table-miss fault tests (2026-11-02)

Two supervised runs with the owner present and the workload idle (tap at 0 pps), firmware 0.86, using the bounded test fault from `src/sdn/table-miss-fault.ts` (see `docs/design/isolation-watch.md`). Not pre-registered: the expectations were the estimates given before each run (below). Times are the Jetson's clock (EST); `journal-extract.txt` is the bridge and watcher journal and `gate-audit-extract.jsonl` the fault and repair lines of the gate audit file, both unedited apart from dropping unrelated lines.

## Test 1: detection and push (repair off, fault for 240 s)

| Time | Event |
| ---- | ----- |
| 10:47:03 | Isolation readback verified; the fault replaces the table-miss DROP with a forward to P3 (`fault_injected`) |
| 10:48:02 | Recheck: `MISMATCH` (59 s after injection) |
| 10:48:09, 10:49:09 | Watcher polls: "state mismatch, table-miss forwards -> critical" |
| 10:49:09 | `sent alert: Zodiac isolation: CRITICAL` (2 min 7 s after injection) |
| 10:51:03 | Time limit: the DROP is re-sent (`fault_reverted`) |
| 10:52:02, 10:53:02 | Recheck: clean readback 1 of 2, then `verified` |
| 10:54:10 | Watcher: second clean poll, `sent recovered` (7 min 7 s after injection) |

Estimated beforehand: alert 1 to 3 minutes (about 2), recovery 5 to 7 minutes. Both held; recovery sat at the top because the bridge's recheck needs two clean readings to leave `mismatch`, which the estimate had not assumed.

## Test 2: repair (repair on, fault for 600 s)

The test paste was run twice by mistake (restarts at 10:57:28 and 10:59:40); the first run's fault was cancelled by the second restart before the governor's third reading, so the clock below starts at the second injection.

| Time | Event |
| ---- | ----- |
| 10:59:42 | Readback verified; fault injected (`fault_injected`, 600 s) |
| 11:00:41 | Recheck: `MISMATCH` |
| 11:01:10, 11:02:10 | Watcher polls: critical; `sent alert: Zodiac isolation: CRITICAL` at 11:02:11 |
| 11:02:41 | Third consecutive "forwards" readback: `[Isolation repair] … re-sending the approved default DROP (priority 0). Everything else on the switch is left as it is.` (`repair` audit line) |
| 11:02:46 | Recheck: clean readback 1 of 2 (5 s after the repair) |
| 11:03:11 | `sent repair: Zodiac isolation: the bridge repaired itself` |
| 11:03:41 | Recheck: back to `verified`, 6/6 rules, table-miss drops |
| 11:05:11 | `sent recovered: Zodiac isolation recovered` |

Estimated beforehand: repair about 3 minutes after injection, `verified` about 5 minutes after. The repair came at 3 minutes (3 readings at 60 s), well before the fault's own 600 s timer, which was cancelled when the bridge was restarted at 11:05:57 to remove the test variables; `verified` came at 4 minutes.

## What this shows and what it does not

- On firmware 0.86 the bridge's readback sees a forwarding table-miss, the watcher classifies it critical and the push arrives; an ADD at priority 0 of the DROP replaces it, and the repair governor does that on its own after 3 readings and touches nothing else. Both runs ended with the isolation `verified` and the DROP in place.
- The urgent alert fires about 30 seconds before the repair (2 polls against 3 readings), so a fault the bridge heals still pages once. The thresholds are the watcher's bounded settings if that should change.
- Only the **forwarding** class was exercised on the switch. An absent or unrecognised table-miss was not (nothing here can remove the DROP), a repair that does not take was not, and each test ran once.
- The fault forwards unmatched traffic to P3, which already receives a copy of the workload's traffic; the segment was idle, so no traffic took the forwarding table-miss during either run.
- The phone received the CRITICAL, repair and recovery pushes (confirmed by the owner). For the recovery push of test 1 the delay from ntfy accepting it to the phone was roughly 35 to 50 seconds, estimated from the owner's "almost 4 minutes ago" against the Jetson clock; the exact phone timestamps were not recorded.
