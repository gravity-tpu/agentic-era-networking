/**
 * api/command.ts
 * Vercel Serverless Function — Zodiac FX Web Command Dispatcher
 *
 * Council Invariants Enforced:
 * - Dean & Ghemawat: Bounded memory allocation (strict 64KB max request body limit).
 * - Ghemawat: Strict data contracts & type guards; banish implicit any.
 * - Hassabis & Ghemawat: Fail-Closed Default Drop on unrecognized methods.
 * - Anti-Shortcut Law: Guaranteed serverless promise lifecycle; stream error listeners and deterministic teardown.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireOperatorAuth } from '../src/auth/google-auth.js';

const MAX_PAYLOAD_BYTES = 64 * 1024; // 64 KB

export interface CommandPayload {
  readonly command: string;
}

function isValidCommandPayload(val: unknown): val is CommandPayload {
  return (
    typeof val === 'object' &&
    val !== null &&
    !Array.isArray(val) &&
    typeof (val as Record<string, unknown>)['command'] === 'string'
  );
}

const SIMULATION_BANNER = `[SIMULATION / CLOUD TWIN SANDBOX - PHYSICAL SWITCH NOT CONNECTED]\nNotice: Device is not physically attached to cloud serverless runtime. Returning simulated preview data.\n\n`;

const mockSwitchIp = process.env['ZODIAC_SWITCH_IP'] ?? '192.0.2.99';
const mockNetmask = process.env['ZODIAC_NETMASK'] ?? '255.255.255.0';
const mockGateway = process.env['SDN_GATEWAY_IP'] ?? '192.0.2.1';
const mockControllerIp = process.env['SDN_CONTROLLER_IP'] ?? '192.0.2.8';
const mockOfPort = process.env['ZODIAC_OPENFLOW_PORT'] ?? '6633';

const MOCK_COMMAND_RESPONSES: Record<string, string> = {
  'show status': `Device Status\nName:             Zodiac_FX\nFirmware Version: 0.86\nCPU Temperature:  31 C\nCPU UID:          1396191488-826951736-875574576-892547120\nUptime:           01:25:40`,
  'status': `Device Status\nName:             Zodiac_FX\nFirmware Version: 0.86\nCPU Temperature:  31 C\nCPU UID:          1396191488-826951736-875574576-892547120\nUptime:           01:25:40`,
  'show ports': `Port 1:\n  Status: DOWN\n  VLAN: 100 (OpenFlow)\n  RX: 42104 Bytes (336 Pkts), TX: 0 Bytes (0 Pkts)\nPort 2:\n  Status: DOWN\n  VLAN: 100 (OpenFlow)\n  RX: 0 Bytes (0 Pkts), TX: 0 Bytes (0 Pkts)\nPort 3:\n  Status: DOWN\n  VLAN: 100 (OpenFlow)\n  RX: 0 Bytes (0 Pkts), TX: 0 Bytes (0 Pkts)\nPort 4:\n  Status: UP\n  VLAN: 200 (Native)\n  RX: 259843 Bytes (1982 Pkts), TX: 169427 Bytes (1540 Pkts)`,
  'ports': `Port 1:\n  Status: DOWN\n  VLAN: 100 (OpenFlow)\n  RX: 42104 Bytes (336 Pkts), TX: 0 Bytes (0 Pkts)\nPort 2:\n  Status: DOWN\n  VLAN: 100 (OpenFlow)\n  RX: 0 Bytes (0 Pkts), TX: 0 Bytes (0 Pkts)\nPort 3:\n  Status: DOWN\n  VLAN: 100 (OpenFlow)\n  RX: 0 Bytes (0 Pkts), TX: 0 Bytes (0 Pkts)\nPort 4:\n  Status: UP\n  VLAN: 200 (Native)\n  RX: 259843 Bytes (1982 Pkts), TX: 169427 Bytes (1540 Pkts)`,
  'show config': `IP Address: ${mockSwitchIp}\nNetmask:    ${mockNetmask}\nGateway:    ${mockGateway}\nController: ${mockControllerIp}:${mockOfPort}\nFailstate:  Secure`,
  'config': `IP Address: ${mockSwitchIp}\nNetmask:    ${mockNetmask}\nGateway:    ${mockGateway}\nController: ${mockControllerIp}:${mockOfPort}\nFailstate:  Secure`,
  'show of': `OpenFlow: Enabled\nVersion: 1.3\nDatapath ID: 0x70b3d58740bc\nActive Tables: 10\nActive Flows: 0`,
  'openflow': `OpenFlow: Enabled\nVersion: 1.3\nDatapath ID: 0x70b3d58740bc\nActive Tables: 10\nActive Flows: 0`,
};

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Telemetry-Provenance', 'cloud_twin_sandbox');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.statusCode = 405;
    res.end(JSON.stringify({
      error: `Method Not Allowed: ${req.method ?? 'UNKNOWN'}. Invariant: Fail-Closed Default Drop.`,
    }));
    return;
  }

  // Council Invariant 3: Operator Authentication Guard (Socket Provenance, Anti-Spoofing)
  const user = requireOperatorAuth(req, res);
  if (!user) {
    return; // 401 response already handled by requireOperatorAuth
  }

  // Await the asynchronous stream processing to prevent premature serverless context freeze
  return new Promise<void>((resolve) => {
    const chunks: Buffer[] = [];
    let bytesReceived = 0;
    let aborted = false;

    req.on('error', (err: Error) => {
      aborted = true;
      req.destroy();
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: `Request stream failure: ${err.message}` }));
      }
      resolve();
    });

    req.on('data', (chunk: Buffer) => {
      if (aborted || res.headersSent) return;
      bytesReceived += chunk.length;
      if (bytesReceived > MAX_PAYLOAD_BYTES) {
        aborted = true;
        req.destroy();
        res.statusCode = 413;
        res.end(JSON.stringify({ error: 'Payload Too Large: Maximum command size is 64KB' }));
        resolve();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted || res.headersSent) {
        resolve();
        return;
      }
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        const parsed: unknown = JSON.parse(body);

        if (!isValidCommandPayload(parsed)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Invalid payload: must be a JSON object with a "command" string' }));
          resolve();
          return;
        }

        const cmd = parsed.command.trim().toLowerCase();
        const rawOutput =
          MOCK_COMMAND_RESPONSES[cmd] ??
          `Command '${parsed.command}' dispatched in cloud preview mode. For live serial CDC interaction, run 'npm run zodiac -- serve' locally.`;
        const output = `${SIMULATION_BANNER}${rawOutput}`;

        res.statusCode = 200;
        res.end(JSON.stringify({ output }));
      } catch (err: unknown) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Invalid JSON' }));
      } finally {
        resolve();
      }
    });
  });
}
