# Models used in the research

This page lists every language model that produced results in this repository: the models that **proposed rule sets** for the verifier, how they were hosted, what was measured, what it cost, and what each is suited to. It does not cover the models used for code review or CI.

All admissibility figures come from the abstract evaluation (RQ1 to RQ3): a rule set is *admissible* when the deterministic verifier accepts it for the stated intent. That is not the same as correct on the wire (RQ4); see [the agent-evaluation index](../benchmarks/results/agent-evaluation/README.md) and the limits at the end of this page.

**Protocols.** Protocol A is zero-shot: one try, no feedback. Protocol B is a closed loop: the verifier's diagnostics are returned to the model for up to 5 turns. **Intents.** `INTENT-1` to `INTENT-4` are the original four; `INTENT-5` to `INTENT-8` are the harder set added on 2026-10-31.

## Summary

| Model | Hosting and hardware | Zero-shot admissible (Protocol A) | With verifier feedback (Protocol B) | Cost to run |
| :--- | :--- | :--- | :--- | :--- |
| `gemma4:26b` (Q4_K_M) | Local: MacBook Pro, Apple M5 Pro, 64 GB unified memory, Ollama | 35% (70/200), reasoning on | 94% (75/80) | No API cost; hours of wall time on this MacBook (see below) |
| `qwen3.8:27b` (Q4_K_M) | Local: same MacBook Pro, Ollama | 57% (113/200) under prompt v1; 43% (86/200) under v2 | 100% (80/80) v1; 99% (79/80) v2 | No API cost; 5 h 49 min (v1) to 7 h 55 min (v2) for Protocol A |
| `qwen2.5:3b` (Q4_K_M) | Local: Jetson Orin Nano Super, 8 GB memory shared by CPU and GPU, Ollama | 0 of the answered trials (INTENT-1 only) | not run | No API cost; removed 2026-10-16 |
| `Qwen3.8-27B` plus LoRA adapters (`L3`, `L4`) | Rented GPU: Runpod A100 SXM 80 GB, open weights | `L3` 88% (176/200) vs 87% for the unadapted control; `L4` 48% (145/300) vs 83% (248/300) | `L3`: 100% (80/80) | About 20 USD per campaign (see below) |
| `claude-haiku-5-5` (effort low) | Cloud API (provider hardware not disclosed) | 96.0% (2,303/2,400, fresh trials); 98% on the harder intents | 100% (400/400) | About 0.0008 USD per admissible set |
| Other cloud models (Gemini, Claude Sonnet and Opus) | Cloud API (provider hardware not disclosed) | Pilot only (12 trials each); see below | not run | 10x to 64x Haiku's cost per admissible set |

Hosting here has three kinds. **Local** means the model ran on hardware in this lab (the Mac workstation or the Jetson). **Rented GPU** means open weights that ran on a short-lived cloud GPU pod, so the model is the same kind as the local ones but the compute is paid by the hour. **Cloud API** means a hosted proprietary model billed per token.

## Local models

### Hardware the local models ran on

| Machine | Specification | Used for |
| :--- | :--- | :--- |
| Mac workstation | MacBook Pro (Mac17,9), Apple M5 Pro: 18-core CPU (6 super + 12 performance cores), 20-core GPU (Metal 4), **64 GB unified memory** | `gemma4:26b` and `qwen3.8:27b` through Ollama; the operator machine for the whole project |
| Jetson Orin Nano Super | Ampere GPU, 8 GB memory shared between CPU and GPU (7.6 GB visible to the OS), reported at the 15 W power mode on 2026-11-07 | `qwen2.5:3b` through Ollama: the load test and the `INTENT-1` run |

How to read the wall-time figures with this in mind:

- **They are for a laptop, not a server.** All Mac hours in this page (Gemma reasoning-on at about 2.1 hours per 50 zero-shot trials, Qwen at 5 h 49 min to 7 h 55 min per Protocol A campaign) are one MacBook Pro running one request at a time. The rented A100 pods managed about one trial per minute per pod on the same Qwen family, but that comparison is not like for like (different serving stack, quantization path and concurrency), and no run here isolates the effect of the hardware.
- **Unified memory is shared with everything else.** The 64 GB is the one pool for the model, the context window, the OS and whatever else the operator had running; the benchmarks did not control for that load. The 26B and 27B models at Q4_K_M fit comfortably (Gemma's weights are 18 GB on disk), so memory capacity was not the visible constraint on the Mac; the Jetson's 8 GB was.
- **The Jetson's limit was memory, not compute.** CPU and GPU share 8 GB, and the controller, verifier, detector and Ollama competed for it; Ollama could not load the 1.9 GB `qwen2.5:3b` once page cache held about 2 GB the GPU allocator could not reclaim (`cudaMalloc failed`), and the GPU was at 96.5% load during the load test. That is why the model was removed.
- **Serving was one request at a time on both machines.** Ollama handled requests serially, so concurrency raised latency without raising throughput; the Mac's 63 tokens/s and the Jetson's 15.3 tokens/s in the load test are single-stream rates.

Provenance of these specifications: the run records (`summary.json`) store only the Mac's Tailscale address, not its hardware. The specifications above were read from the machine on 2026-11-07 (`system_profiler`), and the project's archived roadmap independently describes the workstation as an M5 MacBook with a 20-core Metal GPU. The owner confirmed on 2026-11-07 that the machine has not changed since the start of the project, so the specifications apply to every run. The OS version and the Ollama version at the time of each run were not recorded (the client is now 0.34.4).

### `gemma4:26b` (Mac, Ollama, Q4_K_M)

The plan asked for 8-bit; Q4_K_M is what was available. Temperature 0.2, top-p 0.95, seeds 1 to N.

| Measure | Result |
| :--- | :--- |
| Plan v1, `INTENT-1` to `INTENT-4`, reasoning on | 70/200 zero-shot (35%), 75/80 (94%) within 5 turns |
| `INTENT-1`, reasoning off | 0/50 zero-shot; 2/20 within 5 turns |
| `INTENT-1`, reasoning on | 5/50 zero-shot (10%); 20/20 within 3 turns |
| Failure modes (reasoning on) | `ERR_HAIRPIN`, `ERR_INTENT_LEAK`, `ERR_PREREQUISITE` (an IPv4 match without the EtherType) |
| Throughput (2026-10-04 load test, Mac over Tailscale) | 63 tokens/s aggregate, 68 per request; p50 latency 9.2 s, p95 10.0 s with 2 requests in flight |
| Time per trial | About 5 s with reasoning off; reasoning on used 5,900 to 16,500 output tokens per turn and took about 2.1 hours for 50 zero-shot trials |

Reasoning mode is the largest lever: on versus off took `INTENT-1` from 0 to 10% zero-shot and from 2/20 to 20/20 with feedback. With the original 8,192-token budget, reasoning returned nothing in 3 of 3 pilot trials because the budget went to thinking, so the budget was raised to 32,768.

Not established: Ollama reported a loaded size of 2.36 GB for a model whose weights are 18 GB on disk; this was not investigated. The Mac's GPU, power and memory were not recorded, so why Gemma is faster than Qwen here is unmeasured. The servers handle requests one at a time, so concurrency adds latency but no throughput.

### `qwen3.8:27b` (Mac, Ollama, Q4_K_M, digest `aaee06c39dcf`)

Reasoning on (`think: true`, 32,768-token budget).

| Measure | Result |
| :--- | :--- |
| Plan v1 | 113/200 zero-shot (57%); 80/80 within 5 turns |
| Plan v2 (A10 intent text, prompt v2) | 86/200 zero-shot (43%, with 8 transport failures); 79/80 within 5 turns |
| `INTENT-3` (quarantine precedence) under prompt v2 | 1/50 zero-shot; 47 of 49 failures were `ERR_INTENT_LEAK` (a Port 1 catch-all) |
| Right on the first turn in Protocol B | 33/80, against 63/80 for Haiku |
| Wall time | Plan v1: 5 h 49 min (Protocol A), 3 h 6 min (B). Plan v2: 7 h 55 min (A), 4 h 57 min (B) |
| Transport failures | 8 trials, all `fetch failed` at 301 s (Node's 300 s wait for response headers), not model errors |

With feedback, Qwen reaches the ceiling (79/80, the missing trial being a transport failure) but needs more repair turns than Haiku.

### `qwen2.5:3b` (Jetson Orin Nano, Ollama, Q4_K_M)

Included as the small embedded-edge cohort entry. On `INTENT-1` with reasoning off it produced **no admissible set**: `ERR_SHADOWED` 25, `ERR_SYNTAX` 18 (often a CIDR string in an IPv4 field), 6 transport failures, in 44 answered trials. Load test: 15.3 tokens/s, p50 latency 39.1 s, Jetson GPU load 96.5% mean (99% max), board power 12.5 W mean (13.1 W peak), 56 C mean GPU temperature, 4.6 to 5.1 GB of 7.6 GB RAM. It was removed on 2026-10-16: it could not load under shared-memory pressure and added no measured value. This is one 3B model on one intent, not a comparison of model sizes.

## Rented-GPU models: Qwen3.8-27B with LoRA adapters

Open weights, so the same family as the local Qwen, but trained and evaluated on Runpod A100 80 GB pods (1.79 USD/hour) because the Mac was too slow for the sample sizes. Arms: `B3` is the Ollama-library base, `C3` is the pipeline control (same conversion steps, no adapter), `L3` is the 15-step SFT+DPO proposer adapter (rank 16, alpha 32, 1,466 SFT examples and 1,434 DPO pairs, verifier-grounded), and `L4` is a longer-trained adapter (80 SFT + 90 DPO steps, about half an epoch).

| Campaign | `B3` (base) | `C3` (control) | `L3` (15-step adapter) | `L4` |
| :--- | :--- | :--- | :--- | :--- |
| `INTENT-1` to `INTENT-4`, zero-shot | 174/200 (87%) | 174/200 (87%) | 176/200 (88%) | not run |
| `INTENT-5` to `INTENT-8`, zero-shot | 165/200 (83%) | 174/200 (87%) | **141/200 (71%)** | not run |
| `INTENT-1,3,5,6,7,8`, zero-shot | not run | 248/300 (83%) | not run | **145/300 (48%)**; 119 failures were `ERR_SYNTAX` (truncated or repetitive JSON) |
| Protocol B | not run | 80/80 (at most 2 turns) | 80/80 (at most 2 turns) | not run |

- **The adapters did not replace verification.** `L3` helped the intents that match its training families (`INTENT-3` 40/50 vs 27/50; `INTENT-7` 49/50 vs 32/50) and regressed on multi-host composition (`INTENT-5` 18/50 vs 43/50). `L4` was worse than the unadapted model. These facts fit an adapter overfitted to a few scenarios, but no run varied the data, learning rate, thinking setting or prompt, so the cause is not established.
- **Training cost and time:** the 15-step proposer adapter trained in 14.2 minutes. `L4` training cost about 3.9 USD. Whole campaigns, including failed pods and idle time: about 19.6 USD for the `L3` campaign and about 20 USD for `L4`; the local arms of the harder-intent run cost about 4 to 5 USD per pod. Measured throughput was about one trial per minute per pod.
- **Serving note:** Ollama 0.34.x removed runtime `ADAPTER` loading, so adapters were merged (llama.cpp) or passed with `--lora`.
- Only one 15-step adapter and one half-epoch adapter were trained, on one switch.

## Cloud API models

### `claude-haiku-5-5` (effort low), the frontier arm

Chosen as the cheapest model that could execute the task, with a 50 USD spend cap; about 5 USD was spent on selection and the main evaluation.

| Measure | Result |
| :--- | :--- |
| Fresh trials after the choice (3 rounds of N=200 per intent, 2,400 in all) | **2,303/2,400 (96.0%), 95% interval 95.1% to 96.7%** |
| By intent | `INTENT-1` 91.3%, `INTENT-2` 99.5%, `INTENT-3` 93.0%, `INTENT-4` 100% |
| Protocol B, N=100 chains per intent | **400/400 (99.0% to 100.0%)**; 388 right on the first turn, 12 fixed on turn 2 or later |
| Plan v1 (earlier prompt) | 191/200 zero-shot (96%); 80/80 with feedback |
| Plan v2 (A10 intent text) | 161/200 zero-shot (81%; `INTENT-3` 25/50); 80/80 with feedback |
| Harder intents `INTENT-5` to `INTENT-8` (Batches API) | 196/200 (98%) |
| Cost | 0.00072 USD per trial and **0.0008 USD per admissible set** (pilot); the 200-trial harder-intent baseline cost 0.376 USD; plan v2's eight valid runs cost about 27 cents |
| Rates used | 0.10 USD input and 0.50 USD output per million tokens, as recorded for the 2026-10-20 runs; not re-verified. About 1,320 output tokens per trial (thinking included) |
| Speed | About 35 minutes of wall time for plan v2's valid runs, against about 13 hours for local Qwen on the same plan |

Its non-admissible trials were all intent leaks or missing deliveries; none was a syntax, prerequisite or transport failure. Admissibility is per intent: every `INTENT-1`-admissible set failed `INTENT-4`, because the model does not add the tap-return rule unprompted.

### Other cloud models (selection pilot)

Twelve models from two providers were piloted at Protocol A, N=3 per intent (12 trials each), ranked by measured cost per admissible set, not list price. These are pilot numbers; twelve trials cannot separate 11/12 from 12/12.

| Model | Admissible (of 12) | Cost per admissible set | Notes |
| :--- | :--- | ---: | :--- |
| `claude-haiku-5-5` | 11 | 0.0008 USD | Chosen; 36/40 at stage 2 |
| `claude-sonnet-5-5` | 11 | 0.0088 USD (11x Haiku) | |
| `gemini-4-argon` | 12 | 0.0076 USD (10x) | |
| `gemini-3.8-flash` | 12 | 0.0115 USD (15x) | |
| `gemini-3.6-flash` | 11 | 0.0129 USD (16x) | Stage 2: 33/40, not viable, 0.0141 USD per admissible set |
| `claude-opus-5-5` | 9 | 0.0162 USD (20x) | Declined all 3 `INTENT-4` trials (`refusal:cyber`) |
| `gemini-3.1-pro-preview` | 9 | 0.0505 USD (64x) | |
| `gemini-3.1-flash-lite`, `gemini-3.5-flash-lite` | 5, 4 | 0.0020, 0.0042 USD | Failed `INTENT-1` and `INTENT-4`; cheap per trial, not per admissible set |
| `claude-fable-5-1` | 0 (9 probe trials) | not scored | Declined every trial with its cyber safety classifier |

`claude-fable-5-1` and `claude-opus-5-5` refused to write isolation and quarantine rules for a defensive task. The prompt was not reworded to get past the classifier, because that would change the experiment. A refusal bills only its input and is recorded as an `ERR_SYNTAX` trial with the reason in `doneReason`. Claude ran at its lowest effort and Gemini at default thinking (more tokens), so part of the price gap is the setting, not the model. GPT-4o and the 3.x Sonnet models named in the original plan were not run.

## Suitable uses, as the data suggest

These are readings of the measurements above, not tested recommendations.

| Need | Suited to | Why |
| :--- | :--- | :--- |
| Cheapest accurate proposer for a verified pipeline | `claude-haiku-5-5` | 96% zero-shot at about 0.0008 USD per admissible set, 100% with feedback, minutes not hours |
| Proposals that must stay on local hardware, or no per-token spend | `qwen3.8:27b` or `gemma4:26b` with reasoning on, **with** verifier feedback | Zero-shot rates are 35% to 57%, but feedback brings them to 94% to 100%; expect hours per campaign and more repair turns |
| Large sample sizes at moderate cost | Rented A100 with open weights | About one trial per minute per pod at 1.79 USD/hour; the local arms cost about 4 to 5 USD per pod |
| Embedded, on-switch-host inference | Not supported by this data | The 3B Jetson model produced no admissible set and saturated the GPU |
| Improving a local model by fine-tuning | Not supported by this data | `L3` was within noise of the control and `L4` was worse; verification is still needed |

In every case the verifier decides admissibility and a person approves the install; model quality changes how many repair turns are needed, not whether the checks run.

## Limits

- **Admissible is not correct on the wire.** It is the verifier's verdict over the modelled fields; on-wire conformance (RQ4) is a separate run.
- **Settings differ across arms.** Quantization (Q4_K_M, not the planned 8-bit), reasoning mode, sampling (Claude takes no seed, and Fable takes no temperature or top-p) and prompt version differ between arms, so cross-arm comparisons are approximate.
- **Prompt and intent text changed over time.** Plan v1 and v2 numbers are not comparable; plan v1 predates the A10 intent text.
- **Selection was not blind.** Haiku was picked as the cheapest model that cleared thresholds set after part of the pilot had been seen; only the fresh post-selection trials support its accuracy claim.
- **Hardware is one laptop, and not recorded in the run files.** Local wall times depend on that MacBook Pro and its load at the time, and the specifications above were read after the fact (the owner confirms the machine is unchanged).
- **Local cost is not priced.** Mac electricity was not measured, and hours of Mac time are not like for like with API dollars.
- **Single switch, one run per case**, one Mac, one Jetson; no outside replication.
- Counts and costs are copied from the linked result files; the figures there are authoritative.

## Where the data is

- [Agent-evaluation index](../benchmarks/results/agent-evaluation/README.md) and its per-campaign reports
- [Frontier model selection](../benchmarks/results/agent-evaluation/frontier-selection/README.md)
- [Local `qwen3.8:27b` and Haiku, plan v2](../benchmarks/results/agent-evaluation/proposer-v2-qwen3.8-haiku-5-5.md)
- [LoRA training and the `L3`/`L4` runs](../benchmarks/results/lora-adapters-2026-10-29/README.md), [`lora-v3`](../benchmarks/results/agent-evaluation/lora-v3-2026-10-30/README.md), [`l4-adapter`](../benchmarks/results/agent-evaluation/l4-adapter-2026-10-31/README.md)
- [Ollama load test (Jetson and Mac)](../benchmarks/results/ollama-2026-10-03/README.md)
- [Evaluation plan](evaluation-plan.md) (the pre-registered protocols; its section 4 is superseded by this page)
