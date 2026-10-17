/**
 * trt-quarantine-mode.test.ts
 * Invariant 4: a rate anomaly seen by the GPU detector must not install a DROP on the physical switch without a
 * person. The daemon defaults to proposing; only an explicit QUARANTINE_MODE=enforce installs.
 *
 * Runs the real daemon module under python3 with urllib stubbed, so no network or hardware is touched. The daemon
 * imports only the standard library at module level (TensorRT and pycuda load inside main()).
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DAEMON = resolve(__dirname, '../../scripts/trt-inference-daemon.py');
const hasPython = spawnSync('python3', ['--version']).status === 0;

const DRIVER = `
import importlib.util, json, sys, urllib.request
posts = []
class FakeResp:
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def read(self): return b'{"ruleId":"r1","openFlowInstalled":true}'
urllib.request.urlopen = lambda req, timeout=None: (posts.append(req.full_url), FakeResp())[1]
spec = importlib.util.spec_from_file_location('trt_daemon', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
installed = m._handle_quarantine('10.0.2.52', 12)
print(json.dumps({'mode': m.QUARANTINE_MODE, 'installed': installed, 'posts': posts, 'proposals': m._quarantine_proposals}))
`;

function run(mode: string | undefined): { mode: string; installed: boolean; posts: string[]; proposals: Array<Record<string, unknown>> } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['QUARANTINE_MODE'];
  if (mode !== undefined) env['QUARANTINE_MODE'] = mode;
  const r = spawnSync('python3', ['-c', DRIVER, DAEMON], { env, encoding: 'utf-8' });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}');
}

describe.skipIf(!hasPython || !existsSync(DAEMON))('trt daemon quarantine mode', () => {
  it('proposes and installs nothing by default', () => {
    const out = run(undefined);
    expect(out.mode).toBe('propose');
    expect(out.installed).toBe(false);
    expect(out.posts).toEqual([]);
    expect(out.proposals).toHaveLength(1);
    expect(out.proposals[0]).toMatchObject({ srcIp: '10.0.2.52', pps: 12, status: 'proposed_not_installed' });
  });

  it('treats any value other than the exact word enforce as propose', () => {
    for (const v of ['', 'ENFORCE', 'true', '1', 'enforce ', 'on']) {
      const out = run(v);
      expect(out.mode, `value ${JSON.stringify(v)}`).toBe('propose');
      expect(out.posts, `value ${JSON.stringify(v)}`).toEqual([]);
    }
  });

  it('installs a DROP only when QUARANTINE_MODE=enforce', () => {
    const out = run('enforce');
    expect(out.mode).toBe('enforce');
    expect(out.installed).toBe(true);
    expect(out.posts).toEqual(['http://localhost:3003/api/sdn/quarantine']);
    expect(out.proposals).toEqual([]);
  });
});
