# Live checks of the experiment install path's safety backstops (2026-10-20)

The bridge's experiment install path (`src/sdn/experiment-install.ts`, branch `feat/experiment-install`) promises that an experimental rule set
cannot stay on the switch past its time limit, and that if the bridge dies the data plane stays dark. Four live checks were run on the real
Zodiac FX (firmware 0.86 per the ledger) with no production traffic on it. **The console figures below are transcribed from the scripts' output;
the scripts are in this directory.** Only test D kept its raw capture (`freeze-test.O2.capture.txt`, `tcpdump -tt`, six lines). Tests A to C
saved only their console output.

| Test | What was done | What was seen |
| :--- | :--- | :--- |
| A. Wildcard wipe | Installed the six deployed isolation rules, then a four-rule subset (two rules removed), each through `POST /api/experiment/install` | The subset verified with exactly 5 entries (4 rules and the table-miss) and 0 leftovers: the firmware honours a wildcard `DELETE`. The 20 s bridge-side limit then restored the isolation policy by itself and the isolation status returned to `verified`. |
| B. Bridge killed, restart after 58 s (`test-b-kill-and-wait.py`) | Installed isolation plus a marker rule with a 10 s limit (so every rule carried a 40 s hard timeout), killed the bridge, restarted it at +58 s | The bridge's startup readback counted 7 entries (table-miss and the six rules): the marker was gone. Ambiguous: it could have expired or have been flushed. |
| C. Bridge killed, restart after 20 s (`test-c-kill-and-restart-early.py`) | Same, but restarted at +20 s, before the 40 s hard timeout | 7 entries at +30 s: the marker was **already gone before the hard timeout**. The bridge's startup only adds rules (it sends no delete), so the switch had cleared it. |
| D. Bridge frozen (`test-d-freeze.py`) | Installed one rule (in port 1, IPv4, to port 3) with a 10 s limit, froze the bridge with `SIGSTOP` at about +1 s (its OpenFlow session stays open but nothing answers), sent one UDP datagram per second from node-01 for 70 s and captured at O2 | The rule was copied to the tap for **6 of the 70 datagrams (first at +0.7 s, last at +5.7 s after the install)**, then never again. |

## What this shows

- **The rule disappeared about 5 seconds after the controller stopped answering**, long before the bridge's own 10 s limit could matter (it was frozen) and far
  before the 40 s switch-side hard timeout. The consistent reading of C and D is that this firmware drops the controller session when echo requests go
  unanswered and flushes its flow table when the session drops (fail-secure behaviour). That reading is **inferred from timing**: the firmware was not read for it.
- So on this switch an experimental rule cannot outlive a dead or frozen bridge by more than about 5 seconds, and the data plane is dark (only whatever the
  switch holds after the flush) until the bridge reconnects and re-installs the isolation policy.
- **The switch-side hard timeout was not shown to work.** It never became the operative mechanism in these tests, so it remains a redundant backstop that has
  not been exercised. It would take a test that keeps the controller session alive and answering while the bridge's restore is blocked.

## An edge case the freeze found, and its fix

When the bridge was resumed, its overdue restore could not run (the periodic isolation re-check was frozen holding the flow-read lock), so the installer
raised its alarm (`attention`) and left it set, although the bridge's own reconnect handler had already re-installed and verified the isolation policy.
A manual `POST /api/experiment/restore` cleared it. The alarm outliving its cause was a real defect; `isolationReestablished()` now clears it when the
bridge's own readback verifies after a reconnect (never during an experiment), with a test that fails if the phase guard is removed
(commit `6614d16` on `feat/experiment-install`).

## Limits

- One switch, one firmware, one run of each test; timings are to about a second (one datagram per second).
- Tests A to C have no raw capture; their figures are the console output.
- "Fail-secure on controller silence" is an inference from when the rule vanished, not a read of the firmware.
