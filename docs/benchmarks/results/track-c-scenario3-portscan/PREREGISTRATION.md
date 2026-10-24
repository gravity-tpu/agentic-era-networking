# Track C scenario 3 (port scan and low-rate scan): pre-registration

Written 2026-10-22, before any scan traffic is sent. Committed before the run, same convention as
[`track-c-scenario1-arp-spoof/PREREGISTRATION.md`](../track-c-scenario1-arp-spoof/PREREGISTRATION.md). Results go in
`README.md` next to this file; this file is not edited afterwards except to add a line saying what changed and why.

## The claim under test

Roadmap, Track C, scenario 3: "Port scan and low-rate scan." This is the **first Track C scenario to exercise a
detector at all** — scenarios 1 and 2 test the switch policy, not detection. Both the Jetson GPU sentinel
(`scripts/gpu-sdn-anomaly-sentinel.py`) and the "rate rule" (`scripts/trt-inference-daemon.py`) are candidate
detectors fed by O2 (the Zodiac P3 tap); per the roadmap, their precision and recall are "unmeasured today and become
a result of this track."

**This is not starting from zero.** `docs/benchmarks/results/labelled-runs/` already contains 10 recorded, scored
nmap port-scan runs (fast, slow, 1pps, half-pps) against this same target, through this same tap, scored by replicas
of both detectors (`docs/benchmarks/results/labelled-runs/README.md`). Those runs were recorded as training/scoring
data, not pre-registered as a Track C scenario, and used `agentic-node-01` as the sender — the role assignment in
place before Track C's own adversary-node work settled on `agentic-node-02` (`docs/design/track-c-adversary-network.md`).
This scenario replicates that prior work as a fresh, pre-registered, live run under Track C's own methodology and
current role assignment, rather than retroactively relabeling the old data as a Track C result.

## Scope decision (owner, 2026-10-22)

**Target: the Mac's workload-segment alias, `10.0.2.119`** — the same host used in scenario 1 and in the prior
`labelled-runs` dataset. This is a hard topology requirement, not a preference: `agentic-node-01`, `agentic-node-02`
and `rpi-hailo` all sit behind the same NETGEAR switch (switch #1), and unicast IP traffic between hosts on that
switch is L2-forwarded directly, port to port — it never transits the Zodiac at all. This is independently measured
twice already: Track B's T3 test (`docs/ROADMAP.md`, "node-01 pings node-02 ... never reaches the Zodiac") and
`labelled-runs.py`'s own note ("HTTP and iperf3 runs to the Pi 5 left 0 sender frames at the tap"). A scan of
`agentic-node-01` or `rpi-hailo`'s workload address would therefore produce only ARP traffic at the tap (ARP is an L2
broadcast and crosses regardless of destination), not the TCP SYN traffic this scenario needs to measure. Moving a
second interface onto `rpi-hailo` to put it on the uplink side was considered and rejected for this run: it adds
physical risk to the Pi 5's existing O1 sensor role for no measurement benefit, since the Mac's alias already
satisfies the requirement alone.

**Adversary (sender): `agentic-node-02`**, via its `eth1` workload interface, gated by `scripts/adversary-bind.py`'s
`preflight()` the same way scenario 1 was. A deliberate deviation from the `labelled-runs` dataset's sender
(`agentic-node-01`): node-02 is Track C's current adversary-role node, with its control channel and bind-safety setup
already built and proven in scenario 1.

**Quarantine mode: `propose`** (the bridge's default; confirmed live before this write-up — no pending proposals,
no env override). This run measures detection, not containment: a correctly flagged scan will produce a proposal, not
an installed flow-mod.

## Method (fixed in advance)

- **Safety bounds**, reused from the already-reviewed `scripts/labelled-runs.py` caps rather than inventing new ones:
  `MAX_RUN_SECONDS=120`, `MAX_PPS=2000`, `MAX_PACKETS=20000`. Both scans below run comfortably inside these.
- **Scan 1 ("fast"):** `nmap -sS -T4 -p 1-1000 -n -Pn --max-retries 0 10.0.2.119` from `agentic-node-02`, bound to
  `eth1`. Same parameters as `attack-portscan-fast` in the prior dataset (finished in 0.36 s there).
- **Scan 2 ("low-rate"):** `nmap -sS -T2 -p 1-30 -n -Pn --max-retries 0 --scan-delay 2000ms 10.0.2.119` from the same
  host. Same parameters as `attack-portscan-half-pps`, the specific variant the prior dataset's sentinel replica
  missed on both repeats.
- **Privilege:** `sudo setcap cap_net_raw,cap_net_admin+eip $(which nmap)` on `agentic-node-02` (operator-run, not
  passwordless sudo, consistent with the capability-grant approach chosen for scenario 1's raw ARP sender).
- **Detector state, set up before either scan:**
  - The rate rule (`zodiac-trt.service`) is already live on the Jetson (confirmed running) — no action needed.
  - The GPU sentinel (`gpu-sdn-sentinel.service`) is confirmed **not running** (inactive, disabled, never started on
    this box). Started manually for this run with an explicit `--tap-iface enx9c69d39dd0a6` flag — the systemd unit
    file's own documented default interface name is wrong (points at the OpenFlow control NIC, not the O2 tap; see
    the detector survey below), so the service file is not used as-is for this run. Stopped again after the scenario
    ends; this is a one-off measurement, not a decision to leave it running.
- **Observation, independent of each other:**
  1. **Live, during the run:** `GET /api/sdn/quarantine/proposals` polled immediately before, during, and after each
     scan, to catch a live proposal and its wall-clock arrival time.
  2. **Live, during the run:** the GPU sentinel's own stdout, redirected through a wrapper that stamps each line with
     wall-clock time (its own prints carry only a monotonic counter, not wall-clock time — a known gap, see the
     detector survey).
  3. **Independent, after the run:** a raw tcpdump capture of the same O2 tap interface, taken in parallel with both
     scans (same detached-capture technique as scenario 1: `setsid`-launched, PID-tracked, stopped after a fixed
     settle window), scored afterward with `scripts/sentinel-replay.py` — the proven, timestamp-accurate methodology
     already used to produce the `labelled-runs` numbers, used here as the primary record rather than the live
     process's own unstamped stdout.
- **Scoring definitions**, matching the detector survey's recommendation: "detected" = a stdout/journal
  threshold-breach line and/or a quarantine proposal whose named offender IP is `agentic-node-02`'s, correlated in
  time with a scan window. "Missed" = a scan ran and nothing fired anywhere in that window. "False positive" = an
  alert naming a different offender, or firing outside both scan windows.
- **Corrective step:** none needed — a port scan leaves no persistent state on the target or the switch to undo,
  unlike scenario 1's ARP cache poisoning.

## Predictions

Grounded in the already-measured `docs/benchmarks/results/labelled-runs/README.md` numbers for the identical target,
tool and parameters (different sender; see scope decision):

1. **The rate rule will not fire on either scan.** Measured finding: it caught 0 of 10 scan runs in the prior
   dataset — the fast scan finishes before its 0.5 s minimum window, and the slower scans run at or below its 10 pps
   threshold. No reason to expect a different sender changes this.
2. **The GPU sentinel will fire on the fast scan.** Measured finding: it caught the fast-scan variant in 2 of 3 prior
   repeats (missed one, `attack-portscan-fast-r3`). Predicted to fire here, with a residual chance of a miss
   consistent with that one prior miss.
3. **The GPU sentinel will not fire on the low-rate scan.** Measured finding: it missed both prior half-pps repeats.
   If it does fire here, that would be a reversal of the only consistent negative result in the prior dataset and
   is flagged in advance as the single most informative possible outcome of this run.
4. **No flow-mod is installed in either case** (bridge is in `propose` mode throughout); any alert produces, at most,
   a pending proposal.

## What would count against the predictions

- A rate-rule alert on either scan would contradict its measured 0/10 and would need to be checked against whether
  the daemon's configuration changed since the prior recording, not assumed to be sender-dependent.
- A sentinel miss on the fast scan (beyond the already-expected ~1-in-3 chance) or a sentinel hit on the low-rate scan
  would both be directly reportable findings about detector consistency, not noise to explain away.
- Any proposal naming an offender IP other than `agentic-node-02`'s workload address would be a false attribution,
  not evidence of detection, per the detector survey's known weakness (offender = most frequent src IP/MAC in the
  64-packet window, which can misattribute a bystander).

## Limits stated now

One switch, firmware 0.86. One target (`10.0.2.119`), one sender, two scan profiles out of the four already recorded
(fast and half-pps — the two profiles the prior data disagree most sharply on; slow and 1pps are not re-run here).
The GPU sentinel's "weights" are ten hardcoded constants, not a trained model (disclosed in
`docs/benchmarks/results/sentinel-detection/README.md`); this scenario reports what a fixed arithmetic function does
on live wire traffic, not what a trained classifier would do. Single run per scan profile, not repeats — the prior
dataset's repeat-level variance (the fast scan's 1-in-3 miss) is cited as context, not replicated here. The GPU
sentinel is started specifically for this measurement and stopped afterward; this says nothing about multi-day
unattended operation.
