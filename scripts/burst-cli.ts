#!/usr/bin/env node
/**
 * scripts/burst-cli.ts
 * ====================
 * Instant CLI controller for physical multi-device hardware traffic bursts.
 *
 * Targets:
 *   - Zodiac FX OpenFlow Switch (Port 3 Mirror Tap & Port 4 Controller Link)
 *   - Google Coral Edge TPU #1 (Tap Packet Classifier)
 *   - Google Coral Edge TPU #2 (DNS Intent Sentinel)
 *   - Raspberry Pi 3B+ (Client Workload Node)
 *   - NVIDIA Jetson Orin Nano Super (Master Controller Appliance)
 *
 * Usage:
 *   npm run burst                                     # Default 15m burst across ALL devices
 *   npm run burst -- 5m                               # 5m burst across ALL devices
 *   npm run burst -- --target zodiac --size 50mb      # 50 MB burst targeting Zodiac switch only
 *   npm run burst -- --target coral                   # Target Coral Edge TPUs only
 *   npm run burst -- --target rpi --size 100mb        # 100 MB burst targeting Raspberry Pi only
 *   npm run burst -- --target zodiac,coral --size 1gb # 1 GB burst targeting Zodiac & Corals
 *   npm run burst:status                              # Inspect running burst progress & metrics
 *   npm run burst:stop                                # Stop any active burst cleanly
 */

import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile('.env.local');
  } catch (err: unknown) {
    try {
      process.loadEnvFile('.env');
    } catch (innerErr: unknown) {
      // Non-fatal if neither env file is present; log diagnostic to stderr
      const msgLocal = formatError(err);
      const msgDefault = formatError(innerErr);
      if (!msgLocal.includes('ENOENT') || !msgDefault.includes('ENOENT')) {
        process.stderr.write(`[burst-cli] Notice loading env files: ${msgLocal}; ${msgDefault}\n`);
      }
    }
  }
}

const JETSON_HOST = process.env['JETSON_SSH_HOST'] ?? process.env['JETSON_HOST'] ?? '127.0.0.1';
const JETSON_USER = process.env['JETSON_SSH_USER'] ?? 'zodiac';
const JETSON_TARGET = `${JETSON_USER}@${JETSON_HOST}`;
const RPI_WORKLOAD_IP = process.env['RPI_WORKLOAD_IP'] ?? '';
const ZODIAC_SWITCH_IP = process.env['ZODIAC_SWITCH_IP'] ?? '';
const REMOTE_SCRIPT_PATH = '/home/zodiac/burst-daemon.py';
const REMOTE_LOG_PATH = '/home/zodiac/burst-telemetry.log';

function isRunningOnJetson(): boolean {
  try {
    const hostname = osHostname();
    return hostname.includes('jetson') || fs.existsSync('/etc/nv_tegra_release');
  } catch (err: unknown) {
    process.stderr.write(`[burst-cli] Notice checking platform: ${formatError(err)}\n`);
    return false;
  }
}

function osHostname(): string {
  try {
    return execSync('hostname', { encoding: 'utf8' }).trim();
  } catch (err: unknown) {
    process.stderr.write(`[burst-cli] Notice reading hostname: ${formatError(err)}\n`);
    return '';
  }
}

function syncScriptToJetson(): void {
  const localScript = path.resolve(__dirname, 'hardware-burst-daemon.py');
  if (!fs.existsSync(localScript)) {
    throw new Error(`Local daemon script not found: ${localScript}`);
  }

  if (isRunningOnJetson()) {
    fs.copyFileSync(localScript, REMOTE_SCRIPT_PATH);
    fs.chmodSync(REMOTE_SCRIPT_PATH, 0o755);
    return;
  }

  try {
    execSync(`scp -q -o ConnectTimeout=5 ${localScript} ${JETSON_TARGET}:${REMOTE_SCRIPT_PATH}`, {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    execSync(`ssh -q -o ConnectTimeout=5 ${JETSON_TARGET} "chmod +x ${REMOTE_SCRIPT_PATH}"`, {
      stdio: 'pipe',
      encoding: 'utf8',
    });
  } catch (err: unknown) {
    throw new Error(`Failed to sync daemon script to Jetson (${JETSON_TARGET}): ${formatError(err)}`);
  }
}

export interface BurstOptions {
  duration?: string;
  target?: string;
  size?: string;
  detach?: boolean;
  interval?: number;
  staggered?: boolean;
  staggerRestSec?: number;
}

async function startBurst(options: BurstOptions): Promise<void> {
  const duration = options.duration ?? '15m';
  const target = options.target ?? 'all';
  const size = options.size ?? '';
  const detach = options.detach ?? false;
  const interval = options.interval ?? 15;
  const staggered = options.staggered ?? false;
  const staggerRestSec = options.staggerRestSec;

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🚀 INITIALIZING HARDWARE TRAFFIC & INFERENCE BURST');
  console.log(`   Duration      : ${duration}`);
  console.log(`   Target Device : ${target.toUpperCase()}`);
  console.log(`   Size Limit    : ${size ? size.toUpperCase() : 'UNLIMITED (Duration-based)'}`);
  console.log(`   Mode          : ${staggered ? 'Staggered 5-Phase Cycle' : (detach ? 'Detached (Background)' : 'Live Stream')}`);
  console.log(`   Target Host   : ${JETSON_TARGET}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  process.stdout.write('📦 Syncing burst daemon to Jetson appliance... ');
  syncScriptToJetson();
  console.log('Done.\n');

  // Check if a burst is already running
  try {
    const checkCmd = isRunningOnJetson()
      ? 'pgrep -f burst-daemon.py'
      : `ssh -o ConnectTimeout=5 ${JETSON_TARGET} "pgrep -f burst-daemon.py"`;
    const existingPid = execSync(checkCmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (existingPid) {
      console.warn(`⚠️  A burst is already running on Jetson (PID: ${existingPid.split('\n')[0]}).`);
      console.log(`   Run 'npm run burst:stop' to abort it, or 'npm run burst:status' to view live metrics.\n`);
      return;
    }
  } catch (err: unknown) {
    const status = typeof err === 'object' && err !== null && 'status' in err ? (err as { status?: number }).status : undefined;
    if (status !== 1) {
      process.stderr.write(`[burst-cli] Note: pgrep returned non-standard status ${String(status)}: ${formatError(err)}\n`);
    }
  }

  const envPrefix = [
    RPI_WORKLOAD_IP   ? `RPI_WORKLOAD_IP=${RPI_WORKLOAD_IP}`     : '',
    ZODIAC_SWITCH_IP  ? `ZODIAC_SWITCH_IP=${ZODIAC_SWITCH_IP}`   : '',
  ].filter(Boolean).join(' ');
  const sudoEnv = envPrefix ? `env ${envPrefix} ` : '';
  let pyCmd = `${sudoEnv}/home/zodiac/coral-venv/bin/python3 ${REMOTE_SCRIPT_PATH} --duration ${duration} --interval ${interval} --target ${target} --log-file ${REMOTE_LOG_PATH}`;
  if (size) {
    pyCmd += ` --size ${size}`;
  }
  if (staggered) {
    pyCmd += ` --staggered`;
  }
  if (staggerRestSec !== undefined && staggerRestSec > 0) {
    pyCmd += ` --stagger-rest-sec ${staggerRestSec}`;
  }

  if (detach) {
    const detachCmd = isRunningOnJetson()
      ? `nohup sudo ${pyCmd} > /dev/null 2>&1 &`
      : `ssh -o ConnectTimeout=5 ${JETSON_TARGET} "nohup sudo ${pyCmd} > /dev/null 2>&1 &"`;

    execSync(detachCmd, { encoding: 'utf8' });
    console.log('✨ Burst initiated in background.');
    console.log(`   - Live Dashboard : http://${JETSON_HOST}:3003`);
    console.log(`   - View Status    : npm run burst:status`);
    console.log(`   - Stop Burst     : npm run burst:stop\n`);
    return;
  }

  // Live streaming mode
  console.log('📡 Streaming live hardware telemetry (Press Ctrl+C to abort cleanly)...\n');
  const localEnv = { ...process.env, ...(RPI_WORKLOAD_IP ? { RPI_WORKLOAD_IP } : {}), ...(ZODIAC_SWITCH_IP ? { ZODIAC_SWITCH_IP } : {}) };
  const runner = isRunningOnJetson()
    ? spawn('sudo', ['env', ...Object.entries(localEnv).filter(([k]) => ['RPI_WORKLOAD_IP','ZODIAC_SWITCH_IP'].includes(k)).map(([k,v]) => `${k}=${v}`), '/home/zodiac/coral-venv/bin/python3', REMOTE_SCRIPT_PATH, '--duration', duration, '--interval', String(interval), '--target', target, ...(size ? ['--size', size] : []), ...(staggered ? ['--staggered'] : []), ...(staggerRestSec ? ['--stagger-rest-sec', String(staggerRestSec)] : [])], { stdio: 'inherit', env: localEnv })
    : spawn('ssh', ['-tt', '-o', 'ConnectTimeout=5', JETSON_TARGET, `sudo ${pyCmd}`], { stdio: 'inherit' });

  const cleanExit = () => {
    console.log('\n[!] Stopping burst...');
    try {
      if (isRunningOnJetson()) {
        execSync('sudo pkill -SIGINT -f burst-daemon.py || true', { encoding: 'utf8' });
      } else {
        execSync(`ssh -o ConnectTimeout=5 ${JETSON_TARGET} "sudo pkill -SIGINT -f burst-daemon.py || true"`, { encoding: 'utf8' });
      }
    } catch (err: unknown) {
      process.stderr.write(`[burst-cli] Notice during cleanup pkill: ${formatError(err)}\n`);
    }
  };

  process.on('SIGINT', () => {
    cleanExit();
    process.exit(0);
  });

  runner.on('close', (code) => {
    if (code !== 0 && code !== null) {
      console.log(`\nBurst completed or terminated with code ${code}.`);
    }
    process.exit(code ?? 0);
  });
}

async function checkStatus(): Promise<void> {
  console.log('\n🔭 Probing Hardware Burst Status...\n');

  let isRunning = false;
  let pid = '';

  try {
    const checkCmd = isRunningOnJetson()
      ? 'pgrep -f burst-daemon.py'
      : `ssh -o ConnectTimeout=5 ${JETSON_TARGET} "pgrep -f burst-daemon.py"`;
    pid = execSync(checkCmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    isRunning = pid.length > 0;
  } catch (err: unknown) {
    isRunning = false;
    const status = typeof err === 'object' && err !== null && 'status' in err ? (err as { status?: number }).status : undefined;
    if (status !== 1) {
      process.stderr.write(`[burst-cli] Note: status check pgrep non-zero exit (${String(status)}): ${formatError(err)}\n`);
    }
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  MULTI-DEVICE HARDWARE BURST STATUS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  State           : ${isRunning ? `🟢 ACTIVE (PID ${pid.split('\n')[0]})` : '⚪ IDLE / COMPLETED'}`);
  console.log(`  Target Host     : ${JETSON_TARGET}`);
  console.log(`  Web Dashboard   : http://${JETSON_HOST}:3003`);

  // Query live appliance hardware telemetry (Dean latency budget: 500ms native HTTP timeout)
  try {
    const liveRaw = await new Promise<string>((resolve, reject) => {
      const req = http.get(`http://${JETSON_HOST}:3003/api/zodiac?summary=1`, { timeout: 500 }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString('utf-8'); });
        res.on('end', () => resolve(data));
      });
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Telemetry poll timed out (500ms budget)'));
      });
      req.on('error', reject);
    });

    const liveRawTrimmed = liveRaw.trim();
    if (liveRawTrimmed.startsWith('{')) {
      const liveJson = JSON.parse(liveRawTrimmed);
      const jetson = liveJson.jetson || {};
      const gpuPct = jetson.gpuUtilizationPct ?? '--';
      const gpuTemp = jetson.temperatures?.gpuC ?? '--';
      const cpuTemp = jetson.temperatures?.cpuC ?? '--';
      const pwrMw = jetson.power?.vddCpuGpuCv ?? '--';
      console.log(`  Jetson GPU      : ${gpuPct}% load | Temp: ${gpuTemp}°C | Power: ${pwrMw}mW`);
      console.log(`  Jetson CPU      : ${cpuTemp}°C`);
    }
  } catch (err: unknown) {
    // Council Invariant 1 (Anti-Shortcut Law): Explicitly log telemetry probe status without empty catch
    process.stderr.write(`  [telemetry-poll-note] Live hardware probe unreachable: ${formatError(err)}\n`);
  }

  console.log('──────────────────────────────────────────────────────────────────');

  try {
    const logCmd = isRunningOnJetson()
      ? `tail -n 8 ${REMOTE_LOG_PATH} 2>/dev/null || echo "No log found."`
      : `ssh -o ConnectTimeout=5 ${JETSON_TARGET} "tail -n 8 ${REMOTE_LOG_PATH} 2>/dev/null || echo 'No log found.'"`;
    const logOut = execSync(logCmd, { encoding: 'utf8' }).trim();
    console.log('  RECENT TELEMETRY LOGS:');
    for (const line of logOut.split('\n')) {
      console.log(`    ${line}`);
    }
  } catch (err: unknown) {
    console.log('  Log read failed:', formatError(err));
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

function stopBurst(): void {
  console.log('\n🛑 Aborting Hardware Burst across all devices...\n');
  try {
    const stopCmd = isRunningOnJetson()
      ? 'sudo pkill -SIGTERM -f burst-daemon.py || true'
      : `ssh -o ConnectTimeout=5 ${JETSON_TARGET} "sudo pkill -SIGTERM -f burst-daemon.py || true"`;
    execSync(stopCmd, { stdio: 'inherit', encoding: 'utf8' });
    console.log('✅ Burst process terminated successfully.\n');
  } catch (err: unknown) {
    console.error('❌ Failed to stop burst:', formatError(err));
  }
}

function showHelp(): void {
  console.log(`
Zodiac — Hardware Traffic & Inference Burst CLI

Usage:
  npm run burst [-- <duration>] [--target <device>] [--size <size>] [--detach] [--interval <sec>] [--stagger-rest-sec <sec>]
  npm run burst:status
  npm run burst:stop

Commands / Options:
  start [duration]         - Start burst (default duration: 15m).
                             Supported units: 15m, 5m, 1m, 30s, 900.
  --target, -t <device>    - Target specific device(s) (default: 'all'):
                             * 'all'        - All hardware (Zodiac, Corals, Jetson, RPi)
                             * 'jetson'     - NVIDIA Jetson Orin Ampere GPU compute worker (or 'gpu')
                             * 'zodiac'     - Zodiac FX switch (Port 3 mirror tap + Port 4 ctrl)
                             * 'zodiac-p3'  - Zodiac FX Port 3 mirror tap raw frame burst only
                             * 'zodiac-p4'  - Zodiac FX Port 4 controller UDP probe burst only
                             * 'coral-1'    - Coral TPU #1 (Tap DPI) solo burst via Zodiac Port 3 tap
                             * 'coral-2'    - Coral TPU #2 (DNS Sentinel) solo burst via accelerator worker
                             * 'coral'      - Both Google Coral Edge TPUs
                             * 'rpi'        - Raspberry Pi 3B+ workload node
                             Comma-separated lists supported: e.g. '--target zodiac,coral,gpu'
  --staggered, --stagger   - Execute a 5-phase staggered burst cycle across Coral devices:
                             Stage 1: Coral TPU #1 (Tap DPI) solo burst
                             Stage 2: Settling interval (both TPUs in STANDBY at 0 inf/s)
                             Stage 3: Coral TPU #2 (DNS Sentinel) solo burst
                             Stage 4: Settling interval (both TPUs in STANDBY at 0 inf/s)
                             Stage 5: Dual Coral TPUs concurrently (peak parallelism ~450 inf/s)
  --stagger-rest-sec <sec> - Configure custom settling interval duration in seconds.
  --size, -s <size>        - Cap the total burst data volume (e.g. 50mb, 100mb, 1gb, 500kb).
                             Terminates as soon as byte limit or duration is reached.
  --detach, -d             - Run in the background without holding the shell.
  --interval <sec>         - Set live reporting interval in seconds (default: 15).
  status                   - Check if a burst is running and show recent logs.
  stop                     - Stop any active burst daemon cleanly across all devices.

Examples:
  npm run burst                                      # 15m live burst across all devices
  npm run burst -- --target jetson                   # Target Jetson Orin Ampere GPU worker only
  npm run burst -- --target gpu --size 500mb         # 500 MB compute burst on Ampere GPU
  npm run burst -- 60s --staggered                   # Staggered burst cycle across Coral devices
  npm run burst -- --target coral-1                  # Target Coral TPU #1 (Tap DPI) only
  npm run burst -- --target coral-2                  # Target Coral TPU #2 (DNS Sentinel) only
  npm run burst -- 5m                                # 5m live burst across all devices
  npm run burst -- --target zodiac --size 50mb       # 50 MB burst targeting Zodiac switch
  npm run burst -- --target coral                    # Target Coral Edge TPUs only
  npm run burst -- --target rpi --size 100mb         # 100 MB burst targeting Raspberry Pi only
  npm run burst -- --target zodiac,gpu --size 1gb    # 1 GB burst targeting Zodiac and Jetson GPU
  npm run burst -- 15m --detach                      # 15m detached burst in background
  npm run burst:status                               # View live burst telemetry
  npm run burst:stop                                 # Immediately abort running burst
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'start';

  if (command === 'status' || command === 'burst:status') {
    await checkStatus();
    return;
  }

  if (command === 'stop' || command === 'burst:stop') {
    stopBurst();
    return;
  }

  if (command === 'help' || command === '--help' || command === '-h') {
    showHelp();
    return;
  }

  // Parse duration & options for start
  const options: BurstOptions = {
    duration: '15m',
    target: 'all',
    size: '',
    detach: false,
    interval: 15,
    staggered: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === 'start') continue;
    if (arg === '--detach' || arg === '-d') {
      options.detach = true;
    } else if (arg === '--staggered' || arg === '--stagger') {
      options.staggered = true;
    } else if (arg.startsWith('--interval=')) {
      const parts = arg.split('=');
      const rawVal = parts[1] ?? '';
      const parsed = parseInt(rawVal, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        options.interval = parsed;
      }
    } else if (arg === '--interval' && i + 1 < args.length) {
      const parsed = parseInt(args[++i] ?? '', 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        options.interval = parsed;
      }
    } else if (arg.startsWith('--stagger-rest-sec=')) {
      const parts = arg.split('=');
      const rawVal = parts[1] ?? '';
      const parsed = parseInt(rawVal, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        options.staggerRestSec = parsed;
      }
    } else if (arg === '--stagger-rest-sec' && i + 1 < args.length) {
      const parsed = parseInt(args[++i] ?? '', 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        options.staggerRestSec = parsed;
      }
    } else if (arg.startsWith('--target=')) {
      options.target = arg.split('=')[1]!;
    } else if ((arg === '--target' || arg === '-t' || arg === '--device') && i + 1 < args.length) {
      options.target = args[++i]!;
    } else if (arg.startsWith('--size=')) {
      options.size = arg.split('=')[1]!;
    } else if ((arg === '--size' || arg === '-s') && i + 1 < args.length) {
      options.size = args[++i]!;
    } else if (!arg.startsWith('-')) {
      options.duration = arg;
    }
  }

  await startBurst(options);
}

main().catch((err: unknown) => {
  console.error('\n❌ Fatal Burst CLI Error:', formatError(err));
  process.exit(1);
});
