# Track C scenario 1 (ARP spoofing across P1 and P2): pre-registration

Written 2026-10-22, before any attack traffic is sent. Committed before the run. Results (when they exist) go in `README.md` next to this
file; this file is not edited afterwards except to add a line saying what changed and why, the same convention as
`docs/benchmarks/results/layout-capacity/PREREGISTRATION.md`.

## The claim under test

Roadmap, Track C, scenario 1: "ARP spoofing across P1 and P2 (claim the gateway's address toward the lab LAN)." Property A10 (ARP
confinement: "no ARP forwarded across P1 and P2 unless explicitly allowed") is listed as **blocked on verifying `ARP_SPA`/`ARP_TPA` support
in firmware 0.86**. Reading the deployed policy (`src/sdn/port1-isolation.ts`): the `p1-arp` rule matches `inPort: 1, etherType: ARP` with
**no source or target address field at all** — the match model has nothing to constrain on, because `FlowModMatchOptions` carries no ARP SPA/
TPA fields. So the model already predicts this rule forwards every ARP frame from the workload segment to the uplink, regardless of what
address it claims. This scenario checks that prediction against the real switch and asks what it means for a real host's ARP cache.

## Scope decision (owner, 2026-10-22)

The roadmap's literal wording — "claim the gateway's address" — would mean the real household router. **Scoped instead to a host we own**:
the target identity is the Mac's workload-segment alias, `10.0.2.119` (the same address used in the 2026-10-09 uplink-aliasing finding,
Track C scenario 6). No third-party household device's traffic is touched. This is a deliberate narrowing of the roadmap text, recorded here
so it isn't read back later as having tested the literal scenario.

## Method (fixed in advance)

- **Adversary (sender):** `agentic-node-02` (10.0.2.52), the node now carrying the Track C role assignment and its own `eth1` control
  channel. Its traffic is bound to `eth0` via `scripts/adversary-bind.py`'s `preflight()`, which must report `ok: true` before anything is
  sent — a refusal (for example `eth1`'s leak risk being unresolved, or `wlan0` reassociating) stops the run before any packet goes out.
- **Baseline/reference:** `agentic-node-01` (10.0.2.50) is not involved in this scenario; it is not a party to the ARP exchange under test.
  (It is the designated baseline host for scenarios that need one acting concurrently; scenario 1 does not.)
- **Claimed identity:** `10.0.2.119` (the Mac's workload-segment alias). The adversary node sends a **small, fixed number (3) of unsolicited
  ARP replies** — "who has 10.0.2.119, tell everyone" with the adversary's own source MAC — not a sustained stream. Flooding the segment is
  scenario 4's concern, not this one's.
- **Observation, three independent sources:**
  1. **O3** (`enx9c69d39ddcc0` on the Jetson, mirror of the Zodiac P2 link): ground truth for "the switch actually sent the frame out P2."
     This is the primary measurement — it answers whether `p1-arp` forwards the spoofed frame, independent of whether anything on the P2
     side acts on it.
  2. **The Mac's own ARP cache** (`arp -n 10.0.2.119`), read immediately before and immediately after the three replies are sent. This is
     the test of consequence, not just transit: did a real host's cache actually get poisoned.
  3. **O2** (`enx9c69d39dd0a6`, the Zodiac P3 tap) as a secondary check that the frame was also mirrored there, consistent with `p1-arp`'s
     declared output set `[P2, P3]`.
- **Corrective step, always run, success or failure:** immediately after observation, the Mac sends its own real gratuitous ARP for
  `10.0.2.119` (`arping -U` or equivalent) so no host is left with a stale mapping once the test ends. The run is not considered finished
  until this step has run and the Mac's own cache has been re-read to confirm the correction took.
- **Safety bound on the adversary node:** `preflight(iface='eth0')` must pass before the first packet; if it does not, the scenario does not
  run, the same fail-closed rule used everywhere else in this repo (Invariant 3).

## Predictions

1. **O3 shows the spoofed ARP reaching P2.** Based on the model (`p1-arp` has no address constraint), this is expected to hold. If it does
   **not** hold, that is itself a finding: either the firmware does filter on ARP SPA/TPA despite the model not representing that (resolving
   part of the A10 blocker in the opposite direction expected), or something else intercepts it first.
2. **The Mac's ARP cache changes to the adversary's MAC for `10.0.2.119` after the replies**, consistent with (1). A3 (table-miss is the only
   fail-closed default) and A10 being unimplemented together predict this is not prevented anywhere in the current policy.
3. **No detector reaction is predicted either way** — the GPU autoencoder detector's precision/recall against ARP-based attacks is explicitly
   unmeasured per the roadmap ("Their precision and recall are unmeasured today and become a result of this track"). Any reaction (a
   proposal, a quarantine) is recorded as a secondary finding, not a predicted outcome.

## What would count against the predictions

- O3 showing nothing despite the ARP being sent from the adversary node (confirmed by O2 or a local capture on the adversary's `eth0`) would
  mean the model is wrong about `p1-arp`'s reach, and A10 would need to be re-read in the opposite direction: the firmware may enforce
  something the match model cannot express.
- The Mac's cache not changing despite O3 confirming delivery would mean the host's own ARP stack rejected or ignored the unsolicited reply
  (some OS ARP implementations distinguish gratuitous announcements from replies to nothing outstanding) — itself a useful, recordable
  finding about what actually stops this class of attack today, separate from anything the switch does.

## Amendment (found while building the runner, before any run)

`arp -n 10.0.2.119` on the Mac shows a **`permanent`** entry (`f2:5b:dc:7d:21:d4` on `en0`), not a dynamically learned one. BSD-derived
network stacks (macOS included) commonly install a static ARP mapping for a host's own configured addresses and protect it from being
overwritten by incoming ARP traffic, independent of anything the switch does. The measurement is unchanged (still: does this entry change
after the spoofed replies), but prediction 2 may not hold for a **host-side** reason even if O3 confirms the frame reached P2 — that would
not be a finding about the switch's policy, and the report must say which of the two it was, not conflate them.

## Limits stated now

One switch, firmware 0.86. One claimed identity, one host's ARP stack (macOS); the result says nothing about how a different OS's ARP
implementation would react to the same frames. Not a flood, not sustained — this tells us whether a single spoofed exchange crosses and
sticks, not how a detector handles a sustained campaign (a separate, later question). The adversary's own traffic-binding safety net
(`adversary-bind.py`) has itself only been checked by reading interface state, not by watching a live packet actually fail to escape when
deliberately misdirected — that residual gap is noted, not closed, by this scenario.
