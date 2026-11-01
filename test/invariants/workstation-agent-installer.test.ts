/**
 * workstation-agent-installer.test.ts
 * The macOS LaunchAgent installer, exercised with --dry-run (it writes and loads nothing). macOS only: the installer
 * refuses to run elsewhere, so this is skipped on Linux CI.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = 'deploy/macos/install-workstation-agent.sh';
const isMac = process.platform === 'darwin';
// The real agent imports the compiled dist/, so running it needs `npm run build:server` first (CI builds before testing).
const distBuilt = existsSync('dist/sdn/hardware-probe.js');

/** A directory shaped like a built checkout, so the installer's preconditions pass. */
function fakeRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'ws-agent-repo-'));
  mkdirSync(join(d, 'scripts'), { recursive: true });
  mkdirSync(join(d, 'dist', 'sdn'), { recursive: true });
  writeFileSync(join(d, 'scripts', 'workstation-agent.ts'), '');
  writeFileSync(join(d, 'dist', 'sdn', 'hardware-probe.js'), '');
  return d;
}

const run = (args: string[]) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });

describe.skipIf(!isMac)('install-workstation-agent.sh --dry-run', () => {
  it('renders a valid plist that restarts the agent, starts it at login, and binds the requested address', () => {
    const repo = fakeRepo();
    const r = run(['--repo', repo, '--host', '100.64.1.2', '--port', '11435', '--dry-run']);
    expect(r.status).toBe(0);
    const out = r.stdout;
    expect(out).toContain('<key>RunAtLoad</key><true/>');
    expect(out).toContain('<key>KeepAlive</key><true/>');
    expect(out).toContain('<key>ProcessType</key><string>Interactive</string>');
    expect(out).toContain('<key>WORKSTATION_AGENT_HOST</key><string>100.64.1.2</string>');
    expect(out).toContain('<key>WORKSTATION_AGENT_PORT</key><string>11435</string>');
    expect(out).toContain(`<key>WorkingDirectory</key><string>${repo}</string>`);
    expect(out).toContain('--experimental-strip-types');
    // ioreg is in /usr/sbin, which launchd's default PATH omits: without it the Apple GPU metrics are silently missing
    expect(out).toMatch(/<key>PATH<\/key><string>[^<]*\/usr\/sbin/);
    // the rendered plist is valid
    const plist = out.slice(out.indexOf('<?xml'));
    const file = join(repo, 'rendered.plist');
    writeFileSync(file, plist);
    expect(() => execFileSync('plutil', ['-lint', file])).not.toThrow();
    rmSync(repo, { recursive: true, force: true });
  });

  it('writes nothing in --dry-run', () => {
    const repo = fakeRepo();
    const r = run(['--repo', repo, '--host', '100.64.1.2', '--dry-run']);
    expect(r.stdout).toContain('would write');
    rmSync(repo, { recursive: true, force: true });
  });

  it('refuses a repo that is not built, naming the fix', () => {
    const d = mkdtempSync(join(tmpdir(), 'ws-agent-unbuilt-'));
    mkdirSync(join(d, 'scripts'), { recursive: true });
    writeFileSync(join(d, 'scripts', 'workstation-agent.ts'), '');
    const r = run(['--repo', d, '--host', '100.64.1.2', '--dry-run']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('npm run build:server');
    rmSync(d, { recursive: true, force: true });
  });

  it('refuses a missing agent, a bad port, and a host with shell or XML metacharacters, for the stated reason', () => {
    const repo = fakeRepo();
    const missing = run(['--repo', '/nonexistent-dir-xyz', '--host', '1.2.3.4', '--dry-run']);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('no scripts/workstation-agent.ts');
    for (const port of ['0', '65536', 'abc', '80x', '-1']) {
      const r = run(['--repo', repo, '--host', '1.2.3.4', '--port', port, '--dry-run']);
      expect(r.status, `port ${port}`).not.toBe(0);
      expect(r.stderr, `port ${port}`).toMatch(/--port must be/);
    }
    for (const host of ['1.2.3.4;rm -rf /', '1.2.3.4</string>', '$(id)', 'a b']) {
      const r = run(['--repo', repo, '--host', host, '--dry-run']);
      expect(r.status, JSON.stringify(host)).not.toBe(0);
      expect(r.stderr, JSON.stringify(host)).toContain('--host must be an IPv4 address or hostname');
    }
    // an empty host (an unset variable collapsing to nothing) must not fall through to "every interface" or a bad plist
    const empty = run(['--repo', repo, '--host', '', '--dry-run']);
    expect(empty.status).not.toBe(0);
    expect(empty.stderr).toContain('--host needs an address');
    expect(empty.stdout).not.toContain('<plist');
    rmSync(repo, { recursive: true, force: true });
  });

  it('falls back to every interface, with a warning, only when no address can be found', () => {
    const repo = fakeRepo();
    // PATH without tailscale, so the address cannot be discovered
    const r = spawnSync('bash', [SCRIPT, '--repo', repo, '--dry-run'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin', HOME: process.env['HOME'] ?? '' },
    });
    if (r.status === 0 && r.stdout.includes('WORKSTATION_AGENT_HOST</key><string>0.0.0.0')) {
      expect(r.stderr).toContain('every interface');
    }
    rmSync(repo, { recursive: true, force: true });
  });
});

describe.skipIf(!isMac || !distBuilt)('the agent refuses an invalid bind address instead of widening it', () => {
  // Runs the real agent (macOS only, needs dist/): it must exit before listening, naming the setting.
  const runAgent = (host: string | undefined) =>
    spawnSync('node', ['--experimental-strip-types', 'scripts/workstation-agent.ts'], {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, WORKSTATION_AGENT_PORT: '0', ...(host !== undefined ? { WORKSTATION_AGENT_HOST: host } : {}) },
    });

  it('a charset-valid but bogus address is refused by listen() itself: non-zero exit, and it never listens', () => {
    for (const bogus of ['999.999.999.999', '1.2.3.4.5.6', '---']) {
      const r = runAgent(bogus);
      expect(r.status, bogus).toBe(1);
      expect(r.stderr, bogus).toContain('Server error');
      expect(r.stdout, bogus).not.toContain('Listening on');
    }
  });

  it('a set but invalid host is fatal, with a non-zero exit and the reason, and never reaches listen', () => {
    for (const bad of ['a b', '1.2.3.4;x', '', '$(id)', 'x'.repeat(300)]) {
      const r = runAgent(bad);
      expect(r.status, JSON.stringify(bad)).toBe(1);
      expect(r.stderr, JSON.stringify(bad)).toContain('WORKSTATION_AGENT_HOST');
      expect(r.stderr, JSON.stringify(bad)).toContain('Refusing to start');
      expect(r.stdout, JSON.stringify(bad)).not.toContain('Listening on');
    }
  });
});

describe('the agent binds the interface it is told to', () => {
  it('reads WORKSTATION_AGENT_HOST, validates it, and defaults to every interface', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('scripts/workstation-agent.ts', 'utf8');
    expect(src).toContain("process.env['WORKSTATION_AGENT_HOST']");
    expect(src).toContain("hostFromEnv ?? '0.0.0.0'"); // the default applies only when the variable is unset
    expect(src).not.toContain('listening on 0.0.0.0.'); // no quiet fall back for an invalid value
    expect(src).toMatch(/\^\[A-Za-z0-9\.-\]\{1,253\}\$/); // refuses anything that is not a plain address or hostname
    expect(src).toContain('server.listen(PORT, HOST,');
    expect(src).not.toContain("server.listen(PORT, '0.0.0.0'"); // no hard-coded bind left
    expect(src).toContain('listening on every interface (0.0.0.0)'); // the open default says so
  });
});
