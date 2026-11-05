# Scenario 4, reframed: recovery after the control-plane session is lost (pre-registration)

## Safety framing (read this section first)

This experiment measures how **the project's own switch, on the project's own owned lab bench, recovers from an overload condition the project has already measured and expects.** It is a defensive resilience test, not an attack: the goal is to time a recovery that already happens by itself on this bridge today — the switch is expected to reconnect its OpenFlow session on its own, and the bridge's already-existing `'ready'` handler (which runs for every session, including the deliberate restarts already exercised by `scripts/controller-away-run.py`) then re-sends the table-miss DROP and the isolation policy without anyone acting. Nothing about that handler is new or changed by this experiment.

**Correction 1 (made before this draft was shown to the owner):** an earlier version of this section claimed `scripts/table-miss-load.py`, at its existing 8,000 pps cap, would be sufficient to reproduce the session loss the whitepaper describes. That is wrong. That script sends *unmatched* (table-miss) traffic, and the 2026-11-02 results already on record (`table-miss-extended-2026-11-02`) show the DROP state held the full 8,000 pps with **no** session loss. The whitepaper's capacity-multiple loss threshold ([section 5.3](../../zodiac-infrastructure-bandwidth-whitepaper-2026-10-04.md)) was measured against *forwarded* traffic, with the data-plane bench / layout-capacity tooling, not the table-miss load generator. **Building a new, narrowly-scoped forwarded-traffic sender, with the same stopping-rule discipline as every other experiment in this series, is therefore part of what this pre-registration proposes**, not something already built.

**Correction 2 (made before this draft was shown to the owner):** an earlier version of the recovery-backstop bullet below reused `scripts/controller-away-run.py`'s detached-timer pattern (`OWNER_COMMAND`). That pattern restarts the bridge *process* after it is deliberately stopped, and exists because the bridge being off is the exact condition it recovers from. It does not fit here: this experiment never stops the bridge process; it offers load toward the switch's data plane, and the switch (not the bridge) is expected to drop and re-establish its own OpenFlow session while the bridge keeps running and keeps listening throughout. A pre-armed timer that fires "independently of reachability" is solving a problem this experiment does not have, and importing it implied the Jetson host itself might become unreachable, which nothing in this plan does: only the switch-facing data path is loaded, never the Jetson's own management interface. The actual recovery design is in the bounds below.

**Owner's decision (2026-11-04): the offered rate is 2x the measured deployed-table capacity at k = 0 quarantines, and the sender's hard ceiling is that same number — not a range, and not a higher ceiling with a lower starting point.** `deployedCapacityPps(572n, 0n)` in `src/sdn/deployed-cost-model.ts` gives exactly **12,500 pps** (`t_packet = 80.0 µs`, 572 B payload, the live six-rule policy, no quarantines — the shape the model's own domain note says was measured on the tap-only path). 2x that is **25,000 pps**. The sender refuses to construct or send a plan above 25,000 pps, under any argument.

**This document does not become the registration, and no load is sent, until all of the following hold:**

1. It is approved by the owner, point by point, as the other pre-registrations in this series were (scenario 5, the tag-quarantine follow-up).
2. The owner is present for the run, in real time, able to intervene by hand at any moment.
3. A verified, tested recovery path is confirmed in place **before** any load is sent (below).
4. The run is bounded on paper before it starts: one fixed offered rate, a maximum duration, and a stop that does not require the switch to be reachable to take effect.

**Bounds, fixed in advance and not to be exceeded without a new approval:**

- **Offered load: exactly 25,000 pps, 572 B payload, matched by `p1-default-tap-only` (the tap-only path, not table-miss), for one bounded step.** The sender's plan validation rejects any construction that would exceed 25,000 pps before any ssh and before any socket is opened, under any argument — it is not a configurable "up to" value.
- Duration: one load step. The same `step_seconds` bound already enforced in `table_miss_lib.py` (`MIN_STEP_SECONDS`/`MAX_STEP_SECONDS`, 5 to 10 s) is reused for the new sender, and the same plan-validation pattern (reject the whole plan before any frame is sent if anything is out of bounds) is reused rather than re-invented.
- **Recovery path (see Correction 2): a bounded wait for the switch to reconnect on its own**, watched through the status poll already used throughout this series (`scripts/table_miss_lib.py`'s `POLL_COMMAND`/`parse_poll`, reused unchanged — it already reports the OpenFlow session state, the isolation readback, and a count of the bridge's own reinstall lines since the bridge process last started). If the switch has not reconnected and re-verified within that bound, the one allowed fallback is a single `sudo systemctl restart zodiac-bridge` run locally on the Jetson (an ordinary, already-reachable local command, not a pre-armed timer) before the owner intervenes by hand. That fallback firing is itself a measured, reported outcome (`not_recovered` below), not something retried quietly.
- Abort: stopping the load sender at once (a stop-file polled during the send, the same pattern `table-miss-load.py` already uses) ends the cause of loss without touching the bridge or the switch.
- No new quarantine, no new allow rule, no change to the isolation policy. What this experiment adds beyond existing tooling is one new, narrowly-scoped sender (built with tests first, like every other script in this series) that offers forwarded traffic at exactly 25,000 pps for one bounded step, reusing the existing raw-socket pacer (`table_miss_lib.LOAD_SENDER_SRC`), the existing status poll, and the existing stop-file abort pattern.

## What it closes

The ROADMAP re-scope's scenario 4, reframed: not "what can an attacker do" in the open-ended sense of the original wording, but the narrow, already-implied question the whitepaper and the 2026-11-01/02 results leave open — **given that overload drops the session and the switch clears its table (already measured: [`controller-outage-2026-11-01`](../controller-outage-2026-11-01/README.md), [`controller-away-readback`](../controller-away-readback/README.md)), how long is the gap when the loss is caused by offered load rather than by the bridge process being stopped on purpose, and does the switch's own reconnect, followed by the bridge's existing reinstall handler, close it without a person acting?**

This is a timing measurement of an already-existing recovery behaviour, not new offensive tooling, and not a search for a bigger or different way to cause loss than the ones already on record.

## What is measured

1. **Time to loss**: wall-clock from the start of the load step to the first poll that shows the OpenFlow session is no longer `Connected`.
2. **Time to recovery**: wall-clock from the detected loss to the first poll that shows `Connected` **and** `verified/drops`, with the bridge's reinstall-line count having increased since the step started (confirming a genuine new session, not a stale read) — all through the existing `'ready'` handler, no manual re-push and (unless the fallback fires) no bridge restart.
3. **Whether anything crosses P2 during the gap**: reusing the same O3/O2 observer-validity rules as every other experiment in this series (`scripts/table_miss_lib.py`); a frame here would be a new finding, not an expected one.
4. **Whether the local-restart fallback was needed**, and if so, how long it added.
5. **What the isolation watcher reports and when** (it already exists and already alerts on an unreachable bridge; this is observation of an existing system, not new alerting logic).

## Verdict rules, fixed in advance

- `observer_invalid`: as in every prior experiment in this series; the run is void.
- `recovered`: the switch reconnects and the bridge re-verifies on its own, within the bounded wait, with no local restart needed.
- `recovered_with_fallback`: the bounded wait elapsed with no reconnect, the local `systemctl restart zodiac-bridge` fallback ran, and the bridge came back verified afterward. Reported as a distinct outcome from `recovered`, not folded into it.
- `not_recovered`: even the fallback does not bring the bridge back to `verified`/`drops` within a further bounded wait; the owner restores it by hand at once, and this is the headline finding, not retried automatically.
- `leak`: any frame crosses P2 during the gap. Stops everything; reported at once.

**Prediction, written before any run:** `recovered` (no fallback needed), based on the fact that the switch's own OpenFlow reconnect and the bridge's reinstall-on-`'ready'` handler are both already exercised separately elsewhere in this project (the 2026-11-01 and controller-away-readback results show the latter; the whitepaper's own session-loss-and-recovery numbers, 0.1 to 0.8 s re-sync for up to 24 rules under a different load and rule count, are cited as a rough prior for the order of magnitude, not a bound this run is held to). Moderate-high confidence, not high: unlike the earlier pre-registrations in this series, this is the first time this project has deliberately driven forwarded traffic to 2x the deployed table's measured capacity, so the switch-side reconnect behaviour at this specific offered rate is itself untested, not merely reused.

## Approvals needed from the owner before this is registered

1. ~~The exact offered rate and its ceiling.~~ **Answered 2026-11-04: 2x capacity, 25,000 pps, same number is the ceiling.**
2. ~~Building the new, narrowly-scoped sender~~ **Done: `scripts/session-loss.py` / `scripts/session_loss_lib.py` (PR #218), tests first (`test/invariants/session-loss.test.ts`, 22 tests: pinned frame bytes, `validate_plan` rejecting anything but exactly 25,000 pps before any ssh, the judge's verdict rules, and the choreography against a scripted ssh), reusing `table_miss_lib.py`'s plan-validation and stop-file abort pattern.**
3. ~~The owner's real-time presence for the entire run~~ **Done: every real run (`--owner-go-for-real-load`) was started only after explicit, interactive owner confirmation for that specific run, per Invariant 4.**
4. ~~A dry run of the choreography with no load first~~ **Done 2026-11-03/04: `--dry-run` exercised the status gate and capture plumbing against real hardware before any real load, and `session_loss_lib.selftest()` exercises the local-restart fallback path in isolation (scripted, no real loss caused) as part of the test suite.**
5. ~~Sender: `agentic-node-02` `eth1`~~ **Done as specified: the adversary bind-guard preflight, the exact frame construction (`workload_frames_lib.plain`/`ipv4_packet`, 572 B, no IP options or fragment flags, matched only by `p1-default-tap-only`), and `wlan0` down were all confirmed on every run.**
6. ~~Prerequisites at run time: a current Tailscale SSH approval~~ **Done: confirmed live before each run.**

This was the only item in the current scope that proposed new load-generation tooling rather than reusing an existing one unchanged, because no existing tool in this repository was already both bounded in the right way and capable of reaching the measured loss threshold. That was stated plainly so the owner approved the actual shape of the work, not an overstated safety claim.

**Registered and run, 2026-11-03/04.** Results: [`docs/benchmarks/results/scenario4-session-loss/README.md`](README.md). Headline: 5 valid real-load trials at the registered plan, 2 induced a real OpenFlow session loss, both recovered unaided within seconds (at most 4-6 s by poll resolution, well inside the 30 s reconnect-wait bound), 0 leaks. The prediction above (`recovered`, no fallback needed) held in both observed losses. The one allowed fallback (`systemctl restart` on the bridge) was not observed to fire on real hardware in any of the 13 trials run (5 at the registered plan plus 8 at a diagnostically-shortened wait threshold, `scripts/diagnostics/session-loss-fallback-diag.py`) — it remains verified only by the tooling's own offline selftest; this is recorded as a tracked open item in the results README, not resolved here.
