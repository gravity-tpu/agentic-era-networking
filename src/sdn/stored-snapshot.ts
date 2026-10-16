/**
 * Pure helpers for the persisted latest snapshot (the `ZodiacLatestSnapshot` row).
 *
 * A cold serverless instance hydrates from this row. It therefore stores exactly what the bridge reported (every device
 * block, as received) and nothing synthesized: no default is filled in for a field the bridge did not send (Invariant 6).
 * A device the bridge did not report stays absent, and the dashboard shows "not reported" for it.
 */

/** Row id of the single "latest" row. */
export const LATEST_SNAPSHOT_ROW_ID = 'latest';

/** Default cap on the stored JSON. A snapshot over the cap is not stored (and the previous row ages out), never truncated. */
export const DEFAULT_STORED_SNAPSHOT_MAX_BYTES = 512 * 1024;
const MIN_STORED_SNAPSHOT_MAX_BYTES = 16 * 1024;
const MAX_STORED_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

/** ZODIAC_STORED_SNAPSHOT_MAX_BYTES within 16 KiB..4 MiB; anything else falls back to the default. */
export function readStoredSnapshotMaxBytes(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env['ZODIAC_STORED_SNAPSHOT_MAX_BYTES'];
  if (raw === undefined || raw === '') return DEFAULT_STORED_SNAPSHOT_MAX_BYTES;
  const n = Number(raw);
  return Number.isInteger(n) && n >= MIN_STORED_SNAPSHOT_MAX_BYTES && n <= MAX_STORED_SNAPSHOT_MAX_BYTES
    ? n
    : DEFAULT_STORED_SNAPSHOT_MAX_BYTES;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The newest point only: the history lives in ZodiacTelemetryPoint, this row is "what the bridge last said". */
function keepLastPoint(block: unknown): unknown {
  if (!isRecord(block) || !Array.isArray(block['timeSeries'])) return block;
  const series = block['timeSeries'];
  return { ...block, timeSeries: series.length > 0 ? [series[series.length - 1]] : [] };
}

const DEVICE_KEYS = ['jetson', 'coral', 'workstation', 'rpi5'] as const;

export type StoredSnapshotResult =
  | { readonly ok: true; readonly json: unknown; readonly bytes: number }
  | { readonly ok: false; readonly reason: 'too_large' | 'not_serializable'; readonly bytes: number };

/** Serialize a live snapshot for storage: BigInt as decimal strings, each series cut to its newest point, size-capped. */
export function prepareStoredSnapshot(snapshot: object, maxBytes: number): StoredSnapshotResult {
  const top: Record<string, unknown> = { ...snapshot };
  top['timeSeries'] = (keepLastPoint({ timeSeries: top['timeSeries'] }) as { timeSeries: unknown }).timeSeries;
  for (const key of DEVICE_KEYS) {
    if (key in top) top[key] = keepLastPoint(top[key]);
  }
  let text: string;
  try {
    text = JSON.stringify(top, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return { ok: false, reason: 'not_serializable', bytes: 0 };
  }
  const bytes = Buffer.byteLength(text, 'utf-8');
  if (bytes > maxBytes) return { ok: false, reason: 'too_large', bytes };
  return { ok: true, json: JSON.parse(text) as unknown, bytes };
}

/**
 * Accept a stored value only if it has the shape the POST handler requires of a pushed body (`system`, `openflow`
 * objects; `ports` array). Anything else is treated as no row: hydration fails closed.
 */
export function restoreStoredSnapshot(json: unknown): Record<string, unknown> | null {
  if (!isRecord(json)) return null;
  if (!isRecord(json['system']) || !isRecord(json['openflow']) || !Array.isArray(json['ports'])) return null;
  return json;
}
