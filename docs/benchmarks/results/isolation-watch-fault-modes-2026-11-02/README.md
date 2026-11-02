# The watcher and the repair governor against the real switch: absent table-miss, a repair that does not take, and repeats (2026-11-02)

Follow-up to [`../isolation-watch-fault-2026-11-02/`](../isolation-watch-fault-2026-11-02/README.md), closing the gaps that README listed. Supervised, owner present, workload idle, firmware 0.86, using the test fault's `delete-table-miss` and `forward-to-tap-sticky` modes (`src/sdn/table-miss-fault.ts`). Not pre-registered: the expectations were the estimates given before each run. Times are the Jetson clock (EST); the offsets are from the injection. `journal-extract.txt` is the bridge and watcher journal for 11:36 to 13:43 and `gate-audit-extract.jsonl` the fault and repair lines of the gate audit file, unedited apart from dropping unrelated lines.

An attempt at 11:23:51 did nothing: the Jetson still ran the build before the new modes, which refused `delete-table-miss` as an unknown mode and left the DROP alone (the guard failing closed).

## Runs

| Run | Fault | Repair | Recheck sees it | CRITICAL push | Bridge repair | `exhausted` | Budget-spent push | Fault ends | `verified` again | Recovery push |
| --- | ----- | ------ | --------------- | ------------- | ------------- | ----------- | ----------------- | ---------- | ---------------- | ------------- |
| A (11:36:57) | delete the table-miss, 600 s | on | +0:59 | +2:16 | +2:59 | | | the repair ended it | +3:59 | +5:17 |
| B (11:43:07) | sticky forward, 600 s | on, 1 per window | +1:00 | +2:07 | +3:00 | +5:00 | none (a gap, below) | +10:00 | +12:00 | +14:08 |
| B again (12:37:16, fixed watcher) | sticky forward, 600 s | on, 1 per window | +0:59 | +2:01 | +2:59 | +4:59 | +6:02 | +10:00 | +12:00 | +14:03 |
| C (12:54:25) | forward once, 600 s | on | +1:00 | +2:54 | +3:00 | | | the repair ended it | +4:00 | +5:55 |
| D (13:33:14) | forward once, 240 s | off | +0:59 | +2:08 | none | | | +4:00 | +6:00 | +7:08 |

## What this shows

- **An absent table-miss is detected and repaired.** The firmware honoured the strict delete (the readback showed 6 switch entries, the table-miss gone), the watcher classified "table-miss absent" as critical, the bridge re-sent the DROP after 3 readings and the status returned to `verified`.
- **A repair that does not take is handled as designed by the bridge:** one repair at 3 minutes, overwritten within 2 s by the fault; after 3 more bad readings the governor reported `exhausted`, wrote `repair_exhausted` to the audit file, stopped repairing, and the watcher did not announce recovery while the flag was set (the status read `verified` for a minute before the governor's 3 clean readings cleared it).
- **The first sticky run found two watcher gaps, fixed in #190 and confirmed by the second sticky run.** (1) After the budget was spent no push followed the CRITICAL one: `exhausted` was classified as an ordinary critical and the episode's critical alert had already gone out. It is now its own class above critical, and run B again sent "repair BUDGET SPENT" 1 minute after the bridge gave up. (2) The repair push said "the bridge repaired itself" even though the repair had not taken (run B); it now says the bridge re-sent the DROP and that the next readback decides.
- **The repeats agree with the first runs.** The bridge's own steps are reproducible to the second (recheck at +0:59 to +1:00, repair at +2:59 to +3:00, `verified` at +4:00 after a repair, 6:00 without one); the push times vary by up to about a minute with where the 60 s watcher poll falls (CRITICAL push at +2:01 to +2:54). Repair off (D) matches the first detection run (alert +2:08 against +2:07, recovery +7:08 against +7:07).

## What this does not show

- Only the classes the fault can produce were exercised on the switch: forwarding (the four forward and sticky runs here plus the earlier two), absent (one run) and a repair that does not take (two runs, the first against the watcher before the fix). An **unrecognised** table-miss (an action the parser cannot read) was not exercised, and absent ran only once.
- The faults replace or remove only the table-miss; frames were not sent through the switch during these runs (the workload was idle and the tap read 0 pps), so what an absent or forwarding table-miss does to real traffic on this firmware is not measured here.
- The push arrival times on the phone were not recorded; the owner confirmed the pushes arrived.
- The sticky fault is a stand-in for a repair that does not take; a real cause (the switch rejecting the flow-mod, for example) is not simulated.
- The fault's own 600 s timer fired at 13:04:25 in run C, 7 minutes after the repair had already fixed it (the bridge was not restarted until run D): harmless, and the audit file records it.
