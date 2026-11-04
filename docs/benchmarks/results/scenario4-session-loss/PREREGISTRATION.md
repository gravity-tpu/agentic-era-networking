# Scenario 4, reframed: recovery after the control-plane session is lost (pre-registration, DRAFT)

## Safety framing (read this section first)

This experiment measures how **the project's own switch, on the project's own owned lab bench, recovers from an overload condition the project has already measured and expects.** It is a defensive resilience test, not an attack: the goal is to time the bridge's own recovery path, which already exists and already runs in production on this bridge (`OpenFlowServer`'s `'ready'` handler re-sends the table-miss DROP and the isolation policy every time a session (re)starts, including after the planned restarts used elsewhere in this project, such as `scripts/controller-away-run.py`'s detached timer).

**Correction made before this draft was shown to the owner:** an earlier version of this section claimed `scripts/table-miss-load.py`, at its existing 8,000 pps cap, would be sufficient to reproduce the session loss the whitepaper describes. That is wrong, and is not repeated as a plan below. That script sends *unmatched* (table-miss) traffic, and the 2026-11-02 results already on record (`table-miss-extended-2026-11-02`) show the DROP state held the full 8,000 pps with **no** session loss. The whitepaper's 1.3 to 2.3x-capacity loss threshold ([section 5.3](../../zodiac-infrastructure-bandwidth-whitepaper-2026-10-04.md)) was measured against *forwarded* traffic on the deployed table, with the data-plane bench / layout-capacity tooling (`scripts/zodiac-dataplane-bench.ts`, `scripts/layout-capacity-run.py`), not the table-miss load generator — roughly 10,500 to 28,700 pps on the measured deployed-table capacities, not 8,000. No tool in this repository today is already proven both (a) bounded in the way `table-miss-load.py` is and (b) capable of reliably reaching that threshold. **Building that bounded tool, with the same stopping-rule discipline as every other experiment in this series, is therefore part of what this pre-registration proposes, not something it can claim already exists.** This is stated here so the owner is approving the real shape of the work, not an overstated safety claim.

**This document does not become the registration, and no load is sent, until all of the following hold:**

1. It is approved by the owner, point by point, as the other pre-registrations in this series were (scenario 5, the tag-quarantine follow-up).
2. The owner is present for the run, in real time, able to intervene by hand at any moment (not reachable only through the tooling below).
3. A verified, tested, already-working recovery path exists and is confirmed in place **before** any load is sent (below).
4. The run is bounded on paper before it starts: a maximum offered rate, a maximum duration, and a hard stop that does not depend on the switch being reachable.

**Bounds, fixed in advance and not to be exceeded without a new approval:**

- Offered load: a single forwarded-traffic rate at a **named small multiple of the measured deployed-table capacity** (the whitepaper's own 1.3 to 2.3x range — the low end, not the high end, is the starting point: approval 1 below asks the owner to fix the exact multiple before anything is built). It is not an open-ended "flood"; it is one pre-computed pps number, derived from numbers already measured and in this repository, capped so that the plan is rejected before anything is sent if the number exceeds a ceiling the owner sets.
- Duration: one load step. The same `step_seconds` bound already enforced in `table_miss_lib.py` (`MIN_STEP_SECONDS`/`MAX_STEP_SECONDS`, 5 to 10 s) is reused for whatever new sender is built, and the plan-validation pattern of that module (reject the whole plan before any frame is sent if it is out of bounds) is reused rather than re-invented.
- Recovery backstop: the pre-armed detached systemd timer pattern already used in `scripts/controller-away-run.py` (`OWNER_COMMAND`), which restarts the bridge on a timer that runs independently of whether the switch or the bridge host can be reached while the load is live. If the load causes the bridge host itself to become unreachable, the timer still fires.
- Abort: `scripts/controller-away-run.py`'s `OWNER_ABORT_COMMAND` (cancel the timer, start the bridge now), run from a path that does not depend on the condition under test.
- No new quarantine, no new allow rule, no change to the isolation policy. What this experiment adds beyond existing tooling is one new, narrowly-scoped sender (built with tests first, like every other script in this series) that offers forwarded traffic at the one pre-computed rate for one bounded step, plus reuse of the already-existing status poll and recovery/abort paths.

## What it closes

The ROADMAP re-scope's scenario 4, reframed: not "what can an attacker do" in the open-ended sense of the original wording, but the narrow, already-implied question the whitepaper and the 2026-11-01/02 results leave open — **given that overload drops the session and the switch clears its table (already measured: [`controller-outage-2026-11-01`](../controller-outage-2026-11-01/README.md), [`controller-away-readback`](../controller-away-readback/README.md)), how long is the gap, start to finish, when the loss is caused by load rather than by the bridge process being stopped on purpose, and does the existing recovery path close it without a person acting?**

This is a timing measurement of an already-built recovery mechanism, not new offensive tooling, and not a search for a bigger or different way to cause loss than the ones already on record.

## What is measured

1. **Time to loss**: wall-clock from the start of the bounded load step to the first poll that shows the OpenFlow session is no longer `Connected`.
2. **Time to recovery**: wall-clock from the detected loss to the first poll that shows `Connected` **and** `verified/drops` (the isolation policy re-sent and confirmed), through the bridge's own `'ready'` handler — no manual re-push.
3. **Whether anything crossed P2 during the gap**: reusing the same O3/O2 observer-validity rules as every other experiment in this series (`scripts/table_miss_lib.py`); a frame here would be a new finding, not an expected one.
4. **What the isolation watcher reports and when** (it already exists and already alerts on an unreachable bridge; this is observation of an existing system, not new alerting logic).

## Verdict rules, fixed in advance

- `observer_invalid`: as in every prior experiment in this series.
- `recovered`: the poll shows `Connected`/`verified/drops` within the existing systemd timer's fire time plus a short margin for re-sync; the whitepaper measured 0.1 to 0.8 s for up to 24 rules under load, which is a different rule count and a different cause of loss than this experiment, so it is cited as a rough prior, not a bound this run is held to.
- `not_recovered`: the timer fires and the bridge does not come back verified within a bounded wait; the owner restores it by hand immediately, and this is reported as the headline finding, not retried.
- `leak`: any frame crosses P2 during the gap. Stops everything; reported at once.

**Prediction, written before any run:** `recovered`, based on the fact that this exact restart-and-reinstall path already runs in `scripts/controller-away-run.py` and has already been observed to re-verify the policy in the 2026-11-01 and controller-away-readback results, and based on the 2026-10-18 serial-restart observation that a software-level reset already clears whatever wedges the control-plane connection on this hardware. High confidence, because every component being exercised has already been exercised separately; the only new thing is causing the loss by offered load within the already-measured 1.3 to 2.3x range instead of by stopping the bridge process directly.

## Approvals needed from the owner before this is registered

1. **The exact offered rate and its ceiling.** A specific multiple of the measured deployed-table capacity (not "1.3 to 2.3x" as a range to explore — one number), and a hard ceiling the new sender refuses to exceed regardless of what is asked of it. Until the owner names this number, no sender is built.
2. **Building one new, narrowly-scoped sender** for this one rate and one step, with tests first (pinned bytes, a plan-validation function that rejects an out-of-bounds plan before any ssh, reusing `table_miss_lib.py`'s plan-validation and abort-polling pattern rather than writing new abort logic).
3. The owner's real-time presence for the entire run, with the abort command ready in a separate terminal before the load starts, and verified reachable at that moment (not assumed).
4. Confirming the systemd-timer recovery backstop is armed and tested (a dry run of arm-then-abort, with no load, before the real run) exactly as `scripts/controller-away-run.py` already requires for its own runs.
5. Prerequisites at run time: a current Tailscale SSH approval for the Jetson, and node-02's `wlan0` state as the owner prefers for this run (it does not need to be down for this experiment, since no workload-segment traffic is sent from node-02).

This is the only item in the current scope that proposes new load-generation tooling rather than reusing an existing one unchanged, because no existing tool in this repository already reaches the measured loss threshold within an already-reviewed bound. That is stated plainly so the owner is approving the actual shape of the work.
