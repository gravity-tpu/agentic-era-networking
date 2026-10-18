# Per-source baseline detector and the enforce guard (design)

Status: design with an offline prototype. Nothing here runs on the rack. Measured numbers cite
`docs/benchmarks/results/labelled-runs/`; everything else is marked as a judgment or a plan.

## Why

On the 23 labelled runs neither existing detector can drive anything automatic: the trt daemon's rate rule (10 packets per
second per source) flags 12 of 18 benign runs, and the GPU sentinel (untrained, hand-set constants) flags 11 of 18. The rate
rule also misses a scan that finishes in 0.36 s and one that runs at 2.5 pps. The task is a detector whose behaviour on
ordinary traffic and on attacks is measured, explainable feature by feature, and gated before it may act.

## What the data say

Per run, for the run's own sender (`scripts/baseline-features.py`, output `baseline-features-2026-10-18.txt`):

| Feature (largest value in the run) | Largest benign | Attack values |
| :--- | ---: | :--- |
| SYN-without-ACK per second | 10 (HTTP at 20 requests/s) | 198 and 936 (floods), 987 (fast scan), 3 (slow scan), 0 (UDP flood) |
| Distinct destination ports in 10 s | 1 | 987 (fast scan), 25 (slow scan), 1 (floods) |
| Non-TCP bytes per second | 7,242 | 697,928 (UDP flood) |
| Non-TCP frames per second | 51 | 484 (UDP flood) |

No single feature separates every attack from every benign run, but **each attack has a feature that separates it from
all benign runs by a wide margin**, measured against the largest benign value: 20 and 94 times for the SYN floods (198 and
936 against 10), 96 times for the UDP flood's bytes (and 9.5 times for its frames), and 25 and 987 times for the slow and
fast scans (25 and 987 distinct ports against 1). That is the basis for a union of explicit per-feature rules.

## The detector (v1)

Per source IPv4, per one-second bucket, all integer counts on kernel arrival timestamps:

| Feature | Counts | Catches |
| :--- | :--- | :--- |
| `nontcp_pps`, `nontcp_bytes` | non-TCP IP frames and their wire bytes | UDP or ICMP floods |
| `syn_per_s` | TCP SYN without ACK | SYN floods, fast scans |
| `ports_10s` | distinct TCP/UDP destination ports in the last 10 s | scans, fast or slow |

TCP data volume is deliberately **not** a feature: a bulk transfer is benign and is not yet recorded, so any rule on it would
be a guess (modelled, not measured: a 10 Mbit per second TCP stream is about 1.25 MB per second, which would exceed a
100,000 byte floor if TCP bytes were counted).

- **Threshold per feature** = `max(FLOOR, MARGIN x the largest value that feature took in the benign training runs)`, with
  `MARGIN = 3` and floors of 100 frames, 100,000 bytes, 30 SYN and 10 ports.
- **Damping** (Invariant 5): alert when a feature is over its threshold in at least 2 of the last 3 buckets; a value at
  `SEVERE = 10` times its threshold alerts on a single bucket (a burst that ends inside one second would never collect two).
- **Re-arm**: one report per episode, and a source can be reported again after 5 quiet buckets (the daemon today reports a
  source once until it restarts).
- **Report**: a request to the bridge's `/api/sdn/quarantine` with the feature values, the thresholds and the buckets that
  triggered it as evidence, and a `detector` field naming the detector and its thresholds hash. The bridge, not the
  detector, decides propose or enforce (it already does) and applies the envelope.

All of these are named constants, bounded and configurable (Invariant 5). The thresholds live in a committed, versioned
file produced by an offline script from the labelled benign runs, not computed online.

### Offline result (prototype `scripts/baseline-detector.py`, 23 runs)

| Scoring | Attacks detected with the right sender | Benign runs with an alert |
| :--- | :--- | :--- |
| In sample (thresholds from all benign runs) | 5 of 5 | 0 of 18 |
| Leave one benign family out (ping, idle, HTTP, small UDP), with floors | 5 of 5 in every fold | 0 of 18 |
| The same, thresholds from data only (no floors) | 5 of 5 | **5 of 18** |

Read the last row carefully. Thresholds learned only from the other workload families **false-alert on every held-out HTTP
run**, because no other family ever sent a SYN. A baseline learned from a few workloads cannot know a workload it has not seen,
and a floor is what prevents that. The floors are **judgment, not measurement**: the data only show the benign runs sit far
below them and the attacks far above. Every number in this table is on one repeat of each attack pattern by two tools
(`hping3`, `nmap`), so it is a feasibility result, not a performance claim.

Time to alert: floods 0 to 1 s after the first frame, the fast scan 0 s (through the severe path), the slow scan 5 s.

## Decisions

1. **v1 uses a global benign envelope, not a learned baseline per host.** "Per source" means each host's features are
   counted and judged separately, so one noisy host cannot hide another and an alert names the right host. A per-host *learned*
   baseline (each host's own history raising its own thresholds) would let heavy but legitimate hosts run hotter, but it lets
   an attacker raise its own threshold by ramping slowly (baseline poisoning). It is deferred until a host with a legitimately
   heavier profile exists and the data to bound the adaptation (a hard ceiling, slow decay, learning only from quiet buckets)
   have been recorded. This is a decision for the owner.
2. **Counting is decoupled from the GPU.** The trt daemon runs one TensorRT inference per frame, which limits it to about
   300 frames per second (it dropped 3,458 frames in the flood runs). None of these features needs a model, so the detector
   is a separate process reading the tap with kernel timestamps, with its own fate: if it dies, detection stops visibly (a
   heartbeat in telemetry) and nothing else is affected.
3. **Memory and time are bounded**: at most 1,024 tracked sources (oldest evicted), 10 buckets of ports per source, and a
   per-source set of at most 1,024 ports (past that the count is reported as "at least").

## What it does not do

- **Low and slow.** A scan below about 1 port per second (10 ports in 10 s) is invisible. A second, 60-second port window
  would push the limit to about 0.5 port per second; there is always a rate below which nothing is flagged.
- **TCP floods that look like data.** An ACK or data flood passes, because TCP data volume is not a feature.
- **Spoofed sources.** Source addresses are forgeable on the untrusted segment; an alert can name a forged host (the bridge's
  envelope and protected list limit what that can do).
- **Workloads not in the data.** Bulk TCP, ssh, browsing and Tailscale-style traffic are not recorded; each can cross a
  floor. They must be recorded before the thresholds are frozen.
- **A coordinated mix** below every threshold at once.
- It is a threshold on a few counters, chosen from a small set of runs; it is explainable, not intelligent.

## Evaluation

Every change is scored on the labelled runs by the same code path the live detector uses (the live detector and the replay
share one module, with a test that replaying a capture gives the live detector's alerts exactly). Required before any claim:

1. Record what is missing: bulk TCP at several rates, ssh sessions, a browser-like mix, Tailscale-style traffic, an idle
   baseline over hours, at least three repeats of every attack pattern, slow scans at several rates, ARP and address-spoofing
   attacks.
2. Re-derive and freeze the thresholds, then score on **runs recorded after** the freeze (not on the data they came from).
3. Report recall, benign false-positive rate with its upper bound, time to alert and the evasion boundaries found.

## The enforce guard

Today `ZODIAC_QUARANTINE_MODE=enforce` is a switch and nothing checks whether the detector behind it has ever been scored.
The guard makes the evidence part of the switch:

- The scorer writes a **scorecard** (JSON): detector id and code hash, thresholds hash, a hash of the labelled-run files it
  scored, run counts per benign family and attack pattern, recall, benign false-positive rate with an upper bound (for zero
  false positives in n benign runs the upper bound is about 3/n), p95 time to alert, and the date.
- The bridge leaves `propose` for a detector only when `enforce` is set **and** a scorecard for that detector id passes
  configured bounds: at least 60 benign runs spanning at least 6 families that include bulk TCP, ssh, web, Tailscale-style and
  idle; benign false-positive upper bound at most 5%; at least 3 repeats of each of at least 5 attack patterns with recall at
  least 90%; scorecard younger than 90 days; the detector's code hash equal to the scored one. Requests from any detector
  without a passing scorecard are proposals whatever the mode says (so the unscored sentinel can never enforce).
- A failed check logs the reason, keeps `propose`, and reports it in the proposals endpoint.

**What the guard proves:** that someone produced a scorecard meeting the bounds for this exact detector build. **What it does
not:** it cannot verify the runs happened or were representative (a person can edit the file), and it does not make the
detector correct. It is an audit trail and a speed bump, not security.

## Rollout

| Step | What | Gate |
| :--- | :--- | :--- |
| 0 | Offline prototype (this document) | done |
| 1 | Record the missing traffic and the attack repeats | rack healthy (the harness checks) |
| 2 | Implement the service, the shared module and the replay-equals-live test | review |
| 3 | Shadow mode on the rack: reports as proposals only, compared with known activity for days | owner |
| 4 | Scorecard and the guard | review |
| 5 | Optional `enforce` for this detector only | owner decision |

## Decisions for the owner

1. A global benign envelope in v1 with per-host learning deferred (above), or learned baselines from the start.
2. The guard's bounds (60 benign runs, 6 families, 5% false-positive upper bound, 90% recall, 90 days) are proposals.
3. Whether recording the missing traffic (including bulk TCP, which coincided with the 2026-10-17 switch outage) should
   proceed now that the switch has been power cycled and the harness gates on a verified isolation readback.
