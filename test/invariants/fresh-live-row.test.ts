/**
 * fresh-live-row.test.ts
 * hasFreshLiveTelemetryRow: how a serverless instance with empty memory learns that some other instance has been
 * receiving the real bridge. Any failure must read as "not fresh" (the cloud then does not claim live it cannot see),
 * and a row dated in the future must not read as fresh forever.
 *
 * IMPORTANT (Invariant 6): the database is mocked; rows are fixtures.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = vi.hoisted(() => ({
  row: null as null | { timestampMs: bigint; createdAt: Date },
  mode: 'row' as 'row' | 'throw' | 'hang',
}));

vi.mock('@prisma/adapter-neon', () => ({ PrismaNeon: class { constructor(_o: unknown) {} } }));
vi.mock('@prisma/client', () => ({
  PrismaClient: class {
    zodiacTelemetryPoint = {
      findFirst: async () => {
        if (db.mode === 'throw') throw new Error('connection refused');
        if (db.mode === 'hang') return new Promise(() => undefined);
        return db.row;
      },
    };
  },
  Prisma: {},
}));

const MAX_AGE = 25_000;
const rowAt = (offsetMs: number) => {
  const ts = Date.now() + offsetMs;
  return { timestampMs: BigInt(ts), createdAt: new Date(ts) };
};

beforeEach(() => {
  vi.resetModules();
  vi.useRealTimers();
  db.row = null;
  db.mode = 'row';
  process.env['DATABASE_URL'] = 'postgres://test';
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function run(): Promise<boolean> {
  const { hasFreshLiveTelemetryRow } = await import('../../src/db/telemetry-db.js');
  return hasFreshLiveTelemetryRow(MAX_AGE);
}

describe('hasFreshLiveTelemetryRow', () => {
  it('is true for a recent live row, false for an old one, false when there is none', async () => {
    db.row = rowAt(-5_000);
    expect(await run()).toBe(true);
    db.row = rowAt(-(MAX_AGE + 5_000));
    expect(await run()).toBe(false);
    db.row = null;
    expect(await run()).toBe(false);
  });

  it('a row ahead of this clock is fresh only within the skew tolerance, which is separate from the staleness bound', async () => {
    const { DB_FUTURE_SKEW_TOLERANCE_MS } = await import('../../src/db/telemetry-db.js');
    expect(DB_FUTURE_SKEW_TOLERANCE_MS).toBeLessThan(MAX_AGE); // tolerance for skew is much tighter than the staleness bound
    db.row = rowAt(+2_000);
    expect(await run()).toBe(true);
    db.row = rowAt(+(DB_FUTURE_SKEW_TOLERANCE_MS - 1_000));
    expect(await run()).toBe(true);
    db.row = rowAt(+(DB_FUTURE_SKEW_TOLERANCE_MS + 2_000)); // within MAX_AGE but beyond the skew tolerance
    expect(await run()).toBe(false);
    db.row = rowAt(+(MAX_AGE + 60_000));
    expect(await run()).toBe(false);
  });

  it('the skew tolerance is a named, bounded, configurable limit', async () => {
    const { DB_FUTURE_SKEW_TOLERANCE_MS, readDbFutureSkewToleranceMs } = await import('../../src/db/telemetry-db.js');
    expect(readDbFutureSkewToleranceMs({})).toBe(DB_FUTURE_SKEW_TOLERANCE_MS);
    expect(readDbFutureSkewToleranceMs({ TELEMETRY_DB_FUTURE_SKEW_MS: '3000' })).toBe(3000);
    expect(readDbFutureSkewToleranceMs({ TELEMETRY_DB_FUTURE_SKEW_MS: '0' })).toBe(0);
    for (const bad of ['60001', 'abc', '', '-1', '5s']) {
      expect(readDbFutureSkewToleranceMs({ TELEMETRY_DB_FUTURE_SKEW_MS: bad }), bad).toBe(DB_FUTURE_SKEW_TOLERANCE_MS);
    }
  });

  it('a configured skew tolerance changes what counts as fresh', async () => {
    vi.stubEnv('TELEMETRY_DB_FUTURE_SKEW_MS', '1000');
    db.row = rowAt(+5_000); // fresh under the 10 s default, not under 1 s
    expect(await run()).toBe(false);
  });

  it('the query deadline is a named, bounded, configurable limit', async () => {
    const { DEFAULT_DB_QUERY_DEADLINE_MS, readDbQueryDeadlineMs } = await import('../../src/db/telemetry-db.js');
    expect(DEFAULT_DB_QUERY_DEADLINE_MS).toBe(1500);
    expect(readDbQueryDeadlineMs({})).toBe(1500);
    expect(readDbQueryDeadlineMs({ TELEMETRY_DB_QUERY_TIMEOUT_MS: '800' })).toBe(800);
    for (const bad of ['99', '5001', 'abc', '', '-1', '1e3', '800ms']) {
      expect(readDbQueryDeadlineMs({ TELEMETRY_DB_QUERY_TIMEOUT_MS: bad }), bad).toBe(1500);
    }
  });

  it('a configured deadline governs the hang path', async () => {
    vi.stubEnv('TELEMETRY_DB_QUERY_TIMEOUT_MS', '200');
    db.mode = 'hang';
    vi.useFakeTimers();
    const pending = run();
    await vi.advanceTimersByTimeAsync(250); // well under the 1500 ms default, past the configured 200 ms
    expect(await pending).toBe(false);
    vi.unstubAllEnvs();
  });

  it('reads as not fresh when the query fails, and when it does not answer in time', async () => {
    db.mode = 'throw';
    expect(await run()).toBe(false);
    db.mode = 'hang';
    vi.useFakeTimers();
    const pending = run();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toBe(false);
  });

  it('is false when no database is configured', async () => {
    delete process.env['DATABASE_URL'];
    delete process.env['agentic_POSTGRES_PRISMA_URL'];
    delete process.env['agentic_DATABASE_URL'];
    delete process.env['POSTGRES_PRISMA_URL'];
    expect(await run()).toBe(false);
  });
});
