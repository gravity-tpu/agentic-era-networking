/**
 * src/sdn/telemetry-state-store.ts
 * Atomic Disk-Backed Telemetry State Checkpoint Engine
 *
 * Council Invariants Enforced:
 * - Sanjay Ghemawat: Radical simplicity; atomic file rename (write .tmp -> rename) eliminates corruption.
 * - Jeff Dean: Nanosecond-to-WAN latency budgets; synchronous disk I/O strictly isolated from packet hot paths.
 * - Anti-Shortcut Law: Deterministic BigInt conversions on load/save; fail-safe fallback across namespaces.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  ZodiacTimeSeriesPoint,
  JetsonTimeSeriesPoint,
  CoralTimeSeriesPoint,
  ZodiacPortSeriesPoint,
} from './zodiac-telemetry.js';

export interface PersistentTelemetryState {
  readonly version: 1;
  readonly savedAtMs: number;
  readonly timeSeries: ZodiacTimeSeriesPoint[];
  readonly jetsonTimeSeries: JetsonTimeSeriesPoint[];
  readonly coralTimeSeries: CoralTimeSeriesPoint[];
}

export function resolveTelemetryStateFilePath(): string {
  const envDir = process.env['STATE_DIRECTORY'];
  if (envDir && fs.existsSync(envDir)) {
    return path.join(envDir, 'telemetry-state.json');
  }
  if (fs.existsSync('/var/lib/zodiac')) {
    return '/var/lib/zodiac/telemetry-state.json';
  }
  return '/tmp/zodiac-telemetry-state.json';
}

export function serializeTelemetryState(state: PersistentTelemetryState): string {
  return JSON.stringify(state, (_, value) =>
    typeof value === 'bigint' ? value.toString() : value
  );
}

function deserializePorts(
  ports: Record<string, unknown>
): Record<number, ZodiacPortSeriesPoint> {
  const res: Record<number, ZodiacPortSeriesPoint> = {};
  for (const [key, rawVal] of Object.entries(ports)) {
    const portNum = Number(key);
    if (!Number.isNaN(portNum) && rawVal && typeof rawVal === 'object') {
      const val = rawVal as Record<string, unknown>;
      res[portNum] = {
        rxPackets: BigInt(String(val['rxPackets'] ?? '0')),
        txPackets: BigInt(String(val['txPackets'] ?? '0')),
        rxBytes: BigInt(String(val['rxBytes'] ?? '0')),
        txBytes: BigInt(String(val['txBytes'] ?? '0')),
        rxRatePps: BigInt(String(val['rxRatePps'] ?? '0')),
        txRatePps: BigInt(String(val['txRatePps'] ?? '0')),
        rxRateBps: BigInt(String(val['rxRateBps'] ?? '0')),
        txRateBps: BigInt(String(val['txRateBps'] ?? '0')),
      };
    }
  }
  return res;
}

export function deserializeTelemetryState(jsonString: string): PersistentTelemetryState | null {
  try {
    const raw = JSON.parse(jsonString) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || raw['version'] !== 1) {
      return null;
    }

    const rawTimeSeries = Array.isArray(raw['timeSeries']) ? raw['timeSeries'] : [];
    const timeSeries: ZodiacTimeSeriesPoint[] = rawTimeSeries.map((item: unknown) => {
      const p = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
      const portsObj = p['ports'] && typeof p['ports'] === 'object'
        ? deserializePorts(p['ports'] as Record<string, unknown>)
        : undefined;

      return {
        timestampMs: Number(p['timestampMs'] ?? 0),
        rxBytes: BigInt(String(p['rxBytes'] ?? '0')),
        txBytes: BigInt(String(p['txBytes'] ?? '0')),
        rxPackets: BigInt(String(p['rxPackets'] ?? '0')),
        txPackets: BigInt(String(p['txPackets'] ?? '0')),
        rxRatePps: BigInt(String(p['rxRatePps'] ?? '0')),
        txRatePps: BigInt(String(p['txRatePps'] ?? '0')),
        rxRateBps: BigInt(String(p['rxRateBps'] ?? '0')),
        txRateBps: BigInt(String(p['txRateBps'] ?? '0')),
        cpuTemperatureC: p['cpuTemperatureC'] !== null && p['cpuTemperatureC'] !== undefined
          ? Number(p['cpuTemperatureC'])
          : null,
        latencyNs: BigInt(String(p['latencyNs'] ?? '0')),
        ports: portsObj,
      };
    });

    const rawJetson = Array.isArray(raw['jetsonTimeSeries']) ? raw['jetsonTimeSeries'] : [];
    const jetsonTimeSeries: JetsonTimeSeriesPoint[] = rawJetson.map((item: unknown) => {
      const p = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
      return {
        timestampMs: Number(p['timestampMs'] ?? 0),
        cpuUtilizationPct: Number(p['cpuUtilizationPct'] ?? 0),
        gpuUtilizationPct: Number(p['gpuUtilizationPct'] ?? 0),
        cpuTempC: Number(p['cpuTempC'] ?? 0),
        gpuTempC: Number(p['gpuTempC'] ?? 0),
        junctionTempC: Number(p['junctionTempC'] ?? 0),
        powerWatts: Number(p['powerWatts'] ?? 0),
        ramUsedBytes: BigInt(String(p['ramUsedBytes'] ?? '0')),
        nvmeReadRateBps: BigInt(String(p['nvmeReadRateBps'] ?? '0')),
        nvmeWriteRateBps: BigInt(String(p['nvmeWriteRateBps'] ?? '0')),
        sdnPortRateBps: BigInt(String(p['sdnPortRateBps'] ?? '0')),
        wifiPortRateBps: BigInt(String(p['wifiPortRateBps'] ?? '0')),
      };
    });

    const rawCoral = Array.isArray(raw['coralTimeSeries']) ? raw['coralTimeSeries'] : [];
    const coralTimeSeries: CoralTimeSeriesPoint[] = rawCoral.map((item: unknown) => {
      const p = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
      return {
        timestampMs: Number(p['timestampMs'] ?? 0),
        inferencesPerSecond: BigInt(String(p['inferencesPerSecond'] ?? '0')),
        tapPacketsPerSecond: BigInt(String(p['tapPacketsPerSecond'] ?? '0')),
        latencyP50Us: BigInt(String(p['latencyP50Us'] ?? '0')),
        latencyP99Us: BigInt(String(p['latencyP99Us'] ?? '0')),
        usbThroughputKbps: BigInt(String(p['usbThroughputKbps'] ?? '0')),
        coral1Ips: BigInt(String(p['coral1Ips'] ?? '0')),
        coral2Ips: BigInt(String(p['coral2Ips'] ?? '0')),
        coral1LatencyP50Us: BigInt(String(p['coral1LatencyP50Us'] ?? '0')),
        coral2LatencyP50Us: BigInt(String(p['coral2LatencyP50Us'] ?? '0')),
      };
    });

    return {
      version: 1,
      savedAtMs: Number(raw['savedAtMs'] ?? Date.now()),
      timeSeries,
      jetsonTimeSeries,
      coralTimeSeries,
    };
  } catch (err: unknown) {
    console.warn('[!] [Telemetry State] Failed to deserialize telemetry state file:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

export async function saveTelemetryStateAtomic(
  filePath: string,
  state: PersistentTelemetryState
): Promise<boolean> {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    const parentDir = path.dirname(filePath);
    await fsp.mkdir(parentDir, { recursive: true });
    const data = serializeTelemetryState(state);
    await fsp.writeFile(tmpPath, data, { encoding: 'utf-8', signal: AbortSignal.timeout(5000) });
    await fsp.rename(tmpPath, filePath);
    return true;
  } catch (err: unknown) {
    console.warn(`[!] [Telemetry State] Failed to atomically save state to ${filePath}:`, err instanceof Error ? err.message : String(err));
    try {
      await fsp.rm(tmpPath, { force: true });
    } catch (cleanupErr: unknown) {
      console.warn(`[!] [Telemetry State] Temporary file cleanup error for ${tmpPath}:`, cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr));
    }
    return false;
  }
}

/**
 * Synchronous variant reserved exclusively for process shutdown hooks (SIGTERM/SIGINT)
 * where the Node.js event loop is terminating and asynchronous microtasks may not drain.
 */
export function saveTelemetryStateAtomicSync(
  filePath: string,
  state: PersistentTelemetryState
): boolean {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    const parentDir = path.dirname(filePath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    const data = serializeTelemetryState(state);
    fs.writeFileSync(tmpPath, data, 'utf-8');
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (err: unknown) {
    console.warn(`[!] [Telemetry State] Failed to atomically save state to ${filePath} synchronously:`, err instanceof Error ? err.message : String(err));
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch (cleanupErr: unknown) {
      console.warn(`[!] [Telemetry State] Synchronous temporary file cleanup error for ${tmpPath}:`, cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr));
    }
    return false;
  }
}

export function loadTelemetryState(filePath: string): PersistentTelemetryState | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const data = fs.readFileSync(filePath, 'utf-8');
    return deserializeTelemetryState(data);
  } catch (err: unknown) {
    console.warn(`[!] [Telemetry State] Failed to read state from ${filePath}:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}
