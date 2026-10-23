# Track C: keeping the adversary node's traffic on the interface under test

Found 2026-10-22, while planning Track C scenarios 1 to 3 (docs/ROADMAP.md). Recorded here because it very nearly produced a false result before any
scenario script was even written.

## The finding

Both adversary-node candidates (`agentic-node-01`, `agentic-node-02`) have more than one network interface, and the roadmap's own note —
"Workload `wlan0` interfaces are off during runs, otherwise the lab-LAN Wi-Fi path bypasses the isolation policy being tested" — undersells the
problem. It isn't specific to Wi-Fi. It's specific to having **any** interface that reaches the lab LAN without transiting the Zodiac.

- `agentic-node-01`: `eth0` (10.0.2.0/24 workload segment, plus 10.0.1.0/24, the OpenFlow controller segment — also unmediated by the policy under
  test), `wlan0` (10.0.0.0/24, direct to the household network).
- `agentic-node-02`: `eth0` (10.0.2.0/24), `wlan0` (10.0.0.0/24, same as above), and now `eth1` — a USB Ethernet adapter (ASIX AX88179-based)
  added 2026-10-22 as a control channel so the node stays reachable with `wlan0` off during runs. It landed on the same household network,
  `10.0.0.0/24`, via a spare port on the ISP mesh device.

Adding `eth1` solved the control-channel problem (reaching the node for orchestration while `wlan0` is down) and immediately recreated the
original problem under a new name: on node-02 right now, `eth1` holds the default route. Any traffic the node sends that isn't addressed inside
`10.0.2.0/24` leaves through `eth1`, not `eth0` — exactly as it would have left through `wlan0` before. Turning `wlan0` off did not fix this; it
just moved which interface the leak runs through.

This matters concretely for the planned scenarios. Scenario 1 (ARP spoofing the gateway "toward the lab LAN") and scenario 6 (uplink-side address
aliasing) both target addresses outside the workload segment by design. If that traffic leaves through a second interface instead of `eth0`, the
scenario is testing the household network's own gateway, not the Zodiac's policy, and a "contained" or "not contained" verdict would be
meaningless — it would never have touched the switch.

## The convention

**Turning the other interface off is necessary but not sufficient.** A reconnect, a background service that doesn't respect interface state, or a
scenario script that forgets which tool flag binds an interface will still leak. The actual requirement is: **every packet a scenario generates
is explicitly bound to the workload interface, regardless of what the routing table would otherwise choose.**

`scripts/adversary-bind.py` (Python standard library only, runs on the adversary node) provides this:

- `preflight(iface='eth0')` — fails closed (`ok: false`) if the workload interface is down, or if any OTHER interface holds the default route.
  Every scenario script must call this once at the start and store its output in the run's provenance; a refusal means the run does not proceed,
  the same way a failed clean-tree check or a failed capture-readiness check stops other harnesses in this repo.
- `bind_socket(sock, iface)` — `SO_BINDTODEVICE` for raw/UDP/TCP sockets built in Python. Requires root.
- `TOOL_BINDING_CONVENTIONS` — the binding flag for each external tool a scenario is likely to shell out to (`ping -I`, `arping -I`, `nmap -e`,
  `hping3 -I`, `tcpdump -i`), plus the note that Scapy's `conf.iface` is a default, not an enforcement: every `send()`/`sendp()`/`srp()` call still
  needs an explicit `iface=` kwarg. A tool with no reliable binding flag should not be used to generate scenario traffic.

Checked live against both current nodes (2026-10-22). The first version of `preflight()` only looked at which interface held the default
route, which the strict review (correctly) called out as narrower than the problem actually is: an interface does not need the default route to
leak traffic to its own subnet, and the workload interface itself can carry a second, unmediated subnet. Widened to check every up interface for
any routable address (not just the default-route holder), and to check the workload interface's own addresses against the expected workload
subnet. Re-run against both nodes after the fix:

- **node-01:** refuses on `10.0.1.50` — the controller segment living on `eth0` itself, not a second interface at all. The earlier, narrower
  check missed this because `eth0` isn't the default-route interface either way.
- **node-02:** refuses on two interfaces, not the one originally found: `eth1` (as expected) **and** `tailscale0`, which has its own routable
  address and was invisible to a default-route-only check.

One link-local IPv6 address (`fe80::/10`) is present on every interface by construction and cannot be forwarded off the local segment (RFC 4291
§2.5.6); it is explicitly excluded from both checks rather than producing a false refusal on every single host. `wlan0`'s
administrative-up-but-no-carrier state is reported honestly (`adminUp` vs `up`) rather than folded into a plain "up", since a residual radio that
could reassociate without warning is a different kind of risk than a live leak and the provenance record should say which.

## A third leak path, found building scenario 1's runner (2026-10-22)

`preflight()` refused on node-02 again while building `scripts/track-c-scenario1-arp-spoof.py` — this time on `eth0` itself, not a second
interface. `eth0` had picked up a routable global IPv6 address via SLAAC (`scope global dynamic mngtmpaddr proto kernel_ra`): the household
router's IPv6 advertisements reach the workload segment too, and the Zodiac's policy is IPv4-only, so this is unmediated the same way
node-01's `10.0.1.0/24` controller segment was. `accept_ra` and `autoconf` were both `1` on that interface. NetworkManager governs `eth0`
(profile `eth0-sdn`), so the durable fix is `nmcli connection modify eth0-sdn ipv6.method ignore` rather than a bare `sysctl -w`, which
NetworkManager would otherwise undo on the next reconnect. `preflight()` caught this correctly and refused to let the scenario proceed —
exactly what it is for.

## Known control channels needed an exception, not a workaround (2026-10-22)

Getting node-02 ready to actually run scenario 1 surfaced two more things.

**The interface names swap, deterministically, on this host.** The onboard NIC (workload segment) and the ASIX USB adapter (household
network) have a persistent kernel-level naming collision: `journalctl` showed both trying to rename to the other's current name on every
single boot ("File exists"), regardless of `systemd.link` MAC-based overrides — the kernel's own initial enumeration consistently hands
"eth0" to the ASIX adapter and "eth1" to the onboard NIC before any `.link` file gets a chance. A direct two-way swap via `.link` files
cannot resolve this (confirmed: going through an intermediate non-colliding name pair, `eth10`/`eth11`, worked cleanly; going from there back
to the literal `eth0`/`eth1` hit the identical collision, because every boot starts fresh from the same kernel-assigned pair, not from
whatever a previous boot's udev rename produced). Forcing "eth0 = onboard" on this specific host would require non-`eth0`/`eth1` names
entirely, which just relocates the problem. Resolution: stopped fighting it. `scripts/track-c-scenario1-arp-spoof.py` declares
`NODE02_WORKLOAD_IFACE = 'eth1'` as a documented per-host constant instead.

**`preflight()` could never pass on a host with a live control channel, which is every host that needs one.** An IP-based control channel
(node-02's `eth0`, carrying its SSH path and Tailscale) necessarily has a routable address, which is exactly what the leak check refuses on.
Node-01 avoids this because its control channel is serial — no IP traffic at all, structurally incapable of leaking. `preflight()` gained
`known_control_ifaces`: a caller declares, by name, which interfaces are a known control channel; those are excused and reported in
`excusedControlInterfaces` (visible in the provenance, not silently dropped), while anything NOT declared still refuses exactly as before.
Confirmed live: declaring only `eth0` still correctly refused on `tailscale0` left undeclared; declaring both passed cleanly. The actual
safety property is unchanged — every send is still explicitly bound (`arping -I eth1`), never left to routing-table choice; the allowlist
only changes what the gate does when a human-approved, deliberately-reachable channel already has an address, not what happens to traffic.

## Still to do before any scenario runs

- Strip the default route off `eth1` on node-02 (or raise its metric) so background traffic — not just scenario traffic — can't leak either,
  independent of whether a script remembers to bind.
- Decide node-01's control channel the same way node-02's was solved (USB Ethernet or serial), then run the same `preflight` check against it.
- Wire `preflight()`'s output into each scenario's own provenance file once scenario scripts exist, the same way `conformance-run.ts` and
  `layout-capacity-run.py` record bridge commit and harness hashes.
