# What the switch keeps when its controller goes away: the read-only probe (2026-11-02)

One supervised run of the session in [`PREREGISTRATION.md`](PREREGISTRATION.md) (written before it), firmware 0.86, owner present. **It stopped early: states C and D and the second readback were not measured** (cause below). It did settle the question the pre-registration asked first. Files: `run-2026-11-02/run.log` and `stdout.txt` (the orchestrator's log), `results.json` (what it recorded before it stopped), `provenance.json` (hashes, limits, the Jetson commit `ebe555f`, the probe's CLI hash) and `jetson-journal-extract.txt` (the bridge, the watcher and the Jetson events around the interruption).

## What was measured

| Step | Time (EST) | Result |
| ---- | ---------- | ------ |
| Baseline, bridge up (2,000 pps workload to tap) | 18:56:29 to 18:56:46 | 24,000 sent, 23,693 delivered: **987 permille** (resumed) |
| Table counters before the outage | 18:56:46 | 7 entries; the table-miss had counted 428 packets |
| Bridge stopped (the script saw it down at D) | 18:57:19 to 18:57:20 | |
| State B, bridge down, probe not started | 18:57:20 to 18:57:36 | 24,000 sent, 0 delivered: **0 permille**: the earlier zero is reproduced |
| Probe started, bound 6633 | 18:57:37 | `listening on 0.0.0.0:6633 ... (read-only: nothing will be written to it)` |
| The switch connected | 18:57:38.8 | `switch TCP connection from 10.0.1.99`, handshake complete, **session ready after 1,541 ms** |
| **Readback 1** | 18:57:38.8 | **`0 entries, empty`** |
| State C, probe connected | not measured | the ssh connections to the Jetson were closed at 18:57:42 |
| Readback 2, state D (bridge back) | not measured | |

## What this shows

- **The switch's flow table was empty when a controller reconnected.** The probe read it about 4 ms after the handshake completed, and it held no entries: not the 7 it had before the outage (the six policy rules and the table-miss). So the switch does not keep its table through a controller loss, and the earlier blackout (0 of 48,000 frames on 2026-11-01, 0 of 24,000 here) is an empty table dropping everything, not a switch that kept its table and stopped forwarding. That is hypothesis H1 of the pre-registration; the readings that H2, H2b and H3 predicted (a table equal to the policy) were not seen.
- It also means the bridge's own re-send of the whole table when its session starts is what restores forwarding, not a recovery of what the switch kept, and that **a bridge outage is both a blackout and a loss of the switch's whole configuration**, repaired only by the bridge.

## What it does not show

- **Cleared when?** The probe cannot tell "cleared when the old session ended" from "cleared when any new session starts" (the pre-registration said so beforehand). Either way the table is empty at reconnect.
- **State C was not measured**, so the pre-registered surprising case, frames delivered through an empty table while a session is open (a firmware default behaviour the table does not show), is **not excluded**. B is zero with no session, and nothing here says what an empty table with an open session does. The expected answer under H1 is zero.
- One run, one frame class (the 2,000 pps workload-to-tap UDP stream), one reading of the table. The packet-in count was not read (the probe exited before its final report was recorded).
- The Zodiac FX command line may have a fail-state setting (secure or safe) that would explain this directly; its existence and values were not verified, and the switch's own configuration was not read.

## What happened to the rest of the run, and what to change

- **An unrelated update on the Jetson interrupted the session.** At 18:57:32 the desktop `update-notifier` started an apt transaction (`AptDaemon`), systemd reloaded twice, and at 18:57:42 `tailscaled got signal terminated; shutting down` (a package update restarted Tailscale). Every ssh connection to the Jetson over Tailscale closed (the script's sampler and the probe's output stream), and so did the owner's `sudo` session (`pam_unix(sudo:session): session closed for user root` at 18:57:42), which killed the `sh -c 'systemctl stop ...; sleep 110; systemctl start ...'` before it reached `systemctl start`. The script aborted and tore down cleanly (capture stopped, neighbor entry removed, tap NIC back to promiscuity 0).
- **The bridge did not restart from the command.** It stayed stopped from 18:57:19 until the owner started it by hand at 19:00:08: **169 seconds**, not the planned 116. The isolation watcher did what it should: `sent alert: Zodiac bridge unreachable` at 18:59:39 (3 polls) and `sent recovered` at 19:01:39. After the manual start the isolation read `verified drops` with repair on and no probe or capture left running.
- **Changes for a re-run (not done yet):** (1) make the bridge's return independent of any ssh or sudo session: arm a detached systemd timer first (`sudo systemd-run --unit=away-restart --on-active=110s systemctl start zodiac-bridge`) and then `sudo systemctl stop zodiac-bridge`, so a dropped session cannot leave the bridge down; (2) keep updates from running during a session (the desktop update notifier and unattended upgrades on the Jetson); (3) let the orchestrator survive a dropped ssh (retry or fail the one state, not the run). A re-run would add C, the second readback and D; it costs another blackout of about two minutes.
- Earlier fixes that were needed to get this far, all merged: the orchestrator demanded passwordless sudo on the Jetson (it has none and needs none for the capture, #202) and its `pgrep` matched its own ssh shell (#203).
