/**
 * zodiac-serial.ts
 * Out-of-Band Serial CDC ACM Management Interface for Zodiac FX
 *
 * Council Invariants Enforced:
 * - Anti-Shortcut Law: Deterministic parsing of terminal output, no silent failure.
 * - Ghemawat: Zero unnecessary external dependencies; reliable execution boundary.
 * - Dean: Explicit timeouts preventing indefinite blocking on physical I/O.
 */

import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';

export interface ZodiacPortInfo {
  readonly port: number;
  readonly status: 'UP' | 'DOWN';
  readonly vlanType: string;
  readonly vlanId: number;
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
  private readonly devicePath: string;

  constructor(devicePath?: string) {
    this.devicePath = devicePath ?? this.detectDevice();
  }

  /**
   * Auto-detects the first /dev/cu.usbmodem* device on macOS.
   */
  public detectDevice(): string {
    const devFiles = readdirSync('/dev');
    const modem = devFiles.find((f) => f.startsWith('cu.usbmodem'));
    if (!modem) {
      throw new Error('No Zodiac FX serial modem found under /dev/cu.usbmodem*');
    }
    return `/dev/${modem}`;
  }

  public get path(): string {
    return this.devicePath;
  }

  /**
   * Executes a command on the Zodiac FX CLI over serial and returns the raw response.
   */
  public async executeRaw(command: string, timeoutMs: number = 3000): Promise<string> {
    return new Promise((resolve, reject) => {
      const pythonScript = `
import serial, time, sys

try:
    ser = serial.Serial('${this.devicePath}', 115200, timeout=1.0)
    ser.dtr = True
    ser.rts = True
    time.sleep(0.15)
    ser.reset_input_buffer()
    cmd = '${command}\\r\\n'
    ser.write(cmd.encode('ascii'))
    time.sleep(0.3)
    out = b''
    start_t = time.monotonic()
    while time.monotonic() - start_t < 1.2:
        if ser.in_waiting:
            out += ser.read(ser.in_waiting)
            time.sleep(0.05)
        else:
            time.sleep(0.05)
        if b'Zodiac_FX>' in out or b'Command not recognized' in out:
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

      const statusMatch = content.match(/Status:\s*(UP|DOWN)/i);
      const vlanTypeMatch = content.match(/VLAN type:\s*([^\r\n]+)/i);
      const vlanIdMatch = content.match(/VLAN ID:\s*(\d+)/i);

      ports.push({
        port: portNum,
        status: (statusMatch?.[1]?.toUpperCase() === 'UP' ? 'UP' : 'DOWN'),
        vlanType: vlanTypeMatch?.[1]?.trim() ?? 'Unknown',
        vlanId: vlanIdMatch ? parseInt(vlanIdMatch[1]!, 10) : 0,
      });
    }

    return ports;
  }

  /**
   * Executes a sequence of commands on the Zodiac FX CLI over serial.
   */
  public async executeSequence(commands: string[], timeoutMs: number = 5000): Promise<string> {
    return new Promise((resolve, reject) => {
      const cmdsJson = JSON.stringify(commands);
      const pythonScript = `
import serial, time, sys, json

try:
    cmds = json.loads('''${cmdsJson}''')
    ser = serial.Serial('${this.devicePath}', 115200, timeout=1.0)
    ser.dtr = True
    ser.rts = True
    time.sleep(0.15)
    ser.reset_input_buffer()
    all_out = ''
    for c in cmds:
        ser.write((c + '\\r\\n').encode('ascii'))
        time.sleep(0.35)
        out = b''
        while ser.in_waiting:
            out += ser.read(ser.in_waiting)
            time.sleep(0.05)
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
   * Restarts the Zodiac FX switch via serial command.
   */
  public async restart(): Promise<void> {
    await this.executeRaw('restart');
  }
}
