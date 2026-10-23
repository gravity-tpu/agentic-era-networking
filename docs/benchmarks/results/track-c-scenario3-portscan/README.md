# Track C scenario 3 (port scan and low-rate scan): results

Generated from the live run on 2026-10-22, following [`PREREGISTRATION.md`](PREREGISTRATION.md) (method, scope and
predictions fixed before any scan traffic was sent). Run at 2026-10-22 23:30–23:34 ET, bridge commit `54588fe` on
`main`. Raw sentinel log and O2 capture retained locally (`/tmp/scenario3-data/`, not committed: lab MAC/IP addresses
and sizes unsuited to the repo); the numbers below are taken directly from them.

## What happened

| Step | Result |
| :--- | :--- |
| Preflight (`adversary-bind.py`) | Passed: `eth1` safe to send on, `eth0`/`tailscale0` excused as declared control channels |
| Scan 1 (fast) | `nmap -sS -T4 -p 1-1000` from `agentic-node-02` (`eth1`) against `10.0.2.119`, completed in 0.80 s |
| Scan 2 (low-rate) | `nmap -sS -T2 -p 1-30 --scan-delay 2000ms`, same path, completed in 66.4 s |
| Rate rule (`zodiac-trt.service`, already live throughout) | No alert on either scan |
| GPU sentinel (started for this run, stopped after) | Fired heavily during the fast scan; see below for the low-rate scan, where the live log and an independent offline replica disagree |
| Quarantine proposals (`GET /api/sdn/quarantine/proposals`) | Empty before, during and after both scans |
| **Containment** | **Structurally impossible this run, regardless of detection** — see below |

## The quarantine pipeline was blocked before detection quality mattered

The sentinel's own log shows it tried: 939 anomaly detections, all correctly attributed to `10.0.2.52`
(`agentic-node-02`, the actual scanner — no misattribution, despite the detector survey's documented risk of naming a
bystander), each one dispatched as a quarantine request. **Every single dispatch, all 1,543 attempts across 3
retries each, came back `HTTP 403 Forbidden`.** The bridge's own journal explains why:

```text
Oct 22 23:33:40 jetson-orin zodiac-bridge[1001946]: [!] [Quarantine] Refused (protected): 10.0.2.52 is on the protected-host list
```

`/etc/zodiac/zodiac-bridge.env` sets `ZODIAC_QUARANTINE_PROTECTED_IPS=10.0.2.119,10.0.2.51,10.0.2.52`. `10.0.2.52` is
on that list because it was the "legitimate client" in the roadmap's original topology assignment — a role Track C's
own later work moved to `agentic-node-02` as the **adversary** (scenario 1, and confirmed again here) without ever
updating this config. The practical effect: **the detector can never result in `agentic-node-02` being quarantined,
no matter how correctly or confidently it is flagged.** This was not predicted in the pre-registration (which assumed
`propose` mode would produce a pending proposal on a correct detection) and is the single most important finding of
this run — a containment-pipeline gap caused by role drift between Track C's practice and the deployed system's
configuration, not a detector accuracy problem. It would equally have blocked scenario 1's adversary from ever being
quarantined, had anything there tried.

## Prediction 1 (rate rule fires on neither scan): HOLDS

`zodiac-trt.service` was already running throughout (confirmed live before the run). Its journal shows zero
quarantine, anomaly or alert lines in the run's time window. Consistent with the prior `labelled-runs` finding (0 of
10 scan runs caught): the fast scan finishes before its 0.5 s minimum window, and the low-rate scan's rate is far
below its 10 pps threshold.

## Prediction 2 (sentinel fires on the fast scan): HOLDS

The sentinel's own periodic counters show anomalies climbing to 910 of 910 inferences by its `[010s]` checkpoint —
effectively every window computed during and immediately after the fast-scan burst was flagged, well within a few
seconds of the first frame. First hit confirmed independently in an offline replay at **0.85 s** after the first
captured frame.

## Prediction 3 (sentinel misses the low-rate scan): HOLDS on the live system's own report, but an independent replay disagrees — disclosed, not resolved

The live process's own periodic counters are unambiguous on their face: cumulative anomalies are **939 at `[028s]`
and still exactly 939 at `[104s]`** (76 seconds later, spanning essentially the whole low-rate-scan window) — by the
live system's own accounting, it detected nothing new for the entire low-rate scan. This matches the pre-registered
prediction, grounded in the prior dataset's two half-pps misses.

However, an independent offline replay built for this run (the project's own `Adaptive` threshold class from
`scripts/sentinel-replay.py`, fed the same captured pcap, not an approximation) disagrees: it flags **37 of 141
windows (26.2%) during the low-rate-scan phase**, with a first hit timed right at the start of that phase. It also
counts a slightly different total number of windows overall (1,094 vs. the live process's reported 1,062 inferences,
a 3% difference plausibly from the two independent raw-socket listeners on the same tap interface dropping different
frames during the dense fast-scan burst, though this is not confirmed). This is a genuine, unresolved discrepancy
between the deployed detector's actual live behavior and a faithful-as-built reconstruction of its documented logic,
not a rounding difference to wave away. It is reported here rather than silently preferring whichever number matched
the prediction. Candidate explanations not yet checked: a subtle difference between the live kernel's native CUDA
path and the replica's arithmetic beyond the previously-validated 3e-8 (that validation was against idle/steady
traffic, not a transition from a dense burst into a sparse one); state the live process carries from the few seconds
before the capture started that the replica does not have; or a bug in one or the other's EMA bookkeeping across a
feature-normalization regime change (the `Extractor`'s `max_dt`/`max_len` are running maxima, so a burst followed by
sparse traffic changes the normalization basis for both, but not necessarily identically if frame sets differ).

**What this means for Prediction 3 as stated:** the live, authoritative system's own report supports it holding; an
independently-built check of the same documented math does not agree closely enough to call this settled. Flagged as
an open item, not resolved by this run.

## What this does and does not say

- **Detected: yes, for the fast scan, clearly, by both the deployed sentinel's own live counters and an independent
  replay. For the low-rate scan: the live system's own counters say no; a faithful offline reconstruction of its
  documented logic disagrees. Not settled.**
- **Contained: no, for either scan, independent of detection quality.** The quarantine pipeline refuses every request
  naming `agentic-node-02` before the question of whether detection was correct even matters. This is a config gap
  (stale protected-host list), not a policy or detector defect, and it is fixable by removing `10.0.2.52` from
  `ZODIAC_QUARANTINE_PROTECTED_IPS` now that it is no longer the legitimate-client role — not done here, since
  changing a live quarantine-relevant config mid-write-up was out of scope for this measurement.
- **Rate rule: confirmed blind to both profiles**, consistent with prior data and its own stated design (a packets-
  per-second count over a window too coarse for a fast scan and too strict a floor for a slow one).
- **One switch, firmware 0.86, one target, one sender, two scan profiles, single run each** (not repeats) — per the
  pre-registration's stated limits. The GPU sentinel's "weights" remain ten hardcoded constants, not a trained model.

## Follow-up

- **Done, 2026-10-22 23:44 ET, after this write-up was drafted:** `10.0.2.52` removed from
  `ZODIAC_QUARANTINE_PROTECTED_IPS` in `/etc/zodiac/zodiac-bridge.env` (now `10.0.2.119,10.0.2.51` — the Mac alias and
  the Pi 5 stay protected; neither is an adversary node), `zodiac-bridge` restarted and confirmed serving
  `live_hardware` telemetry normally afterward. Deliberately done as a separate, reviewed step after the measurement
  above, not folded into the run itself, so the numbers in this file describe what was actually observed with the
  stale config in place. Track C's current adversary node can now actually be quarantined by a detector that fires on
  it; this has not yet been re-tested (would need a fresh scan run in `enforce` mode or another approved proposal to
  confirm end to end).
- The live-vs-replay discrepancy on the low-rate scan is worth a dedicated follow-up before trusting
  `sentinel-replay.py`/`score-labelled-runs.py`'s numbers (including the prior `labelled-runs` dataset's own
  half-pps results) as a stand-in for the live deployed process's actual behavior under a burst-then-sparse traffic
  shape.
- Per Track C's exit criteria ("any scenario that defeats the policy produces a new verifier property in Track A"):
  this scenario did not defeat the OpenFlow isolation policy (A1–A11 are unaffected; this tests a detector, not the
  switch), so no new Track A property follows from it. The protected-host gap is a detector/containment config issue,
  tracked here and in a fix, not a new verifier property.
- Scenarios 2 and 4 remain unbuilt; this is 2 of 4 scripted toward the stated Track C exit criteria (1 and 3).
