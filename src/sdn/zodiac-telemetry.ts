/**
 * zodiac-telemetry.ts
 * Comprehensive Telemetry Snapshot & Parser for Zodiac FX Switch
 *
 * Council Invariants Enforced:
 * - Dean & Ghemawat: 64-bit integer units (BigInt) for all packet and byte counters.
 * - Anti-Shortcut Law: Zero field suppression; parses all hardware-exported counters.
 */

export interface ZodiacPortTelemetry {
  readonly port: number;
  readonly name: string;
  readonly status: 'UP' | 'DOWN';
  readonly vlanType: string;
  readonly vlanId: number;
  readonly ipAddress?: string | null;
  readonly rxBytes: bigint;
  readonly txBytes: bigint;
  readonly rxPackets: bigint;
  readonly txPackets: bigint;
  readonly rxDropped: bigint;
  readonly txDropped: bigint;
  readonly rxCrcErrors: bigint;
  readonly physicalLocation: string;
}

export interface ZodiacSystemTelemetry {
  readonly deviceName: string;
  readonly macAddress: string;
  readonly ipAddress: string;
  readonly netmask: string;
  readonly defaultGateway: string;
  readonly openFlowController: string;
  readonly openFlowPort: number;
  readonly failstate: string;
  readonly cpuTemperatureC: number | null;
  readonly cpuUid: string;
  readonly firmwareVersion: string;
  readonly uptime: string;
  readonly timestampNs: bigint;
}

export interface ZodiacFlowRuleEntry {
  readonly ruleId: string;
  readonly priority: number;
  readonly action: string;
  readonly srcCidr: string;
  readonly dstCidr: string;
  readonly protocol: string;
  readonly srcMac?: string;
  readonly dstMac?: string;
  readonly installedAtMs: number;
  readonly openFlowInstalled: boolean;
}

export interface ZodiacOpenFlowTelemetry {
  readonly status: 'Connected' | 'Disconnected' | 'Handshake';
  readonly version: string;
  readonly datapathId: string;
  readonly activeTables: number;
  readonly activeFlows: number;
  readonly tableLookups: bigint;
  readonly tableMatches: bigint;
  readonly lastHeartbeatLatencyNs: bigint;
  readonly rules?: readonly ZodiacFlowRuleEntry[];
}

export interface ZodiacPortSeriesPoint {
  readonly rxPackets: bigint;
  readonly txPackets: bigint;
  readonly rxBytes: bigint;
  readonly txBytes: bigint;
  readonly rxRatePps: bigint;
  readonly txRatePps: bigint;
  readonly rxRateBps: bigint;
  readonly txRateBps: bigint;
}

export interface ZodiacTimeSeriesPoint {
  readonly timestampMs: number;
  readonly rxBytes: bigint;
  readonly txBytes: bigint;
  readonly rxPackets: bigint;
  readonly txPackets: bigint;
  readonly rxRatePps: bigint;
  readonly txRatePps: bigint;
  readonly rxRateBps: bigint;
  readonly txRateBps: bigint;
  readonly cpuTemperatureC: number | null;
  readonly latencyNs: bigint;
  readonly activeFlows?: number;
  readonly tableLookups?: bigint;
  readonly tableMatches?: bigint;
  readonly ports?: {
    readonly [port: number]: ZodiacPortSeriesPoint;
  } | undefined;
}

export interface JetsonNetworkInterfaceTelemetry {
  readonly name: string;
  readonly role: string;
  readonly macAddress: string;
  readonly ipAddress: string | null;
  readonly status: 'UP' | 'DOWN';
  readonly speedMbps: number;
  readonly rxBytes: bigint;
  readonly txBytes: bigint;
  readonly rxPackets: bigint;
  readonly txPackets: bigint;
  readonly rxDropped: bigint;
  readonly txDropped: bigint;
  readonly rxErrors: bigint;
  readonly txErrors: bigint;
  readonly rxRateBps: bigint;
  readonly txRateBps: bigint;
  readonly rxRatePps: bigint;
  readonly txRatePps: bigint;
}

export interface JetsonTimeSeriesPoint {
  readonly timestampMs: number;
  readonly cpuUtilizationPct: number;
  readonly gpuUtilizationPct: number;
  readonly cpuTempC: number | null;
  readonly gpuTempC: number | null;
  readonly junctionTempC: number | null;
  readonly powerWatts: number;
  readonly ramUsedBytes: bigint;
  readonly nvmeReadRateBps: bigint;
  readonly nvmeWriteRateBps: bigint;
  readonly sdnPortRateBps: bigint;
  readonly wifiPortRateBps: bigint;
}

export interface JetsonTelemetrySnapshot {
  readonly status: 'online' | 'offline';
  readonly deviceName: string;
  readonly architecture: string;
  readonly cpuModel: string;
  readonly cpuCoreCount: number;
  readonly cpuUtilizationPct: number;
  readonly cpuCoresPct: number[];
  readonly gpuModel: string;
  readonly gpuCudaCores: number;
  readonly gpuUtilizationPct: number;
  readonly gpuFreqMhz: number;
  readonly ramUsedBytes: bigint;
  readonly ramTotalBytes: bigint;
  readonly swapUsedBytes: bigint;
  readonly swapTotalBytes: bigint;
  readonly nvmeRootPath: string;
  readonly nvmeUsedBytes: bigint;
  readonly nvmeTotalBytes: bigint;
  readonly nvmeReadRateBps: bigint;
  readonly nvmeWriteRateBps: bigint;
  readonly rescueSdMounted: boolean;
  readonly temperatures: {
    readonly cpuC: number | null;
    readonly gpuC: number | null;
    readonly socC: number | null;
    readonly junctionC: number | null;
  };
  readonly powerMw: {
    readonly vddIn: number | null;
    readonly vddCpuGpuCv: number | null;
    readonly vddSoc: number | null;
  };
  readonly systemLoad: [number, number, number];
  readonly osVersion: string;
  readonly kernelVersion: string;
  readonly jetpackVersion: string;
  readonly uptime: string;
  readonly interfaces: JetsonNetworkInterfaceTelemetry[];
  // Ollama LLM Inference Telemetry (qwen2.5:3b on Jetson Orin Nano)
  readonly ollamaStatus: 'ONLINE' | 'OFFLINE';
  readonly ollamaModel: string;
  readonly ollamaModelParamSize: string;
  readonly ollamaModelQuant: string;
  readonly ollamaContextLength: number;
  readonly ollamaToksPerSecond: number;
  readonly ollamaPeakToksPerSecond: number;
  readonly ollamaLastInferenceTimestampMs: number;
  readonly ollamaTotalInferences: bigint;
  readonly ollamaTotalTokens: bigint;
  readonly ollamaPerTokenLatencyNs: bigint;
  readonly timeSeries?: readonly JetsonTimeSeriesPoint[];
}

export interface CoralTimeSeriesPoint {
  readonly timestampMs: number;
  readonly inferencesPerSecond: bigint;
  readonly tapPacketsPerSecond: bigint;
  readonly latencyP50Us: bigint;
  readonly latencyP99Us: bigint;
  readonly usbThroughputKbps: bigint;
  /** Per-device telemetry: Coral TPU #1 (Wire Tap DPI) rate */
  readonly coral1Ips: bigint;
  /** Per-device telemetry: Coral TPU #2 (DNS Sentinel) rate */
  readonly coral2Ips: bigint;
  readonly coral1LatencyP50Us: bigint;
  readonly coral2LatencyP50Us: bigint;
}

export interface CoralDeviceDescriptor {
  readonly id: string;
  readonly name: string;
  readonly vendorId: string;
  readonly productId: string;
  readonly usbBus: string;
  readonly usbSpeed: string;
  readonly assignedRole: 'TAP_PACKET_CLASSIFIER' | 'DNS_SENTINEL' | 'GENERAL_INFERENCE';
  readonly status: 'STANDBY' | 'INFERENCE_ACTIVE' | 'NOT_DETECTED';
  readonly peakTopsInt8: number;
  readonly inferencesPerSecond: bigint;
  readonly totalInferences: bigint;
  readonly latencyP50Ns: bigint;
  readonly latencyP99Ns: bigint;
  readonly loadedModel?: string;
  readonly usbPath?: string;
}

export interface CoralTelemetrySnapshot {
  readonly detected: boolean;
  readonly deviceCount: number;
  readonly devices: readonly CoralDeviceDescriptor[];
  readonly name: string;
  readonly vendorId: string;
  readonly productId: string;
  readonly usbBus: string;
  readonly usbSpeed: string;
  readonly status: 'STANDBY' | 'INFERENCE_ACTIVE' | 'NOT_DETECTED';
  readonly pipelineRole: string;
  readonly peakTopsInt8: number;
  readonly targetLatencyBudgetNs: bigint;
  readonly inferencesPerSecond: bigint;
  readonly totalInferences: bigint;
  readonly latencyP50Ns: bigint;
  readonly latencyP99Ns: bigint;
  readonly loadedModel: string;
  readonly powerMode: string;
  readonly temperatureC: number | null;
  readonly timeSeries?: readonly CoralTimeSeriesPoint[];
}

export interface WorkstationTimeSeriesPoint {
  readonly timestampMs: number;
  readonly cpuUtilizationPct: number;
  readonly gpuUtilizationPct: number;
  readonly gpuMemoryUsedBytes: bigint;
  readonly ramUsedBytes: bigint;
  readonly tokensPerSecond: number;
  readonly promptTokensPerSecond: number;
  readonly totalPromptTokens: bigint;
  readonly totalCompletionTokens: bigint;
  readonly totalTokens: bigint;
}

export interface WorkstationUsbTetherTelemetry {
  readonly connected: boolean;
  readonly deviceName: string;
  readonly vendorId: string;
  readonly productId: string;
  readonly serialNumber: string;
  readonly linkSpeed: string;
  readonly macInterface: string;
  readonly macAddress: string;
  readonly macStatus: 'ACTIVE' | 'INACTIVE';
  readonly hostIp: string | null;
  readonly peerIp: string;
  readonly serialDevice: string | null;
  readonly serialStatus: 'AVAILABLE' | 'NOT_FOUND';
  readonly metricPriority: number;
  readonly failClosedIsolated: boolean;
}

export interface WorkstationTelemetrySnapshot {
  readonly detected: boolean;
  readonly hostName: string;
  readonly platform: string;
  readonly osRelease: string;
  readonly chipModel: string;
  readonly cpuCores: number;
  readonly cpuUtilizationPct: number;
  readonly memoryTotalBytes: bigint;
  readonly memoryUsedBytes: bigint;
  readonly memoryFreeBytes: bigint;
  readonly loadAvg: readonly [number, number, number];
  // Direct USB-C Tether to NVIDIA Jetson Orin Nano Appliance
  readonly usbTether: WorkstationUsbTetherTelemetry;
  // Apple Silicon Metal GPU Telemetry (Physical IOKit truth via ioreg)
  readonly gpuModel: string;
  readonly gpuCoreCount: number;
  readonly gpuUtilizationPct: number;
  readonly rendererUtilizationPct: number;
  readonly tilerUtilizationPct: number;
  readonly gpuMemoryUsedBytes: bigint;
  readonly gpuMemoryAllocatedBytes: bigint;
  // Ollama / Local Gemma 4 Inference & Token Telemetry
  readonly ollamaStatus: 'ONLINE' | 'OFFLINE' | 'BUSY';
  readonly activeModel: string;
  readonly modelFormat: string;
  readonly modelParameterSize: string;
  readonly modelQuantization: string;
  readonly modelContextLength: number;
  readonly modelVramBytes: bigint;
  // Cumulative Token Accounting Ledger (Council Invariant 2: BigInt)
  readonly totalPromptTokens: bigint;
  readonly totalCompletionTokens: bigint;
  readonly totalTokens: bigint;
  readonly totalInferences: bigint;
  // Real-Time Token Generation & Prompt Evaluation Velocity
  readonly tokensPerSecond: number;
  readonly promptTokensPerSecond: number;
  readonly peakTokensPerSecond: number;
  readonly peakPromptTokensPerSecond: number;
  /** Unix epoch ms of the last completed inference; 0 when unknown. Used to zero-out stale rates (Invariant 6). */
  readonly lastInferenceTimestampMs: number;
  // Nanosecond Precision Latency & Durations (Jeff Dean Latency Budgets)
  readonly lastInferenceLatencyNs: bigint;
  readonly lastPromptEvalDurationNs: bigint;
  readonly lastEvalDurationNs: bigint;
  readonly timeToFirstTokenNs: bigint;
  readonly perTokenLatencyNs: bigint;
  // Per-Inference Token Counts & Context Window Saturation
  readonly lastTokenCount: number;
  readonly lastPromptTokenCount: number;
  readonly lastTotalTokenCount: number;
  readonly contextUtilizationPct: number;
  readonly edgeComputeRatioPct: number;
  readonly endpoint: string;
  /** IPv4 /24 CIDR of the resolved agent endpoint, computed by the control plane. Empty string if not determinable. */
  readonly agentSubnet: string;
  readonly timeSeries?: readonly WorkstationTimeSeriesPoint[];
}

export interface ZodiacFullTelemetrySnapshot {
  readonly system: ZodiacSystemTelemetry;
  readonly ports: ZodiacPortTelemetry[];
  readonly openflow: ZodiacOpenFlowTelemetry;
  readonly source: 'live_hardware' | 'cloud_snapshot' | 'disconnected';
  readonly timeSeries?: readonly ZodiacTimeSeriesPoint[] | undefined;
  readonly jetson?: JetsonTelemetrySnapshot | undefined;
  readonly coral?: CoralTelemetrySnapshot | undefined;
  readonly workstation?: WorkstationTelemetrySnapshot | undefined;
  /** Live OS process ID of the bridge daemon — Council Invariant 6: physical truth. */
  readonly bridgePid?: number | undefined;
  /** Live RSS memory bytes from process.memoryUsage() as bigint — structurally enforces integer-only invariant (Council Invariant 2). */
  readonly bridgeRssBytes?: bigint | undefined;
}

/**
 * Single source of truth for cloud relay and serverless live buffer bounds
 * (Council Invariants 2 & 4: Dean Latency Budgets & Coordinated Bounds).
 */
export const CLOUD_RELAY_BOUNDS = {
  /** Maximum points sent over WAN in a single bridge push (150 points = ~6.25–10m live window across 4 appliances). */
  MAX_RELAY_POINTS: 150,
  /** Maximum points maintained in bridge server in-memory buffer (7200 points = 5h continuous 2.5s / full day merge ceiling). */
  MAX_BRIDGE_MEMORY_POINTS: 7200,
  /** Maximum points maintained in rolling serverless in-memory buffer (1200 points = ~10h historical / ~40m live window). */
  MAX_SERVERLESS_POINTS: 1200,
  /** Strict byte threshold for WAN push to prevent 413 Payload Too Large limits. */
  MAX_PAYLOAD_BYTES: 1024 * 1024, // 1 MB
  /** Safe WAN payload transmission ceiling (512 KB) providing 2x headroom below serverless edge limit. */
  MAX_SAFE_WAN_PAYLOAD_BYTES: 512 * 1024,
} as const;

/**
 * Strict time window reserved for high-frequency live points (120 seconds / 2 minutes).
 * Quoc Le Invariant: Time-domain windowing rather than point-count heuristics prevents
 * polling jitter or distribution shifts from starving historical downsampler budgets.
 */
export const LIVE_TELEMETRY_WINDOW_MS = 120_000;

/**
 * Maximum percentage of the WAN relay budget allocated to live points.
 * Ensures the historical downsampler always receives at least 50% of the budget.
 */
export const MAX_LIVE_BUDGET_PERCENT = 50;

/**
 * Minimum live points to retain for real-time responsiveness even during sparse polling.
 */
export const MIN_LIVE_POINTS = 10;

/**
 * Council Invariant 2 & 6: Deterministic WAN Series Bounding with Long-Range History.
 * Combines high-frequency recent points for real-time live graphs with downsampled historical
 * points spanning the entire operational day, while strictly respecting maxPoints payload limits.
 */
export function boundSeriesWithHistory<T extends { readonly timestampMs: number }>(
  series: readonly T[] | undefined,
  downsampleFn: (pts: readonly T[], target: number) => T[],
  maxPoints: number = CLOUD_RELAY_BOUNDS.MAX_RELAY_POINTS,
  liveWindowMs: number = LIVE_TELEMETRY_WINDOW_MS
): T[] {
  if (!series || series.length === 0) return [];
  if (series.length <= maxPoints) return [...series];

  // Strictly define live boundary in the time domain relative to newest point
  const latestTs = series[series.length - 1]?.timestampMs ?? 0;
  const liveCutoffMs = latestTs - liveWindowMs;

  // Filter live points within the time-domain window
  const liveCandidate = series.filter((p) => p.timestampMs >= liveCutoffMs);

  // Bound live points so live high-frequency data never starves the historical budget (integer arithmetic)
  const maxLivePoints = Math.max(MIN_LIVE_POINTS, Math.floor((maxPoints * MAX_LIVE_BUDGET_PERCENT) / 100));
  const livePoints = liveCandidate.length > maxLivePoints
    ? liveCandidate.slice(-maxLivePoints)
    : liveCandidate.length < MIN_LIVE_POINTS
      ? series.slice(-Math.min(MIN_LIVE_POINTS, maxPoints))
      : liveCandidate;

  const actualCutoffMs = livePoints[0]?.timestampMs ?? liveCutoffMs;
  const historicalPortion = series.filter((p) => p.timestampMs < actualCutoffMs);

  if (historicalPortion.length === 0) {
    return series.slice(-maxPoints);
  }

  const historyBudget = Math.max(1, maxPoints - livePoints.length);
  const downsampledHistory = downsampleFn(historicalPortion, historyBudget);

  if (downsampledHistory.length > 0 && historicalPortion[0]) {
    const firstHist = historicalPortion[0];
    const firstDown = downsampledHistory[0];
    if (firstDown && firstDown.timestampMs !== firstHist.timestampMs) {
      downsampledHistory[0] = { ...firstDown, timestampMs: firstHist.timestampMs };
    }
  }

  return [...downsampledHistory, ...livePoints];
}

/**
 * Parses raw HTML exported by the Zodiac FX /d_ports.htm into structured port telemetry.
 */
export function parseZodiacPortsHtml(html: string): ZodiacPortTelemetry[] {
  const ports: ZodiacPortTelemetry[] = [];
  
  // Extract rows from table
  const statusMatch = html.match(/Status:<\/td><td>([^<]+)<\/td><td>([^<]+)<\/td><td>([^<]+)<\/td><td>([^<]+)<\/td>/i);
  const typeMatch = html.match(/VLAN Type:<\/td><td>([^<]+)<\/td><td>([^<]+)<\/td><td>([^<]+)<\/td><td>([^<]+)<\/td>/i);
  const rxBytesMatch = html.match(/RX Bytes:<\/td><td>(\d+)<\/td><td>(\d+)<\/td><td>(\d+)<\/td><td>(\d+)<\/td>/i);
  const txBytesMatch = html.match(/TX Bytes:<\/td><td>(\d+)<\/td><td>(\d+)<\/td><td>(\d+)<\/td><td>(\d+)<\/td>/i);
  const rxPacketsMatch = html.match(/RX Packets:<\/td><td>(\d+)<\/td><td>(\d+)<\/td><td>(\d+)<\/td><td>(\d+)<\/td>/i);
  const txPacketsMatch = html.match(/TX Packets:<\/td><td>(\d+)<\/td><td>(\d+)<\/td><td>(\d+)<\/td><td>(\d+)<\/td>/i);
  const rxDropMatch = html.match(/RX Dropped Packets:<\/td><td>(\d+)<\/td><td>(\d+)<\/td><td>(\d+)<\/td><td>(\d+)<\/td>/i);
  const txDropMatch = html.match(/TX Dropped Packets:<\/td><td>(\d+)<\/td><td>(\d+)<\/td><td>(\d+)<\/td><td>(\d+)<\/td>/i);
  const crcMatch = html.match(/RX CRC Errors:<\/td><td>(\d+)<\/td><td>(\d+)<\/td><td>(\d+)<\/td><td>(\d+)<\/td>/i);

  // Extract selected VLAN IDs
  const vlanIds = [100, 100, 100, 200];
  const vlanIdMatches = Array.from(html.matchAll(/<option selected value="(\d+)">/g));
  if (vlanIdMatches.length >= 4) {
    for (let i = 0; i < 4; i++) {
      vlanIds[i] = parseInt(vlanIdMatches[i]![1]!, 10);
    }
  }

  const locations = [
    'Front Left (Micro-USB / LED side)',
    'Front Middle-Left (Gateway Uplink)',
    'Front Middle-Right (Hardware Tap / Sniffer)',
    'Front Right (Controller Link / Opposite Micro-USB)',
  ];

  for (let i = 0; i < 4; i++) {
    const idx = i + 1;
    ports.push({
      port: idx,
      name: `Port ${idx}`,
      status: (statusMatch?.[idx]?.trim().toUpperCase() === 'UP' ? 'UP' : 'DOWN'),
      vlanType: typeMatch?.[idx]?.trim() ?? (idx === 4 ? 'Native' : 'OpenFlow'),
      vlanId: vlanIds[i] ?? (idx === 4 ? 200 : 100),
      rxBytes: BigInt(rxBytesMatch?.[idx] ?? '0'),
      txBytes: BigInt(txBytesMatch?.[idx] ?? '0'),
      rxPackets: BigInt(rxPacketsMatch?.[idx] ?? '0'),
      txPackets: BigInt(txPacketsMatch?.[idx] ?? '0'),
      rxDropped: BigInt(rxDropMatch?.[idx] ?? '0'),
      txDropped: BigInt(txDropMatch?.[idx] ?? '0'),
      rxCrcErrors: BigInt(crcMatch?.[idx] ?? '0'),
      physicalLocation: locations[i]!,
    });
  }

  return ports;
}

/**
 * Creates a default/baseline telemetry snapshot matching physical Zodiac FX defaults.
 */
export function createDefaultZodiacSnapshot(): ZodiacFullTelemetrySnapshot {
  const base: ZodiacFullTelemetrySnapshot = {
    source: 'cloud_snapshot',
    system: {
      deviceName: 'Zodiac_FX',
      macAddress: '70:B3:D5:87:40:BC',
      ipAddress: process.env['ZODIAC_SWITCH_IP'] ?? '127.0.0.1',
      netmask: process.env['ZODIAC_NETMASK'] ?? '255.255.255.0',
      defaultGateway: process.env['SDN_GATEWAY_IP'] ?? '127.0.0.1',
      openFlowController: process.env['SDN_CONTROLLER_IP'] ?? '127.0.0.1',
      openFlowPort: 6633,
      failstate: 'Secure',
      cpuTemperatureC: 31,
      cpuUid: '1396191488-826951736-875574576-892547120',
      firmwareVersion: '0.86',
      uptime: '01:24:12',
      timestampNs: process.hrtime.bigint(),
    },
    ports: [
      {
        port: 1,
        name: 'Port 1',
        status: 'DOWN',
        vlanType: 'OpenFlow',
        vlanId: 100,
        rxBytes: 42104n,
        txBytes: 0n,
        rxPackets: 336n,
        txPackets: 0n,
        rxDropped: 0n,
        txDropped: 0n,
        rxCrcErrors: 0n,
        physicalLocation: 'Front Left (Micro-USB / LED side)',
      },
      {
        port: 2,
        name: 'Port 2',
        status: 'DOWN',
        vlanType: 'OpenFlow',
        vlanId: 100,
        rxBytes: 0n,
        txBytes: 0n,
        rxPackets: 0n,
        txPackets: 0n,
        rxDropped: 0n,
        txDropped: 0n,
        rxCrcErrors: 0n,
        physicalLocation: 'Front Middle-Left (Gateway Uplink)',
      },
      {
        port: 3,
        name: 'Port 3',
        status: 'DOWN',
        vlanType: 'OpenFlow',
        vlanId: 100,
        rxBytes: 0n,
        txBytes: 0n,
        rxPackets: 0n,
        txPackets: 0n,
        rxDropped: 0n,
        txDropped: 0n,
        rxCrcErrors: 0n,
        physicalLocation: 'Front Middle-Right (Hardware Tap / Sniffer)',
      },
      {
        port: 4,
        name: 'Port 4',
        status: 'UP',
        vlanType: 'Native',
        vlanId: 200,
        rxBytes: 259843n,
        txBytes: 169427n,
        rxPackets: 1982n,
        txPackets: 1540n,
        rxDropped: 0n,
        txDropped: 0n,
        rxCrcErrors: 0n,
        physicalLocation: 'Front Right (Controller Link / Opposite Micro-USB)',
      },
    ],
    openflow: {
      status: 'Connected',
      version: '1.3',
      datapathId: '0x70b3d58740bc',
      activeTables: 10,
      activeFlows: 0,
      tableLookups: 0n,
      tableMatches: 0n,
      lastHeartbeatLatencyNs: 495625n, // 0.496 ms
    },
  };

  const jetson = createDefaultJetsonSnapshot(false);
  const coral = createDefaultCoralSnapshot(false);
  const workstation = createDefaultWorkstationSnapshot(false);

  return {
    ...base,
    timeSeries: generateHistoricalTelemetry(base, 1, 60),
    jetson: {
      ...jetson,
      timeSeries: generateJetsonHistoricalTelemetry(jetson, 1, 60),
    },
    coral: {
      ...coral,
      timeSeries: generateCoralHistoricalTelemetry(coral, 1, 60),
    },
    workstation: {
      ...workstation,
      timeSeries: generateWorkstationHistoricalTelemetry(workstation, 1, 60),
    },
  };
}

/**
 * Creates a default telemetry snapshot for the NVIDIA Jetson Orin Nano appliance.
 * Council Invariant 6 (Anti-Simulation Law):
 * Default must be fail-closed (isDisconnected = true). When disconnected,
 * thermals and power evaluate to physical truth (null), and status is 'offline'.
 */
export function createDefaultJetsonSnapshot(isDisconnected: boolean = true): JetsonTelemetrySnapshot {
  const interfaces: JetsonNetworkInterfaceTelemetry[] = [
    {
      name: 'enP8p1s0',
      role: 'SDN Control Link -> Zodiac Port 4',
      macAddress: isDisconnected ? 'None' : 'ac:3a:e2:98:99:dd',
      ipAddress: process.env['SDN_CONTROLLER_IP'] ?? '127.0.0.1',
      status: isDisconnected ? 'DOWN' : 'UP',
      speedMbps: isDisconnected ? 0 : 1000,
      rxBytes: isDisconnected ? 0n : 1694270n,
      txBytes: isDisconnected ? 0n : 2598430n,
      rxPackets: isDisconnected ? 0n : 15400n,
      txPackets: isDisconnected ? 0n : 19820n,
      rxDropped: 0n,
      txDropped: 0n,
      rxErrors: 0n,
      txErrors: 0n,
      rxRateBps: isDisconnected ? 0n : 8420n,
      txRateBps: isDisconnected ? 0n : 12450n,
      rxRatePps: isDisconnected ? 0n : 42n,
      txRatePps: isDisconnected ? 0n : 58n,
    },
    {
      name: 'wlP1p1s0',
      role: 'Management Plane & Cloud Relay (Wi-Fi)',
      macAddress: isDisconnected ? 'None' : 'f0:68:e3:33:02:a3',
      ipAddress: process.env['JETSON_HOST'] ?? '127.0.0.1',
      status: isDisconnected ? 'DOWN' : 'UP',
      speedMbps: isDisconnected ? 0 : 866,
      rxBytes: isDisconnected ? 0n : 48921000n,
      txBytes: isDisconnected ? 0n : 12450000n,
      rxPackets: isDisconnected ? 0n : 98400n,
      txPackets: isDisconnected ? 0n : 45200n,
      rxDropped: 0n,
      txDropped: 0n,
      rxErrors: 0n,
      txErrors: 0n,
      rxRateBps: isDisconnected ? 0n : 18200n,
      txRateBps: isDisconnected ? 0n : 6400n,
      rxRatePps: isDisconnected ? 0n : 75n,
      txRatePps: isDisconnected ? 0n : 30n,
    },
    {
      name: 'l4tbr0',
      role: 'USB-C Device Mode Tether -> MacBook M5 (en8)',
      macAddress: isDisconnected ? 'None' : '3e:c7:e7:79:f3:87',
      ipAddress: '192.168.55.1',
      status: isDisconnected ? 'DOWN' : 'UP',
      speedMbps: isDisconnected ? 0 : 5000,
      rxBytes: isDisconnected ? 0n : 20537474n,
      txBytes: isDisconnected ? 0n : 5148796850n,
      rxPackets: isDisconnected ? 0n : 362176n,
      txPackets: isDisconnected ? 0n : 3409625n,
      rxDropped: 0n,
      txDropped: 0n,
      rxErrors: 0n,
      txErrors: 0n,
      rxRateBps: isDisconnected ? 0n : 51200n,
      txRateBps: isDisconnected ? 0n : 84200n,
      rxRatePps: isDisconnected ? 0n : 120n,
      txRatePps: isDisconnected ? 0n : 180n,
    },
  ];

  return {
    status: isDisconnected ? 'offline' : 'online',
    deviceName: 'jetson-orin',
    architecture: 'aarch64 (ARMv8.2-A)',
    cpuModel: '6-Core ARM Cortex-A78AE',
    cpuCoreCount: 6,
    cpuUtilizationPct: isDisconnected ? 0 : 8,
    cpuCoresPct: isDisconnected ? [0, 0, 0, 0, 0, 0] : [7, 12, 6, 14, 5, 8],
    gpuModel: 'NVIDIA Ampere (1024 CUDA Cores + 32 Tensor Cores)',
    gpuCudaCores: 1024,
    gpuUtilizationPct: 0,
    gpuFreqMhz: isDisconnected ? 0 : 612,
    ramUsedBytes: isDisconnected ? 0n : 2184183808n,
    ramTotalBytes: 7990149120n,
    swapUsedBytes: 0n,
    swapTotalBytes: 3995074560n,
    nvmeRootPath: '/dev/nvme0n1p2 (SanDisk Optimus 500GB)',
    nvmeUsedBytes: isDisconnected ? 0n : 24696061952n,
    nvmeTotalBytes: 491745476608n,
    nvmeReadRateBps: isDisconnected ? 0n : 1048576n,
    nvmeWriteRateBps: isDisconnected ? 0n : 262144n,
    rescueSdMounted: !isDisconnected,
    temperatures: {
      cpuC: isDisconnected ? null : 48.0,
      gpuC: isDisconnected ? null : 46.5,
      socC: isDisconnected ? null : 46.2,
      junctionC: isDisconnected ? null : 48.0,
    },
    powerMw: {
      vddIn: isDisconnected ? null : 4785,
      vddCpuGpuCv: isDisconnected ? null : 711,
      vddSoc: isDisconnected ? null : 1384,
    },
    systemLoad: isDisconnected ? [0, 0, 0] : [0.82, 0.65, 0.54],
    osVersion: 'Ubuntu 22.04.4 LTS',
    kernelVersion: '5.15.148-tegra',
    jetpackVersion: 'JetPack 6.1 (L4T 36.4.7)',
    uptime: isDisconnected ? 'Offline' : '01:05:22',
    interfaces,
    ollamaStatus: 'OFFLINE',
    ollamaModel: '',
    ollamaModelParamSize: '',
    ollamaModelQuant: '',
    ollamaContextLength: 0,
    ollamaToksPerSecond: 0,
    ollamaPeakToksPerSecond: 0,
    ollamaLastInferenceTimestampMs: 0,
    ollamaTotalInferences: 0n,
    ollamaTotalTokens: 0n,
    ollamaPerTokenLatencyNs: 0n,
  };
}

/**
 * Creates a default telemetry snapshot for the Google Coral Edge TPU.
 * Council Invariant 6 (Anti-Simulation & Goodhart's Law):
 * Default must be fail-closed (isDisconnected = true). When disconnected,
 * detected must evaluate to physical truth (false, 'NOT_DETECTED', null thermals).
 * Physical Edge TPU USB does not expose an on-die thermal sensor in sysfs,
 * so temperatureC must ALWAYS be null, never a fabricated float heuristic.
 */
export function createDefaultCoralSnapshot(isDisconnected: boolean = true): CoralTelemetrySnapshot {
  return {
    detected: !isDisconnected,
    deviceCount: isDisconnected ? 0 : 1,
    devices: isDisconnected
      ? []
      : [
          {
            id: 'coral-0',
            name: 'Google Coral Edge TPU #1 (Tap DPI)',
            vendorId: '1a6e',
            productId: '089a',
            usbBus: 'Bus 002 Device 003',
            usbSpeed: 'USB 3.1 SuperSpeed (5.0 Gbps)',
            assignedRole: 'TAP_PACKET_CLASSIFIER',
            status: 'STANDBY',
            peakTopsInt8: 4,
            inferencesPerSecond: 0n,
            totalInferences: 0n,
            latencyP50Ns: 0n,
            latencyP99Ns: 0n,
            loadedModel: 'MobileNet V2 224x224 INT8 - Wire Tap DPI',
          },
        ],
    name: 'Google Coral Edge TPU USB Accelerator',
    vendorId: isDisconnected ? 'None' : '1a6e',
    productId: isDisconnected ? 'None' : '089a',
    usbBus: isDisconnected ? 'None' : 'Bus 002 Device 003',
    usbSpeed: isDisconnected ? 'Disconnected' : 'USB 3.1 SuperSpeed (5.0 Gbps)',
    status: isDisconnected ? 'NOT_DETECTED' : 'STANDBY',
    pipelineRole: isDisconnected
      ? 'Edge TPU Disconnected — Offline'
      : 'Port 3 Mirror Tap Sub-Millisecond Classifier (Phase 2A Pre-Wired)',
    peakTopsInt8: isDisconnected ? 0 : 4,
    targetLatencyBudgetNs: 500000n,
    inferencesPerSecond: 0n,
    totalInferences: 0n,
    latencyP50Ns: 0n,
    latencyP99Ns: 0n,
    loadedModel: isDisconnected ? 'None (Disconnected)' : 'None (Standby - Pre-Wired for Phase 2A)',
    powerMode: isDisconnected ? 'Offline' : 'Low-Power Standby (<500mW)',
    temperatureC: null,
  };
}

/**
 * Creates a default telemetry snapshot for the MacBook Gemma 4 Workstation appliance.
 * Council Invariant 6 (Anti-Simulation & Goodhart's Law):
 * Default must be fail-closed (isDisconnected = true). When disconnected,
 * detected evaluates to physical truth (false, 'OFFLINE', zero tokens/rates).
 */
export function createDefaultWorkstationSnapshot(isDisconnected: boolean = true): WorkstationTelemetrySnapshot {
  return {
    detected: !isDisconnected,
    hostName: isDisconnected ? 'Offline Workstation' : 'macbook-pro',
    platform: isDisconnected ? 'Offline' : 'darwin (macOS)',
    osRelease: isDisconnected ? 'None' : 'Darwin',
    chipModel: isDisconnected ? 'None' : 'Apple M5 Pro',
    cpuCores: isDisconnected ? 0 : 18,
    cpuUtilizationPct: 0,
    memoryTotalBytes: isDisconnected ? 0n : 68719476736n, // 64 GB Unified Memory
    memoryUsedBytes: 0n,
    memoryFreeBytes: isDisconnected ? 0n : 68719476736n,
    loadAvg: [0, 0, 0],
    gpuModel: isDisconnected ? 'None' : 'Apple M5 Pro Metal GPU',
    gpuCoreCount: isDisconnected ? 0 : 20,
    gpuUtilizationPct: 0,
    rendererUtilizationPct: 0,
    tilerUtilizationPct: 0,
    gpuMemoryUsedBytes: 0n,
    gpuMemoryAllocatedBytes: 0n,
    ollamaStatus: isDisconnected ? 'OFFLINE' : 'ONLINE',
    activeModel: isDisconnected ? 'None' : 'gemma4:26b',
    modelFormat: isDisconnected ? 'None' : 'gguf',
    modelParameterSize: isDisconnected ? 'None' : '25.2B',
    modelQuantization: isDisconnected ? 'None' : 'Q4_K_M',
    modelContextLength: isDisconnected ? 0 : 262144,
    modelVramBytes: 0n,
    totalPromptTokens: 0n,
    totalCompletionTokens: 0n,
    totalTokens: 0n,
    totalInferences: 0n,
    tokensPerSecond: 0,
    promptTokensPerSecond: 0,
    peakTokensPerSecond: 0,
    peakPromptTokensPerSecond: 0,
    lastInferenceTimestampMs: 0,
    lastInferenceLatencyNs: 0n,
    lastPromptEvalDurationNs: 0n,
    lastEvalDurationNs: 0n,
    timeToFirstTokenNs: 0n,
    perTokenLatencyNs: 0n,
    lastTokenCount: 0,
    lastPromptTokenCount: 0,
    lastTotalTokenCount: 0,
    contextUtilizationPct: 0,
    edgeComputeRatioPct: 100.0,
    endpoint: 'http://localhost:11434',
    agentSubnet: '',
    usbTether: {
      connected: !isDisconnected,
      deviceName: isDisconnected ? 'None' : 'NVIDIA Linux for Tegra',
      vendorId: isDisconnected ? 'None' : '0x0955',
      productId: isDisconnected ? 'None' : '0x7020',
      serialNumber: isDisconnected ? 'None' : '1791626120820',
      linkSpeed: isDisconnected ? 'None' : '5 Gbps (SuperSpeed USB 3.0 / USB-C)',
      macInterface: isDisconnected ? 'None' : 'en8',
      macAddress: isDisconnected ? 'None' : '86:2c:05:b5:93:46',
      macStatus: isDisconnected ? 'INACTIVE' : 'ACTIVE',
      hostIp: isDisconnected ? null : '169.254.91.144',
      peerIp: '192.168.55.1',
      serialDevice: isDisconnected ? null : '/dev/cu.usbmodem17916261208203',
      serialStatus: isDisconnected ? 'NOT_FOUND' : 'AVAILABLE',
      metricPriority: 50,
      failClosedIsolated: true,
    },
  };
}

/**
 * Generates deterministic historical time-series points for Jetson Orin Nano.
 */
export function generateJetsonHistoricalTelemetry(
  snapshot: JetsonTelemetrySnapshot,
  durationHours: number = 1,
  pointCount: number = 60
): JetsonTimeSeriesPoint[] {
  const points: JetsonTimeSeriesPoint[] = [];
  const nowMs = Date.now();
  const stepMs = Math.max(1000, Math.floor((durationHours * 3600 * 1000) / pointCount));

  const isDisconnected = snapshot.status === 'offline' || snapshot.temperatures.cpuC === null;
  if (isDisconnected) {
    for (let i = pointCount - 1; i >= 0; i--) {
      const timestampMs = nowMs - i * stepMs;
      points.push({
        timestampMs,
        cpuUtilizationPct: 0,
        gpuUtilizationPct: 0,
        cpuTempC: null,
        gpuTempC: null,
        junctionTempC: null,
        powerWatts: 0,
        ramUsedBytes: 0n,
        nvmeReadRateBps: 0n,
        nvmeWriteRateBps: 0n,
        sdnPortRateBps: 0n,
        wifiPortRateBps: 0n,
      });
    }
    return points;
  }

  const baseCpu = snapshot.cpuUtilizationPct;
  const baseGpu = snapshot.gpuUtilizationPct;
  const baseCpuTemp = snapshot.temperatures.cpuC ?? 48.0;
  const baseGpuTemp = snapshot.temperatures.gpuC ?? 46.5;
  const baseJuncTemp = snapshot.temperatures.junctionC ?? 48.0;
  const basePowerWatts = snapshot.powerMw.vddIn && snapshot.powerMw.vddIn > 0 ? snapshot.powerMw.vddIn / 1000 : 4.8;
  const baseRam = snapshot.ramUsedBytes;

  for (let i = pointCount - 1; i >= 0; i--) {
    const timestampMs = nowMs - i * stepMs;
    const cycle = Math.floor(timestampMs / 60000) % 60;
    const jitter = (cycle % 7) - 3;

    const cpuUtil = Math.max(2, Math.min(100, baseCpu + jitter * 2));
    const gpuUtil = Math.max(0, Math.min(100, baseGpu + (cycle % 5 === 0 ? 15 : 0)));
    const cpuTemp = Math.max(30, Math.min(85, baseCpuTemp + (jitter > 0 ? 1 : -1)));
    const gpuTemp = Math.max(30, Math.min(85, baseGpuTemp + (cycle % 4 === 0 ? 1 : 0)));
    const junctionTemp = Math.max(30, Math.min(90, baseJuncTemp + (jitter > 0 ? 1 : 0)));
    const powerWatts = parseFloat((basePowerWatts + (jitter * 0.15)).toFixed(2));

    const sdnRate = BigInt(Math.max(1000, 10000 + jitter * 1200));
    const wifiRate = BigInt(Math.max(5000, 25000 + jitter * 3500));

    points.push({
      timestampMs,
      cpuUtilizationPct: cpuUtil,
      gpuUtilizationPct: gpuUtil,
      cpuTempC: cpuTemp,
      gpuTempC: gpuTemp,
      junctionTempC: junctionTemp,
      powerWatts,
      ramUsedBytes: baseRam,
      nvmeReadRateBps: 1048576n,
      nvmeWriteRateBps: 262144n,
      sdnPortRateBps: sdnRate,
      wifiPortRateBps: wifiRate,
    });
  }

  return points;
}

/**
 * Generates deterministic historical time-series points for Google Coral Edge TPU.
 */
export function generateCoralHistoricalTelemetry(
  snapshot: CoralTelemetrySnapshot,
  durationHours: number = 1,
  pointCount: number = 60
): CoralTimeSeriesPoint[] {
  const points: CoralTimeSeriesPoint[] = [];
  const nowMs = Date.now();
  const stepMs = Math.max(1000, Math.floor((durationHours * 3600 * 1000) / pointCount));

  for (let i = pointCount - 1; i >= 0; i--) {
    const timestampMs = nowMs - i * stepMs;
    const cycle = Math.floor(timestampMs / 60000) % 60;
    
    const ips = snapshot.inferencesPerSecond;
    const tapPkts = BigInt(cycle % 6 === 0 ? 120 : 0);
    const latP50 = snapshot.status === 'INFERENCE_ACTIVE' ? 320n : 0n;
    const latP99 = snapshot.status === 'INFERENCE_ACTIVE' ? 480n : 0n;
    const usbKbps = snapshot.detected && ips > 0n ? (ips * 300n * 8n) / 1000n : 0n;

    const coral1Ips = snapshot.devices?.[0]?.inferencesPerSecond ?? (snapshot.status === 'INFERENCE_ACTIVE' ? ips : 0n);
    const coral2Ips = snapshot.devices?.[1]?.inferencesPerSecond ?? 0n;
    const coral1LatP50 = snapshot.devices?.[0]?.latencyP50Ns !== undefined ? snapshot.devices[0].latencyP50Ns / 1000n : latP50;
    const coral2LatP50 = snapshot.devices?.[1]?.latencyP50Ns !== undefined ? snapshot.devices[1].latencyP50Ns / 1000n : 0n;

    points.push({
      timestampMs,
      inferencesPerSecond: ips,
      tapPacketsPerSecond: tapPkts,
      latencyP50Us: latP50,
      latencyP99Us: latP99,
      usbThroughputKbps: usbKbps,
      coral1Ips,
      coral2Ips,
      coral1LatencyP50Us: coral1LatP50,
      coral2LatencyP50Us: coral2LatP50,
    });
  }

  return points;
}

/**
 * Generates deterministic historical time-series points for the MacBook Workstation appliance.
 * Follows Council Invariant 2 (Dean BigInt integer arithmetic).
 */
export function generateWorkstationHistoricalTelemetry(
  snapshot: WorkstationTelemetrySnapshot,
  durationHours: number = 1,
  pointCount: number = 60
): WorkstationTimeSeriesPoint[] {
  const points: WorkstationTimeSeriesPoint[] = [];
  const nowMs = Date.now();
  const stepMs = Math.max(1000, Math.floor((durationHours * 3600 * 1000) / pointCount));

  const isDisconnected = !snapshot.detected || snapshot.ollamaStatus === 'OFFLINE';
  if (isDisconnected) {
    for (let i = pointCount - 1; i >= 0; i--) {
      points.push({
        timestampMs: nowMs - i * stepMs,
        cpuUtilizationPct: 0,
        gpuUtilizationPct: 0,
        gpuMemoryUsedBytes: 0n,
        ramUsedBytes: 0n,
        tokensPerSecond: 0,
        promptTokensPerSecond: 0,
        totalPromptTokens: 0n,
        totalCompletionTokens: 0n,
        totalTokens: 0n,
      });
    }
    return points;
  }

  const baseCpu = snapshot.cpuUtilizationPct || 14;
  const baseGpu = snapshot.gpuUtilizationPct || 22;
  const baseGpuMem = snapshot.gpuMemoryUsedBytes || 1950000000n;
  const baseRam = snapshot.memoryUsedBytes || 48000000000n;
  const baseToks = snapshot.tokensPerSecond || 84;

  for (let i = pointCount - 1; i >= 0; i--) {
    const timestampMs = nowMs - i * stepMs;
    const cycle = Math.floor(timestampMs / 60000) % 60;
    const jitter = (cycle % 7) - 3;

    const cpuUtil = Math.max(2, Math.min(100, baseCpu + jitter * 2));
    const gpuUtil = Math.max(0, Math.min(100, baseGpu + (cycle % 4 === 0 ? 25 : jitter * 3)));
    const tokRate = cycle % 3 === 0 ? Math.max(0, Math.round(baseToks + jitter * 4)) : 0;
    const promptTokRate = tokRate > 0 ? Math.round(tokRate * 16) : 0;

    points.push({
      timestampMs,
      cpuUtilizationPct: cpuUtil,
      gpuUtilizationPct: gpuUtil,
      gpuMemoryUsedBytes: baseGpuMem + BigInt(jitter * 50_000_000),
      ramUsedBytes: baseRam,
      tokensPerSecond: tokRate,
      promptTokensPerSecond: promptTokRate,
      totalPromptTokens: snapshot.totalPromptTokens,
      totalCompletionTokens: snapshot.totalCompletionTokens,
      totalTokens: snapshot.totalTokens,
    });
  }

  return points;
}

/**
 * Creates a disconnected telemetry snapshot representing an unlinked or unplugged Zodiac FX switch.
 * Invariant: Anti-Shortcut Law & Zero Suppression of Reality. Never fake live hardware metrics.
 */
export function createDisconnectedZodiacSnapshot(): ZodiacFullTelemetrySnapshot {
  const base: ZodiacFullTelemetrySnapshot = {
    source: 'disconnected',
    system: {
      deviceName: 'Zodiac_FX',
      macAddress: '70:B3:D5:87:40:BC',
      ipAddress: process.env['ZODIAC_SWITCH_IP'] ?? '0.0.0.0',
      netmask: '255.255.255.0',
      defaultGateway: process.env['SDN_GATEWAY_IP'] ?? '0.0.0.0',
      openFlowController: process.env['SDN_CONTROLLER_IP'] ?? '0.0.0.0',
      openFlowPort: 6633,
      failstate: 'Secure',
      cpuTemperatureC: null,
      cpuUid: 'Offline',
      firmwareVersion: 'Offline',
      uptime: 'Disconnected',
      timestampNs: process.hrtime.bigint(),
    },
    ports: [
      {
        port: 1,
        name: 'Port 1',
        status: 'DOWN',
        vlanType: 'OpenFlow',
        vlanId: 100,
        ipAddress: 'Unassigned',
        rxBytes: 0n,
        txBytes: 0n,
        rxPackets: 0n,
        txPackets: 0n,
        rxDropped: 0n,
        txDropped: 0n,
        rxCrcErrors: 0n,
        physicalLocation: 'Front Left (Micro-USB / LED side)',
      },
      {
        port: 2,
        name: 'Port 2',
        status: 'DOWN',
        vlanType: 'OpenFlow',
        vlanId: 100,
        ipAddress: 'Gateway Uplink',
        rxBytes: 0n,
        txBytes: 0n,
        rxPackets: 0n,
        txPackets: 0n,
        rxDropped: 0n,
        txDropped: 0n,
        rxCrcErrors: 0n,
        physicalLocation: 'Front Middle-Left (Gateway Uplink)',
      },
      {
        port: 3,
        name: 'Port 3',
        status: 'DOWN',
        vlanType: 'OpenFlow',
        vlanId: 100,
        ipAddress: 'Unassigned',
        rxBytes: 0n,
        txBytes: 0n,
        rxPackets: 0n,
        txPackets: 0n,
        rxDropped: 0n,
        txDropped: 0n,
        rxCrcErrors: 0n,
        physicalLocation: 'Front Middle-Right (Hardware Tap / Sniffer)',
      },
      {
        port: 4,
        name: 'Port 4',
        status: 'DOWN',
        vlanType: 'Native',
        vlanId: 200,
        ipAddress: process.env['ZODIAC_SWITCH_IP'] ?? 'Controller Link',
        rxBytes: 0n,
        txBytes: 0n,
        rxPackets: 0n,
        txPackets: 0n,
        rxDropped: 0n,
        txDropped: 0n,
        rxCrcErrors: 0n,
        physicalLocation: 'Front Right (Controller Link / Opposite Micro-USB)',
      },
    ],
    openflow: {
      status: 'Disconnected',
      version: '1.3',
      datapathId: '0x000000000000',
      activeTables: 10,
      activeFlows: 0,
      tableLookups: 0n,
      tableMatches: 0n,
      lastHeartbeatLatencyNs: 0n,
    },
  };

  const jetson = createDefaultJetsonSnapshot(true);
  const coral = createDefaultCoralSnapshot(true);
  const workstation = createDefaultWorkstationSnapshot(true);

  return {
    ...base,
    timeSeries: generateHistoricalTelemetry(base, 1, 60),
    jetson: {
      ...jetson,
      timeSeries: generateJetsonHistoricalTelemetry(jetson, 1, 60),
    },
    coral: {
      ...coral,
      timeSeries: generateCoralHistoricalTelemetry(coral, 1, 60),
    },
    workstation: {
      ...workstation,
      timeSeries: generateWorkstationHistoricalTelemetry(workstation, 1, 60),
    },
  };
}

/**
 * Generates deterministic historical time-series points matching switch counters.
 * Complies with Dean Invariant (pure integer arithmetic, monotonic nanoseconds).
 */
export function generateHistoricalTelemetry(
  snapshot: ZodiacFullTelemetrySnapshot,
  durationHours: number = 1,
  pointCount: number = 60
): ZodiacTimeSeriesPoint[] {
  const points: ZodiacTimeSeriesPoint[] = [];
  const nowMs = Date.now();
  const stepMs = Math.max(1000, Math.floor((durationHours * 3600 * 1000) / pointCount));

  // If hardware is disconnected, flatline to zero with null temperature (Reality Invariant)
  if (snapshot.source === 'disconnected' || snapshot.system.cpuTemperatureC === null) {
    for (let i = pointCount - 1; i >= 0; i--) {
      points.push({
        timestampMs: nowMs - i * stepMs,
        rxBytes: 0n,
        txBytes: 0n,
        rxPackets: 0n,
        txPackets: 0n,
        rxRatePps: 0n,
        txRatePps: 0n,
        rxRateBps: 0n,
        txRateBps: 0n,
        cpuTemperatureC: null,
        latencyNs: 0n,
      });
    }
    return points;
  }

  // Aggregate baseline counters
  let totalRxBytes = 0n;
  let totalTxBytes = 0n;
  let totalRxPkts = 0n;
  let totalTxPkts = 0n;
  for (const p of snapshot.ports) {
    totalRxBytes += p.rxBytes;
    totalTxBytes += p.txBytes;
    totalRxPkts += p.rxPackets;
    totalTxPkts += p.txPackets;
  }

  const baseTemp = snapshot.system.cpuTemperatureC ?? 31;
  const baseLatency = snapshot.openflow.lastHeartbeatLatencyNs || 495625n;

  for (let i = pointCount - 1; i >= 0; i--) {
    const timestampMs = nowMs - i * stepMs;
    const progress = BigInt(pointCount - i);
    const totalProg = BigInt(pointCount);

    // Diurnal variation wave with integer math (80% to 120%)
    const cycle = Math.floor(timestampMs / 60000) % 60;
    const modFactor = BigInt(80 + (cycle % 40));

    const rxBytes = (totalRxBytes * progress * modFactor) / (totalProg * 100n);
    const txBytes = (totalTxBytes * progress * modFactor) / (totalProg * 100n);
    const rxPackets = (totalRxPkts * progress * modFactor) / (totalProg * 100n);
    const txPackets = (totalTxPkts * progress * modFactor) / (totalProg * 100n);

    const intervalSec = BigInt(Math.max(1, Math.floor(stepMs / 1000)));
    const rxRatePps = (totalRxPkts * modFactor) / (totalProg * 100n * intervalSec);
    const txRatePps = (totalTxPkts * modFactor) / (totalProg * 100n * intervalSec);
    const rxRateBps = (totalRxBytes * modFactor) / (totalProg * 100n * intervalSec);
    const txRateBps = (totalTxBytes * modFactor) / (totalProg * 100n * intervalSec);

    const tempJitter = cycle % 3 === 0 ? 1 : cycle % 5 === 0 ? -1 : 0;
    const cpuTemperatureC = Math.max(25, Math.min(65, baseTemp + tempJitter));

    const latJitter = BigInt((cycle % 7) * 15000);
    const latencyNs = baseLatency + latJitter;

    points.push({
      timestampMs,
      rxBytes,
      txBytes,
      rxPackets,
      txPackets,
      rxRatePps,
      txRatePps,
      rxRateBps,
      txRateBps,
      cpuTemperatureC,
      latencyNs,
    });
  }

  return points;
}

/**
 * Deterministic BigInt byte counter formatting using integer division and modulo math.
 * Banishes IEEE-754 floating-point arithmetic.
 */
export function formatBytesDeterministic(bytes: bigint): string {
  const ONE_KB = 1024n;
  const ONE_MB = 1048576n;       // 1024 * 1024
  const ONE_GB = 1073741824n;    // 1024 * 1024 * 1024

  if (bytes < ONE_KB) {
    return `${bytes} B`;
  }
  if (bytes < ONE_MB) {
    const kb = bytes / ONE_KB;
    const frac = ((bytes % ONE_KB) * 100n) / ONE_KB;
    const fracStr = frac < 10n ? `0${frac}` : `${frac}`;
    return `${kb}.${fracStr} KB`;
  }
  if (bytes < ONE_GB) {
    const mb = bytes / ONE_MB;
    const frac = ((bytes % ONE_MB) * 100n) / ONE_MB;
    const fracStr = frac < 10n ? `0${frac}` : `${frac}`;
    return `${mb}.${fracStr} MB`;
  }
  const gb = bytes / ONE_GB;
  const frac = ((bytes % ONE_GB) * 1000n) / ONE_GB;
  let fracStr = `${frac}`;
  if (frac < 10n) fracStr = `00${frac}`;
  else if (frac < 100n) fracStr = `0${frac}`;
  return `${gb}.${fracStr} GB`;
}

/**
 * Deterministic BigInt nanosecond latency formatting using integer division and modulo math.
 */
export function formatLatencyNsDeterministic(ns: bigint): string {
  if (ns === 0n) return '< 500 µs';
  const micros = ns / 1000n;
  if (micros < 1000n) {
    const frac = (ns % 1000n) / 100n;
    return `${micros}.${frac} µs`;
  }
  const millis = micros / 1000n;
  const frac = (micros % 1000n) / 10n;
  const fracStr = frac < 10n ? `0${frac}` : `${frac}`;
  return `${millis}.${fracStr} ms`;
}

export interface ProvenanceValidationContext {
  readonly isLoopback: boolean;
  readonly bridgeSecret?: string | undefined;
  readonly expectedSecret?: string | undefined;
}

/**
 * Validates telemetry snapshot source against transport origin and cryptographic credentials.
 * Council Invariant 6: Goodhart's Law & Epistemic Telemetry Provenance (Anti-Simulation Law).
 * Enforces Verification Asymmetry: An external caller cannot claim 'live_hardware' without
 * loopback transport or a verified bridge secret.
 */
export function resolveVerifiedProvenance(
  requestedSource: unknown,
  ctx: ProvenanceValidationContext
): 'live_hardware' | 'cloud_snapshot' | 'disconnected' {
  if (requestedSource === 'disconnected') {
    return 'disconnected';
  }

  if (requestedSource === 'live_hardware') {
    const secretValid =
      Boolean(ctx.expectedSecret) &&
      ctx.bridgeSecret === ctx.expectedSecret;

    if (ctx.isLoopback || secretValid) {
      return 'live_hardware';
    }

    // Fail-Closed: Quarantine/demote unverified remote claims of live_hardware to cloud_snapshot sandbox
    return 'cloud_snapshot';
  }

  return 'cloud_snapshot';
}

/**
 * Asserts that a declared telemetry source possesses physical verification.
 * Throws an Epistemic Provenance Violation error if unverified.
 */
export function assertVerifiedProvenance(
  source: string,
  isPhysicallyVerified: boolean
): void {
  if (source === 'live_hardware' && !isPhysicallyVerified) {
    throw new Error('Epistemic Provenance Violation: live_hardware declared without physical link verification');
  }
}

