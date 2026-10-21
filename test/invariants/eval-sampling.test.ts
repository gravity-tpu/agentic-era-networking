import { describe, it, expect } from 'vitest';
import { samplingRecord } from '../../src/sdn/eval-sampling.js';

describe('samplingRecord', () => {
  it('records the real settings for the arms that send them', () => {
    for (const p of ['ollama', 'gemini'] as const) {
      expect(samplingRecord(p, 0.2, 0.95, 50)).toEqual({ temperature: 0.2, topP: 0.95, seeds: '1..50', sent: true });
    }
  });

  it('records no numbers for the Anthropic arm, which sends none', () => {
    expect(samplingRecord('anthropic', 0.2, 0.95, 200)).toEqual({ temperature: null, topP: null, seeds: 'provider-default', sent: false });
  });
});
