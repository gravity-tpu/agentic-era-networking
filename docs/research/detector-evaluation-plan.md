# Detector precision and recall: what is measured, what is missing, and a plan (DRAFT)

**Status: an unregistered draft by the operator (a Claude Code session), written 2026-11-09 for the owner's decision. Nothing here is authorised: no recording or run starts until the owner approves it and a commit registers the final text before any data. It does not change any recorded result.**

## 1. Why this page exists

The README and the roadmap say "detector precision and recall are unmeasured", and the Hailo-8 entry criterion (a) in `docs/ROADMAP.md` is that "the Jetson detector has measured precision and recall on labelled captures from track C". Reading the results directory, that statement is **too coarse**: several detector scores exist, on small lab datasets and on a public dataset, with stated limits. This page lays out what exists, what "precision and recall" would have to mean to meet the criterion, what is missing, and whether a Runpod pod helps.

## 2. What is measured today

All numbers are copied from the linked results; they are per run unless said otherwise.

| Detector | Data | Result | Source |
| :--- | :--- | :--- | :--- |
| GPU sentinel, deployed (ten hard-coded constants, no training) | 27-run held-out lab split (9 benign, 18 attack) | 15 of 18 attacks caught with the right sender; 4 of 9 benign runs raise a false alert | `sentinel-training/README.md` |
| Same, on the 13-attack lab held-out set | lab held-out | 10 of 13 attacks | `sentinel-training-two-anchor/CAMPAIGN-SUMMARY.md` |
| trt daemon rate rule (10 packets per second per source) and the untrained sentinel, on all scored runs | 45 scored labelled runs | the rate rule flags 21 of 27 benign runs and misses every scan run (10 of 10); the sentinel flags 12 of 27 benign runs | `docs/design/per-source-baseline-detector.md` |
| Trained weights (fitted on lab runs) | same 27-run split | 4 of 18 attacks, 0 of 9 false alerts: not an improvement under the pre-registered rule | `sentinel-training/README.md` |
| Two-model ensemble (batch 13; **not deployed**) | CIC-IDS2017 Wednesday and Friday, plus lab held-out | Hulk and GoldenEye recall 100%, CIC-benign false positives 0.00% and 0.25%, lab held-out 10 of 13, **lab benign false alerts 5 of 9** | `CAMPAIGN-SUMMARY.md` |
| Same ensemble on CIC classes it was not fitted on | CIC Slowhttptest, slowloris, DDoS | recall 2.3% to 3.5% on two, 16.2% on slowloris | `CAMPAIGN-SUMMARY.md` |
| Deterministic port-scan rule | the labelled runs | validated by `--validate`; detail in its README | `portscan-rule/README.md` |
| Per-source baseline detector | labelled runs | an offline prototype; "nothing here runs on the rack" | `docs/design/per-source-baseline-detector.md` |

The two held-out sets above (27 runs, and 13 attacks) are different splits, and the baseline scores 15 of 18 on one and 10 of 13 on the other; this page does not reconcile them.

Live, on the rack: Track C scenario 3 found the sentinel's fast-scan detection not reproducible run to run (one run fired strongly, an identical retry produced zero anomalies) and its low-rate scan detection unresolved.

## 3. What is missing for the claim the roadmap wants

1. **No single, defined measurement.** The existing figures mix run-level counts ("caught the attacker in the run") with window-level rates on CIC. "Precision and recall" needs one stated unit. This draft proposes the **run** (the pcap is the run, as in `labelled-runs.md`) as the primary unit, with the first-alert delay as a second metric, and window-level rates reported separately and labelled as such.
2. **Small samples, no intervals.** 9 benign and 18 attack runs (or 13 attacks) cannot support a stated precision; with 9 benign runs, 4 false alerts has a 95% Wilson interval that spans roughly 19% to 73%. Precision needs the benign-to-attack mix the detector would see, which the project has not defined.
3. **Benign traffic is narrow.** `labelled-runs.md` lists what is still missing: ssh sessions and a browser-like mix, Tailscale-style traffic, repeats of the attack runs, and ARP and address-spoofing attacks. The bulk-TCP runs failed and need re-recording.
4. **The detector under test is not the one with the best numbers.** The deployed sentinel is the hard-coded baseline; the better CIC numbers belong to an ensemble that is not wired into the service.
5. **"On live traffic".** The scores are replays of captures recorded at the Zodiac P3 tap, not the live kernel reacting during a Track C scenario with the quarantine path in `propose` mode.

## 4. Proposed measurement (for the owner to approve or change)

| Item | Draft |
| :--- | :--- |
| Detectors scored | the **deployed** sentinel, the trt rate rule, and, as a separate row, the ensemble replica (flagged not deployed). The per-source baseline prototype only if the owner wants it counted |
| Unit and labels | one run, one class, one sender, as in `scripts/labelled-runs.py`; a run is a hit if the detector alerts and names the attacker, and a false alert if it alerts on a benign run |
| New recordings | fill the gaps in section 3: ssh-like and browser-like benign mixes, Tailscale-style traffic, re-recorded bulk TCP, repeats of every attack class, and ARP-flood and address-spoofing attacks. The sample size is for the owner to set; a stated target of at least 30 benign and 30 attack runs per detector would give 95% Wilson intervals about 33 points wide at worst (a rate near one half) and narrower near 0% or 100%; that is a figure to confirm with the owner, not a result |
| Reporting | per class and overall: hits, misses, false alerts, precision and recall with 95% Wilson intervals, first-alert delay, and the per-class breakdown. No pooling of replica and live results |
| Safety | unchanged: the bounds in `labelled-runs.md` (rate, duration, packet and payload limits, attack sender, targets), `--execute` required, quarantine in `propose` mode |
| Registration | thresholds, the run list and the scoring rule are committed before any new recording is scored |

A **live end-to-end** variant (the real kernel and the quarantine path reacting to a scripted attack, with detection and proposal times) is a second phase and needs the owner's decision about running the detector in `propose` mode during runs.

## 5. Does a Runpod pod help?

**Mostly no, and no pod is proposed for the main measurement.**

- The recordings and the scoring are bench- and Mac-bound: traffic must cross the Zodiac and be captured at the tap. A pod cannot produce it.
- The scoring and the weight fits are small CPU jobs. The sentinel has ten weights, and the 13.4 GB and 8.8 GB CIC-IDS2017 captures were processed in full on the Mac ("a full pass turned out to be practical", `cic-ids2017-adapter/README.md`).
- The one place compute could help is processing **more CIC-IDS2017 days** for out-of-sample classes. That would be a CPU job with large downloads. The Runpod wrapper (`scripts/runpod.ts`) supports only GPU kinds and the Hailo compile kind, so a CPU processing job would need a new kind and its own budget logic, and was therefore **not dry-run**. The value is also limited: those results would describe a detector that is not deployed.
- The Hailo compile pipeline (a CPU pod) stays parked until criterion (a) is met.

## 6. Decisions for the owner

1. **The unit and the claim:** run-level precision and recall on the stated benign mix, with window-level rates secondary?
2. **Which detectors count:** the deployed sentinel and the rate rule only, or the ensemble and the per-source prototype too?
3. **Sample size and benign mix:** a target number of runs and which benign classes (section 3, item 3).
4. **Whether to wire the ensemble into the service first**, since its numbers are better but it is not deployed (the campaign summary scopes the work and says it needs the owner's review).
5. **Whether the live end-to-end phase is in scope.**
6. **Wording now:** the README says "unmeasured"; it could say "measured only on small lab runs and a public dataset, not on live traffic; see this page" without waiting for the new data.

## 7. What this would not show

One rack, one switch, one adversary host, one benign-traffic generator set; scores say nothing about traffic the lab does not produce. The CIC-IDS2017 results show that the detector family is tuned to volumetric floods and is "not a general network intrusion detector" (`CAMPAIGN-SUMMARY.md`); a larger benign set does not change that. Admissible rule sets and detector alerts are different questions: the verifier decides what may be installed; the detector only proposes within the quarantine envelope.

## 8. Phase 0 (registered 2026-11-09): whole-day CIC-IDS2017 scoring of the deployed sentinel, on a pod

**Status: the owner cleared a Runpod pod for the detector work on 2026-11-09 ("proceed anyway, we might discover other useful information"). This section registers one bounded job, chosen by the operator to fit that clearance, before any of its data exists. Sections 1 to 7 stay a draft; this job does not decide any of the questions in section 6, and it does not change the roadmap statement that detector precision and recall on the rack's own traffic are unmeasured.** Section 5 explained why a pod does not help the main measurement; this is the one part that is compute-shaped, so it is the one that can use a pod.

### 8.1 Question

What are the window-level false-positive rate and per-class alert rate (with 95% Wilson intervals) of the **deployed** sentinel rule on whole days of the public CIC-IDS2017 captures, including the classes and the full day of benign traffic that earlier work did not score? Earlier results used Wednesday and Friday with sampled benign and attack buckets; Monday (a day of benign traffic only), Tuesday (FTP-Patator, SSH-Patator) and Thursday (web attacks, infiltration) were not processed.

### 8.2 Design

| Item | Value |
| :--- | :--- |
| Detector | the deployed rule only: the hard-coded kernel in `scripts/sentinel-replay.py` (`kernel_loss`) with `BASE_TAU` 0.15 as a static threshold, and the adaptive controller (`sr.Adaptive`, defaults) run continuously through each day. **Not** the two-model ensemble, which is not deployed |
| Data | the Hugging Face mirror `bencorn/CICIDS2017`: five pcaps (about 52 GB) and `GeneratedLabelledFlows.zip`. Every file is checked on the pod against the mirror's own size and LFS sha256; a mismatch fails the run |
| Method | `scripts/cic-ids2017-adapter.py`, unmodified, streams each day and joins each 64-packet window to a label; `scripts/cic-score-windows.py` (new, tested first) turns the windows into counts and rates. The adaptive controller's state is per day |
| Pod | one cheap GPU pod on Community Cloud, on-demand: the job is CPU- and network-bound; the GPU is not used |
| Code | `scripts/runpod/launch-cic-score.sh` at the commit that registers this section |

### 8.3 Metrics, fixed in advance

Per day and combined: windows per majority label; for each of the static and adaptive views, alerts per label; false-positive rate on benign windows, recall on attack windows (over all attack labels, and per label) and precision, each with a 95% Wilson interval; unlabelled windows (excluded from every rate); join coverage per day, read from the adapter's log. **Quality gate, stated now:** a day whose label join covers less than 90% of its IPv4 packets is reported but excluded from the combined rates, because its labels cannot be trusted. Wednesday and Friday were joined at 99.98% and 99.99% earlier (`cic-ids2017-adapter/README.md`); this run recomputes them, so the figures can be cross-checked against that README.

### 8.4 Analysis rules

Descriptive only. Nothing is tuned: no threshold, weight or label rule is changed after seeing a result. Windows overlap and are strongly dependent, so the intervals are optimistic, and precision depends on each day's benign-to-attack mix, so it is reported next to the mix and not as a rate the rack would see. Results are not merged with the lab-run scores of section 2 and are not described as live. If a day fails, it is reported as failed with its log; the other days stand.

### 8.5 Cost, stopping condition and decision-maker

- **Decision-maker:** the owner, who cleared the pod. The default per-run cap (5 USD) applies.
- **Stop:** one pod. One relaunch is allowed for an infrastructure failure (the pod, its network or the launcher). If the download or processing cannot finish inside the pod's time limit, the days already scored are reported as partial and the run is not repeated without a new decision. The in-pod `timeout` ends billing even if the launcher dies.
- **Cost:** recorded in 8.7 from the dry run.

### 8.6 What this will not show

Anything about traffic on this rack: CIC-IDS2017 is a 2017 lab capture with its own attack tools, and the earlier campaign already found that this detector family catches volumetric floods and is "not a general network intrusion detector". Window-level rates are not run-level detection. A low false-positive rate on Monday's benign traffic does not bound the rate on the rack's traffic, which the section 4 recordings address.

### 8.7 Dry run record

`scripts/runpod/launch-cic-score.sh --minutes 240 --gpu "NVIDIA GeForce RTX 3090"`, without `--yes`, on 2026-11-09, nothing created: `plan: score on NVIDIA GeForce RTX 3090 (community on-demand) 240 min @ $0.2200/hr -> worst case $0.8800 (cap $5.0000)`. A 180-minute plan on the same card was 0.66 USD, and on an A40 (0.35 USD per hour) 1.05 USD. The pod time limit is 240 minutes. The 240 minutes is an estimate, not a measurement: the adapter processed about 11,700 packets per second on the Mac, about 13.8 million packets in the largest day, plus a window-scan pass and the download of about 52 GB; pod CPUs may be slower.
