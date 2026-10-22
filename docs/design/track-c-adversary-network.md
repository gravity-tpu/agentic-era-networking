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

## Still to do before any scenario runs

- Strip the default route off `eth1` on node-02 (or raise its metric) so background traffic — not just scenario traffic — can't leak either,
  independent of whether a script remembers to bind.
- Decide node-01's control channel the same way node-02's was solved (USB Ethernet or serial), then run the same `preflight` check against it.
- Wire `preflight()`'s output into each scenario's own provenance file once scenario scripts exist, the same way `conformance-run.ts` and
  `layout-capacity-run.py` record bridge commit and harness hashes.
