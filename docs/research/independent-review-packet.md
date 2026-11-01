# Independent review packet: what the network-engineer review covers (2026-10-31)

The Track A sequence (`docs/ROADMAP.md`, section 4, step 7) calls for an **independent review of the policy and the property list by a network engineer, before results are published**. This packet says what that review is, where to look, and what questions would be most useful to answer. The reviewer is the owner. Nothing here has been signed off.

## What you are reviewing

1. **The deployed isolation policy**: does it enforce what a network engineer would mean by "isolate the untrusted workload on P1, with the uplink on P2 and a tap on P3"?
2. **The property list A1 to A11** and how it is checked: is anything missing that a reviewer would expect, and is anything claimed that is not shown?
3. **The experiment's claims**: that the verifier's model matches the switch on the flows tested, with the limits stated.

You are not asked to review the language-model results or the training work.

## 1. The policy

Deployed rules (six, plus the table-miss DROP), as the live readback reports them: `p1-ipv4-intra-segment`, `p1-arp-allow-10.0.2.50`, `p1-arp-allow-10.0.2.52`, `p1-default-tap-only`, `p2-ipv4-to-segment`, `p3-tap-return`. Read: `src/sdn/port1-isolation.ts` (the builder), the live status `GET /api/zodiac` (`port1Isolation`), and the ledger `.agents/network-context.md` (its policy block predates the A10 ARP change: ARP from P1 is now allowed by sender address and there is no P2 ARP rule, because `ZODIAC_UPLINK_ARP_PEERS=none`).

Questions: Is forwarding intra-segment IPv4 to both P2 and P3 right? Is "everything else from P1 goes only to the tap" the right default, and what happens to IPv6 and other EtherTypes (they fall to that rule from P1 and to the table-miss from P2)? Is ARP allowed by sender address alone enough (no MAC binding)? Is an empty uplink ARP peer list acceptable for real use (chosen from an idle 24-hour capture; `docs/benchmarks/results/a10-uplink-arp-capture-2026-10-26/README.md`)?

## 2. The properties

`docs/ROADMAP.md` track A (A1 to A11, with decision records for A4 versus A9 and the A10 history) and `docs/research/track-a-ci-matrix.md` (where each is checked, enforced and tested, and what is not covered).

Questions: Is the list complete for a single-table OpenFlow 1.3 switch (loops are not a concern with one switch; what about L4 ports, VLAN tags, IPv6, rate limits)? Is the A4-over-A9 decision right (quarantine DROPs above every forwarding rule, at the measured higher cost)? A3: what should act when the table-miss is found missing or changed after an install (open, an owner decision)? A8: the capacity target of 6,000 pps at 572 B is derived in `docs/research/track-a-closeout-plan.md` (Phase 4) from `src/sdn/deployed-cost-model.ts` (80.0 µs + 5.42 µs per quarantine DROP, 8,106 pps at the full depth of 8, with session loss seen at 1.3 to 2.3 times capacity); is that the right way to set it, and is refusing every table the cost model does not cover acceptable? Is A6's unmeasured tie-breaking acceptable?

**A3, what acts on a post-install table-miss mismatch: decided 2026-10-31 by the owner, option 2 (damped auto-repair), implemented and off by default** (`docs/design/isolation-repair.md`). The options considered were: (1) report only; (2) damped auto-repair; (3) a redundant priority-1 backstop DROP; (4) go dark. Chosen: (2), narrowed to the smallest action (re-send the approved default DROP only), after 3 consecutive table-miss readings, never during an experiment, at most 3 repairs per hour then stop and ask a person, audited, and announced to the phone by the isolation watcher (`docs/design/isolation-watch.md`, through ntfy). To review: is re-sending only the default DROP the right scope? Is 3 readings (about 3 minutes) and 3 repairs per hour right? Not yet validated on the switch (a supervised session that breaks the table-miss on purpose is owed).

**A finding from the live bridge (2026-10-31, from its startup log):** A8 is *unverifiable for the live policy itself*. The deployed cost model recognises the older 7-rule isolation policy; the live table has 6 rules since the A10 change removed `p2-arp` (`ZODIAC_UPLINK_ARP_PEERS=none`), so the shape is not recognised, and with a throughput target declared the install gate would refuse every allow-route install (the startup check is advisory, so it only logs). The target in effect was 7,900 pps at 572 B, about 97% of the 8,106 pps modelled capacity at full quarantine depth, not the 6,000 pps derived above (about 74%); the owner's first attempt to set 6,000 did not apply (the `systemctl edit` was cancelled with an empty file). **Since corrected (2026-10-31 21:58 EDT):** the target is 6,000 pps in `/etc/zodiac/zodiac-bridge.env`, still advisory at startup and still unverifiable for the live policy, and the experiment endpoints are disabled (`ZODIAC_EXPERIMENT_ENDPOINTS=0`: the routes answer 404, including for the token that was pasted into a chat). To fix: update the model's recognised shape to the current policy and re-measure it on the bench (the ladder drives the switch toward session loss, so the owner should be present).

## 3. The experiment and its claims

- Design and its amendments: `docs/research/evaluation-plan.md` sections 13 to 16 (16.10: A1 to A4).
- What was run and found: `docs/benchmarks/results/conformance/wire-run-2026-10-31/README.md` (128 rule sets, 611 flow checks, none disagreeing with the model or the intent; the repeats stable) and `docs/benchmarks/results/conformance/validation-2026-10-31/README.md` (two harness defects found and fixed; finding F1).
- The eight intents and their reference policies: `src/sdn/intents.ts`, `src/sdn/intents-hard.ts`, `src/sdn/intent-references-hard.ts`.

Questions: Does each intent say what a network engineer means by it? Are the claims in the results README (and the "does not show" list) fair to the evidence? F1, IPv4 frames with identical source and destination address are not forwarded although the model says so, looks like land-attack protection: is it expected for this switch and the lab-side switch, and where would you look for it? Is relaxing the uplink isolation by moving a node's NIC onto the uplink VLAN for the tests an acceptable method, and was it restored?

## Safety of how it was done

The experiment endpoint needs a LAN operator and a token, bounds the rules, re-checks A5, A6 and A7, installs the table-miss DROP, reads back, has a bridge time limit and a switch-side hard timeout, and the runner restores the isolation policy after every set and stops on any unverified restore (`src/sdn/experiment-install.ts`, `src/sdn/wire-session.ts`; backstop tests in `docs/benchmarks/results/conformance/safety-backstops/`). The unattended sessions ran under the owner's written grant; the token was pasted into a chat during the work and should be rotated.

## What would count as a finding

Anything in 1 to 3 that a reviewer would not accept as stated: record it as an issue against the section, with the file and line, and say whether it blocks publishing the results.
