/**
 * zodiac-serial-console.test.ts
 * The switch's serial-console tool only restarts the switch when explicitly asked, and always reads its state first.
 * Uses --dry-run and the module's own plan(); it opens no serial port.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../../scripts/zodiac-serial-console.py');
const hasPython = spawnSync('python3', ['--version']).status === 0;
const dry = (...args: string[]) => spawnSync('python3', [SCRIPT, '--dry-run', ...args], { encoding: 'utf-8' });

describe.skipIf(!hasPython)('zodiac-serial-console.py', () => {
  it('by default sends diagnostics only, and never a restart', () => {
    const r = dry();
    expect(r.status, r.stderr).toBe(0);
    const cmds = r.stdout.trim().split('\n');
    expect(cmds).toContain('show status');
    expect(cmds).toContain('show config');
    expect(cmds).not.toContain('restart');
  });

  it('with --restart sends the same diagnostics first, then restart as the very last command', () => {
    const base = dry().stdout.trim().split('\n');
    const withRestart = dry('--restart').stdout.trim().split('\n');
    expect(withRestart.slice(0, base.length)).toEqual(base);
    expect(withRestart.slice(base.length)).toEqual(['restart']);
  });

  it('the word restart is sent from one place only, so no other path can reboot the switch', () => {
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src.match(/RESTART\s*=\s*"restart"/g)).toHaveLength(1);
    expect(src.match(/"restart"/g)).toHaveLength(1); // only the constant; every other use goes through RESTART
  });

  it('a dry run opens no serial device (it works where the device does not exist)', () => {
    const r = dry('--restart', '--dev', '/dev/does-not-exist');
    expect(r.status, r.stderr).toBe(0);
  });
});
