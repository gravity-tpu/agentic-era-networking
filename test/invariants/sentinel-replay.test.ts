/**
 * sentinel-replay.test.ts
 * Guards the offline replica of the GPU sentinel's arithmetic (scripts/sentinel-replay.py):
 *  - its weights stay equal to the ones in the CUDA source, so the replica cannot silently drift from the kernel;
 *  - a few deterministic synthetic patterns keep the losses the findings document quotes.
 * The replica was also compared with the real native library on the Jetson (300 windows, largest difference 3e-8);
 * that comparison needs the GPU and is not repeated here.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../../scripts/sentinel-replay.py');
const KERNEL = resolve(__dirname, '../../src/gpu/gpu_anomaly_kernel.cu');
const hasNumpy = spawnSync('python3', ['-c', 'import numpy']).status === 0;

const DRIVER = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('rep', sys.argv[1]); rep = importlib.util.module_from_spec(spec); spec.loader.exec_module(rep)
def loss_of(gen, dt):
    ls = rep.losses(rep.synth(300, gen, dt))
    return sum(ls) / len(ls)
out = {
  'weights': [float(x) for x in rep.W],
  'icmp': loss_of(lambda r, i: (98, 1, 0, 0, 0), 200000),
  'tcpBulkAck': loss_of(lambda r, i: (1500, 6, 0x10, 443, 50000), 100),
  'synFloodFixedPorts': loss_of(lambda r, i: (60, 6, 0x02, 40000, 80), 100),
  'arpFlood': loss_of(lambda r, i: (42, 0, 0, 0, 0), 1000),
  'baseTau': rep.BASE_TAU,
}
print(json.dumps(out))
`;

interface Out {
  weights: number[];
  icmp: number;
  tcpBulkAck: number;
  synFloodFixedPorts: number;
  arpFlood: number;
  baseTau: number;
}

function run(): Out {
  const r = spawnSync('python3', ['-c', DRIVER, SCRIPT], { encoding: 'utf-8' });
  expect(r.status, r.stderr).toBe(0);
  const parsed: Out = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}');
  return parsed;
}

describe.skipIf(!hasNumpy)('sentinel replay replica', () => {
  it('uses exactly the weights compiled into the CUDA kernel', () => {
    const src = readFileSync(KERNEL, 'utf-8');
    const block = /default_weights\[NUM_WEIGHT_PARAMS\]\s*=\s*\{([\s\S]*?)\};/.exec(src);
    expect(block, 'default_weights block not found in the kernel source').not.toBeNull();
    const nums = [...(block?.[1] ?? '').matchAll(/(-?\d+\.\d+)f/g)].map((m) => Number(m[1]));
    // The kernel reads w[0]..w[9]; the remaining six are unused padding (zeros).
    expect(nums.slice(0, 4)).toEqual([0.2, 0.3, 0.25, 0.25]); // four encoder weights, in this order
    const used = [nums[0], nums[1], nums[2], nums[3], nums[4], nums[5], nums[6], nums[7], nums[8], nums[9]];
    const out = run();
    out.weights.forEach((w, i) => expect(w).toBeCloseTo(used[i] ?? Number.NaN, 6));
  });

  it('keeps the quoted losses: ping and ARP above the threshold, bulk TCP and a fixed-port SYN flood below it', () => {
    const o = run();
    expect(o.baseTau).toBe(0.15);
    expect(o.icmp).toBeCloseTo(0.236, 2);
    expect(o.arpFlood).toBeCloseTo(0.241, 2);
    expect(o.tcpBulkAck).toBeCloseTo(0.08, 2);
    expect(o.synFloodFixedPorts).toBeCloseTo(0.139, 2);
    expect(o.icmp).toBeGreaterThan(o.baseTau);
    expect(o.arpFlood).toBeGreaterThan(o.baseTau);
    expect(o.tcpBulkAck).toBeLessThan(o.baseTau);
    // The finding itself: a SYN flood scores LOWER than a benign ping.
    expect(o.synFloodFixedPorts).toBeLessThan(o.icmp);
  });
});
