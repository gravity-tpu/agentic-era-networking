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
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile();
  } catch (_) {
    // Non-fatal if .env doesn't exist
  }
}

const JETSON_HOST = process.env['JETSON_SSH_HOST'] ?? '127.0.0.1';
const JETSON_USER = process.env['JETSON_SSH_USER'] ?? 'zodiac';
const JETSON_TARGET = `${JETSON_USER}@${JETSON_HOST}`;
const REMOTE_SCRIPT_PATH = '/home/zodiac/burst-daemon.py';
const REMOTE_LOG_PATH = '/home/zodiac/burst-telemetry.log';

function isRunningOnJetson(): boolean {
  try {
    const hostname = osHostname();
    return hostname.includes('jetson') || fs.existsSync('/etc/nv_tegra_release');
  } catch {
    return false;
  }
}

function osHostname(): string {
  try {
    return execSync('hostname', { encoding: 'utf8' }).trim();
  } catch {
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
    });
    execSync(`ssh -q -o ConnectTimeout=5 ${JETSON_TARGET} "chmod +x ${REMOTE_SCRIPT_PATH}"`, {
      stdio: 'pipe',
    });
  } catch (err: unknown) {
    throw new Error(`Failed to sync daemon script to Jetson (${JETSON_TARGET}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface BurstOptions {
  duration?: string;
  target?: string;
  size?: string;
  detach?: boolean;
  interval?: number;
}

async function startBurst(options: BurstOptions): Promise<void> {
  const duration = options.duration ?? '15m';
  const target = options.target ?? 'all';
  const size = options.size ?? '';
  const detach = options.detach ?? false;
  const interval = options.interval ?? 15;

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🚀 INITIALIZING HARDWARE TRAFFIC & INFERENCE BURST');
  console.log(`   Duration      : ${duration}`);
  console.log(`   Target Device : ${target.toUpperCase()}`);
  console.log(`   Size Limit    : ${size ? size.toUpperCase() : 'UNLIMITED (Duration-based)'}`);
  console.log(`   Mode          : ${detach ? 'Detached (Background)' : 'Live Stream'}`);
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
    const existingPid = execSync(checkCmd, { encoding: 'utf8' }).trim();
    if (existingPid) {
      console.warn(`⚠️  A burst is already running on Jetson (PID: ${existingPid.split('\n')[0]}).`);
      console.log(`   Run 'npm run burst:stop' to abort it, or 'npm run burst:status' to view live metrics.\n`);
      return;
    }
  } catch {
    // pgrep exited 1: no process running, proceed
  }

  let pyCmd = `/home/zodiac/coral-venv/bin/python3 ${REMOTE_SCRIPT_PATH} --duration ${duration} --interval ${interval} --target ${target} --log-file ${REMOTE_LOG_PATH}`;
  if (size) {
    pyCmd += ` --size ${size}`;
  }

  if (detach) {
    const detachCmd = isRunningOnJetson()
      ? `nohup sudo ${pyCmd} > /dev/null 2>&1 &`
      : `ssh -o ConnectTimeout=5 ${JETSON_TARGET} "nohup sudo ${pyCmd} > /dev/null 2>&1 &"`;

    execSync(detachCmd);
    console.log('✨ Burst initiated in background.');
    console.log(`   - Live Dashboard : http://${JETSON_HOST}:3003`);
    console.log(`   - View Status    : npm run burst:status`);
    console.log(`   - Stop Burst     : npm run burst:stop\n`);
    return;
  }

  // Live streaming mode
  console.log('📡 Streaming live hardware telemetry (Press Ctrl+C to abort cleanly)...\n');
  const runner = isRunningOnJetson()
    ? spawn('sudo', ['/home/zodiac/coral-venv/bin/python3', REMOTE_SCRIPT_PATH, '--duration', duration, '--interval', String(interval), '--target', target, ...(size ? ['--size', size] : [])], { stdio: 'inherit' })
    : spawn('ssh', ['-tt', '-o', 'ConnectTimeout=5', JETSON_TARGET, `sudo ${pyCmd}`], { stdio: 'inherit' });

  const cleanExit = () => {
    console.log('\n[!] Stopping burst...');
    try {
      if (isRunningOnJetson()) {
        execSync('sudo pkill -SIGINT -f burst-daemon.py || true');
      } else {
        execSync(`ssh -o ConnectTimeout=5 ${JETSON_TARGET} "sudo pkill -SIGINT -f burst-daemon.py || true"`);
      }
    } catch {
      // Ignore
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

function checkStatus(): void {
  console.log('\n🔭 Probing Hardware Burst Status...\n');

  let isRunning = false;
  let pid = '';

  try {
    const checkCmd = isRunningOnJetson()
      ? 'pgrep -f burst-daemon.py'
      : `ssh -o ConnectTimeout=5 ${JETSON_TARGET} "pgrep -f burst-daemon.py"`;
    pid = execSync(checkCmd, { encoding: 'utf8' }).trim();
    isRunning = pid.length > 0;
  } catch {
    isRunning = false;
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  MULTI-DEVICE HARDWARE BURST STATUS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  State           : ${isRunning ? `🟢 ACTIVE (PID ${pid.split('\n')[0]})` : '⚪ IDLE / COMPLETED'}`);
  console.log(`  Target Host     : ${JETSON_TARGET}`);
  console.log(`  Web Dashboard   : http://${JETSON_HOST}:3003`);
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
  } catch (err) {
    console.log('  Log read failed:', err instanceof Error ? err.message : String(err));
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

function stopBurst(): void {
  console.log('\n🛑 Aborting Hardware Burst across all devices...\n');
  try {
    const stopCmd = isRunningOnJetson()
      ? 'sudo pkill -SIGTERM -f burst-daemon.py || true'
      : `ssh -o ConnectTimeout=5 ${JETSON_TARGET} "sudo pkill -SIGTERM -f burst-daemon.py || true"`;
    execSync(stopCmd, { stdio: 'inherit' });
    console.log('✅ Burst process terminated successfully.\n');
  } catch (err) {
    console.error('❌ Failed to stop burst:', err instanceof Error ? err.message : String(err));
  }
}

function showHelp(): void {
  console.log(`
Agentic Era Networking — Hardware Traffic & Inference Burst CLI

Usage:
  npm run burst [-- <duration>] [--target <device>] [--size <size>] [--detach] [--interval <sec>]
  npm run burst:status
  npm run burst:stop

Commands / Options:
  start [duration]         - Start burst (default duration: 15m).
                             Supported units: 15m, 5m, 1m, 30s, 900.
  --target, -t <device>    - Target specific device(s) (default: 'all'):
                             * 'all'       - All hardware (Zodiac, Corals, Jetson, RPi)
                             * 'zodiac'    - Zodiac FX switch (Port 3 mirror tap + Port 4 ctrl)
                             * 'zodiac-p3' - Zodiac FX Port 3 mirror tap raw frame burst only
                             * 'zodiac-p4' - Zodiac FX Port 4 controller UDP probe burst only
                             * 'coral'     - Google Coral Edge TPU INT8 neural inference
                             * 'rpi'       - Raspberry Pi 3B+ workload node
                             * 'jetson'    - NVIDIA Jetson Orin compute & network stack
                             Comma-separated lists supported: e.g. '--target zodiac,coral'
  --size, -s <size>        - Cap the total burst data volume (e.g. 50mb, 100mb, 1gb, 500kb).
                             Terminates as soon as byte limit or duration is reached.
  --detach, -d             - Run in the background without holding the shell.
  --interval <sec>         - Set live reporting interval in seconds (default: 15).
  status                   - Check if a burst is running and show recent logs.
  stop                     - Stop any active burst daemon cleanly across all devices.

Examples:
  npm run burst                                      # 15m live burst across all devices
  npm run burst -- 5m                                # 5m live burst across all devices
  npm run burst -- --target zodiac --size 50mb       # 50 MB burst targeting Zodiac switch
  npm run burst -- --target coral                    # Target Coral Edge TPUs only
  npm run burst -- --target rpi --size 100mb         # 100 MB burst targeting Raspberry Pi only
  npm run burst -- --target zodiac,coral --size 1gb  # 1 GB burst targeting Zodiac and Corals
  npm run burst -- 15m --detach                      # 15m detached burst in background
  npm run burst:status                               # View live burst telemetry
  npm run burst:stop                                 # Immediately abort running burst
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'start';

  if (command === 'status' || command === 'burst:status') {
    checkStatus();
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
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === 'start') continue;
    if (arg === '--detach' || arg === '-d') {
      options.detach = true;
    } else if (arg.startsWith('--interval=')) {
      options.interval = parseInt(arg.split('=')[1]!, 10);
    } else if (arg === '--interval' && i + 1 < args.length) {
      options.interval = parseInt(args[++i]!, 10);
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
  console.error('\n❌ Fatal Burst CLI Error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
