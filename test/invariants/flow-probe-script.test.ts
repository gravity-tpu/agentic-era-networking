/**
 * flow-probe-script.test.ts
 * Runs scripts/zodiac-flow-probe.ts as a real subprocess against a fake bridge HTTP server. The script is not
 * covered by tsc, so this is the check that it works: what it saves, what it refuses, and the exit codes.
 *
 * IMPORTANT (Invariant 6): the bridge below is a fake serving fixture bytes (test/helpers/flow-stats-fixtures.ts),
 * not a capture. The script imports the compiled dist/, so these tests need `npm run build` first (CI runs it
 * before the test step).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildOfpFlowMod, FlowModCommand } from '../../src/sdn/openflow-types.js';
import { buildPort1IsolationPolicy } from '../../src/sdn/port1-isolation.js';
import { buildFlowProbeReport, type FlowProbeReport } from '../../src/sdn/flow-probe.js';
import { entryFrom, replyOf } from '../helpers/flow-stats-fixtures.js';

const execFileP = promisify(execFile);
const distBuilt = existsSync('dist/sdn/flow-probe.js');

const policy = buildPort1IsolationPolicy();
const flowMods = policy.map((r, i) => buildOfpFlowMod(r.flowMod, i + 1));
const tableMissMod = buildOfpFlowMod({ command: FlowModCommand.OFPFC_ADD, priority: 0 }, 99);
const make = (withInstructions: boolean): FlowProbeReport =>
  buildFlowProbeReport({
    policy,
    replies: [
      replyOf([
        entryFrom(tableMissMod),
        ...flowMods.map((fm) => (withInstructions ? entryFrom(fm) : entryFrom(fm, Buffer.alloc(0)))),
      ]),
    ],
    capturedAtIso: '2026-10-15T01:02:03.004Z',
    capturedMonotonicNs: 987_654_321n,
  });

interface Reply {
  status: number;
  body: string;
}
let current: Reply = { status: 200, body: '' };
let server: http.Server;
let port = 0;
let work = '';

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'flow-probe-script-'));
  server = http.createServer((req, res) => {
    if (req.url === '/api/zodiac/flows/probe' && req.method === 'GET') {
      res.statusCode = current.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(current.body);
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  port = typeof addr === 'object' && addr !== null ? addr.port : 0;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(work, { recursive: true, force: true });
});

async function run(args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await execFileP('node', ['--experimental-strip-types', 'scripts/zodiac-flow-probe.ts', ...args], { timeout: 30_000 });
    return { code: 0, out: stdout + stderr };
  } catch (e: unknown) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof err.code === 'number' ? err.code : -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

const freshOut = (name: string): string => join(work, name);
const filesIn = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : []);

describe('flow-probe script test prerequisites', () => {
  it('dist is built when running in CI (the build step must precede the tests)', () => {
    if (process.env['CI']) expect(distBuilt).toBe(true);
  });
});

describe.skipIf(!distBuilt)('zodiac-flow-probe.ts against a fake bridge', () => {
  const url = (): string => `http://127.0.0.1:${port}`;

  it('saves the report and a provenance sidecar, and prints the finding', async () => {
    const report = make(true);
    current = { status: 200, body: JSON.stringify(report) };
    const out = freshOut('ok');
    const r = await run(['--url', url(), '--out', out, '--firmware', '0.86']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('finding: reports-instructions');
    expect(r.out).toContain('proven forwarding intent: true');
    const files = filesIn(out);
    expect(files).toHaveLength(2);
    const reportFile = files.find((f) => !f.endsWith('.meta.json')) ?? '';
    const metaFile = files.find((f) => f.endsWith('.meta.json')) ?? '';
    const body = readFileSync(join(out, reportFile), 'utf8');
    const meta = JSON.parse(readFileSync(join(out, metaFile), 'utf8')) as Record<string, unknown>;
    expect(meta['origin']).toBe('physical_readback');
    expect(meta['reportSha256']).toBe(createHash('sha256').update(body).digest('hex'));
    expect(meta['rawRepliesSha256']).toBe(report.rawRepliesSha256);
    expect(meta['rederivedFromRawBytes']).toBe('summary matches');
    expect(meta['firmwareDeclaredByOperator']).toBe('0.86');
  });

  it('reports a switch that omits instructions without calling it a failure', async () => {
    current = { status: 200, body: JSON.stringify(make(false)) };
    const r = await run(['--url', url(), '--out', freshOut('omit')]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('finding: no-instructions-reported');
    expect(r.out).toContain('action level: unobservable');
    expect(r.out).toContain('proven forwarding intent: false');
  });

  it('exits 2 and saves nothing when the bridge refuses (no switch session, or rate limited)', async () => {
    for (const status of [503, 429]) {
      current = { status, body: JSON.stringify({ error: 'refused' }) };
      const out = freshOut(`refused-${status}`);
      const r = await run(['--url', url(), '--out', out]);
      expect(r.code, `status ${status}`).toBe(2);
      expect(filesIn(out)).toEqual([]);
    }
  });

  it('exits 3 when the bridge summary disagrees with its own raw bytes, and does not save it as evidence', async () => {
    const lying = { ...make(false), finding: 'reports-instructions' };
    current = { status: 200, body: JSON.stringify(lying) };
    const out = freshOut('lying');
    const r = await run(['--url', url(), '--out', out]);
    expect(r.code).toBe(3);
    expect(r.out).toContain('disagrees');
    const files = filesIn(out);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('DISAGREES');
    expect(files.some((f) => f.endsWith('.meta.json'))).toBe(false);
  });

  it('exits 1 for a response that is not a probe report, and for bad arguments', async () => {
    current = { status: 200, body: JSON.stringify({ hello: 'world' }) };
    const out = freshOut('junk');
    expect((await run(['--url', url(), '--out', out])).code).toBe(1);
    expect(filesIn(out)).toEqual([]);
    expect((await run(['--bogus', 'x'])).code).toBe(1);
    expect((await run(['--timeout-ms', '5'])).code).toBe(1);
  });

  it('--analyze re-derives a saved report offline and writes nothing', async () => {
    const file = join(work, 'saved-report.json');
    writeFileSync(file, JSON.stringify(make(true)));
    const out = freshOut('analyze');
    const r = await run(['--analyze', file, '--out', out]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('summary matches');
    expect(filesIn(out)).toEqual([]);
  });
});
