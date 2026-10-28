# A10: uplink to workload ARP confined on the live bridge (2026-10-27 to 2026-10-28)

The opt-in confinement of uplink to workload ARP (PR #119) was switched on in the Jetson's bridge with **`ZODIAC_UPLINK_ARP_PEERS=none`**, on the owner's explicit approval, after the 24-hour capture
(`../a10-uplink-arp-capture-2026-10-26/`). The deployed policy no longer forwards any ARP arriving on the uplink (P2) to the workload (P1): the `p2-arp` rule is gone and uplink ARP falls to the table-miss DROP.

| Item | Value |
| :--- | :--- |
| Approved | by the owner, 2026-10-27 evening: peers `none`, a brief bridge restart, and the pull to include the unrelated display and telemetry change |
| Code on the Jetson | `/home/zodiac/agentic-era-networking` fast-forwarded from `72659d7` to `415b70a` (`main` at the time); a local-only `generatedAt` change to `public/asset-manifest.json` was stashed, not discarded |
| Build | built with TypeScript 7.0.2 into `dist-new` and overlaid into `dist/` after a backup (`dist-prev-a10`); the 21 `dist/` files absent from the new build are stale leftovers whose sources no longer exist, and a walk of the bridge's import graph in the new build found 36 modules, none missing, and every npm package it needs installed |
| Dry run on the Jetson, before the restart | default policy (variable unset): the same 7 rules as before; with `none`: 6 rules (`p2-arp` removed), strict verifier 0 violations, install gate admits it under the matching intent and refuses it under the original intent |
| Armed | `ZODIAC_UPLINK_ARP_PEERS=none` appended to `/etc/zodiac/zodiac-bridge.env` (backup `zodiac-bridge.env.bak-before-a10-uplink`) |
| Restart | `sudo systemctl restart zodiac-bridge`, run by the owner at 2026-10-27 23:59:04 EDT |

## What was measured

| | Before (`bridge-state-before.json`) | After (`bridge-state-after.json`) |
| :--- | :--- | :--- |
| Isolation state | `verified` | `verified` |
| Rules confirmed on the switch | 7: `p1-ipv4-intra-segment`, `p1-arp-allow-10.0.2.50`, `p1-arp-allow-10.0.2.52`, `p1-default-tap-only`, `p2-ipv4-to-segment`, **`p2-arp`**, `p3-tap-return` | 6: the same without `p2-arp` |
| Mismatches, switch errors | none, none | none, none |
| Actions (output ports, table-miss drop) | confirmed | confirmed |

The bridge's own log (`bridge-restart-journal.txt`) ends with `Isolation readback VERIFIED: 6/6 rules confirmed on switch (7 total entries); actions confirmed`. The switch's physical readback
(`flow-readback-t0.json`, `flow-readback-t1.json`, 75 s apart) lists 7 entries (6 rules and the table-miss), finding `reports-instructions`, `provenForwarding: true`, no mismatches. The table-miss entry's packet count rose from 13 to 22 in those 75
seconds (2,892 to 5,544 bytes, an average of 294 bytes a packet, so it counts frames larger than ARP as well, which the readback does not identify); the other six entries did not change between the two readbacks (one per-host ARP entry shows a single 60-byte packet in both, the readback does not say which of the two). OpenFlow was
`Connected` at version 1.3. A ping from node-01 to node-02 over the workload segment went through, 3 of 3 (that traffic may not cross the Zodiac, so it shows the workload plane is up, not that the rule set passes it).

## What was not shown

- **That the NETGEAR switch's ARP broadcast is now dropped, as opposed to the rule being absent.** A 90-second read-only count on node-01's workload interface saw **zero frames of any kind**, so the segment was silent and the
  check has no control; it is inconclusive, not a confirmation. There is no capture on the workload side from before the change to compare with. What is established is the table: no `p2-arp` rule, and the table-miss entry drops what no rule matches.
- **The scenario 6 style check from a host that is not a peer** (the runbook's step 3) was not run: no uplink-side 10.0.2.x test host was up.
- It is the idle state. An experiment with an uplink-side host in 10.0.2.x needs that host listed as a peer while it runs (set `ZODIAC_UPLINK_ARP_PEERS=<address>` and restart), or the workload cannot resolve it.

## Rollback

Remove the line without `sudo` and restart: `sed -i '/^ZODIAC_UPLINK_ARP_PEERS=/d' /etc/zodiac/zodiac-bridge.env`, then `sudo systemctl restart zodiac-bridge`. The previous build is in `/home/zodiac/agentic-era-networking/dist-prev-a10`, and a restart without the variable
reinstalls the earlier 7-rule policy. If the install gate ever refused the new policy the data plane would stay at the table-miss DROP; it did not.
