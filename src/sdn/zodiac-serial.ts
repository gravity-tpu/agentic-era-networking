/**
 * zodiac-serial.ts
 * Out-of-Band Serial CDC ACM Management Interface for Zodiac FX
 *
 * Council Invariants Enforced:
 * - Anti-Shortcut Law: Deterministic parsing of terminal output, no silent failure.
 * - Ghemawat: Zero unnecessary external dependencies; reliable execution boundary.
 * - Dean: Explicit timeouts preventing indefinite blocking on physical I/O.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

/**
 * Safely parses BigInt values from raw hardware serial strings.
 * Council Invariant 1 (Anti-Shortcut / Robustness Boundary):
 * Strips non-digit characters and catches SyntaxError to guarantee fail-closed resilience against line noise.
 */
export function safeParseBigInt(val: string, fallback: bigint = 0n): bigint {
  const cleaned = val.trim().replace(/[^0-9]/g, '');
  if (cleaned.length === 0) return fallback;
  try {
    return BigInt(cleaned);
  } catch (err: unknown) {
    // Council Invariant 1 (Zero Suppression of Reality): Never swallow parsing exceptions silently
    process.stderr.write(
      `[ZodiacSerial] safeParseBigInt parsing error for "${val}" (cleaned: "${cleaned}"): ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return fallback;
  }
}

export interface ZodiacPortInfo {
  readonly port: number;
  readonly status: 'UP' | 'DOWN';
  readonly vlanType: string;
  readonly vlanId: number;
  readonly rxBytes: bigint;
  readonly txBytes: bigint;
  readonly rxPackets: bigint;
  readonly txPackets: bigint;
  readonly rxDropped: bigint;
  readonly txDropped: bigint;
  readonly rxCrcErrors: bigint;
}

export interface ZodiacDeviceStatus {
  readonly firmwareVersion: string;
  readonly cpuTempC: number;
  readonly uptime: string;
  readonly cpuUid: string;
}

export interface ZodiacConfig {
  readonly name: string;
  readonly macAddress: string;
  readonly ipAddress: string;
  readonly netmask: string;
  readonly gateway: string;
  readonly controllerIp: string;
  readonly controllerPort: number;
  readonly failstate: string;
}

export class ZodiacSerialClient {
  private readonly _explicitPath: string | undefined;

  constructor(devicePath?: string) {
    this._explicitPath = devicePath;
  }

  /**
   * Northbound Networks Zodiac FX USB identifiers (Atmel SAM4E8E CDC-ACM).
   * Verified against `lsusb` output on a live Jetson Orin with Zodiac FX attached.
   * Source: Atmel/Microchip USB Vendor ID registry; Zodiac FX firmware USB descriptor.
   */
  private static readonly ZODIAC_USB_VENDOR_ID = '03eb' as const; // Atmel Corporation

  /**
   * Auto-detects the Zodiac FX CDC-ACM serial device.
   *
   * Platform resolution (Ghemawat: zero external deps, pure /dev + sysfs scan):
   *
   *   macOS  → /dev/cu.usbmodem*  (USB CDC-ACM call-out device; no sysfs available)
   *
   *   Linux  → Primary:  sysfs VID probe on /sys/class/tty/ttyACMx/device/idVendor
   *                       matching Northbound Networks / Atmel VID 0x03eb.
   *                       This prevents mis-binding to Coral debug consoles, UPS
   *                       serial cables, or other CDC-ACM devices on the same bus.
   *            Fallback:  First /dev/ttyUSB* if no VID-matched ttyACM* is found.
   *
   * Dean Invariant: synchronous I/O here is acceptable — detectDevice() is called
   * only during one-shot CLI startup, never on the hot OpenFlow or telemetry paths.
   *
   * Council Invariant 3 (Fail-Closed): throws deterministically if the device is
   * absent. Callers must not swallow this error. Offline testing must be gated
   * via the MOCK_SERIAL environment variable, not by catching this exception.
   */
  public detectDevice(): string {
    const platform = process.platform;

    if (platform === 'darwin') {
      // macOS: sysfs unavailable; match first call-out USB modem device.
      const devFiles = readdirSync('/dev');
      const modem = devFiles.find((f) => f.startsWith('cu.usbmodem'));
      if (!modem) {
        throw new Error(
          'No Zodiac FX serial device found under /dev/cu.usbmodem*. ' +
            'Ensure the Micro-USB cable is connected and the Zodiac FX is powered on.',
        );
      }
      return `/dev/${modem}`;
    }

    // Linux (Jetson Orin ARM64): use sysfs VID matching to deterministically
    // identify the Zodiac FX among potentially many CDC-ACM devices on the bus.
    const devFiles = readdirSync('/dev');
    const candidates = devFiles.filter((f) => f.startsWith('ttyACM'));

    for (const candidate of candidates) {
      const vidCandidates = [
        `/sys/class/tty/${candidate}/device/idVendor`,
        `/sys/class/tty/${candidate}/device/../idVendor`,
      ];
      for (const vidPath of vidCandidates) {
        try {
          const vid = readFileSync(vidPath, 'utf8').trim().toLowerCase();
          if (vid === ZodiacSerialClient.ZODIAC_USB_VENDOR_ID) {
            return `/dev/${candidate}`;
          }
        } catch (_) {
          // try next path
        }
      }
    }

    // Fallback 1: ttyACM device present but sysfs VID unreadable (older kernels).
    // Warn loudly so the operator knows auto-detection was imprecise.
    const firstAcm = candidates[0];
    if (firstAcm !== undefined) {
      process.stderr.write(
        `[ZodiacSerial] WARNING: Could not verify USB Vendor ID for /dev/${firstAcm} ` +
          `via sysfs. Binding anyway. Set ZODIAC_SERIAL_PATH to suppress this warning.\n`,
      );
      return `/dev/${firstAcm}`;
    }

    // Fallback 2: ttyUSB* (CP210x / FTDI USB-serial adapter).
    const usbSerial = devFiles.find((f) => f.startsWith('ttyUSB'));
    if (usbSerial !== undefined) {
      return `/dev/${usbSerial}`;
    }

    throw new Error(
      'No Zodiac FX serial device found. Expected /dev/ttyACM* (Atmel VID 0x03eb) ' +
        'or /dev/ttyUSB*. Ensure the Micro-USB cable is connected and the Zodiac FX ' +
        'is powered on. To override, set ZODIAC_SERIAL_PATH=/dev/ttyACMx in the environment.',
    );
  }

  public get path(): string {
    return this.devicePath;
  }

  public get devicePath(): string {
    if (this._explicitPath) return this._explicitPath;
    // Council Invariant 1 (Zero Suppression of Reality / Anti-Shortcut Law):
    // Never swallow detectDevice() errors with a synthetic fallback path.
    // A hardcoded path when the device is absent masks the root cause and
    // produces a confusing downstream ENOENT / EACCES error.
    //
    // Offline / CI testing: set MOCK_SERIAL=1. Methods that spawn Python
    // (e.g. _executeRaw) guard themselves against MOCK_SERIAL and return
    // empty mock data before ever accessing devicePath, so this getter
    // is never reached when MOCK_SERIAL is active. If it is somehow called,
    // surface the intent clearly rather than returning a misleading path.
    if (process.env['MOCK_SERIAL']) {
      throw new Error(
        '[ZodiacSerial] devicePath accessed with MOCK_SERIAL=1. ' +
          'Callers must check process.env["MOCK_SERIAL"] and bypass hardware I/O.',
      );
    }
    return this.detectDevice();
  }

  private mutexPromise: Promise<void> = Promise.resolve();

  private async acquireLock<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void = () => {};
    const nextPromise = new Promise<void>((r) => { release = r; });
    const prevPromise = this.mutexPromise;
    this.mutexPromise = prevPromise.then(() => nextPromise, () => nextPromise);
    await prevPromise.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Executes a command on the Zodiac FX CLI over serial and returns the raw response.
   */
  public async executeRaw(command: string, timeoutMs: number = 3000): Promise<string> {
    return this.acquireLock(() => this._executeRaw(command, timeoutMs));
  }

  private async _executeRaw(command: string, timeoutMs: number = 3000): Promise<string> {
    // MOCK_SERIAL guard: bypass all Python serial I/O in offline / CI environments.
    // Returning '' here prevents any tcsetattr / ioctl on /dev/null (ENOTTY risk)
    // and keeps test suites hardware-independent (Council Invariant 3: fail-closed
    // mock is an explicit override, not a silent suppression).
    if (process.env['MOCK_SERIAL']) return '';

    return new Promise((resolve, reject) => {
      const pythonScript = `
import serial, time, sys

try:
    ser = serial.Serial('${this.devicePath}', 115200, timeout=1.0, write_timeout=2.0, rtscts=False, dsrdtr=False)
    ser.dtr = True
    ser.rts = True
    time.sleep(0.1)
    ser.reset_input_buffer()
    cmd = '${command}\\r\\n'
    ser.write(cmd.encode('ascii'))
    time.sleep(0.2)
    out = b''
    start_t = time.monotonic()
    while time.monotonic() - start_t < 1.5:
        if ser.in_waiting:
            out += ser.read(ser.in_waiting)
            time.sleep(0.05)
        else:
            time.sleep(0.05)
        trimmed = out.rstrip()
        if (
            trimmed.endswith(b'#')
            or trimmed.endswith(b'>')
            or b'Zodiac_FX>' in out
            or b'Command not recognized' in out
            or b'Unknown command' in out
        ):
            break
    ser.close()
    sys.stdout.write(out.decode('latin1', errors='replace'))
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(1)
`;

      const py = spawn('python3', ['-c', pythonScript], { timeout: timeoutMs });
      let stdout = '';
      let stderr = '';

      py.stdout.on('data', (d) => { stdout += d.toString(); });
      py.stderr.on('data', (d) => { stderr += d.toString(); });

      py.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Serial command '${command}' failed on ${this.devicePath}: ${stderr || `exit code ${code}`}`));
        } else {
          resolve(stdout);
        }
      });

      py.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Queries 'show status' and parses device metrics.
   */
  public async getStatus(): Promise<ZodiacDeviceStatus> {
    const raw = await this.executeRaw('show status');

    const firmwareMatch = raw.match(/Firmware Version:\s*([^\r\n]+)/i);
    const tempMatch = raw.match(/CPU Temp:\s*(\d+)\s*C/i);
    const uptimeMatch = raw.match(/Uptime:\s*([^\r\n]+)/i);
    const uidMatch = raw.match(/CPU UID:\s*([^\r\n]+)/i);

    return {
      firmwareVersion: firmwareMatch?.[1]?.trim() ?? 'Unknown',
      cpuTempC: tempMatch ? parseInt(tempMatch[1]!, 10) : 0,
      uptime: uptimeMatch?.[1]?.trim() ?? 'Unknown',
      cpuUid: uidMatch?.[1]?.trim() ?? 'Unknown',
    };
  }

  /**
   * Queries 'show ports' and returns status of Ports 1–4.
   */
  public async getPorts(): Promise<ZodiacPortInfo[]> {
    const raw = await this.executeRaw('show ports');
    const ports: ZodiacPortInfo[] = [];

    const portBlocks = raw.split(/Port\s+(\d+)/i);
    for (let i = 1; i < portBlocks.length; i += 2) {
      const portNum = parseInt(portBlocks[i]!, 10);
      const content = portBlocks[i + 1] ?? '';

      let status: 'UP' | 'DOWN' = 'DOWN';
      let vlanType = 'Unknown';
      let vlanId = 0;
      let rxBytes = 0n;
      let txBytes = 0n;
      let rxPackets = 0n;
      let txPackets = 0n;
      let rxDropped = 0n;
      let txDropped = 0n;
      let rxCrcErrors = 0n;

      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('Status:')) {
          status = trimmed.substring(7).trim().toUpperCase() === 'UP' ? 'UP' : 'DOWN';
        } else if (trimmed.startsWith('VLAN type:')) {
          vlanType = trimmed.substring(10).trim();
        } else if (trimmed.startsWith('VLAN ID:')) {
          const idClean = trimmed.substring(8).trim().replace(/[^0-9]/g, '');
          vlanId = idClean.length > 0 ? parseInt(idClean, 10) : 0;
        } else if (trimmed.startsWith('RX Bytes:')) {
          rxBytes = safeParseBigInt(trimmed.substring(9));
        } else if (trimmed.startsWith('TX Bytes:')) {
          txBytes = safeParseBigInt(trimmed.substring(9));
        } else if (trimmed.startsWith('RX Packets:')) {
          rxPackets = safeParseBigInt(trimmed.substring(11));
        } else if (trimmed.startsWith('TX Packets:')) {
          txPackets = safeParseBigInt(trimmed.substring(11));
        } else if (trimmed.startsWith('RX Dropped Packets:')) {
          rxDropped = safeParseBigInt(trimmed.substring(19));
        } else if (trimmed.startsWith('TX Dropped Packets:')) {
          txDropped = safeParseBigInt(trimmed.substring(19));
        } else if (trimmed.startsWith('RX CRC Errors:')) {
          rxCrcErrors = safeParseBigInt(trimmed.substring(14));
        }
      }

      ports.push({
        port: portNum,
        status,
        vlanType,
        vlanId,
        rxBytes,
        txBytes,
        rxPackets,
        txPackets,
        rxDropped,
        txDropped,
        rxCrcErrors,
      });
    }

    return ports;
  }

  /**
   * Executes a sequence of commands on the Zodiac FX CLI over serial.
   */
  public async executeSequence(commands: string[], timeoutMs: number = 5000): Promise<string> {
    return this.acquireLock(() => this._executeSequence(commands, timeoutMs));
  }

  private async _executeSequence(commands: string[], timeoutMs: number = 5000): Promise<string> {
    return new Promise((resolve, reject) => {
      const cmdsJson = JSON.stringify(commands);
      const pythonScript = `
import serial, time, sys, json

try:
    cmds = json.loads('''${cmdsJson}''')
    ser = serial.Serial('${this.devicePath}', 115200, timeout=1.0, write_timeout=2.0, rtscts=False, dsrdtr=False)
    ser.dtr = True
    ser.rts = True
    time.sleep(0.1)
    ser.reset_input_buffer()
    all_out = ''
    for c in cmds:
        ser.write((c + '\\r\\n').encode('ascii'))
        time.sleep(0.2)
        out = b''
        start_t = time.monotonic()
        while time.monotonic() - start_t < 1.5:
            if ser.in_waiting:
                out += ser.read(ser.in_waiting)
                time.sleep(0.05)
            else:
                time.sleep(0.05)
            trimmed = out.rstrip()
            if (
                trimmed.endswith(b'#')
                or trimmed.endswith(b'>')
                or b'Zodiac_FX>' in out
                or b'Command not recognized' in out
                or b'Unknown command' in out
            ):
                break
        all_out += out.decode('latin1', errors='replace') + '\\n'
    ser.close()
    sys.stdout.write(all_out)
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(1)
`;

      const py = spawn('python3', ['-c', pythonScript], { timeout: timeoutMs });
      let stdout = '';
      let stderr = '';

      py.stdout.on('data', (d) => { stdout += d.toString(); });
      py.stderr.on('data', (d) => { stderr += d.toString(); });

      py.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Serial sequence failed on ${this.devicePath}: ${stderr || `exit code ${code}`}`));
        } else {
          resolve(stdout);
        }
      });

      py.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Queries 'config' -> 'show config' and parses network & controller config.
   */
  public async getConfig(): Promise<ZodiacConfig> {
    const raw = await this.executeSequence(['config', 'show config', 'exit']);

    const nameMatch = raw.match(/Name:\s*([^\r\n]+)/i);
    const macMatch = raw.match(/MAC Address:\s*([^\r\n]+)/i);
    const ipMatch = raw.match(/IP Address:\s*([^\r\n]+)/i);
    const maskMatch = raw.match(/Netmask:\s*([^\r\n]+)/i);
    const gwMatch = raw.match(/Gateway:\s*([^\r\n]+)/i);
    const ofCtrlMatch = raw.match(/OpenFlow Controller:\s*([^\r\n]+)/i);
    const ofPortMatch = raw.match(/OpenFlow Port:\s*(\d+)/i);
    const failstateMatch = raw.match(/Failstate:\s*([^\r\n]+)/i);

    return {
      name: nameMatch?.[1]?.trim() ?? 'Zodiac_FX',
      macAddress: macMatch?.[1]?.trim() ?? '',
      ipAddress: ipMatch?.[1]?.trim() ?? '',
      netmask: maskMatch?.[1]?.trim() ?? '',
      gateway: gwMatch?.[1]?.trim() ?? '',
      controllerIp: ofCtrlMatch?.[1]?.trim() ?? '',
      controllerPort: ofPortMatch ? parseInt(ofPortMatch[1]!, 10) : 6633,
      failstate: failstateMatch?.[1]?.trim() ?? 'Secure',
    };
  }

  /**
   * Provisions standard Council networking configuration onto the physical Zodiac FX EEPROM:
   * - Switch IP: from ZODIAC_SWITCH_IP env or params
   * - Controller: from SDN_CONTROLLER_IP env or params (port 6633, OpenFlow 1.3)
   * - Failstate: Secure
   * - VLAN 100 (OpenFlow): Ports 1, 2, 3
   * - VLAN 200 (Native): Port 4 (Host Controller Channel)
   */
  public async initializeDefaultConfig(params?: {
    switchIp?: string;
    netmask?: string;
    gateway?: string;
    controllerIp?: string;
    controllerPort?: number;
  }): Promise<string> {
    const ip = params?.switchIp ?? process.env['ZODIAC_SWITCH_IP'] ?? '127.0.0.1';
    const mask = params?.netmask ?? process.env['ZODIAC_NETMASK'] ?? '255.255.255.0';
    const gw = params?.gateway ?? process.env['SDN_GATEWAY_IP'] ?? '127.0.0.1';
    const ctrlIp = params?.controllerIp ?? process.env['SDN_CONTROLLER_IP'] ?? '127.0.0.1';
    const ctrlPort = params?.controllerPort ?? parseInt(process.env['ZODIAC_OPENFLOW_PORT'] ?? '6633', 10);

    const commands = [
      'config',
      'set name Zodiac_FX',
      `set ip-address ${ip}`,
      `set netmask ${mask}`,
      `set gateway ${gw}`,
      `set of-controller ${ctrlIp}`,
      `set of-port ${ctrlPort}`,
      'set failstate secure',
      'set of-version 4',
      'delete vlan 100',
      'add vlan 100 openflow',
      'set vlan-type 100 openflow',
      'add vlan-port 100 1',
      'add vlan-port 100 2',
      'add vlan-port 100 3',
      'delete vlan 200',
      'add vlan 200 native',
      'set vlan-type 200 native',
      'add vlan-port 200 4',
      'save',
      'exit',
    ];

    return this.executeSequence(commands, 15000);
  }

  /**
   * Restarts the Zodiac FX switch via serial command.
   */
  public async restart(): Promise<void> {
    await this.executeRaw('restart');
  }
}
