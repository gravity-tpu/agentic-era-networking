# Protocol B for the adapter: L3 against C3 (2026-10-31)

The runs of plan section 12 (`docs/research/evaluation-plan.md`), registered by commit `c58b695` before any Protocol B data. Abstract evaluation only (RQ1 to RQ3): verdicts come
from `src/sdn/proposal-triage.ts`; nothing was installed on the switch. **Admissible means the verifier accepts the rule set, not that it is correct on the wire.**
Protocol B: up to 5 turns, the verifier's detail lines returned after each rejected turn; prompt v3, N = 20 per intent (seeds 1 to 20), temperature 0.2, top-p 0.95, `think: true`, `num_predict` 32768, one run per cell.
Arms L3 (adapter) and C3 (no adapter) are built as in `../lora-v3-2026-10-30/README.md` (GGUF-space merge from the original checkpoint, Q4_K_M, Ollama 0.34.4). One NVIDIA A100 SXM4 80GB pod per arm (Runpod Community Cloud), the four intents running concurrently against one Ollama server.
Run commit `c58b695` (permanent tag `provenance/protocol-b-run-c58b695`; the same change is `e7ca232` on `main`); `scripts/agent-eval.ts` and `src/sdn/` are identical to the Stage 2 run commit `02ec648` (tag `provenance/section11-stage2-run-02ec648`; checked with `git diff`).

## Results

| Intent | Arm | Admissible on turn 1 | Within 5 turns (95% Wilson) | Turn it became admissible | Still failing after 5 turns | Distinct turn-1 outputs | Transport failures | Run commit |
| :--- | :--- | ---: | :--- | :--- | :--- | ---: | ---: | :--- |
| dns-confinement/v1 | C3 | 20/20 | 20/20: 84% to 100% | turn 1: 20 (mean 1.00) | none | 20 | 0 | `c58b695` |
| dns-confinement/v1 | L3 | 19/20 | 20/20: 84% to 100% | turn 1: 19, turn 2: 1 (mean 1.05) | none | 14 | 0 | `c58b695` |
| port1-isolation/v1 | C3 | 18/20 | 20/20: 84% to 100% | turn 1: 18, turn 2: 2 (mean 1.10) | none | 16 | 0 | `c58b695` |
| port1-isolation/v1 | L3 | 13/20 | 20/20: 84% to 100% | turn 1: 13, turn 2: 7 (mean 1.35) | none | 19 | 0 | `c58b695` |
| quarantine-precedence/v1 | C3 | 12/20 | 20/20: 84% to 100% | turn 1: 12, turn 2: 8 (mean 1.40) | none | 20 | 0 | `c58b695` |
| quarantine-precedence/v1 | L3 | 17/20 | 20/20: 84% to 100% | turn 1: 17, turn 2: 3 (mean 1.15) | none | 20 | 0 | `c58b695` |
| tap-return-isolation/v1 | C3 | 20/20 | 20/20: 84% to 100% | turn 1: 20 (mean 1.00) | none | 20 | 0 | `c58b695` |
| tap-return-isolation/v1 | L3 | 20/20 | 20/20: 84% to 100% | turn 1: 20 (mean 1.00) | none | 17 | 0 | `c58b695` |

| Arm | All intents: turn 1 | Within 5 turns (95% Wilson) | Mean turns to admissibility |
| :--- | ---: | :--- | ---: |
| C3 | 70/80 | 80/80: 95% to 100% | 1.13 |
| L3 | 69/80 | 80/80: 95% to 100% | 1.14 |

Each cell directory holds `summary.json`, `trials.jsonl` (every turn's raw output and verdict) and its pod's provenance files.

## What the numbers say, and no more

- **Both arms are admissible on all 80 trials within 5 turns, and no trial needed more than 2 turns.** This is the ceiling section 12.4 predicted, so the primary comparison does not discriminate: with the verifier's feedback, the model repairs every rejected proposal on the second turn, with or without the adapter.
- **The secondary measure does not discriminate overall either.** Turn 1 is 69 of 80 for L3 and 70 of 80 for C3; the mean turn of repair is 1.14 and 1.13 (L3 repaired 11 trials on turn 2, C3 10).
- **Per intent, the pattern matches Protocol A.** On INTENT-3 L3 passes turn 1 more often (17 of 20 against 12 of 20, mean 1.15 against 1.40 turns); on INTENT-1 it passes less often (13 of 20 against 18 of 20, mean 1.35 against 1.10); INTENT-2 and INTENT-4 are within one trial. The Protocol A runs of the same arms showed the same direction (INTENT-3 40/50 against 27/50, INTENT-1 41/50 against 47/50). Cells of 20 trials carry wide intervals, the seeds overlap with Protocol A's first 20, and each cell is one run.
- **Seeded runs do not reproduce each other in general.** For seeds 1 to 20, Protocol B's turn-1 output is identical to the Protocol A output for the same seed in 0 or 1 of 20 trials in seven of the eight cells; the exception is L3 on INTENT-3 (19 of 20). The verdict category agrees in 11 to 20 of 20. On INTENT-3 the control passed 9 of 20 in Protocol A and 12 of 20 on turn 1 here with the same seeds, which is one measure of run-to-run noise at N = 20. The mechanism (concurrent batching, scheduling, anything else) was not investigated.

## Deviations and incidents

None changed an arm's settings, prompts, seeds or the verifier. (1) Scheduling: Protocol B ran four intents concurrently per server, Protocol A Stage 2 three, Stage 1 one, so cells are compared within a protocol only. (2) No pod needed a manual intervention. (3) The cost of this run was about 3.84 USD (Runpod balance 46.78 to 42.94 USD).

## What this does not show

- Any benefit of the adapter's repair training: both arms repair everything by turn 2, so a harder benchmark or a harder metric is needed to see one.
- Anything the verifier feedback does when the verifier is wrong or incomplete: every verdict here comes from the same verifier that produced the training data.
- On-wire behaviour (RQ4), a second seed set, or the adapter served at run time (`llama-server --lora`).
- One run per cell, N = 20, prompt v3 written after the v2 failures on these intents were read.
