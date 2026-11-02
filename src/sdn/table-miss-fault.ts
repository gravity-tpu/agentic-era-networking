/**
 * table-miss-fault.ts
 * Configuration of a bounded, acknowledged FAULT: after the isolation readback has verified the baseline, the bridge replaces the table-miss DROP with a priority-0
 * forward to the tap port (P3) or removes it, then puts the DROP back at a time limit. Three modes: `forward-to-tap` (once), `forward-to-tap-sticky` (re-asserts the
 * forward every few seconds, so a repair that re-sends the DROP does not take: it exercises the repair governor's budget), and `delete-table-miss` (a strict delete, so the
 * entry is absent). Its only purpose is to let the isolation watcher (docs/design/isolation-watch.md) and the repair
 * governor (docs/design/isolation-repair.md) be exercised against the real switch, which nothing else can do: no route can change the table-miss and the experiment endpoint
 * always reinstalls the DROP.
 *
 * Fail closed (Invariant 3): the fault is off unless the mode, the exact acknowledgement string AND a valid time limit are all present. Any doubt leaves the DROP alone
 * and says why. The time limit is bounded (Invariant 5); the mode is the only one that exists, so a typo cannot select a different, looser one. Pure: reads an
 * environment object, touches nothing.
 */

export const TABLE_MISS_FAULT_MODES = ['forward-to-tap', 'forward-to-tap-sticky', 'delete-table-miss'] as const;
export type TableMissFaultMode = (typeof TABLE_MISS_FAULT_MODES)[number];
/** How often the sticky mode re-sends the forward. Shorter than the repair verification delay (5 s), so a repair is overwritten before it is read back. */
export const TABLE_MISS_FAULT_REASSERT_MS = 2_000;
export const TABLE_MISS_FAULT_ACK = 'I-ACCEPT-A-BOUNDED-FORWARDING-TABLE-MISS';
export const TABLE_MISS_FAULT_DEFAULT_SECONDS = 240;
/** Below one recheck period (60 s) the isolation recheck could miss the fault entirely. */
export const TABLE_MISS_FAULT_MIN_SECONDS = 60;
export const TABLE_MISS_FAULT_MAX_SECONDS = 900;

export interface TableMissFaultConfig {
  readonly enabled: boolean;
  readonly mode: TableMissFaultMode | null;
  /** Milliseconds until the DROP is put back; 0 when the fault is off. */
  readonly durationMs: number;
  /** Milliseconds between re-assertions (sticky mode only); 0 otherwise. */
  readonly reassertMs: number;
  /** Why the fault is off although something asked for it; empty when it is off because nothing did. */
  readonly warnings: readonly string[];
}

const OFF = (...warnings: string[]): TableMissFaultConfig => ({ enabled: false, mode: null, durationMs: 0, reassertMs: 0, warnings });
const isMode = (m: string): m is TableMissFaultMode => (TABLE_MISS_FAULT_MODES as readonly string[]).includes(m);

export function parseTableMissFault(env: Readonly<Record<string, string | undefined>>): TableMissFaultConfig {
  const mode = env['ZODIAC_FAULT_TABLE_MISS'];
  if (mode === undefined || mode === '') return OFF();
  if (!isMode(mode)) return OFF(`ZODIAC_FAULT_TABLE_MISS=${JSON.stringify(mode)} is not a known mode (known: ${TABLE_MISS_FAULT_MODES.join(', ')}); the table-miss stays a DROP`);
  if (env['ZODIAC_FAULT_TABLE_MISS_ACK'] !== TABLE_MISS_FAULT_ACK) return OFF('ZODIAC_FAULT_TABLE_MISS is set but ZODIAC_FAULT_TABLE_MISS_ACK is missing or wrong; the table-miss stays a DROP');
  const raw = env['ZODIAC_FAULT_TABLE_MISS_SECONDS'];
  let seconds = TABLE_MISS_FAULT_DEFAULT_SECONDS;
  if (raw !== undefined) {
    const bad = (): TableMissFaultConfig => OFF(`ZODIAC_FAULT_TABLE_MISS_SECONDS=${JSON.stringify(raw)} must be a whole number from ${TABLE_MISS_FAULT_MIN_SECONDS} to ${TABLE_MISS_FAULT_MAX_SECONDS}; the table-miss stays a DROP`);
    if (!/^[0-9]{1,4}$/.test(raw)) return bad();
    seconds = Number(raw);
    if (seconds < TABLE_MISS_FAULT_MIN_SECONDS || seconds > TABLE_MISS_FAULT_MAX_SECONDS) return bad();
  }
  return { enabled: true, mode, durationMs: seconds * 1000, reassertMs: mode === 'forward-to-tap-sticky' ? TABLE_MISS_FAULT_REASSERT_MS : 0, warnings: [] };
}
