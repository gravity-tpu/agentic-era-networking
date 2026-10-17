# Workload nodes (`agentic-node-01`, `agentic-node-02`)

Host-side setup for the Pi 3B+ workload nodes behind the Zodiac's Port 1.

## Keep Tailscale off the workload interface

`block-tailscale-on-eth0.sh` drops Tailscale's UDP port (41641) on `eth0`, input and output, so a node's management
traffic does not cross the Zodiac (the device under test) and its P3 tap.

### Why

Tailscale advertises every local interface address as a candidate path. `eth0` (`10.0.2.x`) and the Mac's `10.0.2.119`
alias are on the same /24, so a node picks that direct path to the Mac and its WireGuard and disco traffic (UDP 41641,
packets up to about 1.4 KB) goes through the Zodiac. Measured 2026-10-16, with a capture on the Jetson's tap NIC:

- A 125-frame capture while `agentic-node-02` pinged the Mac at 5 per second held 60 ICMP echoes, 2 ARP requests and
  63 UDP frames `10.0.2.52:41641` to `10.0.2.119:41641`, 30 frames of the whole capture in its first second.
- That burst is what made the GPU detector propose a quarantine for `10.0.2.52` at 18 to 46 packets per second
  against a 10 per second threshold, while the pings alone were 5 per second.
- `agentic-node-01` was on that path continuously: its Tailscale status showed the Mac at `10.0.2.119:41641`, active.

The same traffic also counts in any measurement taken at the tap, so it distorts detector and benchmark results.

### Install

On each node, as root (the nodes do not have passwordless sudo):

```sh
sudo bash deploy/workload/block-tailscale-on-eth0.sh
```

`--dry-run` prints the ruleset and systemd unit without changing anything. `--iface NAME` and `--port N` override the
defaults (`eth0`, 41641). `--uninstall` removes it. The script refuses an interface that carries the node's default
route (that is how Tailscale reaches the internet) and rejects an interface name or port that is not plain text.

It installs an nftables table, `inet zodiac_tailscale_block`, and a oneshot unit,
`zodiac-tailscale-eth0-block.service`, ordered before `tailscaled` so the rules exist before Tailscale starts probing
paths. It lists the loaded table afterwards and exits non-zero if either rule is missing.

### Check that it works

1. Give Tailscale a minute to re-probe, then on the node: `tailscale status --json | grep -i curaddr`. No peer should
   show a `10.0.2.x` address.
2. On the Jetson, capture the tap while pinging from the node and count `41641`:
   `sudo tcpdump -i enx9c69d39dd0a6 -n -c 200 udp port 41641` should see none from the node.
3. On the node, `sudo nft list table inet zodiac_tailscale_block` shows the drop counters; they rise while Tailscale
   tries `eth0` and are then quiet.

### What it does not do

- It does not stop other traffic from reaching the lab LAN: `wlan0` itself, and `agentic-node-01`'s extra
  `10.0.1.50/24` on `eth0` (the control subnet), are separate roadmap items.
- It does not replace a real out-of-band management path (a second NIC on a management VLAN). With this rule,
  management goes over `wlan0` or a Tailscale relay, so `wlan0` must stay up for management; the roadmap's rule of
  `wlan0` off during attack runs applies to the adversary node and then needs a scheduled window.
- Blocking is by Tailscale's port. If a node's `tailscaled` listens on another port, pass `--port`.

### Measured status

The generated ruleset parsed with `nft -c -f` and the unit passed `systemd-analyze verify` on `agentic-node-01`
(check only, nothing installed). The install itself has not been run on either node yet, so the effect on the tap
traffic is not measured.
