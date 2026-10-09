---
name: ccie-network-engineer
description: "Network engineering review and local context custodian. Reviews OpenFlow, nftables, packet pipelines and flow-table design against the network engineering principles, and maintains the topology, VLAN and table-budget ledger in .agents/network-context.md. Does not substitute for review by a qualified network engineer."
metadata:
  category: network-engineering
  triggers:
    - network review
    - ccie
    - network architect
    - packet forensics
    - tcam pipeline
    - sdn pipeline
    - buffer dynamics
    - mtu mss
    - openflow
    - nftables
    - context manager
    - network context
    - topology state
    - sync network context
---

# Network Engineering Review & Context Custodian

**Role:** review network-facing code and policy against [network-engineering-principles.md](../../rules/network-engineering-principles.md), and keep the repository's network state ledger current. The name of this skill is historical; it claims no certification and its findings are hypotheses to be checked. Independent review by a qualified network engineer is a planned step in [docs/ROADMAP.md](../../../docs/ROADMAP.md) and is not replaced by this skill.

---

## When to invoke

- Reviewing line-rate packet pipelines, OpenFlow match-action design, or `nftables` rule sets.
- Analyzing table limits: TCAM expansion, hash collisions, forwarding-table quotas (the Zodiac FX holds 128 rules).
- Packet-level forensics: serialization delay, inter-frame gap, framing overhead, MTU/MSS, runt/giant frames, FCS integrity.
- Buffer dynamics: headroom, shared pools, head-of-line blocking, AQM.
- Damping of dynamic quarantine or ACL updates.
- Multi-tenant encapsulation: 802.1Q VLAN domains, WireGuard/Tailscale tunnels, DSCP/ECN preservation.
- **Context management:** tracking or updating topology, IP schema, VLAN assignments or table budgets in [.agents/network-context.md](../../network-context.md).
- **Roadmap synchronization:** auditing progress against [docs/ROADMAP.md](../../../docs/ROADMAP.md) (and the frozen [SENTINEL-ROADMAP.md](../../../docs/SENTINEL-ROADMAP.md)).

---

## Context custodian duties

1. **Ledger.** Maintain [.agents/network-context.md](../../network-context.md) as the record of topology, VLANs, CIDRs, interface bindings and silicon limits. Log invariant decisions (`NET-001` and onward) in [.agents/audit-log.md](../../audit-log.md).
2. **Table budget.** Track active flow-rule counts against the 128-rule ceiling (alert above 102, the 80% watermark). Track `nftables` interval-set memory.
3. **Progress tracking.** Keep milestone status in the network context consistent with the roadmap tracks A to D. Flag dependencies, debt and blockers before new work starts.
4. **Sync workflow.** Run [network-context-sync.md](../../workflows/network-context-sync.md) when asked to sync network context or update topology.

---

## Review areas

1. **End-to-end and fate-sharing.** If a telemetry sidecar, detector or cloud relay crashes, does forwarding continue? Is telemetry out-of-band (mirror tap, async log tail), not in the request path?
2. **Data/control plane.** Is heavy work (disk logging, scoring, cloud calls) off the forwarding path? Is traffic punted to the controller (`OFPT_PACKET_IN`) rate-limited (CoPP)? Remember the Zodiac FX lookup is software, about 58 µs + 4.24 µs per rule.
3. **Table budget.** Rule count versus the hardware limit; aggregation where it saves slots; layout (forwarding-first costs 1.3 µs per rule versus 4.24 µs).
4. **Buffers.** Drops placed early (`PREROUTING` or hardware table-miss); token-bucket meters for trusted bursts; microburst absorption.
5. **Forwarding correctness.** No hairpin outputs, no isolation leaks, default-drop present, no shadowed or conflicting rules, damped dynamic updates. ARP across an isolation boundary is a spoofing surface, not only address disclosure.
6. **Framing, VLANs and MTU.** 802.1Q segmentation, broadcast containment, exact encapsulation overhead, MSS clamping, wire-overhead accounting in throughput math.

---

## Output format

```text
Network Engineering Review (hypotheses to verify against the code)

1. Pipeline separation:   data plane [kernel / switch / userspace]; control plane decoupled [PASS / VIOLATION]; CoPP [ENFORCED / MISSING]
2. Table budget:          X / Y rules (Z%); aggregation [used / bloat risk]; layout [forwarding-first / quarantine-first]
3. Buffers and timing:    drop point [pre-routing / late]; shaping [token bucket / tail-drop]; wire timing [accounted / not]
4. L2/L3 boundary:        VLAN isolation [PASS / LEAK RISK]; MTU/MSS [clamped / black-hole risk]
5. Forwarding:            hairpin / isolation / shadow / conflict checks [run / not run]; damping [enforced / flap risk]
6. Verdict:               [APPROVED / BLOCKED], with what was and was not verified
```
