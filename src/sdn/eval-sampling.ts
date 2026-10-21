/**
 * What an evaluation run records as its sampling settings (scripts/agent-eval.ts).
 *
 * Only settings that were actually sent to the model are recorded as numbers. The Anthropic arm sends no temperature, top-p or seed
 * (Claude Fable 5.1 rejects them, and the runner sends none to any Claude model), so its summary says `provider-default` instead of
 * carrying the nominal 0.2 / 0.95 that the Ollama and Gemini arms really used. Pure: no I/O.
 */

export type EvalProvider = 'ollama' | 'gemini' | 'anthropic';

export interface SamplingRecord {
  readonly temperature: number | null;
  readonly topP: number | null;
  /** `1..N` when seeds were sent, `provider-default` when none were. */
  readonly seeds: string;
  /** True when the numbers above were actually sent to the model. */
  readonly sent: boolean;
}

export function samplingRecord(provider: EvalProvider, temperature: number, topP: number, trials: number): SamplingRecord {
  if (provider === 'anthropic') return { temperature: null, topP: null, seeds: 'provider-default', sent: false };
  return { temperature, topP, seeds: `1..${trials}`, sent: true };
}
