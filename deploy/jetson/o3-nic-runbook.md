# O3 capture NIC: day-of runbook (local, gitignored)

Goal: attach the third Jetson USB NIC to **uplink switch #2 port 3** (mirror destination of port 4 = the Zodiac P2 link),
make it receive-only, and verify the mirror against the policy, once, properly.

State going in (2026-10-10): switch #2 mgmt `192.168.0.240`; mirror **P4 -> P3** configured; 802.3x flow control on P4 and P5;
ports 1-3 empty. Existing USB NIC `enx9c69d39dd0a6` stays on **Zodiac P3** (O2). Helper: `.agents/local/zodiac-o3-nic.sh`.

Nothing here is committed. Put results in your own notes; ask Claude to turn them into a ledger/roadmap PR afterwards.

## 0. Before you start (5 min)

- [ ] Jetson reachable (`ssh jetson`, hardware key touch). Note current state: `lsusb -t`, `systemctl --failed`.
- [ ] Copy the helper over: `scp .agents/local/zodiac-o3-nic.sh jetson:~/` then `chmod +x ~/zodiac-o3-nic.sh`.
- [ ] Packages present: `command -v ethtool tc tcpdump python3` (else `sudo apt install ethtool iproute2 tcpdump`).
- [ ] Switch #2: confirm in its UI (`http://192.168.0.240`) that the mirror is P4 -> P3 and survives a power cycle (the first switch's persistence was never tested).

## 1. Move the Corals off the Jetson first

They share the USB bus the NIC will use (the repo documents hub contention and `libedgetpu` aborts).

```bash
sudo systemctl disable --now zodiac-coral.service        # Restart=always would crash-loop once unplugged
systemctl list-units 'zodiac-*' 'hardware-burst*' --no-pager   # nothing else should still use the Corals
lsusb -t                                                 # record the "before" bus layout
```

Then unplug the Corals. The dashboard's Coral tiles should read offline/zero (provenance), not stale values.
Corals' new home is a separate decision (see notes); do not leave them dangling on the Jetson.

## 2. Identify the new NIC

```bash
sudo ./zodiac-o3-nic.sh snapshot        # BEFORE plugging in
# plug the NIC into the Jetson, cable it to switch #2 PORT 3
sudo ./zodiac-o3-nic.sh diff            # prints the new interface and its MAC
```

- [ ] Exactly one new interface appears. Write down its **name and MAC**.
- [ ] Link speed shows 1000 (or 100). If the link is down, check the cable is in port **3** and that nothing else is on ports 1-3.

## 3. Install and verify (receive-only)

```bash
sudo ./zodiac-o3-nic.sh install <MAC>
sudo ./zodiac-o3-nic.sh verify  <iface>      # offloads off, promisc, no address (incl. IPv6), NM unmanaged, egress drop
sudo ./zodiac-o3-nic.sh selftest <iface>     # sends one raw frame; the egress-drop counter must rise
```

Pass = `verify ok` and `selftest ok: egress drop counter N -> M`.
**If selftest fails, stop: the NIC is not fail-closed. Unplug it from switch #2 until fixed.**

Persistence: reboot the Jetson once, then `verify` again (udev must re-apply it). Also re-check after any `nmcli` change.

## 4. Verify the mirror against the policy

Run each capture from the Jetson while the traffic runs elsewhere. Label every capture; each writes a pcap plus a `.meta.json` provenance sidecar.

| # | Traffic (run on...) | Capture (Jetson) | Expected at O3 |
| :--- | :--- | :--- | :--- |
| T1 | Mac: `ping -c5 10.0.2.52` | `sudo ./zodiac-o3-nic.sh capture <iface> 20 t1-allowed "mac->node02"` | 5 requests + 5 replies (`10.0.2.119` <-> `10.0.2.52`) |
| T2 | `agentic-node-01`: `ping -I eth0 -c5 10.0.0.1` | `... capture <iface> 20 t2-blocked "node01->gateway"` | **No ICMP** from `10.0.2.50`; ARP who-has may appear (policy lets ARP cross) |
| T3 | `agentic-node-01`: `ping -I eth0 -c5 10.0.2.52` (stays inside the workload switch) | `... capture <iface> 20 t3-local "node01->node02"` | Nothing at all (never reaches Zodiac) |
| T4 | Mac `ping -c5 10.0.2.52`, with O2 captured at the same time on `enx9c69d39dd0a6` | two captures at once | Prediction from the documented policy: replies appear at **both** O2 and O3; requests only at O3 (O2 is a copy of P1 ingress). Treat as a hypothesis to test |

Read a pcap quickly: `sudo tcpdump -nn -e -r <file.pcap> | head -30`.

- [ ] T1 pass, T2 pass, T3 pass, T4 observed (note any mismatch with the prediction: that is a model-vs-wire finding, not an error).
- [ ] Any ICMP from `10.0.2.50` to `10.0.0.1` at O3 means the policy leaked. Stop and keep the pcap.

## 5. Wrap up

- [ ] Keep captures in `/var/lib/zodiac/o3-captures/` (the helper chowns them to you). Copy the pcaps and sidecars off the Jetson (they are the first conformance evidence).
- [ ] Record: NIC name/MAC, link speed, T1-T4 results, anything surprising, and whether the switch mirror survived a power cycle.
- [ ] Then ask Claude to update `.agents/network-context.md`, `docs/ROADMAP.md` (O3 is live; time-share plan retired) and the whitepaper testbed row, in one PR.
- [ ] Optionally write the ledger entry for the Corals' new home at the same time.

## Rollback

```bash
sudo ./zodiac-o3-nic.sh uninstall     # removes the unit, udev rule, NM override and env; keeps captures
sudo ip link set dev <iface> down     # and unplug it from switch #2 port 3
```

Re-enable the Corals only if you also want the old state back: `sudo systemctl enable --now zodiac-coral.service`.

## Known unknowns (not verified)

- The helper is syntax-checked only; it has not run on the Jetson. If `verify` fails on a check, read which one: each message names it.
- `ethtool -K` may refuse a feature on some USB NICs; the helper tolerates that but `verify` will then fail on the feature that stayed on.
- The switch's destination port is documented to drop ingress for the first switch; it is not verified for this unit.
- The Jetson's USB topology was not inspected; `lsusb -t` before and after is how you will know whether the NIC shares a hub.
