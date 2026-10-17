/**
 * trt-quarantine-mode.test.ts
 * The trt daemon no longer decides whether a rate anomaly becomes a DROP: it asks the bridge, with the numbers behind
 * the request, and the bridge is the single place that applies propose or enforce (see quarantine-request.test.ts).
 * These tests run the real daemon module under python3 with urllib stubbed, so no network or hardware is touched.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DAEMON = resolve(__dirname, '../../scripts/trt-inference-daemon.py');
const hasPython = spawnSync('python3', ['--version']).status === 0;

const DRIVER = `
import importlib.util, json, sys, struct, socket, urllib.request
reply = json.loads(sys.argv[2])
posts = []
class FakeResp:
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def read(self): return json.dumps(reply).encode()
def fake_urlopen(req, timeout=None):
    posts.append({'url': req.full_url, 'body': json.loads(req.data)})
    if reply.get('_raise'):
        raise OSError('refused')
    return FakeResp()
urllib.request.urlopen = fake_urlopen
spec = importlib.util.spec_from_file_location('trt_daemon', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
ts = struct.pack('ll', 1700000000, 123456789)
parsed = m.parse_kernel_timestamp_ns([(socket.SOL_SOCKET, m.SO_TIMESTAMPNS, ts)])
none_other = m.parse_kernel_timestamp_ns([(socket.SOL_SOCKET, 1, ts), (0, m.SO_TIMESTAMPNS, ts), (socket.SOL_SOCKET, m.SO_TIMESTAMPNS, b'short')])
none_empty = m.parse_kernel_timestamp_ns([])
installed = m._handle_quarantine('10.0.2.52', 12, 6, 500000000, {'read': [100, 130, 130, 900000100], 'kernel': [1000, 201000, 401000], 'lag': [5, 3, 1]})
live = None
if sys.platform.startswith('linux'):
    rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); rx.bind(('127.0.0.1', 0)); rx.settimeout(2)
    rx.setsockopt(socket.SOL_SOCKET, m.SO_TIMESTAMPNS, 1)
    tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    import time
    before = time.time_ns(); tx.sendto(b'x', rx.getsockname())
    _d, anc, _f, _a = rx.recvmsg(64, 64); after = time.time_ns()
    k = m.parse_kernel_timestamp_ns(anc)
    live = None if k is None else {'withinReadWindow': before - 1_000_000_000 <= k <= after + 1_000_000_000}
print(json.dumps({'kernelLive': live, 'kernelTs': str(parsed), 'noneOther': none_other, 'noneEmpty': none_empty,
                  'gaps': m.interarrival_gaps_ns([5, 5, 20, 120]), 'empty': m.interarrival_gaps_ns([]), 'one': m.interarrival_gaps_ns([7]),
                  'installed': installed, 'posts': posts, 'hasMode': hasattr(m, 'QUARANTINE_MODE')}))
`;

interface Post {
  url: string;
  body: {
    targetIp: string;
    priority: number;
    reason: string;
    evidence: {
      pps: number;
      thresholdPps: number;
      windowFrames: number;
      windowElapsedNs: number;
      interArrivalNs: number[];
      kernelInterArrivalNs: number[];
      readLagNs: number[];
    };
  };
}

interface DriverOutput {
  kernelLive: { withinReadWindow: boolean } | null;
  kernelTs: string;
  noneOther: number | null;
  noneEmpty: number | null;
  gaps: number[];
  empty: number[];
  one: number[];
  installed: boolean;
  posts: Post[];
  hasMode: boolean;
}

function run(reply: Record<string, unknown>, env: Record<string, string> = {}): DriverOutput {
  const r = spawnSync('python3', ['-c', DRIVER, DAEMON, JSON.stringify(reply)], { env: { ...process.env, ...env }, encoding: 'utf-8' });
  expect(r.status, r.stderr).toBe(0);
  const parsed: DriverOutput = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}');
  return parsed;
}

describe.skipIf(!hasPython || !existsSync(DAEMON))('trt daemon quarantine requests', () => {
  it('always asks the bridge, with the evidence, and has no mode of its own', () => {
    const out = run({ ok: true, proposed: true, quarantined: false });
    expect(out.hasMode).toBe(false);
    expect(out.posts).toHaveLength(1);
    const post = out.posts[0];
    if (post === undefined) throw new Error('no request sent');
    expect(post.url).toBe('http://localhost:3003/api/sdn/quarantine');
    expect(post.body).toMatchObject({ targetIp: '10.0.2.52', priority: 65535 });
    expect(post.body.evidence).toMatchObject({ pps: 12, thresholdPps: 10, windowFrames: 6, windowElapsedNs: 500000000 });
    // The inputs re-derive the rate exactly (6 frames in 0.5 s = 12 pps), with integer floor division as in the daemon.
    expect((BigInt(post.body.evidence.windowFrames) * 1_000_000_000n) / BigInt(post.body.evidence.windowElapsedNs)).toBe(BigInt(post.body.evidence.pps));
    expect(post.body.evidence.interArrivalNs).toEqual([30, 0, 899999970]);
    expect(post.body.evidence.kernelInterArrivalNs).toEqual([200000, 200000]);
    expect(post.body.evidence.readLagNs).toEqual([5, 3, 1]);
  });

  it('a proposal from the bridge is not an install', () => {
    expect(run({ ok: true, proposed: true, quarantined: false }).installed).toBe(false);
  });

  it('reports an install only when the bridge says it installed one', () => {
    expect(run({ ok: true, quarantined: true, ruleId: 'r1', openFlowInstalled: true }).installed).toBe(true);
  });

  it('a refusal, an unexpected reply and an unreachable bridge are all not installs', () => {
    expect(run({ ok: false, quarantined: false, code: 'protected' }).installed).toBe(false);
    expect(run({ unexpected: true }).installed).toBe(false);
    expect(run({ _raise: true }).installed).toBe(false);
  });

  it('ignores the old per-daemon mode variable: it cannot make the daemon skip or force a request', () => {
    for (const v of ['propose', 'enforce', 'garbage']) {
      expect(run({ ok: true, proposed: true }, { QUARANTINE_MODE: v }).posts, v).toHaveLength(1);
    }
  });

  it('computes inter-arrival gaps from read-time stamps (empty and single-frame inputs give none)', () => {
    const out = run({ ok: true, proposed: true });
    expect(out.gaps).toEqual([0, 15, 100]);
    expect(out.empty).toEqual([]);
    expect(out.one).toEqual([]);
  });

  it('reads the kernel receive timestamp only from a well-formed SCM_TIMESTAMPNS message', () => {
    const out = run({ ok: true, proposed: true });
    expect(out.kernelTs).toBe('1700000000123456789'); // as a string: this value exceeds 2^53
    expect(out.noneOther).toBeNull();
    expect(out.noneEmpty).toBeNull();
  });

  it.skipIf(process.platform !== 'linux')('parses the timestamp the Linux kernel actually attaches', () => {
    expect(run({ ok: true, proposed: true }).kernelLive).toEqual({ withinReadWindow: true });
  });
});
