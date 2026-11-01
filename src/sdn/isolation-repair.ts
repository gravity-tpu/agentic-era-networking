/**
 * isolation-repair.ts
 * The repair governor: when the bridge may re-install the person-approved isolation policy by itself after the switch's table-miss DROP is found
 * missing or wrong (roadmap property A3; docs/design/isolation-repair.md).
 *
 * This is detector-driven action without a person, so it acts only inside an envelope a person approved in advance (Invariant 4; the same rule as
 * quarantine-envelope.ts): opt-in (off unless ZODIAC_ISOLATION_REPAIR=1), scoped to the table-miss (a generic mismatch may be a quarantine or an experiment
 * table that a re-install would wipe), damped (several consecutive confirmed readings), rate-limited (a minimum interval between repairs), bounded per window,
 * never while an experiment runs or the switch session is down, and when its budget is spent it stops and waits for a person. It repairs to the policy a person
 * already approved; it never invents one. It does not prove the switch is repaired: the readback that follows does. Pure: no I/O, no clock of its own.
 */

export interface RepairConfig {
  readonly enabled: boolean;
  /** Consecutive bad readings before a repair. */
  readonly readingsToRepair: number;
  /** Minimum time between two repairs. */
  readonly minIntervalMs: number;
  /** At most this many repairs in any window. */
  readonly maxPerWindow: number;
  readonly windowMs: number;
  /** Consecutive clean readings that clear the exhausted flag: the condition really resolved. */
  readonly cleanReadingsToClear: number;
}

export const DEFAULT_REPAIR_CONFIG: RepairConfig = {
  enabled: false,
  readingsToRepair: 3,
  minIntervalMs: 600_000,
  maxPerWindow: 3,
  windowMs: 3_600_000,
  cleanReadingsToClear: 3,
};

interface Bound { readonly env: string; readonly key: 'readingsToRepair' | 'minIntervalMs' | 'maxPerWindow' | 'windowMs'; readonly min: number; readonly max: number }
const BOUNDS: readonly Bound[] = [
  { env: 'ZODIAC_ISOLATION_REPAIR_READINGS', key: 'readingsToRepair', min: 1, max: 20 },
  { env: 'ZODIAC_ISOLATION_REPAIR_MIN_INTERVAL_MS', key: 'minIntervalMs', min: 60_000, max: 3_600_000 },
  { env: 'ZODIAC_ISOLATION_REPAIR_MAX_PER_WINDOW', key: 'maxPerWindow', min: 1, max: 20 },
  { env: 'ZODIAC_ISOLATION_REPAIR_WINDOW_MS', key: 'windowMs', min: 600_000, max: 86_400_000 },
];

/** Reads the settings. Off unless ZODIAC_ISOLATION_REPAIR is exactly "1" (or "0"); anything else, and any value out of bounds, is an error: nothing is clamped or guessed. */
export function parseRepairConfig(env: Readonly<Record<string, string | undefined>>): RepairConfig {
  const out: { -readonly [K in keyof RepairConfig]: RepairConfig[K] } = { ...DEFAULT_REPAIR_CONFIG };
  const flag = env['ZODIAC_ISOLATION_REPAIR'];
  if (flag !== undefined && flag !== '') {
    if (flag !== '0' && flag !== '1') throw new RangeError(`ZODIAC_ISOLATION_REPAIR must be 0 or 1, got ${JSON.stringify(flag)}`);
    out.enabled = flag === '1';
  }
  for (const b of BOUNDS) {
    const raw = env[b.env];
    if (raw === undefined || raw === '') continue;
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < b.min || n > b.max) throw new RangeError(`${b.env} must be a whole number from ${b.min} to ${b.max}, got ${JSON.stringify(raw)}`);
    out[b.key] = n;
  }
  return out;
}

/** Table-miss readings that mean the default drop is not as the policy requires. */
const BAD_TABLE_MISS: ReadonlySet<string> = new Set(['absent', 'forwards', 'unrecognised']);

export interface RepairReading { readonly state: string; readonly tableMiss: string | null; readonly monoNs: bigint }
export interface RepairContext { readonly sessionUp: boolean; readonly experimentIdle: boolean; readonly busy: boolean }

export type RepairDecision =
  | { readonly action: 'none' }
  | { readonly action: 'repair'; readonly trigger: string; readonly readings: number }
  | { readonly action: 'blocked'; readonly reason: string }
  | { readonly action: 'exhausted' };

export interface RepairStatus {
  readonly enabled: boolean;
  readonly totalRepairs: number;
  readonly repairsInWindow: number;
  readonly lastRepairAtMs: number | null;
  readonly lastTrigger: string | null;
  readonly exhausted: boolean;
}

const NS_PER_MS = 1_000_000n;

export class RepairGovernor {
  private streak = 0;
  private clean = 0;
  private lastTrigger: string | null = null;
  private lastRepairAtMs: number | null = null;
  private total = 0;
  private exhausted = false;
  private exhaustedAnnounced = false;
  private readonly repairsNs: bigint[] = [];

  constructor(private readonly cfg: RepairConfig) {}

  private prune(nowNs: bigint): void {
    const horizon = BigInt(this.cfg.windowMs) * NS_PER_MS;
    while (this.repairsNs.length > 0 && nowNs - (this.repairsNs[0] as bigint) > horizon) this.repairsNs.shift();
  }

  observe(r: RepairReading, ctx: RepairContext): RepairDecision {
    this.prune(r.monoNs);
    if (!this.cfg.enabled) return { action: 'none' };

    const isBad = r.tableMiss !== null && BAD_TABLE_MISS.has(r.tableMiss);
    const isClean = r.state === 'verified' && r.tableMiss === 'drops';
    if (isClean) {
      this.streak = 0;
      this.clean++;
      if (this.exhausted && this.clean >= this.cfg.cleanReadingsToClear) { this.exhausted = false; this.exhaustedAnnounced = false; }
      return { action: 'none' };
    }
    if (!isBad) return { action: 'none' }; // a generic mismatch, a failed or unobservable readback: out of scope or no knowledge, so no action and no change to the streak
    this.clean = 0;
    this.streak++;
    if (this.streak < this.cfg.readingsToRepair) return { action: 'none' };

    if (!ctx.experimentIdle) return { action: 'blocked', reason: 'an experiment is running' };
    if (!ctx.sessionUp) return { action: 'blocked', reason: 'no OpenFlow session' };
    if (ctx.busy) return { action: 'blocked', reason: 'an install or repair is in progress' };

    if (this.exhausted) return this.exhaustedAnnounced ? { action: 'none' } : this.announceExhausted();
    const last = this.repairsNs[this.repairsNs.length - 1];
    if (last !== undefined && r.monoNs - last < BigInt(this.cfg.minIntervalMs) * NS_PER_MS) {
      return { action: 'blocked', reason: `the minimum interval between repairs (${Math.round(this.cfg.minIntervalMs / 60_000)} min) has not passed` };
    }
    if (this.repairsNs.length >= this.cfg.maxPerWindow) { this.exhausted = true; return this.announceExhausted(); }
    return { action: 'repair', trigger: r.tableMiss as string, readings: this.streak };
  }

  private announceExhausted(): RepairDecision {
    this.exhausted = true;
    this.exhaustedAnnounced = true;
    return { action: 'exhausted' };
  }

  /** The caller sent the repair: count it, and start a fresh streak so the next repair needs fresh readings. */
  repaired(monoNs: bigint, nowMs: number, trigger: string): void {
    this.repairsNs.push(monoNs);
    this.total++;
    this.lastRepairAtMs = nowMs;
    this.lastTrigger = trigger;
    this.streak = 0;
  }

  status(): RepairStatus {
    return { enabled: this.cfg.enabled, totalRepairs: this.total, repairsInWindow: this.repairsNs.length, lastRepairAtMs: this.lastRepairAtMs, lastTrigger: this.lastTrigger, exhausted: this.exhausted };
  }
}
