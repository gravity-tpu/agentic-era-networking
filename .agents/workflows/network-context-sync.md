# Network Context Synchronization & Audit Workflow

**Trigger:** `@ccie`, `sync network context`, `audit network state`, `update topology`, or `network review`

## Objective

Synchronize the local network context manager ([network-context.md](../network-context.md)) with current physical topology, silicon table limits, protocol configurations, and multi-track development milestones.

---

## Steps

### Step 1: Inspect Physical & Logical Network State

1. Query or inspect active interfaces, switch ports, and VLAN tags:
   - Check if changes have been introduced to VLAN 100 (OpenFlow data plane) or VLAN 200 (native controller channel).
   - Verify IP and CIDR prefix assignments across management (`10.0.0.0/24`), control (`10.0.1.0/24`), and workload (`10.0.2.0/24`) subnets.
2. Check transport layer bindings and wire listeners:
   - OpenFlow 1.3 TCP `6633` listener status.
   - RFC 1035 UDP DNS `53` socket status.
   - Prometheus metrics exposition (`:9100` / `:9105`).

### Step 2: Audit Silicon Budgets & Forwarding Capacity

1. Calculate active rule consumption:
   - Zodiac FX hardware flow table: Count installed entries against the 128-rule ceiling (alert if > 102 rules / 80% watermark).
   - Linux netfilter `nftables`: Verify interval sets use CIDR aggregation (`/24` or `/16`) instead of fine-grained `/32` host bloat.
2. Verify buffer and rate-shaping parameters:
   - Ensure trusted sister-site burst traffic uses token-bucket meters rather than abrupt tail-drop.

### Step 3: Invariant Compliance Gate

Audit the proposed changes against the 6 Network Engineering Invariants:

1. **NET-1 (Separation & CoPP)**: Is the transit packet path completely decoupled from slow-path control daemons and synchronous RPCs? Is CoPP enforced?
2. **NET-2 (TCAM Budget)**: Does the change respect hardware table ceilings and avoid range-expansion TCAM explosion?
3. **NET-3 (Fate-Sharing)**: Does origin traffic fail-open if the monitoring sidecar crashes?
4. **NET-4 (Loop-Freedom & Damping)**: Does the rule set pass the hairpin, isolation and conflict checks, and are dynamic updates damped?
5. **NET-5 (Buffer Dynamics & AQM)**: Are malicious drops executed in `PREROUTING` before socket instantiation?
6. **NET-6 (MTU/MSS & Framing)**: Is TCP MSS clamped to 1460 bytes (or overlay budget) across tunneling or encapsulation interfaces?

### Step 4: Synchronize High-Level Development State

1. Review progress across active roadmaps:
   - [ROADMAP.md](../../docs/ROADMAP.md) (testbed and verifier tracks A to D).
   - [SENTINEL-ROADMAP.md](../../docs/SENTINEL-ROADMAP.md) (frozen; out of current scope).
2. Update milestone statuses, completed tasks, and newly discovered blockers in [.agents/network-context.md](../network-context.md).

### Step 5: Deliver Context Audit Summary

Output the structured network review to the operator and record any architectural changes in [.agents/audit-log.md](../audit-log.md).
