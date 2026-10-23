# A deterministic port-scan rule, measured against the labelled-runs dataset

Follow-up from [Track C scenario 3](../track-c-scenario3-portscan/README.md): the GPU sentinel's detection of a
fast port scan was not reproducible run to run (one live run fired strongly, an immediate identical retry produced
zero anomalies), and its detection of the low-rate scan remains genuinely unresolved (the live process and an
independent replay of its own documented math disagree). The sentinel's four features (inter-arrival time, frame
length, protocol/flags, port distance) have no representation of "one source touching many distinct destination
ports" at all — the actual signature of a port scan, and the one real NIDS tools (Snort, Suricata) check directly.
`scripts/portscan-rule-detector.py` adds that signature as its own deterministic detector.

## Method

Per `(source IP, destination IP)` pair, track the distinct destination TCP/UDP ports contacted within a trailing
time window; alert when the count reaches a threshold. Measured, not assumed: `--validate` runs this exact logic
against `docs/benchmarks/results/labelled-runs/` (51 recorded runs, 27 benign, 18 attack scored + 3 ARP-flood runs
not meaningfully comparable since ARP carries no TCP/UDP ports).

```text
python3 scripts/portscan-rule-detector.py --validate docs/benchmarks/results/labelled-runs
```

## What the data says about window size and threshold

Max distinct destination ports seen by any sender, to any one destination, within windows of several sizes:

| Workload | 5 s | 30 s | 60 s |
| :--- | ---: | ---: | ---: |
| **Every benign run** (ping, HTTP, bulk TCP, interactive, UDP small/burst, idle) | 0–1 | 0–1 | 0–1 |
| `attack-portscan-fast` (`nmap -T4`, 1000 ports in 0.36–0.86 s) | 987–998 | 987–998 | 987–998 |
| `attack-portscan-slow` (`-T2`, 200 ports, ~80 s) | 13 | 75 | 150 |
| `attack-portscan-1pps` (1 probe/s) | 5 | 30 | 60 |
| `attack-portscan-half-pps` (1 probe/2s — the profile the GPU sentinel misses) | 3 | 15 | 29 |
| Floods (`synflood`, `udpflood`) and `arpflood` | 0–1 | 0–1 | 0–1 |

**No benign run, at any window size tested, exceeds 1 distinct destination port to any one destination.** Every
port-scan profile, including the slowest one tested, reaches at least 15 within 30 s. That gap (1 vs. 15) is wide on
both sides, which is why the defaults below don't need to be finely tuned to this one dataset.

## Defaults, and why

- `WINDOW_SECONDS = 30`, `DISTINCT_PORT_THRESHOLD = 5` — comfortably above the measured benign ceiling (1) and
  comfortably below the slowest measured attack's 30 s count (15). Both are named, env-overridable constants in
  `scripts/portscan-rule-detector.py` (Invariant 5: no buried magic numbers).
- `MAX_TRACKED_PAIRS = 4096` bounds memory: oldest-inserted `(src, dst)` pair is evicted first if the table fills,
  far above anything this lab topology produces.
- `ALERT_COOLDOWN_SECONDS = 30` stops one scan from re-dispatching a quarantine request on every subsequent packet
  once already over threshold.

Detection latency falls out of the same numbers, not a separate tuning: the window only bounds how far back distinct
ports are counted from, not how long the detector waits before checking. The fast scan crosses 5 distinct ports
within tens of milliseconds; the half-pps scan (1 port every 2 s) crosses it in about 8–10 s; 1pps in about 5 s —
all faster than the GPU sentinel's inconsistent response to the same traffic.

## Validation results

```text
attack runs detected (right sender): 10/21
benign runs with any alert (false positives): 0/30
runs naming a non-sender: 0/51
```

The 21-run "attack" denominator includes 6 synflood runs, 2 udpflood runs and 3 ARP-flood runs that this rule is not
designed to catch (no distinct-port signature exists in a flood to one port, or in ARP, which carries no TCP/UDP
ports at all) — correctly not flagged, not a false negative against this rule's actual scope. Narrowed to the
runs this rule targets: **10 of 10 port-scan runs detected (fast, slow, 1pps, half-pps, including repeats), 0 of 30
benign runs false-positived, 0 misattributions.** This is a stronger and more consistent result on this dataset than
either existing detector: the rate rule caught 0 of the 10 scan runs; the GPU sentinel caught most but not
reproducibly (see the scenario 3 write-up for a live demonstration of that inconsistency).

## What this does and does not say

- **Scope is narrow by design.** This rule only sees multi-port probes. It is blind to floods, single-port attacks,
  ARP-based attacks, and anything that doesn't touch many distinct ports on one destination — it is meant to sit
  alongside the GPU sentinel and the rate rule, not replace either.
- **One dataset, one lab topology, short runs.** The clean separation (benign ≤ 1, attack ≥ 15 at 30 s) is a real,
  measured gap on this data, but it is 51 runs from one rack. A legitimate client that happens to contact many
  different services on a single host within 30 s (not present anywhere in this dataset) would be indistinguishable
  from a scan under this rule alone; this is a known, disclosed limit, not a claim that false positives are
  impossible in general.
- **Not yet deployed live.** This script runs the same raw-tap-to-`/api/sdn/quarantine` pattern as the other two
  detectors, but has not been run against the live switch or started as a service. That is a separate, deliberate
  step (same as every other live-hardware change this session), to be done only after the owner reviews this
  write-up.

## Follow-up

- Run it live (same tap, same scan scripts as Track C scenario 3) to confirm it behaves the same way on real-time
  wire traffic as it does replaying the recorded captures — a replay-only validation is not the same guarantee as a
  live run, per this project's own standard for every other detector and policy claim.
- Consider running it alongside the GPU sentinel permanently rather than instead of it: the two catch different
  attack shapes, and a scan that somehow evaded one (crafted to avoid distinct ports, e.g. a single-port repeated
  probe) is exactly the kind of traffic the other was built to catch.
