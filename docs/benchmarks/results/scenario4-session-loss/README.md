# Scenario 4, reframed: session loss and recovery — results (2026-11-03/04)

Run under [`PREREGISTRATION.md`](PREREGISTRATION.md) (owner's rate decision 2026-11-04: exactly 2x the deployed table's measured capacity, 25,000 pps, not a range). Tooling: `scripts/session-loss.py` / `scripts/session_loss_lib.py` (PR #218, `feat/scenario4-tooling`). Raw script output, one JSON line per trial, unedited: [`results.jsonl`](results.jsonl).

**Headline: the registered load (25,000 pps, 572 B, 10 s) does induce real OpenFlow session loss on this switch, but only sometimes — 2 of 5 valid trials — and every loss observed recovered on its own, within about 2 s, well inside the 30 s reconnect-wait bound. The fallback restart has never been observed to fire on real hardware; it remains verified only by `session_loss_lib.py`'s own selftest.**

## What was sent and what was seen

Five valid trials (`try3`–`try7`) at the exact registered plan, each a fresh invocation of `session-loss.py LABEL --owner-go-for-real-load` with no deviation from the registered pps, frame or step duration:

| Trial | Verdict | Loss detected | Fallback fired | O3 (leak) | O2 (tap) |
| ----- | ------- | -------------- | --------------- | --------- | -------- |
| try3 | `no_loss_observed` | no | — | 0 | 109,149 |
| try4 | `no_loss_observed` | no | — | 0 | 109,256 |
| try5 | **`recovered`** | **yes** | no | 0 | 90,754 |
| try6 | **`recovered`** | **yes** | no | 0 | 89,359 |
| try7 | `no_loss_observed` | no | — | 0 | 109,259 |

Two earlier attempts (`s4-real-run-2026-11-03`, `try2`) are **not** part of this result: both came back `observer_invalid` because of a pre-existing bug, not a finding about the switch (see below). No leak in any trial: O3, the mirror of the Zodiac P2 uplink, read 0 frames every time.

## A bug found and fixed before the first valid trial

The first two attempts failed `observer_invalid` with the same message, the frame-line count pinned at exactly 14,184 both times despite different summary totals (109,224 and 109,252): `table_miss_lib.read_capture()` read back the O2 tap's `tcpdump -e` text with a hardcoded `head -c 2000000` cap, written in 2026-09 for the much smaller table-miss-extended experiment. At the registered 25,000 pps for 10 s, O2's capture (everything from the sender's own MAC, which this scenario's traffic saturates) produces far more than 2 MB of text, so the parser silently saw only the first ~14,184 lines while tcpdump's own exit summary (read separately) correctly reported the full count. The validity check caught the mismatch and failed closed exactly as designed (Invariant 3) — it did not silently under-report a count as the truth.

Fixed by raising the cap to a named, documented 64 MiB constant (`CAPTURE_TEXT_READ_CAP_BYTES`, `table_miss_lib.py`) sized with margin over the largest registered single send (25,000 pps x 10 s, up to 250,000 frames, ~35 MB of text at the observed line width); the mismatch check itself is unchanged; it will still catch and void a capture larger than the new cap rather than under-reporting it. All 77 existing tests in `test/invariants/table-miss-extended.test.ts` and `test/invariants/session-loss.test.ts` still pass. This is a shared helper used by every script that reads a tcpdump capture back over ssh; no other caller previously had a large enough capture to hit the old cap.

## The fallback path: not observed on real hardware

Both real losses (try5, try6) recovered on the very next poll, about 2 s later — consistent with `RECONNECT_WAIT_S = 30`'s own stated rationale, that nothing measured on this testbed has ever taken longer than 30 s to recover, including a full device reboot. To try to exercise `recovered_with_fallback` (and confirm the real `sudo -n systemctl restart zodiac-bridge.service` fallback actually works against live hardware, not just against the mocked ssh in `session_loss_lib.py`'s selftest), 8 further trials (`sl-fallback-diag-1`..`-8`) were run via [`scripts/diagnostics/session-loss-fallback-diag.py`](../../../../scripts/diagnostics/session-loss-fallback-diag.py) — a diagnostic script, not part of the registered scenario-4 tooling and not itself pre-registered, but committed and reviewable — that reuses `session_loss_lib.run_experiment()` and every real I/O function unmodified, with only `RECONNECT_WAIT_S`/`FALLBACK_WAIT_S` overridden in memory from 30 s to 1 s — short enough that the ~2 s natural recovery already observed would cross the threshold and force the real restart command to fire. `TARGET_PPS`/`STEP_SECONDS` were untouched; this still sent the exact registered plan, and the script requires the same `--owner-go-for-real-load` confirmation as `session-loss.py` itself. All 8 attempts came back `no_loss_observed`: no session loss happened to occur in any of them, so the shortened threshold was never crossed either.

**`recovered_with_fallback` and `not_recovered` remain verified only by `session_loss_lib.py`'s own selftest** (`selftest()` cases 2 and 3, scripted ssh, deterministic poll sequences) — not by a real invocation of the actual `sudo systemctl restart` against live hardware. Reproducing a natural loss that lasts past even a 1 s threshold took 0 hits in 8 tries here; across all 13 valid real trials today only 2 ever showed a loss at all (~15%), both recovering in ~2 s. Forcing a real sustained (>30 s) outage to properly exercise the fallback would require deliberately interrupting the OpenFlow TCP session to the switch independent of load (the bridge is the TCP server; stopping the whole `zodiac-bridge.service` instead kills its own status API too, making every poll `unreadable` rather than a readable `Disconnected` — confirmed before attempting it, not after a wasted run) — out of scope for this pass; left open, not fixed.

## What this shows

- **The registered 2x-capacity load does induce real session loss**, confirming the central premise of this scenario, but it is probabilistic on this hardware (2/5 ≈ 40% in valid natural trials), not deterministic.
- **Every observed loss recovered unaided**, well inside the registered 30 s reconnect-wait bound, with the session count strictly higher afterward (a new session, not a stale read) and `isolation_state: verified` / `table_miss: drops` restored — the switch's own reconnect plus the bridge's existing session-start handler is sufficient in every case seen so far.
- **No leak in any of the 13 valid trials.** The registered frame shape (matched only by `p1-default-tap-only`) never crossed P2.

## What this does not show

- Whether the one allowed fallback (`sudo systemctl restart zodiac-bridge.service`) actually restores forwarding when the switch does not reconnect on its own — not reproduced on real hardware in 13 trials; verified only by the offline selftest.
- Whether a loss can ever take long enough on this hardware to need the fallback at all; the only measured recovery times (natural session loss, ~2 s; a full device reboot, <30 s per 2026-10-18) are both well under the bound.
- A rate between 12,500 and 25,000 pps, or a step other than 10 s; only the one registered plan was run.
- Behavior under repeated back-to-back losses within one window, or with a quarantine installed.

## Provenance

- Branch `feat/scenario4-tooling`, commits through `49393b4` (table-miss capture-cap fix not yet committed separately — see `.agents/audit-log.md` for the push history); `scripts/table_miss_lib.py` and `scripts/session_loss_lib.py` as committed alongside this README.
- Runs at 23:33–23:49 EST on 2026-11-03 (`try*`) and 00:01–00:08 EST on 2026-11-04 (`sl-fallback-diag-*`), labels as shown in `results.jsonl`.
- Owner approved the real-load run interactively ("Let's proceed with the real launch now"), the capture-cap fix and re-run, the additional natural trials ("Run it again, a few more trials"), and the fallback diagnostic approach (temporary in-memory threshold override via an uncommitted script, not an edit to the registered tooling) before each was run.
- The adversary preflight passed on every trial; status read `verified/drops` with 0 quarantines before every trial.
