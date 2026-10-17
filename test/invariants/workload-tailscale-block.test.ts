/**
 * workload-tailscale-block.test.ts
 * deploy/workload/block-tailscale-on-eth0.sh, exercised with --dry-run (it writes and loads nothing) and with inputs
 * that must be refused. The generated ruleset and unit were also validated on a real node with `nft -c` and
 * `systemd-analyze verify` (check-only); that is not repeated here because CI has no nft or systemd.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';

const SCRIPT = 'deploy/workload/block-tailscale-on-eth0.sh';
const run = (args: string[]) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('block-tailscale-on-eth0.sh --dry-run', () => {
  it('drops Tailscale UDP on the workload interface in both directions, and only there', () => {
    const r = run(['--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('iifname "eth0" udp dport 41641 counter drop');
    expect(r.stdout).toContain('oifname "eth0" udp sport 41641 counter drop');
    expect(r.stdout).toContain('table inet zodiac_tailscale_block');
    // Idempotent reload: the table is created, deleted and recreated in one file.
    expect(r.stdout.indexOf('add table')).toBeLessThan(r.stdout.indexOf('delete table'));
    // The only interface named in a rule is the one asked for.
    const ifaceRules = r.stdout.split('\n').filter((l) => /iifname|oifname/.test(l));
    expect(ifaceRules).toHaveLength(2);
    for (const l of ifaceRules) expect(l).toContain('"eth0"');
  });

  it('honours --iface and --port', () => {
    const r = run(['--dry-run', '--iface', 'enx9c69d39dd0a6', '--port', '50000']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('iifname "enx9c69d39dd0a6" udp dport 50000 counter drop');
    expect(r.stdout).toContain('oifname "enx9c69d39dd0a6" udp sport 50000 counter drop');
  });

  it('starts before tailscaled and loads the same file it wrote', () => {
    const r = run(['--dry-run']);
    expect(r.stdout).toMatch(/Before=tailscaled\.service/);
    expect(r.stdout).toContain('ExecStart=');
    expect(r.stdout).toContain('/etc/zodiac/tailscale-eth0-block.nft');
    expect(r.stdout).toContain('ExecStop=');
  });
});

describe('block-tailscale-on-eth0.sh refuses unsafe input', () => {
  it.each([
    ['empty interface', ['--iface', '']],
    ['interface with a space', ['--iface', 'eth 0']],
    ['rule injection through the interface', ['--iface', 'eth0" accept #']],
    ['interface longer than 15 characters', ['--iface', 'abcdefghijklmnop']],
    ['port zero', ['--port', '0']],
    ['port above 65535', ['--port', '65536']],
    ['non-numeric port', ['--port', '41641; reboot']],
    ['empty port', ['--port', '']],
    ['missing --iface value', ['--iface']],
    ['unknown option', ['--frobnicate']],
  ])('%s', (_name, args) => {
    const r = run(['--dry-run', ...args]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('table inet');
    expect(r.stderr).toMatch(/error:/);
  });

  it.skipIf(isRoot)('a real install without root changes nothing and says to use sudo', () => {
    const r = run([]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/run as root/);
  });
});
