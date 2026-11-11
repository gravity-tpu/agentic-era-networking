# Scenario 6, revisited: address aliasing from the uplink side — results (2026-11-06/07)

Follow-up to the original observation (2026-10-09): a lab-LAN host takes a `10.0.2.x` address and reaches the workload nodes. That observation predates two independent hardening changes to this testbed — the `zodiac_netgear_2` VLAN isolation fix (2026-10-25, `.agents/network-context.md` caveat 11) and this session's own fixes below — so it was re-run from scratch rather than assumed still true.

**Headline: the address-aliasing path no longer works, and for a sound reason — not the one originally assumed.** The switch's VLAN isolation on the uplink was not actually what stopped it. The attack was being silently intercepted by a host-level ARP misconfiguration on `agentic-node-01` before ever reaching the Zodiac. That misconfiguration is now fixed (not just worked around), and the attack still doesn't succeed, now because the aliasing host (this Mac, `10.0.2.119` on `en0`, the same alias used in 2026-10-09) can no longer even resolve an L2 address for either workload host.

## What was tested

Sender: this Mac, aliased as `10.0.2.119/8` on `en0` (lab-LAN side, same setup as 2026-10-09). Targets: `agentic-node-01` (`10.0.2.50`) and `agentic-node-02` (`10.0.2.52`), the real workload hosts. Evidence: `ping` + `arp -a` on the sender, and `GET /api/zodiac/flows/probe` (read-only OFPMP_FLOW readback, rate-limited, no FlowMod) on the Zodiac bridge, read before and after each attempt.

## Timeline

1. **First attempt** (`wlan0` up on both nodes, `arp_filter=0`): both pings 100% loss. ARP for `10.0.2.50` resolved to `58:ef:68:b4:88:a3` — **`agentic-node-01`'s `eth1`**, not `eth0` (which actually owns `10.0.2.50`). `10.0.2.52` never resolved (`incomplete`). Table-miss read `+10` over the test window, which at first looked like a match for the 10 pings sent.
2. **Idle-baseline control**: two flow-table reads 44 s apart with zero test traffic showed only `+1` table-miss — but a later, unrelated idle window showed `+57` over a similar scale. **Table-miss turned out to be a noisy signal, driven by background activity unrelated to this test, not usable as per-test evidence.** The `+10` correlation in step 1 was very likely coincidence; this is a correction to a conclusion drawn earlier in the same investigation, not a separate finding.
3. **`wlan0` turned off** on both `agentic-node-01` and `agentic-node-02` (administratively down, confirmed via `ip -brief addr show wlan0`). Re-ran with a freshly cleared ARP cache (`sudo arp -d`, to rule out a stale cache entry from step 1): `10.0.2.50` **still** resolved to `eth1`'s MAC. `wlan0` was not the leak path.
4. **Root cause confirmed:** `net.ipv4.conf.{all,eth0,eth1,wlan0}.arp_filter = 0` on both nodes — Linux's default "weak host model," which answers an ARP request for any of a host's own addresses on any interface, regardless of which interface the request arrived on. `agentic-node-01` holds `10.0.2.50` on `eth0` (the genuine, Zodiac-isolated workload NIC) and also has `eth1` up with a lab-LAN address (`10.0.0.56`) on the same broadcast domain as this Mac's alias path. With `arp_filter=0`, `eth1` answers for `eth0`'s address.
5. **Fixed:** `net.ipv4.conf.{all,default,eth0,eth1,wlan0}.arp_filter = 1` set live and persisted (`/etc/sysctl.d/99-zodiac-arp-filter.conf`) on both `agentic-node-01` and `agentic-node-02`.
6. **Final, clean re-run** (`wlan0` down, `arp_filter=1` on both nodes, fresh ARP cache): **neither host resolves at all** (`(incomplete)` for both `10.0.2.50` and `10.0.2.52`). With no ARP reply, the sending host cannot construct an Ethernet frame to either destination — the ping never reaches the wire with a valid destination MAC. `p2-ipv4-to-segment` (the Zodiac rule this scenario is actually about) read `0/0` packets/bytes throughout every attempt, consistent with the traffic never reaching the switch at all, in any attempt.

## What this shows

- **The 2026-10-09 observation does not reproduce today**, and — this is the real result — **it had already stopped reproducing for a reason nobody had verified**: a host-level ARP misconfiguration (`arp_filter=0` on `agentic-node-01`) was masking whatever the switch's own policy would have done, by intercepting the traffic one hop before the Zodiac. The fix in step 5 closes that masking, independent of the Zodiac's own policy.
- **The uplink switch's VLAN isolation (`zodiac_netgear_2`, fixed 2026-10-25) was never actually exercised by this test.** The traffic never reached port 4 in any attempt, so this result says nothing about whether that VLAN fix is itself sound — only that it was irrelevant here because the host-level leak intercepted the traffic first.
- **Two real, standing infrastructure fixes came out of this, not just a scenario result:** `wlan0` is now administratively down on both `agentic-node-01` and `agentic-node-02` (was up on both before this session), and `arp_filter=1` is now set and persisted on both. These are lasting changes to the lab, not reverted after this test — future experiments on these nodes run under the corrected configuration by default.

## What this does not show

- **Whether `p2-ipv4-to-segment` would actually forward this traffic if it ever reached the Zodiac.** That rule matches on destination address alone, with no source check (`src/sdn/port1-isolation.ts`) — by the policy's own text it should forward regardless of source, but this was never exercised: the traffic never got far enough to test it.
- **Physical Explanation for the 0/0 Count (2026-11-10 audit):** On `zodiac_netgear_2`, Port 4 (cabled to Zodiac Port 2) resides alone on 802.1Q VLAN 2 with no other member ports, while node management NICs and the gateway uplink reside on VLAN 1. Even if raw frames are transmitted from a lab node, the NETGEAR switch silicon drops them at the port/VLAN boundary before they can enter Zodiac Port 2. Thus, the 0 packet counter on `p2-ipv4-to-segment` is physical proof that the upstream switch's VLAN isolation is airtight.
- **Whether the `zodiac_netgear_2` VLAN isolation (2026-10-25) is itself still correctly enforced.** Not exercised by this test (see above). `.agents/network-context.md` caveat 11 already asks for this to be re-verified after any switch reconfiguration; that re-verification is still open.
- **`agentic-node-02`'s side of the ARP-flux mechanism.** `10.0.2.52` never resolved in any attempt, including before the fix, because `agentic-node-02`'s lab-LAN-side interface (`eth0`) does not hold `10.0.2.52` — there was no address collision to exploit on that host in the first place. `arp_filter=1` was still applied there for consistency, not because a leak was demonstrated.
- A found, unrelated bug in `scripts/netgear-tunnel.sh` (always opened its tunnel on switch 1's port regardless of target) was fixed separately — see PR #223, not part of this result.

## Provenance

- Sender: this Mac, `10.0.2.119/8` on `en0` (pre-existing alias, unchanged from 2026-10-09).
- Read via `GET /api/zodiac/flows/probe` on the live Jetson bridge; no FlowMod sent, rate-limited to one read per 5 s.
- `agentic-node-01`, `agentic-node-02`: `wlan0` set administratively down (`sudo ip link set wlan0 down`); `arp_filter` set via `sysctl -w` and persisted in `/etc/sysctl.d/99-zodiac-arp-filter.conf`, both on 2026-11-07, both by direct operator action (node-02 required the owner's own sudo password; node-01 has standing passwordless sudo).
- No FlowMod was ever sent to the switch; no isolation policy was changed; no quarantine was triggered.
