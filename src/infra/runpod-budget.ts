/**
 * Pure budget and deadline logic for ephemeral Runpod pods. No I/O.
 *
 * Invariant 2: money is integer micro-USD (BigInt), time is whole seconds. Prices arrive from the
 *   API as JSON numbers; they are converted through their decimal string, truncated to micro-USD.
 * Invariant 3/4: a run that cannot be priced, exceeds the cap or exceeds the balance is refused.
 * Invariant 5: the cap is named and bounded (default and ceiling below).
 *
 * What this proves: the planned worst-case spend (rate x timeout, rounded up) is within the cap and
 * the balance at plan time. It does not prove the pod actually stops; the in-pod `timeout`, the
 * post-create price check and `sweep` in scripts/runpod.ts exist for that.
 */

const MICROS_PER_USD = 1_000_000n;

/** Per-run cap approved by the owner on 2026-10-29. */
export const DEFAULT_RUN_CAP_MICROS = 5n * MICROS_PER_USD;
/** No flag or env var may raise a single run above this without a code change and review. */
export const MAX_RUN_CAP_MICROS = 25n * MICROS_PER_USD;

const POD_NAME_PREFIX = 'zodiac-';

export function parseUsdToMicros(value: string | number): bigint {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`ERR_BAD_USD: ${String(value)}`);
  }
  const text = String(value);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (match === null) {
    throw new Error(`ERR_BAD_USD: ${JSON.stringify(text)}`);
  }
  const whole = BigInt(match[1] ?? '0');
  const fraction = (match[2] ?? '').padEnd(6, '0').slice(0, 6);
  return whole * MICROS_PER_USD + BigInt(fraction);
}

export function formatMicros(micros: bigint): string {
  const whole = micros / MICROS_PER_USD;
  const frac = (micros % MICROS_PER_USD).toString().padStart(6, '0').slice(0, 4);
  return `$${whole.toString()}.${frac}`;
}

export interface RunRequest {
  readonly capMicros: bigint;
  readonly ratePerHourMicros: bigint;
  readonly balanceMicros: bigint;
  readonly requestedSeconds: bigint;
}

export type RunRefusalCode =
  | 'ERR_CAP_ABOVE_CEILING'
  | 'ERR_NO_PRICE'
  | 'ERR_BAD_DURATION'
  | 'ERR_OVER_CAP'
  | 'ERR_INSUFFICIENT_BALANCE';

export type RunPlan =
  | { readonly ok: true; readonly estimatedMicros: bigint; readonly timeoutSeconds: bigint }
  | { readonly ok: false; readonly code: RunRefusalCode; readonly detail: string };

export function planRun(req: RunRequest): RunPlan {
  if (req.capMicros <= 0n || req.capMicros > MAX_RUN_CAP_MICROS) {
    return {
      ok: false,
      code: 'ERR_CAP_ABOVE_CEILING',
      detail: `cap ${formatMicros(req.capMicros)} outside (0, ${formatMicros(MAX_RUN_CAP_MICROS)}]`,
    };
  }
  if (req.ratePerHourMicros <= 0n) {
    return { ok: false, code: 'ERR_NO_PRICE', detail: 'no positive hourly price for this GPU/cloud' };
  }
  if (req.requestedSeconds <= 0n) {
    return { ok: false, code: 'ERR_BAD_DURATION', detail: 'duration must be a positive number of seconds' };
  }
  const estimatedMicros = (req.ratePerHourMicros * req.requestedSeconds + 3599n) / 3600n;
  if (estimatedMicros > req.capMicros) {
    return {
      ok: false,
      code: 'ERR_OVER_CAP',
      detail: `estimate ${formatMicros(estimatedMicros)} exceeds cap ${formatMicros(req.capMicros)}`,
    };
  }
  if (estimatedMicros > req.balanceMicros) {
    return {
      ok: false,
      code: 'ERR_INSUFFICIENT_BALANCE',
      detail: `estimate ${formatMicros(estimatedMicros)} exceeds balance ${formatMicros(req.balanceMicros)}`,
    };
  }
  return { ok: true, estimatedMicros, timeoutSeconds: req.requestedSeconds };
}

/** Pod names carry the wall-clock deadline (epoch seconds) so `sweep` can find overdue pods. */
export function encodePodName(label: string, deadlineEpochSeconds: bigint): string {
  const safe = label.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${POD_NAME_PREFIX}${deadlineEpochSeconds.toString()}-${safe}`;
}

/** Null for any pod this tool did not create, so `sweep` never touches foreign pods. */
export function decodePodDeadline(name: string): bigint | null {
  if (!name.startsWith(POD_NAME_PREFIX)) return null;
  const match = /^(\d+)-/.exec(name.slice(POD_NAME_PREFIX.length));
  return match === null ? null : BigInt(match[1] ?? '0');
}

export function isExpired(deadlineEpochSeconds: bigint, nowEpochSeconds: bigint): boolean {
  return nowEpochSeconds >= deadlineEpochSeconds;
}

/**
 * Placement policy (owner, 2026-10-30): Community Cloud spot for quick scoring and sweeps, Secure Cloud
 * on-demand reserved for longer multi-epoch fine-tuning. A preempted spot pod loses its container disk, so
 * spot runs are bounded (Invariant 5) and must be restartable; training is never placed on spot.
 */
export type JobKind = 'score' | 'sweep' | 'train';
export type Cloud = 'secure' | 'community';
export interface Placement {
  readonly cloud: Cloud;
  readonly interruptible: boolean;
}

/** Longest run allowed on an interruptible pod. */
export const MAX_SPOT_SECONDS = 3n * 3600n;

export function placementFor(kind: JobKind, opts: { readonly onDemand?: boolean } = {}): Placement {
  switch (kind) {
    case 'train':
      if (opts.onDemand === true) {
        throw new Error('ERR_PLACEMENT: training is already Secure on-demand; --on-demand only applies to score and sweep');
      }
      return { cloud: 'secure', interruptible: false };
    case 'score':
    case 'sweep':
      // Never Secure: the override moves the pod off spot, not onto the reserved tier.
      return { cloud: 'community', interruptible: opts.onDemand !== true };
    default:
      throw new Error(`ERR_PLACEMENT: unknown job kind ${JSON.stringify(kind)}`);
  }
}

export type PlacementCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'ERR_SPOT_TOO_LONG'; readonly detail: string };

export function checkPlacementDuration(placement: Placement, seconds: bigint): PlacementCheck {
  if (placement.interruptible && seconds > MAX_SPOT_SECONDS) {
    return {
      ok: false,
      code: 'ERR_SPOT_TOO_LONG',
      detail: `${seconds.toString()} s exceeds the ${MAX_SPOT_SECONDS.toString()} s spot ceiling; use --on-demand or split the job`,
    };
  }
  return { ok: true };
}
