# A10 batch 1: does firmware 0.86 actually enforce ARP_SPA matching?

Run 2026-10-24, bridge commit `f396b97` on `main`. This is a feasibility check, not the confinement policy itself —
the open question was whether `OFPXMT_OFB_ARP_SPA` is something this firmware merely *accepts* in a flow-mod
(control-plane bookkeeping) or actually *evaluates* when forwarding a frame (data-plane enforcement). Without this,
no ARP_SPA-based confinement rule can be trusted regardless of how it's written.

## Method

One experiment rule installed via the bounded, auto-reverting `/api/experiment/install` path (90s TTL, restores the
real policy automatically):

```json
{"id": "arp-spa-forward-test", "priority": 100, "outputPorts": [2, 3],
 "match": {"inPort": 1, "etherType": 2054, "arpSpa": "10.0.2.250"}}
```

No other ARP rule installed — everything else falls through to table-miss (DROP), which stands in as the negative
case. From `agentic-node-02` (`eth1`, preflight-checked via `adversary-bind.py`), sent two sets of 3 unsolicited ARP
replies, identical except for the claimed SPA:

- `10.0.2.250` — matches the rule. Prediction: forwarded to the uplink (O3).
- `10.0.2.251` — does not match the rule. Prediction: dropped by table-miss, absent from O3.

O3 (`enx9c69d39ddcc0`, the independent uplink mirror) is ground truth, same as every other Track C measurement this
project has made.

## Result

```text
00:31:09.390976 ARP, Reply 10.0.2.250 is-at b8:27:eb:79:ff:0a, length 46
00:31:09.690976 ARP, Reply 10.0.2.250 is-at b8:27:eb:79:ff:0a, length 46
00:31:09.991172 ARP, Reply 10.0.2.250 is-at b8:27:eb:79:ff:0a, length 46
```

All 3 replies claiming `10.0.2.250` crossed to O3. **Zero** frames claiming `10.0.2.251` appear anywhere in the
capture (full capture retained, `o3-a10-test.pcap`, not committed — lab MAC/IP addresses, available on request).

**Both predictions held.** The switch distinguished between two frames that differed only in the claimed SPA value,
forwarding the one the rule named and dropping the one it didn't. That's selective, data-plane behavior, not just a
flow-mod the control plane accepted and then ignored.

## What this does and does not say

- **Firmware 0.86 does enforce ARP_SPA matching on this hardware.** A10 (ARP confinement) is achievable by rule, not
  blocked by a firmware limitation — the only thing missing was the type-level plumbing to express the constraint at
  all (now added, `src/sdn/openflow-types.ts`, `src/sdn/rule-hygiene.ts`, `src/sdn/experiment-install.ts`).
- **One rule, one claimed address, one host, 3 packets.** Not a claim about ARP_TPA (the target address field,
  untested here), about masked/prefix ARP_SPA matches, or about behavior under load.
- **The hygiene checker's shadow/coverage analysis does not yet understand `arpSpa` as a real narrowing dimension.**
  An earlier two-rule design (a specific-SPA drop rule above a catch-all ARP forward rule) was correctly refused by
  A5 ("shadowed"), because the coverage check only has `arpSpa` wired into exhaustiveness and exact-duplicate
  detection, not subset/overlap reasoning between different SPA values. Worked around for this feasibility test by
  using a single rule plus the implicit table-miss default. **This needs a real fix before any confinement policy
  with more than one ARP rule at different priorities can be built and verified** — tracked as the next piece of
  work before batch 2 (the actual confinement rule set).

## Follow-up

- Fix `rule-hygiene.ts`'s coverage analysis to understand `arpSpa`/`arpTpa` as real partitioning fields (needed
  before a multi-rule ARP confinement policy can pass A5/A6).
- Design the actual confinement rule(s): likely "forward ARP from a workload host only when its claimed SPA matches
  that host's assigned address," which needs either a per-host rule (small, fixed host count) or ARP_TPA target
  restriction, or both — a design decision for the next batch, not assumed here.
- Verify ARP_TPA similarly before relying on it.
