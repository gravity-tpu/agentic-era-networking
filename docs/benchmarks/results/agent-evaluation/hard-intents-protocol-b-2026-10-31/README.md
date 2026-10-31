# Protocol B on INTENT-5 and INTENT-7: L3 against C3, prompt v3 (2026-10-31)

The conditional run of plan section 14.2 item 4 (`docs/research/evaluation-plan.md`), registered by commit `f50adbb` (which is also the run commit of both pods) before any of this data. It ran because the C3 cells of section 13 were below the saturation threshold of 47 of 50 on INTENT-5 (quarantine-set, 43) and INTENT-7 (uplink-arp-confinement, 32); INTENT-6 and 8 were saturated and were not run. Abstract evaluation only (RQ1 to RQ3): verdicts come from `src/sdn/proposal-triage.ts`; nothing was installed on the switch.
**Admissible means the verifier accepts the rule set, not that it is correct on the wire.**

Protocol B (verifier feedback, up to 5 turns), N = 20 per intent, seeds 1 to 20, temperature 0.2, top-p 0.95, `think: true`, one A100 SXM4 80GB Community pod per arm (Ollama 0.34.4), the two intents run concurrently. Models built as in section 11 (GGUF-space merge for L3; C3 the same pipeline without the adapter). Each cell directory holds `summary.json`, `trials.jsonl` and the pod's provenance files.

## Results

| Intent | Arm | Admissible on turn 1 | Within 5 turns (95% Wilson) | Turn it became admissible | Still failing after 5 turns | Distinct turn-1 outputs | Transport failures | Run commit |
| :--- | :--- | ---: | :--- | :--- | :--- | ---: | ---: | :--- |
| quarantine-set/v1 | C3 | 15/20 | 20/20: 84% to 100% | turn 1: 15, turn 2: 4, turn 3: 1 (mean 1.30) | none | 20 | 0 | `f50adbb` |
| quarantine-set/v1 | L3 | 12/20 | 20/20: 84% to 100% | turn 1: 12, turn 2: 7, turn 3: 1 (mean 1.45) | none | 20 | 0 | `f50adbb` |
| uplink-arp-confinement/v1 | C3 | 11/20 | 20/20: 84% to 100% | turn 1: 11, turn 2: 9 (mean 1.45) | none | 20 | 0 | `f50adbb` |
| uplink-arp-confinement/v1 | L3 | 18/20 | 20/20: 84% to 100% | turn 1: 18, turn 2: 2 (mean 1.10) | none | 20 | 0 | `f50adbb` |

| Arm | All intents: turn 1 | Within 5 turns (95% Wilson) | Mean turns to admissibility |
| :--- | ---: | :--- | ---: |
| L3 | 30/40 | 40/40: 91% to 100% | 1.27 |
| C3 | 26/40 | 40/40: 91% to 100% | 1.38 |

## What the numbers say, and no more

- **Both arms reach the ceiling.** Every trial of both arms was admissible within 5 turns (40 of 40 each, 91% to 100%), so the primary comparison of section 12.3 does not discriminate; section 12.6 stated this ceiling as likely.
- **Secondary measure (turn at which a trial became admissible).** On turn 1 L3 passed 30 of 40 and C3 26 of 40; mean turns 1.27 against 1.38. By intent: INTENT-5 12 against 15 of 20 on turn 1, INTENT-7 18 against 11. These differences are a few trials at N = 20, inside the same-seed run-to-run variation measured in section 12, and they point in opposite directions on the two intents; none of them is read as an effect.
- **Feedback repairs what the adapter and the control get wrong zero-shot.** In Protocol A the same intents were 18 (L3) and 43 (C3) of 50 on INTENT-5 and 49 and 32 on INTENT-7 (`../hard-intents-2026-10-31/`); with feedback every cell recovers within three turns. Protocol A and B are not merged, and turn 1 here is a fresh sample, not the Protocol A run.

## Deviations and incidents

None changed an arm's settings, prompts, seeds or the verifier. No transport failures; no cell was relaunched. The pods ran concurrently with the adapter training pod.

## What this does not show

- Anything about the L4 adapter (arm L4 is reported separately), or about intents other than these two.
- That the ceiling means the proposals are correct: the verifier is the author's, and wire behaviour (RQ4) was not tested.
- Any difference between L3 and C3 at this N: one run per cell.
