# Owner review packet: what the owner's review of the policy covers (2026-10-31; signed off 2026-11-07)

The Track A sequence (`docs/ROADMAP.md`, section 4, step 7) calls for a **review of the policy and the property list by a network engineer, before results are published**. The reviewer is the owner, who also made the policy decisions, so this is the author's review and is not independent; published results say so and say that no outside review has happened. This packet says what the review is, where to look, and what questions were answered; it would serve an outside reviewer equally. **Signed off by the owner on 2026-11-07 (see Section 4 below).**

## What you are reviewing

1. **The deployed isolation policy**: does it enforce what a network engineer would mean by "isolate the untrusted workload on P1, with the uplink on P2 and a tap on P3"?
2. **The property list A1 to A11** and how it is checked: is anything missing that a reviewer would expect, and is anything claimed that is not shown?
3. **The experiment's claims**: that the verifier's model matches the switch on the flows tested, with the limits stated.

You are not asked to review the language-model results or the training work.

## 1. The policy

Deployed rules (six, plus the table-miss DROP), as the live readback reports them: `p1-ipv4-intra-segment`, `p1-arp-allow-10.0.2.50`, `p1-arp-allow-10.0.2.52`, `p1-default-tap-only`, `p2-ipv4-to-segment`, `p3-tap-return`. Read: `src/sdn/port1-isolation.ts` (the builder), the live status `GET /api/zodiac` (`port1Isolation`), and the ledger `.agents/network-context.md` (updated in PR #221 to reflect the A10 ARP change: ARP from P1 is allowed by exact sender address and there is no general P2 ARP rule when `ZODIAC_UPLINK_ARP_PEERS=none`).

Questions: Is forwarding intra-segment IPv4 to both P2 and P3 right? Is "everything else from P1 goes only to the tap" the right default, and what happens to IPv6 and other EtherTypes (they fall to that rule from P1 and to the table-miss from P2)? Is ARP allowed by sender address alone enough (no MAC binding)? Is an empty uplink ARP peer list acceptable for real use (chosen from an idle 24-hour capture; `docs/benchmarks/results/a10-uplink-arp-capture-2026-10-26/README.md`)?

## 2. The properties

`docs/ROADMAP.md` track A (A1 to A11, with decision records for A4 versus A9 and the A10 history) and `docs/research/track-a-ci-matrix.md` (where each is checked, enforced and tested, and what is not covered).

Questions: Is the list complete for a single-table OpenFlow 1.3 switch (loops are not a concern with one switch; what about L4 ports, VLAN tags, IPv6, rate limits)? Is the A4-over-A9 decision right (quarantine DROPs above every forwarding rule, at the measured higher cost)? A3: what should act when the table-miss is found missing or changed after an install (open, an owner decision)? A8: the capacity target of 6,000 pps at 572 B is derived in `docs/research/track-a-closeout-plan.md` (Phase 4) from `src/sdn/deployed-cost-model.ts` (80.0 µs + 5.42 µs per quarantine DROP, 8,106 pps at the full depth of 8, with session loss seen at 1.3 to 2.3 times capacity); is that the right way to set it, and is refusing every table the cost model does not cover acceptable? Is A6's unmeasured tie-breaking acceptable?

**A3, what acts on a post-install table-miss mismatch: decided 2026-10-31 by the owner, option 2 (damped auto-repair), implemented, off by default in code, and turned on for the live bridge 2026-11-02** (`docs/design/isolation-repair.md`). The options considered were: (1) report only; (2) damped auto-repair; (3) a redundant priority-1 backstop DROP; (4) go dark. Chosen: (2), narrowed to the smallest action (re-send the approved default DROP only), after 3 consecutive table-miss readings, never during an experiment, at most 3 repairs per hour then stop and ask a person, audited, and announced to the phone by the isolation watcher (`docs/design/isolation-watch.md`, through ntfy). To review: is re-sending only the default DROP the right scope? Is 3 readings (about 3 minutes) and 3 repairs per hour right? **Validated on the real switch 2026-11-02** against a forwarding, an absent and an unrecognised table-miss (each repaired at the third bad reading, `verified` again a minute later) and against a repair that does not take (the governor reported `exhausted` and stopped, as designed); that run also found two isolation-watcher gaps (no push when the repair budget ran out; a message claiming "repaired itself" for a repair that had not actually taken), both fixed and confirmed by a second run. See `docs/ROADMAP.md`, the 2026-11-02 section, and [`docs/benchmarks/results/isolation-watch-fault-2026-11-02/README.md`](../benchmarks/results/isolation-watch-fault-2026-11-02/README.md).

**A finding from the live bridge (2026-10-31, from its startup log):** A8 is *unverifiable for the live policy itself*. The deployed cost model recognises the older 7-rule isolation policy; the live table has 6 rules since the A10 change removed `p2-arp` (`ZODIAC_UPLINK_ARP_PEERS=none`), so the shape is not recognised, and with a throughput target declared the install gate would refuse every allow-route install (the startup check is advisory, so it only logs). The target in effect was 7,900 pps at 572 B, about 97% of the 8,106 pps modelled capacity at full quarantine depth, not the 6,000 pps derived above (about 74%); the owner's first attempt to set 6,000 did not apply (the `systemctl edit` was cancelled with an empty file). **Since corrected (2026-10-31 21:58 EDT):** the target is 6,000 pps in `/etc/zodiac/zodiac-bridge.env`, still advisory at startup and still unverifiable for the live policy, and the experiment endpoints are disabled (`ZODIAC_EXPERIMENT_ENDPOINTS=0`: the routes answer 404, including for the token that was pasted into a chat). **Since measured (2026-10-31, owner present):** the live table was re-measured on the bench and all three pre-registered predictions held (`docs/benchmarks/results/layout-capacity/README-live-policy-2026-10-31.md`); the shape check now accepts exactly the measured table and refuses the older 7-rule one as unverifiable. That code change is in the repository; it applies to the live bridge after the owner updates and restarts it.

## 3. The experiment and its claims

- Design and its amendments: `docs/research/evaluation-plan.md` sections 13 to 16 (16.10: A1 to A4).
- What was run and found: `docs/benchmarks/results/conformance/wire-run-2026-10-31/README.md` (128 rule sets, 611 flow checks, none disagreeing with the model or the intent; the repeats stable) and `docs/benchmarks/results/conformance/validation-2026-10-31/README.md` (two harness defects found and fixed; finding F1).
- The eight intents and their reference policies: `src/sdn/intents.ts`, `src/sdn/intents-hard.ts`, `src/sdn/intent-references-hard.ts`.

Questions: Does each intent say what a network engineer means by it? Are the claims in the results README (and the "does not show" list) fair to the evidence? F1, IPv4 frames with identical source and destination address are not forwarded although the model says so, looks like land-attack protection: is it expected for this switch and the lab-side switch, and where would you look for it? Is relaxing the uplink isolation by moving a node's NIC onto the uplink VLAN for the tests an acceptable method, and was it restored?

## Safety of how it was done

The experiment endpoint needs a LAN operator and a token, bounds the rules, re-checks A5, A6 and A7, installs the table-miss DROP, reads back, has a bridge time limit and a switch-side hard timeout, and the runner restores the isolation policy after every set and stops on any unverified restore (`src/sdn/experiment-install.ts`, `src/sdn/wire-session.ts`; backstop tests in `docs/benchmarks/results/conformance/safety-backstops/`). The unattended sessions ran under the owner's written grant; the token was pasted into a chat during the work. **Rotated 2026-11-05** on the jetson (`/etc/zodiac/zodiac-bridge.env`, `ZODIAC_EXPERIMENT_TOKEN`, 64 hex characters from `secrets.token_hex(32)`; the old value is backed up at `zodiac-bridge.env.bak-before-rotation-20261105T232849`, not in this repository); `ZODIAC_EXPERIMENT_ENDPOINTS` remains `0`, so neither value was ever live during the rotation, and no bridge restart was needed.

## What would count as a finding

Anything in 1 to 3 that a reviewer would not accept as stated: record it as an issue against the section, with the file and line, and say whether it blocks publishing the results.

## 4. Owner's review record (2026-11-07)

**Reviewer:** repository owner and policy author (not an independent reviewer; no outside review has happened).  
**Disposition:** Confirmed and signed off on 2026-11-07 with zero blocking findings; all stated limits remain disclosed in `docs/ROADMAP.md`, `README.md`, and `docs/research/track-a-ci-matrix.md`.

1. **Section 1 (The deployed isolation policy):** Confirmed.
   - Forwarding intra-segment IPv4 (`10.0.2.0/24 → 10.0.2.0/24`) from `P1` to `[P2, P3]` while sending all other `P1` frames (including IPv6 and non-IPv4 EtherTypes) to `[P3]` (tap only) and dropping unmatched `P2` ingress at the `prio 0` table-miss `DROP` is the intended isolation boundary.
   - `A10` ARP confinement on `P1 → P2` by exact sender IPv4 address (`arp_spa` in `DEFAULT_WORKLOAD_HOSTS`, without Ethernet MAC binding, which the switch's OpenFlow 1.3 match set does not expose) and `ZODIAC_UPLINK_ARP_PEERS=none` on `P2 → P1` (derived from the 24-hour idle capture, requiring any uplink-side `10.0.2.x` experiment host to be explicitly listed while running) are accepted with those limits stated.
2. **Section 2 (The properties `A1`–`A11`):** Confirmed.
   - The `A1`–`A11` property list and labels (*enforced before install*, *checked at readback only*, *decided not needed*) in `docs/research/track-a-ci-matrix.md` are accepted for this single-table OpenFlow 1.3 switch, with unmodelled fields (VLAN tags, IPv6, L4 ports outside `A11` clauses, and unmeasured firmware tie-breaking on non-identical equal-priority overlaps in `A6`) explicitly documented as limits.
   - **`A4` over `A9`:** Confirmed that quarantine `DROP`s sit at `prio 65535` above all forwarding rules, accepting the measured deployed-table cost (`80.0 µs + 5.42 µs × k`).
   - **`A3` post-install auto-repair:** Confirmed the live configuration (`ZODIAC_ISOLATION_REPAIR=1`, re-sending only the approved `prio 0` default `DROP` after 3 consecutive bad readings ~3 min, 600 s cooldown, max 3 repairs/hour before stopping and paging via `ntfy`, validated on hardware 2026-11-02).
   - **`A8` capacity target (`6,000 pps` at `572 B`):** Confirmed as a ceiling guard (`74%` of full `k=8` quarantine capacity `8,106 pps`, below the `1.3x–2.3x` session-loss cliff), and confirmed that refusing allow-route installs outside the measured 6-rule deployed shape and 8-rule allow floor (`7,765 pps`) is the intended fail-closed behavior.
3. **Section 3 (The experiment and its claims):** Confirmed.
   - The eight intents (`INTENT-1..8`) and the on-wire conformance report (`611/611` flow checks across 128 rule sets agreeing with the model and intent, 20 sets repeated identically across 3 sessions, with finding `F1`—switch IC dropping self-addressed `src === dst` IPv4 frames—recorded as hardware land-attack filtering) fairly represent the evidence and its boundaries.
   - The temporary isolated uplink VLAN arrangement on `zodiac_netgear_2` (moving `agentic-node-01` `eth1` onto VLAN 2 with Zodiac `P2` for the uplink-ingress reference flows, then restoring the 3-VLAN split) is accepted.
