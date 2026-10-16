/**
 * fresh-live-row.test.ts
 * hasFreshLiveTelemetryRow: how a serverless instance with empty memory learns that some other instance has been
 * receiving the real bridge. Any failure must read as "not fresh" (the cloud then does not claim live it cannot see),
 * and a row dated in the future must not read as fresh forever.
 *
 * IMPORTANT (Invariant 6): the database is mocked; rows are fixtures.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

  it('a row only slightly ahead of this clock (skew) is fresh, but one far in the future is not', async () => {
    db.row = rowAt(+2_000);
    expect(await run()).toBe(true);
    db.row = rowAt(+(MAX_AGE + 60_000));
    expect(await run()).toBe(false);
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
