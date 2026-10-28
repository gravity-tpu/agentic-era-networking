# A10: what crossed the Zodiac's uplink link in 24 hours (2026-10-26 to 2026-10-27)

A 24-hour, read-only capture of ARP on the Jetson's O3 interface (`enx9c69d39ddcc0`), which mirrors the Zodiac P2 link (NETGEAR #2 port 4) in both directions. It was taken to
find which uplink-side hosts legitimately send ARP toward the workload, so the opt-in confinement of uplink to workload ARP (PR #119, `ZODIAC_UPLINK_ARP_PEERS`) can be given a peer
list from evidence. **Nothing was changed on any host and no packet was sent.** The proposal at the end is not approved and not deployed.

| Item | Value |
| :--- | :--- |
| Command | `tcpdump -i enx9c69d39ddcc0 -n -s 128 -Z zodiac -C 20 -W 5 -w /tmp/p2-arp.pcap arp` under `timeout 86400`, run by the owner with `sudo` on the Jetson |
| Window | first frame 2026-10-26 12:47:17, last frame 2026-10-27 12:46:56 (Jetson clock, EDT); the file was closed at 12:47:09 on 2026-10-27 |
| Frames | 3,754, all ARP; the kernel reported 3,754 received by the filter and **0 dropped** |
| File | `p2-arp.pcap0` (285,328 bytes, one file, the ring never rotated), sha256 `52f8d99c82d7070cd40706fb9f955f2f0f8fd8ea2a357d8c6d89d664c44bfdcf`; the copy in this directory was checked against the Jetson's |
| Analysis | `scripts/analyze-arp-capture.py` over `tcpdump -nne -tttt -r` text gives `summary.json`; the Mac's and the Jetson's `tcpdump` give an identical summary |

## What it contains

| Frames | Sender | What | Span |
| ---: | :--- | :--- | :--- |
| 3,751 | `28:94:01:8b:70:e5` (the NETGEAR #2 switch), `192.168.0.240` | broadcast "who has `192.168.0.254`", about 156 an hour, 153 to 164 in every full hour | the whole window |
| 3 | `b8:27:eb:79:ff:0a`, `10.0.2.52` | ARP announcement for its own address (sender equals target), sent 2 s apart | 2026-10-26 17:50:47, :49, :51 |

There is **no ARP reply** in the capture, **no ARP from any uplink-side host asking for or announcing a workload address**, and no frame at all involving `10.0.2.50`, `10.0.2.51` or any other
10.0.2.x address besides the three announcements.

- The 3,751 frames are the managed switch's own chatter, looking for a default gateway on its factory subnet (`192.168.0.0/24`). They are nothing a workload host needs, and no one answers them.
- The 3 announcements are from `b8:27:eb:79:ff:0a`, which the repo's telemetry code records as agentic-node-02's workload NIC (eth1, `10.0.2.52`). `10.0.2.52` is one of the two listed workload hosts, so these
  crossing P1 to P2 is the deployed per-host rule (`p1-arp-allow-10.0.2.52`) working on live traffic. The timing is consistent with the interface or its address coming up; the cause was not checked.
- **Both directions are evidenced by real frames:** the NETGEAR's broadcasts are the uplink side's traffic into the Zodiac's P2 port, and the announcements are the workload side's traffic out of it.

## What it means for the open half of A10 (`p2-arp`)

1. **In this window, no legitimate uplink-side ARP sender toward the workload appeared.** The only uplink-side ARP is the NETGEAR's management broadcast.
2. **The unconfined `p2-arp` rule forwards that broadcast to the workload.** By the rule (`in_port=2, ARP -> [P1]`), about 3,750 unrelated frames a day are delivered onto the workload segment. This was not observed on the P1 side; it follows from the installed rule.
3. An empty peer list would drop all of it, and drop nothing anyone used in this window.

## What it does not show

- **It was an idle day for the uplink.** No experiment with an uplink-side host in 10.0.2.x ran (the Track C scenario 1 adversary node, `10.0.2.119`, or the resolver INTENT-2 names, `10.0.2.1`, both would
  need to ARP the workload, and under an empty list they could not: the workload could not resolve them, because their replies would be dropped). A peer list of `none` is right for the idle state only.
- One switch, one day, one window; ARP only, not other traffic; the capture is of the link, not of port 1.
- It does not show that the confined policy installs and behaves on the switch: that is the deployment step, which has not been done.

## Proposal (not approved, not deployed)

Set `ZODIAC_UPLINK_ARP_PEERS=none` on the bridge as the default, and add an experiment's uplink-side host as a peer only while the experiment runs. The deployment needs: pulling the merged code on the Jetson
(its repo is at `72659d7`; `main` also carries an unrelated display and telemetry change), building it, setting the variable in `/etc/zodiac/zodiac-bridge.env`, and a `sudo systemctl restart zodiac-bridge`.
The bridge verifies the policy, passes it through the install gate and checks the switch's readback; if the gate refused it the data plane would stay at the table-miss DROP, so the rollback is to unset the
variable and restart. The runbook is `docs/design/a10-uplink-arp-confinement.md`.
