# Rate ladder: 600-byte UDP capacity vs quarantine-rule depth (2026-10-04)

Source: `depth-ladder-base-*.json` and `depth-ladder-fwdfirst-*.json` (one round each, 45 s steps, offered 500 ... 15,000 pps of 572-byte UDP payload = 600-byte IP packets, rule depth = quarantine DROP rules in addition to 2 forwarding rules). Single round per layout, so treat every number as one observation, not a distribution.

## Capacity by depth (packets/s the switch forwarded when saturated)

| Quarantine rules | Base layout (quarantine rules first, higher priority) | Forwarding-first layout (forwarding rules installed first, higher priority) |
| --- | --- | --- |
| 0 | at least 14,807 (not saturated up to 15,000 offered) | not measured (session lost, see below) |
| 16 | 8,053 | 12,692 |
| 32 | 5,224 | 10,000 |
| 64 | not reached (clean at 2,000; session lost at 4,000) | clean at 6,000; session lost at 8,000 |
| 126 | 1,710 | 4,497 |

At 600 bytes, 1,000 pps is 4.8 Mbit/s of payload: 8,053 pps is 38.7 Mbit/s, 5,224 pps is 25.1, 1,710 pps is 8.2, and 12,692 pps is 60.9. The roadmap's 20,800 pps (100 Mbit/s) is not reached at any measured depth.

## Per-packet cost is linear in rule count (n = 3 points per fit)

- Base layout: 1 / capacity = 57.3 µs + 4.19 µs x rules. Predicts about 17,400 pps at 0 rules, 6,300 at 24 and 1,700 at 126.
- Forwarding-first layout: 57.9 µs + 1.3 µs x rules (capacity 78.8, 100 and 222 µs per packet at 16, 32 and 126 rules).
- Same fixed cost (~58 µs per packet, about 17k pps) in both layouts; the forwarding-first layout cuts the per-rule cost by roughly 3x. Consistent with a software lookup whose cost depends on where in the table a packet matches.
- Fits use three saturated points each; the exact intercept and slope should be confirmed with the full sweep (more depths, 4 rounds).

## Session loss

- The switch lost its OpenFlow session when offered load reached roughly 1.3-2.3x capacity in every run that overloaded it (base: 12,000 pps at 16 rules, 8,000 at 32, 4,000 at 64 and 126).
- Throughput above capacity (up to 1.25x) was survived for 45 s without losing the session (16 rules: 10,000 offered, 8,053 forwarded).
- Echo round trips stayed 0.5-1.5 ms in normal steps and the switch recovered and answered within about 1 s of the load ending.

## Unexplained: a session loss at low load

Forwarding-first layout, 0 rules, 4,000 pps offered (about a quarter of the ~17k pps capacity): the controller's dead-peer rule fired after the switch was silent for more than 8 s (a 6.9 s gap at 13.8 s into the step, session closed at 21.8 s), although every echo reply received in the step was fast (0.5-1.3 ms). Load was far below capacity, so this loss is not explained by overload. One occurrence in about 60 ladder steps; cause unknown, and the depth-0 forwarding-first capacity is therefore not measured.

## Caveats

- One round per layout.
- Receiver-side "loss" is a constant ~1.2-1.3 % offset at every rate below saturation (it matches the switch's own ingress count falling short of the nominal rate), so it is a measurement artifact, not downstream loss.
- Switch CPU load was not measured directly.
