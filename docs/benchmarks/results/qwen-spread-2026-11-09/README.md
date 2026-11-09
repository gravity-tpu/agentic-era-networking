# Run-to-run spread of the local base-model arm, fresh seeds (2026-11-09)

Run of the plan registered in [`docs/research/evaluation-plan.md`](../../../research/evaluation-plan.md) section 17: the base arm `B3` (`qwen3.8:27b`, Ollama library, digest `aaee06c39dcf`) on the registered cell (`INTENT-1` to `INTENT-4`, prompt v3, Protocol A, `think: true`, `num_predict` 32768, temperature 0.2, top-p 0.95, N = 50 per intent), on two **new seed blocks**, 51 to 100 and 101 to 150, each on its own Runpod A100 SXM4 80 GB pod (Community Cloud, on-demand, 1.39 USD per hour), Ollama 0.34.4, the four intents concurrent as four streams. The original run (`agent-evaluation/lora-v3-2026-10-30`) used seeds 1 to 50. This directory is deliberately outside `agent-evaluation/`: the frozen on-wire conformance bundle is regenerated from every `trials.jsonl` under that tree (`test/invariants/wire-bundle.test.ts`), so recorded proposals added there would change a bundle that was approved by hash. Abstract evaluation only (RQ1 to RQ3): admissible means the verifier accepts the rule set, not that it is correct on the wire.

Run commit `eb496017d2da36eaa717ac67f9a43b40dd06b16f` for both pods (`seeds-*/repo-commit.txt`); one launch per block, no relaunch, no cell rerun.

## Result

Admissible out of 50, per seed block, per cell:

| Intent | Seeds 1 to 50 (original) | Seeds 51 to 100 | Seeds 101 to 150 | Range across blocks (width) | Pooled, 150 trials (95% Wilson) | Original inside the range of the two new blocks | Distinct turn-1 outputs (new blocks, of 50) |
| :--- | ---: | ---: | ---: | :--- | :--- | :--- | :--- |
| INTENT-1 port-1 isolation | 47 | 44 | 48 | 44 to 48 (4) | 139/150 = 92.7% (87.3 to 95.9) | yes | 41 and 38 |
| INTENT-2 DNS confinement | 50 | 50 | 49 | 49 to 50 (1) | 149/150 = 99.3% (96.3 to 99.9) | yes | 47 and 43 |
| INTENT-3 quarantine precedence | 27 | 26 | 31 | 26 to 31 (5) | 84/150 = 56.0% (48.0 to 63.7) | yes | 50 and 50 |
| INTENT-4 tap return | 50 | 50 | 49 | 49 to 50 (1) | 149/150 = 99.3% (96.3 to 99.9) | yes | 48 and 46 |
| **All four** | **174** | **170** | **177** | **170 to 177 (7)** | **521/600 = 86.8% (83.9 to 89.3)** | yes | |

- **The total moved by 7 trials across three blocks** (170 to 177 of 200, 3.5 points); the original 174 sits between the two new totals.
- **The mid-rate cells move most:** `INTENT-3` ranged 26 to 31 and `INTENT-1` 44 to 48 (5 and 4 trials, 10 and 8 points of 50). `INTENT-2` and `INTENT-4` were at or near the ceiling (49 to 50), so their range is bounded by it and says nothing about their spread.
- **The failures are the same kinds in every block:** `INTENT-3` loses to `ERR_INTENT_MISSING` (16 and 13 of 50 in the new blocks, 17 originally) and `ERR_INTENT_LEAK`; `INTENT-1` to a few leaks and misses, with 3 `ERR_HAIRPIN` across the two new blocks. No syntax or prerequisite failures.
- **Two transport failures, kept:** seeds 148 (`INTENT-4`) and 149 (`INTENT-2`) in the second block, both `fetch failed` at about 301 s, Node's 300 s wait for response headers; they are counted as not admissible and not replaced (plan 17.4). Neither block was relaunched.

## How to read it

- **Descriptive, as registered.** Three blocks cannot support a significance test and none is made. The pooled intervals treat the 150 trials per cell as independent; the distinct-output counts show that most turn-1 answers differ, but the intervals are still a little optimistic for `INTENT-1` (38 to 41 distinct of 50).
- **What the spread is for.** It says how many trials of difference between arms on this stack, for these four intents, are within the seed-to-seed movement of one arm: up to about 5 trials per cell and 7 in total were seen here. A one-run difference of that size should not be read as an effect.
- **What it does not say.** It is two extra blocks on one pod type, so a range from three blocks is itself imprecise. It does not cover `INTENT-5` to `INTENT-8`, where the adapter's differences from the control were larger (17 to 25 trials) and were not re-measured; it does not cover the Mac runs, prompt v2 or Protocol B; and it cannot separate seed variation from serving-stack variation (concurrent batching makes seeded outputs not guaranteed identical).
- **Known inequality with the original, stated in advance:** the original `INTENT-3` cell ran as a single stream at another commit, the repeats as four concurrent streams at one commit. `INTENT-3` came out 27, 26, 31, so there is no sign that scheduling moved it, but the data cannot rule it out.

## Cost and time

Pod runtimes, from the `start` to the `done` line of each `pod.log`: seeds 51 to 100, 2:44 PM to 5:13 PM ET on 2026-11-09 (about 2.5 hours); seeds 101 to 150, 2:47 PM to 5:38 PM ET (about 2.9 hours), after both pods had waited for Community A100 capacity. The account balance fell from 17.17 to 9.22 USD over the period, about 7.95 USD, which includes the detector job's pod (about 0.2 USD), so the two Qwen pods cost about 7.7 USD against the registered worst case of 11.12 USD. Both pods were terminated and verified gone.

## Files

`seeds-51-100/` and `seeds-101-150/`: per cell `summary.json` (settings, model digest, prompt hash, commit, counts, `seeds`, `seedStart`) and `trials.jsonl` (every raw model output and verdict, nothing dropped); `pod.log`, `gpu.txt`, `versions.txt`, `repo-commit.txt`.
