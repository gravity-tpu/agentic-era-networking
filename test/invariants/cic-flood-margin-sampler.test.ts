/**
 * test/invariants/cic-flood-margin-sampler.test.ts
 * Guards the pure, pcap-independent parts of scripts/cic-flood-margin-sampler.py used by this round's
 * CIC-IDS2017-augmented margin training (docs/benchmarks/results/sentinel-training-margin-cic/PREREGISTRATION.md):
 * the per-class cap/early-stop logic and the benign generalization-check cutoff-epoch gate. Uses small synthetic
 * frame fixtures (the same (t_us, wire_len, proto, flags, sp, dp, src_ip, dst_ip, t_epoch) tuple shape
 * scripts/cic-ids2017-adapter.py's iter_pcapng_frames yields), the same pattern
 * test/invariants/cic-ids2017-adapter.test.ts already uses for stream_windows - no scapy/pcapng file needed.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const SAMPLER_SCRIPT = resolve(ROOT, 'scripts/cic-flood-margin-sampler.py');
const hasNumpy = spawnSync('python3', ['-c', 'import numpy']).status === 0;

function runPython(driver: string, args: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('python3', ['-c', driver, ...args], { encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function lastJson(stdout: string): unknown {
  const line = stdout.trim().split('\n').pop() ?? 'null';
  return JSON.parse(line);
}

describe.skipIf(!hasNumpy)('cic-flood-margin-sampler: Bucket', () => {
  const DRIVER = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('s', sys.argv[1]); s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)
b = s.Bucket('X', cap=2)
out = {'full_before': b.full()}
b.add([1.0] * 256, 100.0, '1.2.3.4')
out['full_after_one'] = b.full()
b.add([2.0] * 256, 101.0, '1.2.3.4')
out['full_after_two'] = b.full()
b.add([3.0] * 256, 102.0, '1.2.3.4')  # over cap: must be a no-op, not an error or a silent grow past cap
out['len_after_overfill_attempt'] = len(b.features)
out['src_ips'] = b.src_ips
print(json.dumps(out))
`;

  it('stops accepting windows once the cap is reached, silently (no error) and without growing past it', () => {
    const r = runPython(DRIVER, [SAMPLER_SCRIPT]);
    expect(r.status, r.stderr).toBe(0);
    const out = lastJson(r.stdout) as any;
    expect(out.full_before).toBe(false);
    expect(out.full_after_one).toBe(false);
    expect(out.full_after_two).toBe(true);
    expect(out.len_after_overfill_attempt).toBe(2);
    expect(out.src_ips).toEqual(['1.2.3.4', '1.2.3.4']);
  });

  it('records an empty-string source IP rather than null/None when a window has no known source', () => {
    const DRIVER2 = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('s', sys.argv[1]); s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)
b = s.Bucket('X', cap=1)
b.add([0.0] * 256, 1.0, None)
print(json.dumps({'src_ips': b.src_ips}))
`;
    const r = runPython(DRIVER2, [SAMPLER_SCRIPT]);
    expect(r.status, r.stderr).toBe(0);
    expect((lastJson(r.stdout) as any).src_ips).toEqual(['']);
  });
});

describe.skipIf(!hasNumpy)('cic-flood-margin-sampler: bucket_frames (synthetic frames, no scapy/pcap needed)', () => {
  const DRIVER = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('s', sys.argv[1]); s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)
lbl = s.lbl

def frame(t, src_ip, dst_ip, sp=4444, dp=80, proto=6, flen=60, flags=0x02):
    return (t * 1_000_000.0, flen, proto, flags, sp, dp, src_ip, dst_ip, t)

flows = [
    lbl.FlowLabel(src_ip='172.16.0.1', dst_ip='192.168.10.50', sport=4444, dport=80, protocol=6,
                  start_epoch=0.0, end_epoch=200.0, label='DoS Hulk', source_file='x', row=0),
    lbl.FlowLabel(src_ip='10.0.0.5', dst_ip='10.0.0.6', sport=1111, dport=2222, protocol=6,
                  start_epoch=0.0, end_epoch=1000.0, label='BENIGN', source_file='x', row=1),
]
idx = lbl.FlowIndex(flows, slack_s=1.0)

# 200 attack frames spanning 0..99.5s, then 200 benign frames spanning 300..399.5s.
attack_frames = [frame(i * 0.5, '172.16.0.1', '192.168.10.50') for i in range(200)]
benign_frames = [frame(300 + i * 0.5, '10.0.0.5', '10.0.0.6', sp=1111, dp=2222) for i in range(200)]
all_frames = attack_frames + benign_frames

hulk_bucket = s.Bucket('DoS Hulk', cap=50)
benign_bucket = s.Bucket('BENIGN', cap=30)
stats = s.bucket_frames(iter(all_frames), idx, {'DoS Hulk': hulk_bucket}, benign_bucket=benign_bucket,
                         benign_cutoff_epoch=250.0, progress_every=0)
print(json.dumps({
    'packets_processed': stats['packets_processed'],
    'stopped_early': stats['stopped_early'],
    'hulk_collected': len(hulk_bucket.features),
    'hulk_feature_len': len(hulk_bucket.features[0]) if hulk_bucket.features else None,
    'hulk_src_ips_all_attacker': all(ip == '172.16.0.1' for ip in hulk_bucket.src_ips),
    'benign_collected': len(benign_bucket.features),
    'windows_by_label': stats['windows_by_label'],
}))
`;

  it('fills the attack bucket to its cap, excludes benign windows that start after the cutoff epoch, and stops early once every bucket is settled', () => {
    const r = runPython(DRIVER, [SAMPLER_SCRIPT]);
    expect(r.status, r.stderr).toBe(0);
    const out = lastJson(r.stdout) as any;
    expect(out.hulk_collected).toBe(50); // capped well below the 200 available attack windows
    expect(out.hulk_feature_len).toBe(256); // one row per window: 64 packets x 4 features, flattened
    expect(out.hulk_src_ips_all_attacker).toBe(true);
    // The benign flow is active the whole time, but all benign frames arrive at t=300+, after the 250s cutoff:
    // none should ever be collected, even though 200 benign-majority windows exist in the stream.
    expect(out.benign_collected).toBe(0);
    expect(out.windows_by_label['DoS Hulk']).toBeGreaterThan(0);
    // Processing should stop once the hulk bucket is full AND the benign window has closed (first frame >= 250s),
    // well before all 400 input frames are consumed.
    expect(out.packets_processed).toBeLessThan(400);
    expect(out.stopped_early).toBe(true);
  });

  it('collects benign windows that end before the cutoff epoch, and stops once that bucket is full', () => {
    const DRIVER2 = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('s', sys.argv[1]); s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)
lbl = s.lbl
flows = [lbl.FlowLabel(src_ip='10.0.0.5', dst_ip='10.0.0.6', sport=1111, dport=2222, protocol=6,
                        start_epoch=0.0, end_epoch=1000.0, label='BENIGN', source_file='x', row=1)]
idx = lbl.FlowIndex(flows, slack_s=1.0)
def frame(t, src_ip, dst_ip, sp=1111, dp=2222, proto=6, flen=60, flags=0x10):
    return (t * 1_000_000.0, flen, proto, flags, sp, dp, src_ip, dst_ip, t)
frames = [frame(i * 0.5, '10.0.0.5', '10.0.0.6') for i in range(300)]  # spans 0..149.5s
b = s.Bucket('BENIGN', cap=20)
stats = s.bucket_frames(iter(frames), idx, {}, benign_bucket=b, benign_cutoff_epoch=1000.0, progress_every=0)
print(json.dumps({'collected': len(b.features), 'stopped_early': stats['stopped_early'],
                   'packets_processed': stats['packets_processed']}))
`;
    const r = spawnSync('python3', ['-c', DRIVER2, SAMPLER_SCRIPT], { encoding: 'utf-8' });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}');
    expect(out.collected).toBe(20);
    expect(out.stopped_early).toBe(true);
    expect(out.packets_processed).toBeLessThan(300);
  });

  it('raises if a benign bucket is given without a cutoff epoch, rather than silently collecting unbounded benign windows', () => {
    const DRIVER3 = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location('s', sys.argv[1]); s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)
try:
    s.bucket_frames(iter([]), None, {}, benign_bucket=s.Bucket('BENIGN', cap=1), benign_cutoff_epoch=None)
    print('no_error')
except ValueError:
    print('value_error')
`;
    const r = spawnSync('python3', ['-c', DRIVER3, SAMPLER_SCRIPT], { encoding: 'utf-8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('value_error');
  });
});
