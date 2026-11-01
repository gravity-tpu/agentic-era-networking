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
