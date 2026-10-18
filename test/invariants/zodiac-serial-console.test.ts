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

  it('finds the processes holding the device from /proc, ignoring itself and others', () => {
    const r = spawnSync('python3', ['-c', `
import importlib.util, json, os, sys, tempfile
spec = importlib.util.spec_from_file_location('zsc', sys.argv[1]); zsc = importlib.util.module_from_spec(spec); spec.loader.exec_module(zsc)
root = tempfile.mkdtemp()
dev = os.path.join(root, 'ttyACM0'); open(dev, 'w').close()
other = os.path.join(root, 'other'); open(other, 'w').close()
def proc(pid, target):
    d = os.path.join(root, 'proc', str(pid), 'fd'); os.makedirs(d); os.symlink(target, os.path.join(d, '3'))
os.makedirs(os.path.join(root, 'proc'))
proc(111, dev); proc(222, other); proc(333, dev); proc(os.getpid(), dev)
os.makedirs(os.path.join(root, 'proc', 'self')); os.makedirs(os.path.join(root, 'proc', 'notapid'))
print(json.dumps([zsc.find_openers(dev, os.path.join(root, 'proc')), zsc.find_openers(os.path.join(root, 'missing'), os.path.join(root, 'proc')), zsc.find_openers(dev, os.path.join(root, 'no-such-proc'))]))
`, SCRIPT], { encoding: 'utf-8' });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout.trim().split('\n').pop() ?? '[]')).toEqual([[111, 333], [], []]);
  });

  it('refuses to restart while another process holds the port, and says why (exit 3)', () => {
    const r = spawnSync('python3', ['-c', `
import importlib.util, os, subprocess, sys, tempfile
spec = importlib.util.spec_from_file_location('zsc', sys.argv[1]); zsc = importlib.util.module_from_spec(spec); spec.loader.exec_module(zsc)
dev = os.path.join(tempfile.mkdtemp(), 'ttyACM0'); open(dev, 'w').close()
holder = open(dev)  # this very process holds it, so another process (a child) sees one holder
child = subprocess.run([sys.executable, '-c', 'import importlib.util,sys;s=importlib.util.spec_from_file_location("z",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.OPENER_WAIT_SECONDS=1;sys.argv=["z","--restart","--dev",sys.argv[2]];sys.exit(m.main())', sys.argv[1], dev], capture_output=True, text=True)
print(child.returncode); print(child.stderr.strip()[:140])
`, SCRIPT], { encoding: 'utf-8' });
    expect(r.status, r.stderr).toBe(0);
    const [code, msg] = r.stdout.trim().split('\n');
    expect(code).toBe(process.platform === 'linux' ? '3' : code); // /proc exists on Linux only; elsewhere the check cannot see holders
    if (process.platform === 'linux') expect(msg).toMatch(/refusing to restart: process\(es\) \[\d+\] still have/);
  });

  it('looks for other openers once more just before the restart goes out, and declines if any appeared', () => {
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src).toMatch(/if cmd == RESTART:\n\s+# One more look[\s\S]*?holders = find_openers\(dev\)\n\s+if holders:\n\s+raise SystemExit\(f"not restarting/);
  });

  it('opens the port exclusively, so another opener cannot interleave with a session', () => {
    expect(readFileSync(SCRIPT, 'utf-8')).toContain('dsrdtr=False, exclusive=True)');
  });

  it('every command read is capped in total time, not only by a quiet gap', () => {
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src).toContain('time.monotonic() - started < MAX_SECONDS_PER_COMMAND');
  });
});
