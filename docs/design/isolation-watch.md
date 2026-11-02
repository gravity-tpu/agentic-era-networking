# Isolation watcher: telling a person when the isolation breaks

## The gap it closes

The bridge re-reads the switch's flow table every minute (`src/sdn/isolation-recheck.ts`) and sets `port1Isolation.state` to `mismatch` for any table-miss problem (absent, forwarding, unrecognised) or any rule mismatch. That reaches a person only through a dashboard badge (for someone who has it open), `GET /api/zodiac/flows`, and the journal. No path pushes it to a phone, so "report only" meant nobody was told. `src/sdn/isolation-watch.ts` decides when a person should be told; `src/sdn/isolation-watch-cli.ts` polls the bridge and sends the messages to ntfy (`src/sdn/ntfy.ts`).

## What it sends

| Situation | Needs | Priority |
| :--- | :--- | :--- |
| Table-miss absent, forwarding or unrecognised, or the policy rejected by the verifier | 2 consecutive polls (about 2 minutes) | urgent |
| Any other mismatch, `readback_failed`, `not_installed`, or an unknown state | 5 polls (outlasts the stale `mismatch` that follows an experiment session) | high |
| Bridge unreachable, or the status says `verified` but its last check is older than 5 minutes (the re-check stopped, so `verified` is not evidence) | 3 polls | high |
| The bridge repaired itself (its `port1Isolation.repair.totalRepairs` went up; see `docs/design/isolation-repair.md`) | immediately, one message per repair | high |
| The bridge's repair budget is spent and the table-miss is still wrong | 2 polls (critical) | urgent |
| Recovery | 2 consecutive clean polls | default |
| Reminder while a problem lasts | every 30 minutes, at most 8 | as the alert |
| Heartbeat | every 24 hours; **no heartbeat means the watcher is not running** | low |

One alert per episode; a worse class (bad to critical) alerts again. A message stays pending until ntfy confirms delivery, so a failed push is retried and never lost or duplicated. Every number is a named, bounded setting (`ISOLATION_WATCH_*`); a value out of bounds is an error, never clamped.

## Setting it up

1. Install the ntfy app on the phone and subscribe to a long random topic (`openssl rand -hex 16`, prefixed `zodiac-`). On the public server the topic is the secret.
2. On the Jetson, in the repository: `git pull && npx tsc`, then follow the installation steps in `deploy/jetson/zodiac-isolation-watch.service` (the env file is `/etc/zodiac/isolation-watch.env`, mode 600).
3. Send a test push: `node dist/sdn/isolation-watch-cli.js --test` (with the env loaded), then `systemctl enable --now zodiac-isolation-watch`. `--once` prints one observation and its classification without sending.

## What it does not do

It reports what the bridge's readback says; it cannot see traffic. If the bridge is down or wedged it says so only after three polls, and if the Jetson itself is down the heartbeat stops, which is something a person has to notice. It sends no secrets: only state names, counts and ages, and the logs show the ntfy host, never the topic.

## Validation so far (2026-11-01)

Installed on the Jetson (`zodiac-isolation-watch`, enabled) and exercised on the real bridge with the owner present:

- **Delivery:** `--test` sent two messages and the service's own "started" message; all three arrived on the owner's phone.
- **Unreachable bridge:** with the thresholds shortened for the test only (`ISOLATION_WATCH_POLL_MS=10000`, `ISOLATION_WATCH_UNREACHABLE_POLLS=1`, both inside the documented bounds), the bridge was stopped for about 25 s. The first failed poll sent "Zodiac bridge unreachable" within 0.3 s; after the bridge returned, "Zodiac isolation recovered" followed after two clean polls (19 s). The overrides were removed and the service restarted at the defaults. Journal lines: `journalctl -u zodiac-isolation-watch` for 2026-11-01 22:50 to 22:53 EST.

- **Forwarding table-miss, detection and push (2026-11-02, repair off):** with the test fault below (240 s), the bridge's recheck read `MISMATCH` 59 s after injection, the watcher sent the CRITICAL push after 2 polls (2 min 7 s after injection), the fault ended on its own at 4 min, the recheck needed 2 clean readings to return to `verified` (2 min later), and the recovery push followed at 7 min 7 s. The phone received the pushes (for the recovery push the delay after ntfy accepted it was roughly 35 to 50 seconds, estimated; the exact phone timestamps were not recorded).
- **Repair (2026-11-02, repair on, fault 600 s):** the CRITICAL push at 2 min 29 s, the bridge's own repair after 3 consecutive readings at 2 min 59 s (`[Isolation repair] … re-sending the approved default DROP`), `verified` again 1 min later, the "bridge repaired itself" push 30 s after the repair and the recovery push 2 min 30 s after it. Timelines and journal extracts: `docs/benchmarks/results/isolation-watch-fault-2026-11-02/`.

**Not validated:** detection of an **absent** or **unrecognised** table-miss on firmware 0.86 (only the forwarding class was exercised on the switch; no route can remove the DROP), a repair that does not take, more than one run of each test, and why the switch stops forwarding while the controller is away. That last one was measured afterwards (`docs/benchmarks/results/controller-outage-2026-11-01/`): during a 60 s bridge outage 0 of 48,000 frames on the tap path were delivered (98.7% before and after), so an unreachable bridge also means no workload connectivity through the switch; whether the flow table was cleared or the switch blocks without a controller is not known. A supervised test of the table-miss path needs a guarded way to replace the DROP for a bounded time and is not built.

## Exercising it against the real switch: the test fault

No route can change the table-miss, and the experiment endpoint always reinstalls the DROP, so the table-miss paths of the watcher and of the repair governor could only be tested against fakes. `src/sdn/table-miss-fault.ts` adds a deliberate, bounded fault for a supervised test. It is **off unless all of these are set** in `/etc/zodiac/zodiac-bridge.env` (anything else leaves the DROP alone and logs why):

| Variable | Value |
| :--- | :--- |
| `ZODIAC_FAULT_TABLE_MISS` | `forward-to-tap` (forward once), `forward-to-tap-sticky` (re-send the forward every 2 s, so a repair does not take) or `delete-table-miss` (a strict delete: the entry is absent) |
| `ZODIAC_FAULT_TABLE_MISS_ACK` | `I-ACCEPT-A-BOUNDED-FORWARDING-TABLE-MISS` (exactly) |
| `ZODIAC_FAULT_TABLE_MISS_SECONDS` | optional, whole seconds from 60 to 900, default 240 |

What it does: when the bridge starts, sends the policy, and the readback has **verified** the baseline, it replaces the table-miss DROP with a priority-0 forward to P3 (or, in the delete mode, removes the entry) (the tap, which already receives a copy of everything the workload sends, so the fault opens no new path), logs `TEST FAULT ACTIVE`, writes a `fault_injected` line to the gate audit file, and sets a timer that puts the DROP back (`fault_reverted`). It acts once per process; a new switch session re-sends the DROP and cancels a pending revert. If the readback did not verify, nothing is injected.

What it is not: a path to forward untrusted traffic. While it is active the isolation status reads `mismatch` (table-miss `forwards`), which is the point. Remove the three variables and restart the bridge when the test is done; a bridge restarted with them still set will inject again.

Two supervised tests use it, both with the owner present and the workload idle:

1. **Detection and push (repair off, the default).** Fault for 240 s. Expected: the status goes `mismatch`, the watcher sends an urgent alert after 2 polls (about 2 minutes at the default 60 s), the DROP returns at 240 s, the watcher sends the recovery message after 2 clean polls.
2. **Repair.** Set `ZODIAC_ISOLATION_REPAIR=1` too and a fault of 600 s or more, so the governor acts first. Expected: after 3 readings the bridge re-sends the DROP itself (`repair` audit line, one "the bridge repaired itself" push), and the status returns to `verified` well before the fault's own time limit.

More supervised tests with the other modes (owner present, workload idle; the live bridge now runs with repair on, so a test that must not be repaired sets `ZODIAC_ISOLATION_REPAIR=0` after the repair line):

- **Absent table-miss** (`delete-table-miss`, 600 s, repair on). Expected: the status leaves `verified`, the watcher alerts, the bridge re-sends the DROP after 3 readings and the status returns to `verified`.
- **A repair that does not take** (`forward-to-tap-sticky`, 600 s, repair on, `ZODIAC_ISOLATION_REPAIR_MAX_PER_WINDOW=1` and `ZODIAC_ISOLATION_REPAIR_MIN_INTERVAL_MS=60000` for the test). Expected: one repair at about 3 minutes, overwritten by the fault; 3 more bad readings later the governor reports `exhausted` (a `repair_exhausted` audit line and a critical push) and stops; at the time limit the DROP stays and, after 3 clean readings, the exhausted flag clears and the status returns to `verified`.
- **Repeats** of the forward tests above: with repair off (`ZODIAC_ISOLATION_REPAIR=0`) and with it on.

Remove every `ZODIAC_FAULT_TABLE_MISS*` line and every test override (and keep `ZODIAC_ISOLATION_REPAIR=1`) when the tests are done.
