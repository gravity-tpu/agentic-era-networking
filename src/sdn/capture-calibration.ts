/**
 * capture-calibration.ts
 * Pure helpers and data structures for observation-point NIC capture calibration.
 *
 * Council Invariant 2 (Integer accounting): Counters and PPM calculations are strictly 64-bit BigInt.
 * Council Invariant 3 (Fail closed): Unobserved bursts fail closed.
 * Council Invariant 6 (Provenance): Calibration artifacts store cryptographic and physical metadata.
 */

export const CALIBRATION_SCHEMA = 'zodiac-capture-calibration/v1' as const;

export interface CalibrationCounters {
  readonly startRxPackets: bigint;
  readonly endRxPackets: bigint;
  readonly startRxDropped: bigint;
  readonly endRxDropped: bigint;
  readonly injectedPackets: bigint;
}

export type CalibrationStatus = 'clean' | 'lossy' | 'failed';

export interface CalibrationVerdict {
  readonly status: CalibrationStatus;
  readonly capturedPackets: bigint;
  readonly kernelDroppedPackets: bigint;
  readonly missingPackets: bigint;
  readonly lossPpm: bigint;
  readonly allowedLossPpm: bigint;
}

export interface CalibrationRecord {
  readonly schema: typeof CALIBRATION_SCHEMA;
  readonly observationPoint: 'O1' | 'O2' | 'O3';
  readonly interfaceName: string;
  readonly host: string;
  readonly startedAtIso: string;
  readonly startedMonotonicNs: bigint;
  readonly finishedMonotonicNs: bigint;
  readonly injectedRatePps: number;
  readonly counters: CalibrationCounters;
  readonly verdict: CalibrationVerdict;
}

/**
 * Derives a deterministic calibration verdict from before/after capture counters.
 * All math is integer PPM (parts-per-million) without floats (Invariant 2).
 */
export function deriveCalibrationVerdict(
  counters: CalibrationCounters,
  allowedLossPpm: bigint = 0n,
): CalibrationVerdict {
  const capturedPackets =
    counters.endRxPackets >= counters.startRxPackets ? counters.endRxPackets - counters.startRxPackets : 0n;

  const kernelDroppedPackets =
    counters.endRxDropped >= counters.startRxDropped ? counters.endRxDropped - counters.startRxDropped : 0n;

  const missingPackets =
    counters.injectedPackets > capturedPackets ? counters.injectedPackets - capturedPackets : 0n;

  const lossPpm =
    counters.injectedPackets > 0n ? (missingPackets * 1_000_000n) / counters.injectedPackets : 0n;

  let status: CalibrationStatus;
  if (counters.injectedPackets > 0n && capturedPackets === 0n) {
    status = 'failed';
  } else if (lossPpm <= allowedLossPpm) {
    status = 'clean';
  } else {
    status = 'lossy';
  }

  return {
    status,
    capturedPackets,
    kernelDroppedPackets,
    missingPackets,
    lossPpm,
    allowedLossPpm,
  };
}
