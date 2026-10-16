/**
 * latest-snapshot-hydration.test.ts
 * A cold serverless instance hydrates from the stored latest snapshot. What it hydrates must be exactly what the bridge
 * reported: a device the bridge did not send stays absent (nothing is filled in), a non-live push never overwrites the
 * row, and every failure reads as "no snapshot" (fail closed).
 *
 * IMPORTANT (Invariant 6): the database is mocked; the snapshot fixtures are test data.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_STORED_SNAPSHOT_MAX_BYTES,
  prepareStoredSnapshot,
  readStoredSnapshotMaxBytes,
  restoreStoredSnapshot,
} from '../../src/sdn/stored-snapshot.js';

const db = vi.hoisted(() => ({
  stored: null as null | { id: string; timestampMs: bigint; source: string; snapshotJson: unknown; updatedAt: Date },
  upserts: 0,
  mode: 'row' as 'row' | 'throw' | 'hang' | 'late_reject',
}));

vi.mock('@prisma/adapter-neon', () => ({ PrismaNeon: class { constructor(_o: unknown) {} } }));
vi.mock('@prisma/client', () => ({
  PrismaClient: class {
    zodiacTelemetryPoint = { create: async () => ({}) };
    zodiacLatestSnapshot = {
      findUnique: async () => {
        if (db.mode === 'throw') throw new Error('connection refused');
        if (db.mode === 'hang') return new Promise(() => undefined);
        if (db.mode === 'late_reject') return new Promise((_, rej) => setTimeout(() => rej(new Error('late failure')), 250));
        return db.stored;
      },
      upsert: async (args: { create: { id: string; timestampMs: bigint; source: string; snapshotJson: unknown } }) => {
        db.upserts += 1;
        db.stored = { ...args.create, updatedAt: new Date() };
        return db.stored;
      },
    };
  },
  Prisma: {},
}));

const MAX_AGE = 25_000;
// The per-point DB row writer needs full jetson points; these tests are about the latest-snapshot row, so no series.
const withBareJetson = { jetson: { status: 'online' } };

function liveSnapshot(extra: Record<string, unknown> = {}): never {
  const point = (t: number) => ({ timestampMs: t, rxBytes: 5n });
  return {
    source: 'live_hardware',
    system: { deviceName: 'Zodiac_FX', uptime: '99:01:02', cpuTemperatureC: 41 },
    ports: [{ port: 1, name: 'P1', status: 'UP', rxBytes: 123456789012345678n }],
    openflow: { status: 'Connected', activeFlows: 6, rules: [{ id: 1 }] },
    timeSeries: [point(1), point(2), point(3)],
    jetson: { status: 'online', timeSeries: [point(1), point(2)] },
    ...extra,
  } as never;
}

beforeEach(() => {
  vi.resetModules();
  db.stored = null;
  db.upserts = 0;
  db.mode = 'row';
  process.env['DATABASE_URL'] = 'postgres://test';
});
afterEach(() => vi.unstubAllEnvs());

describe('prepareStoredSnapshot', () => {
  it('writes BigInt as decimal strings (no precision loss) and keeps only the newest point of each series', () => {
    const r = prepareStoredSnapshot(liveSnapshot(), DEFAULT_STORED_SNAPSHOT_MAX_BYTES);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const j = r.json as { ports: Array<{ rxBytes: string }>; timeSeries: unknown[]; jetson: { timeSeries: unknown[] } };
    expect(j.ports[0]?.rxBytes).toBe('123456789012345678');
    expect(j.timeSeries).toEqual([{ timestampMs: 3, rxBytes: '5' }]);
    expect(j.jetson.timeSeries).toHaveLength(1);
  });

  it('refuses an oversized snapshot instead of truncating it', () => {
    const r = prepareStoredSnapshot(liveSnapshot({ blob: 'x'.repeat(5000) }), 2000);
    expect(r).toMatchObject({ ok: false, reason: 'too_large' });
  });

  it('does not invent a block the bridge did not send', () => {
    const r = prepareStoredSnapshot(liveSnapshot(), DEFAULT_STORED_SNAPSHOT_MAX_BYTES);
    if (!r.ok) throw new Error('unexpected');
    const j = r.json as Record<string, unknown>;
    expect('coral' in j).toBe(false);
    expect('workstation' in j).toBe(false);
    expect('rpi5' in j).toBe(false);
  });
});

describe('restoreStoredSnapshot / limits', () => {
  it('rejects values that are not a snapshot', () => {
    expect(restoreStoredSnapshot(null)).toBeNull();
    expect(restoreStoredSnapshot([])).toBeNull();
    expect(restoreStoredSnapshot({ system: {}, ports: [] })).toBeNull();
    expect(restoreStoredSnapshot({ system: {}, ports: {}, openflow: {} })).toBeNull();
    expect(restoreStoredSnapshot({ system: {}, ports: [], openflow: {} })).not.toBeNull();
  });

  it('bounds the size limit: out-of-range or malformed values fall back to the default', () => {
    expect(readStoredSnapshotMaxBytes({})).toBe(DEFAULT_STORED_SNAPSHOT_MAX_BYTES);
    expect(readStoredSnapshotMaxBytes({ ZODIAC_STORED_SNAPSHOT_MAX_BYTES: '100000' })).toBe(100000);
    expect(readStoredSnapshotMaxBytes({ ZODIAC_STORED_SNAPSHOT_MAX_BYTES: '10' })).toBe(DEFAULT_STORED_SNAPSHOT_MAX_BYTES);
    expect(readStoredSnapshotMaxBytes({ ZODIAC_STORED_SNAPSHOT_MAX_BYTES: '1e12' })).toBe(DEFAULT_STORED_SNAPSHOT_MAX_BYTES);
    expect(readStoredSnapshotMaxBytes({ ZODIAC_STORED_SNAPSHOT_MAX_BYTES: 'abc' })).toBe(DEFAULT_STORED_SNAPSHOT_MAX_BYTES);
  });
});

describe('persist then hydrate', () => {
  it('round-trips what the bridge reported and fills in nothing else', async () => {
    const m = await import('../../src/db/telemetry-db.js');
    await m.persistTelemetrySnapshot(liveSnapshot(withBareJetson), true);
    expect(db.upserts).toBe(1);
    const h = await m.getLatestTelemetrySnapshotFromDb(MAX_AGE);
    expect(h).not.toBeNull();
    expect(h?.system?.uptime).toBe('99:01:02');
    expect(h?.openflow?.activeFlows).toBe(6);
    expect(h?.jetson).toBeDefined();
    expect(h?.coral).toBeUndefined();
    expect(h?.workstation).toBeUndefined();
    expect(h?.rpi5).toBeUndefined();
  });

  it('never stores a non-live snapshot, so it cannot overwrite what the real bridge last said', async () => {
    const m = await import('../../src/db/telemetry-db.js');
    await m.persistTelemetrySnapshot(liveSnapshot(withBareJetson), true);
    await m.persistTelemetrySnapshot(liveSnapshot({ ...withBareJetson, source: 'cloud_snapshot', system: { uptime: 'FAKE' } }), true);
    await m.persistTelemetrySnapshot(liveSnapshot({ ...withBareJetson, source: 'disconnected' }), true);
    expect(db.upserts).toBe(1);
    const h = await m.getLatestTelemetrySnapshotFromDb(MAX_AGE);
    expect(h?.system?.uptime).toBe('99:01:02');
  });
});

describe('getLatestTelemetrySnapshotFromDb fails closed', () => {
  const stored = (offsetMs: number, over: Partial<{ source: string; snapshotJson: unknown }> = {}) => {
    const ts = Date.now() + offsetMs;
    return {
      id: 'latest',
      timestampMs: BigInt(ts),
      source: 'live_hardware',
      snapshotJson: { system: { uptime: 'u' }, ports: [], openflow: {} },
      updatedAt: new Date(ts),
      ...over,
    };
  };

  it('returns null for no row, a stale row, a non-live row, a malformed row, a query error and a hung query', async () => {
    const m = await import('../../src/db/telemetry-db.js');
    db.stored = null;
    expect(await m.getLatestTelemetrySnapshotFromDb(MAX_AGE)).toBeNull();
    db.stored = stored(-(MAX_AGE + 5_000));
    expect(await m.getLatestTelemetrySnapshotFromDb(MAX_AGE)).toBeNull();
    db.stored = stored(-1_000, { source: 'cloud_snapshot' });
    expect(await m.getLatestTelemetrySnapshotFromDb(MAX_AGE)).toBeNull();
    db.stored = stored(-1_000, { snapshotJson: { system: {} } });
    expect(await m.getLatestTelemetrySnapshotFromDb(MAX_AGE)).toBeNull();
    db.stored = stored(-1_000);
    expect(await m.getLatestTelemetrySnapshotFromDb(MAX_AGE)).not.toBeNull();
    db.mode = 'throw';
    expect(await m.getLatestTelemetrySnapshotFromDb(MAX_AGE)).toBeNull();
  });

  it('does not treat a row dated far in the future as fresh', async () => {
    const m = await import('../../src/db/telemetry-db.js');
    db.stored = stored(10 * 60_000);
    expect(await m.getLatestTelemetrySnapshotFromDb(MAX_AGE)).toBeNull();
  });

  it('gives up on a hung query at the deadline', async () => {
    vi.stubEnv('TELEMETRY_DB_QUERY_TIMEOUT_MS', '100');
    const m = await import('../../src/db/telemetry-db.js');
    db.mode = 'hang';
    expect(await m.getLatestTelemetrySnapshotFromDb(MAX_AGE)).toBeNull();
  });

  it('a query that fails after the deadline is logged, not left as an unhandled rejection', async () => {
    vi.stubEnv('TELEMETRY_DB_QUERY_TIMEOUT_MS', '100');
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const m = await import('../../src/db/telemetry-db.js');
      db.mode = 'late_reject';
      expect(await m.getLatestTelemetrySnapshotFromDb(MAX_AGE)).toBeNull();
      await new Promise((r) => setTimeout(r, 400));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
