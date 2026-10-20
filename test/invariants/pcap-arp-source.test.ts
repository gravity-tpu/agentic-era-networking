/**
 * pcap-arp-source.test.ts
 * An ARP request has no IPv4 header, so a capture parser keyed on IPv4 sources attributed 0 frames to an ARP flooder.
 * With arp_src the parser takes the ARP sender protocol address as the frame's source. That address is as forgeable as an
 * IPv4 source. By default it does not, so the replicas of the deployed daemon (which ignores ARP) stay faithful. This test
 * pins both, and that a well-formed Ethernet/IPv4 ARP frame is attributed and a malformed one is not.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../../scripts/sentinel-replay.py');

// scripts/sentinel-replay.py imports numpy for its detector model; parse_pcap, which this test exercises, never calls it. CI has no numpy, so
// when it is missing the driver stands in a stub just good enough for the module-level import (np.array and np.float32). With numpy present
// (a developer machine) the real module is used and nothing is stubbed. If parse_pcap ever starts using numpy this test fails loudly, by design.
const DRIVER = `
import importlib.util, json, struct, sys, tempfile, os, types
try:
    import numpy
except ImportError:
    stub = types.ModuleType('numpy'); stub.array = lambda *a, **k: None; stub.float32 = float; sys.modules['numpy'] = stub
spec = importlib.util.spec_from_file_location('sr', sys.argv[1]); sr = importlib.util.module_from_spec(spec); spec.loader.exec_module(sr)
def arp(htype=1, ptype=0x0800, hlen=6, plen=4, spa=bytes([10,0,2,50]), trunc=0):
    eth = bytes.fromhex('ffffffffffff') + bytes.fromhex('b827eba2ecb0') + struct.pack('!H', 0x0806)
    body = struct.pack('!HHBBH', htype, ptype, hlen, plen, 1) + bytes.fromhex('b827eba2ecb0') + spa + bytes(6) + bytes([10,0,2,119])
    return (eth + body)[:len(eth + body) - trunc]
frames = [arp(), arp(htype=6), arp(plen=16), arp(trunc=10), arp(spa=bytes([0,0,0,0]))]
path = os.path.join(tempfile.mkdtemp(), 'a.pcap')
with open(path, 'wb') as f:
    f.write(struct.pack('<IHHiIII', 0xa1b23c4d, 2, 4, 0, 0, 65535, 1))
    for i, fr in enumerate(frames):
        f.write(struct.pack('<IIII', 1, i * 1000, len(fr), len(fr)) + fr)
print(json.dumps([[x[6] for x in sr.parse_pcap(path, with_src=True)], [x[6] for x in sr.parse_pcap(path, with_src=True, arp_src=True)]]))
`;

describe('capture parser: ARP frames', () => {
  it('attributes a well-formed Ethernet/IPv4 ARP request to its sender address, and nothing malformed', () => {
    const r = spawnSync('python3', ['-c', DRIVER, SCRIPT], { encoding: 'utf-8' });
    expect(r.status, r.stderr).toBe(0);
    // well-formed -> 10.0.2.50; wrong hardware type, wrong address length, truncated, and a 0.0.0.0 probe -> no source.
    const last = r.stdout.trim().split('\n').pop();
    expect(last, 'the driver printed nothing').toBeTruthy();
    const [plain, arp] = JSON.parse(last as string);
    expect(plain).toEqual([null, null, null, null, null]);
    expect(arp).toEqual(['10.0.2.50', null, null, null, null]);
  });
});
