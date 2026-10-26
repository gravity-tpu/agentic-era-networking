# A10, uplink to workload ARP confinement (opt-in, built 2026-10-26, not deployed)

## What exists

The deployed policy forwards every ARP frame arriving on the uplink (P2) to the workload (P1) through one rule, `p2-arp`.
Confining the workload to uplink direction (2026-10-25) left this half open: an uplink-side host can still inject any ARP
claim into the workload segment.

This change adds an opt-in confined variant. Nothing changes unless it is switched on.

- `buildPort1IsolationPolicy(subnet, prefixLen, workloadHosts, uplinkArpPeers?)`: with a peer list, `p2-arp` is replaced by one
  rule per peer (`p2-arp-allow-<ip>`: in_port 2, ARP, `arp_spa` = that exact address, output P1). Other uplink ARP matches no
  rule and falls to the table-miss DROP. A peer outside the subnet, equal to a workload host address, or listed twice is refused
  at build time. With the argument omitted the output is identical to before (a test compares them).
- `verifyPort1Isolation(..., { requireConfinedUplinkArp: true })`: an uplink to workload ARP rule must claim one exact /32.
  The default is unchanged, so the verifier does not call the deployed policy confined.
- `port1IsolationUplinkArpIntent(peers)` in `src/sdn/intents.ts`: a new intent (`port1-isolation-uplink-arp/v1`), because the
  four evaluated intents are frozen with their plan. The original intent rejects the confined policy and the new intent rejects
  the unconfined one, so the pairing is not interchangeable (tests).
- `ZODIAC_UPLINK_ARP_PEERS` read by `zodiac-bridge-server.ts`: unset or blank is off, `none` is confined with no peers, otherwise a
  comma-separated list. A malformed value stops the bridge at startup. When set, the startup install gate and the allow-rule gate
  use the matching intent and the strict verifier.

## Measured offline

Single-point mutants of the confined policy, judged by the new intent (`computeBaselinesFor`, peers `10.0.2.1` and `10.0.2.119`):
38 of 52 rejected. The original policy under its own intent: 33 of 46. Every survivor is a kind the original also has: raising a
rule's priority with no semantic effect, or removing a tap output or the tap return that the intent permits. Dropping a peer rule
is rejected. This says the checks can fail; it does not say the policy is correct on the wire.

## Not done, and why

- **No peer list is chosen.** Which uplink hosts legitimately ARP the workload has not been measured. The O3 capture NIC on the
  Jetson mirrors the Zodiac P2 link in both directions, so a capture there shows it. The Jetson was not reachable from the
  unattended session on 2026-10-26: Tailscale SSH asked for an additional browser check and the `jetson` alias uses a hardware
  key that needs a touch. Both are identity checks for the owner and were not worked around.
- **Not deployed, not measured on the switch.** Firmware 0.86 enforcing `arp_spa` on the P1 side (A10 feasibility) does not show
  it does so for frames arriving on P2; that needs the hardware run below.

## Runbook (needs an authenticated Jetson session)

1. Measure the peers, read-only, for at least a day that includes normal use:
   `sudo tcpdump -nei enx9c69d39ddcc0 -w /tmp/p2-arp.pcap arp`, then list the distinct ARP sender addresses on frames whose target is
   a workload address (`10.0.2.50`, `.51`, `.52`), separating requests from replies. Keep only hosts that must reach the workload.
2. Set `ZODIAC_UPLINK_ARP_PEERS=<list>` in the bridge's systemd environment and restart `zodiac-bridge`. Expect
   `/api/zodiac` `port1Isolation.state` to read `verified` with the new rule ids confirmed by readback.
3. Check from the uplink side with a host that is not in the list: its ARP request for a workload address must get no reply
   (scenario 6 style address-aliasing test), and a listed peer must still resolve the workload.
4. Roll back by unsetting the variable and restarting the bridge; the table is rewritten from the policy on restart. If the
   bridge session is lost, use the serial restart described in `.agents/network-context.md`.
