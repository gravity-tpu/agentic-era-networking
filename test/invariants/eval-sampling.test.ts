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
  it('labels an offset seed range and leaves the default label alone', () => {
    expect(samplingRecord('ollama', 0.2, 0.95, 50, 51).seeds).toBe('51..100');
    expect(samplingRecord('ollama', 0.2, 0.95, 50, 101).seeds).toBe('101..150');
    expect(samplingRecord('ollama', 0.2, 0.95, 50, 1).seeds).toBe('1..50');
    expect(samplingRecord('anthropic', 0.2, 0.95, 50, 51).seeds).toBe('provider-default');
  });
});
