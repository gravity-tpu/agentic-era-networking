import { describe, it, expect } from 'vitest';
import { todayLine } from '../../scripts/ai-reviewer.mjs';

describe('the reviewer is told today\'s date', () => {
  it('states the UTC date of the clock it is given', () => {
    expect(todayLine(new Date('2026-10-26T16:43:57Z'))).toContain('2026-10-26');
    expect(todayLine(new Date('2027-01-01T00:00:00Z'))).toContain('2027-01-01');
  });

  it('uses the UTC day, not the local day, at the boundary', () => {
    // 23:30 on 2026-10-26 in UTC-5 is already 2026-10-27 UTC: the line must say UTC's day
    expect(todayLine(new Date('2026-10-27T04:30:00Z'))).toContain('2026-10-27');
  });

  it('tells the model only later dates are future, and works with the default clock', () => {
    const line = todayLine();
    expect(line).toMatch(/flag a date only if it is later than today/);
    expect(line).toMatch(/Today's date is \d{4}-\d{2}-\d{2} \(UTC\)/);
  });
});
