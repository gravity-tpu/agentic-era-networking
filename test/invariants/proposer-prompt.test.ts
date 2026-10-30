import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { proposerPrompts, PROPOSER_SYSTEM_PROMPT_V1, PROPOSER_SYSTEM_PROMPT_V2, PROPOSER_SYSTEM_PROMPT_V3 } from '../../src/sdn/proposer-prompt.js';
import { DEFAULT_WORKLOAD_HOSTS } from '../../src/sdn/port1-isolation.js';
import { DNS_CONFINEMENT_INTENT, PORT1_ISOLATION_INTENT } from '../../src/sdn/intents.js';
import { parseProposal } from '../../src/sdn/proposal-triage.js';

const RESULTS = path.resolve(__dirname, '../../docs/benchmarks/results/agent-evaluation');
const sha = (system: string, user: string) => crypto.createHash('sha256').update(system + '\n---\n' + user).digest('hex');

describe('proposer prompt v1 is the wording the recorded results used', () => {
  // The dns-confinement text has not changed since the runs, so v1 must reproduce the hash recorded by every model's run of it.
  const recorded = [
    'protocol-a-dns-confinement_v1-qwen3.8-27b-think-true-n50',
    'frontier-full/protocol-a-dns-confinement_v1-claude-haiku-5-5',
    'protocol-a-dns-confinement_v1-gemma4-26b-think-true',
  ];
  for (const dir of recorded) {
    it(`reproduces promptSha256 of ${dir}`, () => {
      const summary = JSON.parse(fs.readFileSync(path.join(RESULTS, dir, 'summary.json'), 'utf8')) as { promptSha256: string };
      const p = proposerPrompts('v1', DNS_CONFINEMENT_INTENT);
      expect(sha(p.system, p.user)).toBe(summary.promptSha256);
    });
  }
});

describe('proposer prompt v2', () => {
  it('adds the ARP fields and the workload host addresses, and changes nothing else in the system prompt', () => {
    const extra = PROPOSER_SYSTEM_PROMPT_V2.split('\n').filter((l) => !PROPOSER_SYSTEM_PROMPT_V1.split('\n').includes(l));
    expect(extra).toHaveLength(1);
    expect(extra[0]).toMatch(/"arpSpa", "arpTpa"/);
    expect(extra[0]).toMatch(/2054/);
    const user = proposerPrompts('v2', PORT1_ISOLATION_INTENT).user;
    for (const h of DEFAULT_WORKLOAD_HOSTS) expect(user).toContain(h);
    expect(user).toContain(PORT1_ISOLATION_INTENT.description);
  });

  it('differs from v1 in both the system prompt and the hash, so a run records which one it used', () => {
    const a = proposerPrompts('v1', PORT1_ISOLATION_INTENT);
    const b = proposerPrompts('v2', PORT1_ISOLATION_INTENT);
    expect(a.system).not.toBe(b.system);
    expect(sha(a.system, a.user)).not.toBe(sha(b.system, b.user));
  });

  it('describes fields the proposal parser accepts, and its ARP fields parse as written', () => {
    const rule = [{ id: 'a', priority: 200, outputPorts: [2], match: { inPort: 1, etherType: 2054, arpSpa: DEFAULT_WORKLOAD_HOSTS[0] } }];
    expect(parseProposal(JSON.stringify(rule)).ok).toBe(true);
    // the prompt says "exact host only": the parser enforces it (a prefix length other than 32 is a syntax error)
    const bad = [{ id: 'a', priority: 200, outputPorts: [2], match: { inPort: 1, etherType: 2054, arpSpa: DEFAULT_WORKLOAD_HOSTS[0], arpSpaPrefixLen: 24 } }];
    expect(parseProposal(JSON.stringify(bad)).ok).toBe(false);
  });
});

describe('proposer prompt v3', () => {
  it('adds exactly one anti-spoofing and intra-segment clarification rule to v2, leaving v1 and v2 unchanged', () => {
    const extra = PROPOSER_SYSTEM_PROMPT_V3.split('\n').filter((l) => !PROPOSER_SYSTEM_PROMPT_V2.split('\n').includes(l));
    expect(extra).toHaveLength(1);
    expect(extra[0]).toMatch(/srcIp/);
    expect(extra[0]).toMatch(/dstIp/);
    expect(extra[0]).toMatch(/intra-segment IPv4/);

    const v2 = proposerPrompts('v2', PORT1_ISOLATION_INTENT);
    const v3 = proposerPrompts('v3', PORT1_ISOLATION_INTENT);
    expect(v3.user).toBe(v2.user);
    expect(sha(v3.system, v3.user)).not.toBe(sha(v2.system, v2.user));
  });
});
