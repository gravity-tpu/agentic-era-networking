# Does the switch keep forwarding while its controller is down? (2026-11-01)

One supervised run, owner present. Not pre-registered: it was a single observation to settle a question the isolation-watcher validation left open (what the switch does while the bridge is away), so there is no prediction to compare against.

## Result

**While the bridge was down, nothing the workload sent reached the tap NIC.**

| Step (2,000 pps, 12 s, 572 B UDP from the workload side, matched by `p1-default-tap-only`) | Sent | Delivered | Ratio |
| ------------------------------------------------------------------------------------------ | ---- | --------- | ----- |
| Bridge up (before) | 24,000 | 23,689 | 0.987 |
| Bridge down, step 1 (23:10:20 to 23:10:36 ET) | 24,000 | 0 | 0.000 |
| Bridge down, step 2 (23:10:36 to 23:10:53 ET) | 24,000 | 0 | 0.000 |
| Bridge back and verified (after) | 24,000 | 23,690 | 0.987 |

The bridge was stopped for 60 s with `sudo sh -c 'systemctl stop zodiac-bridge; sleep 60; systemctl start zodiac-bridge'`; it was back at 23:11:20 ET, the isolation status read `verified` afterwards, and the "before" and "after" steps match to within one packet.

## What this shows and what it does not

- Frames that the live table sends to P3 (the path measured in every layout-capacity run) were **not** forwarded without a controller, twice in a row. The switch did not keep forwarding by its flow table. For this path the outage is a blackout, not a degraded mode: workload traffic stops when the bridge stops, and resumes when the bridge has re-sent the table.
- It does **not** say why. Either the switch cleared its flow table when the controller session ended, or it stops forwarding when it has no controller even with the table in place; the bridge cannot read the table while it is down, so this run cannot tell the two apart. It also does not say how long the blackout lasts after the session returns beyond the first step (the bridge came back 1 minute 1 second after the stop and the first step after that was clean).
- Only one path was measured (frames from the workload side matched by `p1-default-tap-only`, delivered to P3). The uplink side (P2) and the ARP rules were not exercised, and nothing was sent that the table should drop, so this run says nothing about whether a dropped frame stays dropped during an outage.
- One outage of 60 s, one pass, firmware 0.86.
- A consequence for operations: a bridge restart (a few seconds) interrupts the workload's tap path, which explains why restarts are visible as a gap in the tap capture. The isolation watcher's "bridge unreachable" alert therefore also means the workload has no connectivity through the switch.

## Provenance

Script: `scripts/outage-forwarding.py` (the run used the same code with an absolute import path for the harness; the harness at the time was the revision with SHA-256 starting `34725152e5eccd30`, listed in `../layout-capacity/HARNESS-REVISIONS.md`). Setup as in the layout-capacity runs: a permanent neighbor entry for 10.0.0.119 on `agentic-node-01` `eth0` and a promiscuous tap NIC (`tcpdump -w /dev/null`), both removed afterwards. `results.json` and `run.log` are the script's own output.
