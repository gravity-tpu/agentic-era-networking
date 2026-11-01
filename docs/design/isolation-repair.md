# Isolation repair: the bridge re-sends the default DROP by itself, within an envelope

The owner chose this (option 2 of the A3 options in `docs/research/independent-review-packet.md`) on 2026-10-31: when the switch's table-miss DROP is found missing or wrong, a damped, bounded auto-repair restores it, and a person is told. **It is off unless `ZODIAC_ISOLATION_REPAIR=1`.**

## What it does

One action: re-send the person-approved table-miss DROP (a flow-mod ADD at priority 0 with no outputs; an ADD at the same match and priority replaces the existing entry, as the bridge already relies on when it installs the entry at session start). **Nothing else:** not the policy rules, not the quarantines, not allow rules, not an experiment's table. That is the smallest action that fixes property A3, it cannot wipe state a person set, and it cannot desynchronise the bridge's own model of the table. If anything else on the switch is wrong, the bridge reports it and the isolation watcher tells a person; it is not auto-repaired. About 5 seconds after a repair the bridge asks the re-check for a verifying read: the readback, not the send, says whether it worked.

## When it acts, and when it must not

It acts only when the table-miss reads `absent`, `forwards` or `unrecognised` on **3 consecutive successful readbacks** (about 3 minutes at the default 60 s re-check). A generic mismatch whose table-miss drops is out of scope (it may be a quarantine or an experiment table). Failed or unobservable readbacks neither count nor reset the streak; a clean reading resets it. It does nothing, and says why in the journal, while an experiment is running, without an OpenFlow session, or while another install or repair is in progress. Limits (Invariants 4 and 5, all named and bounded, `src/sdn/isolation-repair.ts`):

| Setting | Default | Bounds |
| :--- | ---: | :--- |
| `ZODIAC_ISOLATION_REPAIR` | 0 (off) | `0` or `1`, nothing else |
| `ZODIAC_ISOLATION_REPAIR_READINGS` | 3 | 1 to 20 |
| `ZODIAC_ISOLATION_REPAIR_MIN_INTERVAL_MS` | 600000 | 60000 to 3600000 |
| `ZODIAC_ISOLATION_REPAIR_MAX_PER_WINDOW` | 3 | 1 to 20 |
| `ZODIAC_ISOLATION_REPAIR_WINDOW_MS` | 3600000 | 600000 to 86400000 |

A malformed value stops the bridge from starting. After the per-window budget is spent the governor stops repairing, records that a person is needed, and stays stopped until 3 consecutive clean readings show the condition really resolved.

## How a person hears about it

Every repair and an exhausted budget are in the status payload (`port1Isolation.repair`: `enabled`, `totalRepairs`, `repairsInWindow`, `lastRepairAtMs`, `lastTrigger`, `exhausted`), in the journal (`[Isolation repair]`), and in the audit file (`install-gate-audit.jsonl`, events `repair` and `repair_exhausted`, route `repair`). The isolation watcher (`docs/design/isolation-watch.md`) pushes to the phone: a **high-priority message each time the repair count goes up** ("the bridge repaired itself: something changed or removed the default drop; the repair is automatic, the cause is not") and an **urgent alert when the budget is spent**. The watcher treats the first observation as its baseline, so it never announces an old repair.

## Enabling it

1. Install and test the watcher first, so a repair is never silent.
2. Set `ZODIAC_ISOLATION_REPAIR=1` in `/etc/zodiac/zodiac-bridge.env` (edit the file, not a drop-in) and restart the bridge. Do not restart it while a measurement or an experiment is running.
3. To turn it off, set it to `0` and restart.

## What it does not do, and what is not yet validated

- It does not repair a wiped table: if every rule is gone, only the default DROP comes back (the data plane goes dark, which is the fail-closed state) and the rest is reported. A new OpenFlow session reinstalls everything, as before.
- It cannot see traffic; it acts on what the readback says. A firmware that misreports the table-miss would trigger repeated repairs, bounded by the per-window budget and then by the exhausted state.
- **Not yet validated on the switch:** that an ADD at priority 0 really replaces a table-miss that forwards or is absent, on firmware 0.86. The tests use a spy for the switch (the wiring, the gates, the audit, the status), not the hardware. The validation owed is a supervised session that breaks the table-miss on purpose, with the owner present, and checks that the bridge repairs it and the watcher pushes.
