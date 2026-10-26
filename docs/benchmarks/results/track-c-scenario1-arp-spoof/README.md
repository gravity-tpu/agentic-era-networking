# Track C scenario 1 (ARP spoofing across P1 and P2): results

Generated from `run-2026-10-22/result.json`, following [`PREREGISTRATION.md`](PREREGISTRATION.md) (method, scope decision and predictions
fixed before any attack traffic was sent). Run at 2026-10-22 20:48 ET, bridge commit `cd3939a` on `main`.

## What happened

| Step | Result |
| :--- | :--- |
| Preflight (`adversary-bind.py`) | Passed: `eth1` (node-02's workload interface) safe to send on, `eth0` and `tailscale0` excused as declared control channels |
| Sent | 3 unsolicited ARP replies from node-02 (`eth1`, MAC `b8:27:eb:79:ff:0a`), claiming `10.0.2.119` (the Mac's workload-segment alias) |
| **O3 (ground truth, Zodiac P2 mirror)** | **All 3 crossed from P1 to P2**, plus a 4th frame (see below) |
| O2 (Zodiac P3 tap) | All 3 also reached P3, consistent with `p1-arp`'s declared output set `[P2, P3]` |
| Mac's own ARP cache for `10.0.2.119` | **Unchanged** (stayed `permanent`, the real MAC) |
| Corrective step | No-op: nothing needed correcting |
| Bridge health after | Isolation verified, 6/6 confirmed, 0 mismatches; no quarantine proposal raised |

## Prediction 1 (the spoofed ARP reaches P2): HOLDS

```text
20:48:30.865954 b8:27:eb:79:ff:0a > ff:ff:ff:ff:ff:ff, ethertype ARP (0x0806), length 60: Reply 10.0.2.119 is-at b8:27:eb:79:ff:0a, length 46
20:48:31.166346 b8:27:eb:79:ff:0a > ff:ff:ff:ff:ff:ff, ethertype ARP (0x0806), length 60: Reply 10.0.2.119 is-at b8:27:eb:79:ff:0a, length 46
20:48:31.466249 b8:27:eb:79:ff:0a > ff:ff:ff:ff:ff:ff, ethertype ARP (0x0806), length 60: Reply 10.0.2.119 is-at b8:27:eb:79:ff:0a, length 46
```

All 3 crafted frames appear verbatim on O3, the mirror of the Zodiac P2 link — physical proof the switch forwarded them from the workload
segment to the uplink. This confirms, on the real switch and not just the model, that `p1-arp` forwards ARP from P1 to P2 with no
constraint on the claimed address: **property A10 (ARP confinement) is not implemented on this firmware.** The roadmap listed A10 as
"blocked on verifying `ARP_SPA`/`ARP_TPA` support in firmware 0.86" — this result answers that: the firmware does not filter on it.

## Prediction 2 (the Mac's cache changes): DOES NOT HOLD — and a fourth frame shows why

The Mac's `arp -n 10.0.2.119` read unchanged, before and after. The pre-registration's amendment anticipated this could happen for a
host-side reason unrelated to the switch (macOS protects a `permanent` entry for its own address). The capture shows something more
specific than passive resistance:

```text
20:48:39.136563 f2:5b:dc:7d:21:d4 > b8:27:eb:79:ff:0a, ethertype ARP (0x0806), length 60: Reply 10.0.2.119 is-at f2:5b:dc:7d:21:d4, length 46
```

This is the Mac's own real MAC (`f2:5b:dc:7d:21:d4`), sending its own gratuitous ARP reply, **addressed directly to the adversary's MAC**
(not broadcast) — macOS detected the conflicting claim and sent a corrective announcement straight back to the source of it, about 8
seconds after the spoofed frames. This was not predicted in advance (the pre-registration's amendment anticipated passive protection via
the `permanent` entry, not an active counter-reply); it is a genuine finding, not something the switch's policy had anything to do with.

## Prediction 3 (no detector reaction predicted either way): holds, weakly

No quarantine proposal was raised and the bridge's isolation status stayed verified throughout. Per the roadmap, the GPU autoencoder
detector's precision and recall against this class of attack are still unmeasured — a 3-packet, sub-second spoof may simply be far below
whatever threshold it would need to react to. This result says nothing about whether a sustained campaign would be noticed; it was not run.

## What this does and does not say

- **Contained at the switch: no.** The policy has no mechanism to stop this, and now there is a measurement showing it, not just an
  inference from the model.
- **Contained at this particular host: yes, but not because of anything the network did.** macOS's own `permanent`-entry protection and
  active counter-announcement are specific to an address the host itself owns. The scope decision for this run was deliberately a host we
  own (`10.0.2.119`, the Mac's alias) rather than the real household gateway; a third-party device without this specific OS behavior, or an
  address nobody currently holds, would very likely behave differently. This result does not generalize past the host tested.
- **One switch, firmware 0.86, one run, one claimed identity, one OS.** Per the pre-registration's stated limits.

## Follow-up

- `docs/ROADMAP.md` Track A, property A10: update from "blocked" to "confirmed not implemented on firmware 0.86" per this result.
- Track C's exit criteria call for "any scenario that defeats the policy produces a new verifier property in track A" — this scenario
  defeated it (P1→P2 crossing with no address constraint), so A10 should move from blocked to an active item: a verifier check that
  refuses to claim ARP confinement unless the switch is shown to filter on SPA/TPA, which this result shows it does not.
- Worth a second run against a target address nobody currently holds (no permanent entry, no active defender), to separate "the switch
  didn't stop it" from "the host happened to defend itself" more cleanly than this run's scope decision allowed.

## Re-run against the deployed A10 fix (2026-10-25)

Generated from `run-2026-10-25c/result.json`, same method and target as the original run above, against bridge commit `72659d7` on
`main` (per-host ARP_SPA confinement, PRs #111/#114) deployed live and readback-verified on the Jetson (`/api/zodiac`'s
`port1Isolation.state: "verified"`, all 7 rules including `p1-arp-allow-10.0.2.50`/`p1-arp-allow-10.0.2.52` confirmed against the switch).

### What happened

| Step | Result |
| :--- | :--- |
| Preflight (`adversary-bind.py`) | Passed: `eth1` safe to send on, `eth0`/`tailscale0` excused as declared control channels |
| Sent | 3 unsolicited ARP replies from node-02 (`eth1`, MAC `b8:27:eb:79:ff:0a`), claiming `10.0.2.119` (not a listed workload host) |
| **O3 (ground truth, Zodiac P2 mirror)** | **0 of 7 ARP frames matched the spoofed claim** |
| O2 (Zodiac P3 tap) | All 3 reached P3, consistent with the `p1-default-tap-only` fallback for a non-allowlisted ARP_SPA |
| Mac's own ARP cache for `10.0.2.119` | Unchanged |

### Prediction (the spoofed ARP no longer reaches P2): HOLDS

```text
o3.matchingHits: []   (0 of 7 ARP frames)
```

No frame claiming `10.0.2.119 is-at b8:27:eb:79:ff:0a` appears on O3. Unlike the 2026-10-22 run, where all 3 crafted frames crossed
verbatim, the per-host ARP_SPA allowlist now stops the claim at P1 — it falls through to `p1-default-tap-only` (tap only, never
the uplink) because `10.0.2.119` is not one of the two listed workload hosts (`10.0.2.50`, `10.0.2.52`).

### Two confounds found and resolved before this result could be trusted

Two unrelated problems surfaced during this re-run and are recorded here because they affect how much weight this result should carry:

1. **A test-harness matching bug** (`scripts/track-c-scenario1-arp-spoof.py`'s `frames_claiming()`): an earlier run (`run-2026-10-25b`)
   showed 1 "hit" on O3 that turned out to be a false positive — a legitimate corrective ARP reply from the Mac's own real MAC,
   addressed *to* the adversary, was miscounted because the old check matched the adversary's MAC appearing anywhere in the tcpdump
   line (including as a unicast destination), not specifically as the claimed `is-at` binding. Fixed to require the literal string
   `"<target_ip> is-at <adversary_mac>"`.
2. **A standing topology change that briefly bypassed the switch** (`.agents/network-context.md` caveat 11): while debugging (1),
   it emerged that `zodiac_netgear_2`'s ports 1/2 (node-01/node-02 management NICs) had been placed on the same VLAN as port 4
   (the Zodiac's own P2 uplink link), to restore wired SSH access during a Wi-Fi outage. This gave both workload nodes a second,
   switch-bypassing L2 path onto the exact segment this scenario measures — a confound bigger than the harness bug, since it meant
   an adversary wouldn't need to defeat the policy at all. Re-split into three VLANs (`1,2,5` / `4` / `3`) before this run.

With both resolved, `run-2026-10-25c` is a clean, confound-free measurement: the per-host ARP confinement policy holds on real
hardware, through the actual switch, with no alternate path available to the adversary node.

### What this does and does not say

- **Contained at the switch: yes**, for the workload→uplink direction, for this claimed address, against this one adversary node,
  on this firmware. This directly answers the 2026-10-22 result's open question ("the switch didn't stop it") — on the deployed
  fix, it now does.
- **Still open**: the uplink→workload direction (`p2-arp`) remains unconfined by design — not exercised by this scenario, not
  claimed fixed here. See `docs/ROADMAP.md`'s A10 entry and `src/sdn/port1-isolation.ts`'s docstring.
- **One switch, firmware 0.86, one run, one claimed identity (not one of the two listed hosts), one adversary node.** A run from
  node-01 or claiming a different non-listed address was not repeated here; the policy's logic (exact-match allowlist, not a
  property of which node sent it) makes this an acceptable scope limit, not a gap expected to behave differently.

### Follow-up

- `docs/ROADMAP.md` Track A, property A10: workload→uplink direction closes to "confirmed fixed on hardware, 2026-10-25" per this
  result (already reflected there from the PR #114 merge; this is the live-hardware confirmation of what that PR claimed).
- The VLAN-merge confound (caveat 11) is a standing lesson for any future switch reconfiguration done for operational convenience:
  re-verify the physical topology, not just the node-level preflight, after any change to a switch a control interface runs through.
