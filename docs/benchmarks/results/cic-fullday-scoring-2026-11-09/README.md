# Whole-day CIC-IDS2017 scoring of the deployed sentinel (2026-11-09)

Run of the Phase 0 job registered in [`docs/research/detector-evaluation-plan.md`](../../../research/detector-evaluation-plan.md) section 8, on one Runpod RTX 3090 pod (Community Cloud, on-demand, 0.22 USD per hour; 64 vCPUs, 124 GB RAM). Code commit `ee20d1901754b13a9dca66f4d92be43b61d4311e` (`repo-commit.txt`). The pod took about 56 minutes from launch to completion (about 0.2 USD at the hourly price; not read from the account balance, which was also moving for two other pods). All five pcaps and the label archive were verified against the Hugging Face mirror's size and sha256 (`pod.log`). The adapter is `scripts/cic-ids2017-adapter.py`, unmodified; the scorer is `scripts/cic-score-windows.py`.

**Detector scored:** the deployed rule only (hard-coded kernel, `BASE_TAU` 0.15 static, and the adaptive controller run continuously through each day). Not the ensemble.

## Headline, with the limits that change how to read it

Over the four days whose labels joined (Tuesday to Friday; 44,660,390 labelled windows):

| View | False-positive rate on benign windows | Recall on attack windows | Precision at these days' mix |
| :--- | :--- | :--- | :--- |
| Static threshold (loss >= 0.15) | 12.65% (5,101,738 of 40,342,624) | 34.20% | 22.4% |
| Adaptive controller, run continuously | 1.05% (421,705 of 40,342,624) | 1.01% | 9.3% |

- **Windows are not detection events.** An attack is hundreds of thousands of overlapping windows (a 64-packet sliding window per packet). Window-level recall says what fraction of windows during an attack alert, not whether the attack is noticed. An attack noticed once, in one window, scores almost zero here. The run-level measure in the plan (section 4) is the one that answers "was it detected".
- **Intervals are meaningless at this size.** The 95% Wilson intervals in the summaries are a few hundredths of a percentage point wide because they treat 40 million overlapping windows as independent. They are not evidence of precision; do not quote them.
- **Precision depends on the mix.** Attack windows are about 10% of the labelled windows here; the rack's mix is different.
- **The adaptive view is a whole-day continuous run.** The earlier training campaign scored the adaptive controller with a per-block reset, so its recall figures are not comparable to the adaptive column here. Run continuously, the controller's moving baseline absorbs sustained attack traffic (the feedback loop that `sentinel-training-two-anchor/CAMPAIGN-SUMMARY.md` describes), which is why its recall is about 1%.
- **This is 2017 lab traffic with its own attack tools.** It says nothing about the rack's own traffic.

## Per attack class (Tuesday to Friday)

Share of that label's windows that alert. `BENIGN` row: the false-positive rate.

| Label | Windows | Static | Adaptive |
| :--- | ---: | ---: | ---: |
| BENIGN | 40,342,624 | 12.65% | 1.05% |
| Bot | 4,996 | 8.55% | 0.78% |
| DDoS | 1,273,650 | 50.45% | 1.78% |
| DoS GoldenEye | 106,533 | 9.39% | 0.46% |
| DoS Hulk | 2,289,360 | 30.99% | 0.45% |
| DoS Slowhttptest | 31,223 | 18.29% | 0.70% |
| DoS slowloris | 22,690 | 62.72% | 5.39% |
| FTP-Patator | 54,585 | 47.07% | 3.71% |
| Heartbleed | 46,117 | 0.74% | 0.07% |
| Infiltration | 45,481 | 5.52% | 2.05% |
| PortScan | 323,661 | 18.75% | 1.46% |
| SSH-Patator | 117,162 | 3.73% | 0.55% |
| Web Attack - Brute Force | 1,726 | 18.66% | 4.00% |
| Web Attack - XSS | 582 | 49.48% | 14.78% |

## Per day

| Day | Benign windows | Benign FP, static | Benign FP, adaptive | Attack windows | Attack alert, static | Attack alert, adaptive |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| Tuesday | 11,380,139 | 12.56% | 1.08% | 171,747 | 17.5% | 1.6% |
| Wednesday | 11,292,892 | 10.03% | 0.83% | 2,495,923 | 29.6% | 0.5% |
| Thursday | 9,274,157 | 16.45% | 1.35% | 47,789 | 6.5% | 2.3% |
| Friday | 8,395,436 | 12.08% | 0.96% | 1,602,307 | 43.9% | 1.7% |

## Monday did not join: all 11,709,908 windows are unlabelled

Monday was meant to be the full day of benign traffic. Its label file loaded **529,918 rows and parsed none of them** (`Monday.adapter.log`: `parsed_ok: 0, parse_error: 529918`), so no packet matched a flow (0 of 11,626,492 IPv4 packets). By the quality gate registered before the run (a day below 90% label coverage is excluded from the combined rates), Monday is excluded; its windows are all unlabelled and so also contribute nothing to the rates above.

**Cause, read from the label archive afterwards:** Monday's CSV writes the timestamp as `03/07/2017 08:55:58` (zero-padded, with seconds). Tuesday to Friday write `4/7/2017 8:54` (no padding, no seconds), the shape the adapter's parser (`scripts/cic-ids2017-labels.py`) was built for. The parser rejects every Monday row. This is a limit of the existing label parser, not a finding about Monday's traffic. It is not fixed here: the registered job is left as it was run. Recovering Monday would need a parser change with a test and a re-run of that one day (about an hour of pod time).

**Cross-check against the earlier Mac run:** Wednesday and Friday joined at the same counts as `cic-ids2017-adapter/README.md` (13,704,848 of 13,705,555 and 9,913,758 of 9,915,680 IPv4 packets), which the earlier run reached with the same adapter.

## Throughput

Per day, 7,087 to 7,510 packets per second through extraction, features and label lookup, against 11,700 on the Mac in the earlier run: the pod's cores are slower. The days ran four at a time on 64 vCPUs; the full job needed about 56 minutes of the 240-minute limit.

## Files

`combined.summary.json` and `<Day>.summary.json` (counts and rates), `<Day>.adapter.log` (join coverage, throughput), `dataset-manifest.json` (mirror metadata used for verification), `pod.log`, and the pod's hardware. The per-day windows files (several GB) were deleted on the pod after scoring.
