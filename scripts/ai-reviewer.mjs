/**
 * ai-reviewer.mjs  — AI code review (second reader, not a verifier)
 * Reviews staged git changes, last commit, or uncommitted changes.
 * Reviews diffs against the repository invariants (see AGENTS.md). Model output is a second opinion; it is not evidence of correctness.
 * Model priority and fallback chain are driven by config/models.json.
 *
 * Usage:
 *   npm run council:review              — reviews staged changes (or unstaged fallback)
 *   npm run council:review -- --last   — reviews the last commit
 *   npm run council:review -- --head   — reviews all uncommitted changes (staged + unstaged)
 *   npm run council:review -- --strict — exit(1) on Warnings as well as Critical Issues (used by pre-push hook)
 */

import { execSync } from 'child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, buildModelFallbacks, runWithFallback, NoAvailableModelsError, ROOT, GIT_DIFF_OPTIONS, sanitizeDiff, flushPendingTelemetry, DEFAULT_TELEMETRY_DRAIN_TIMEOUT_MS } from './ai-utils.mjs';

loadEnv();

// ─── Argument parsing ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.includes('--skip-ollama') || args.includes('--gemini')) {
  process.env.SKIP_OLLAMA = '1';
}

const FALLBACKS = buildModelFallbacks();

// Bounded empty-state matching: strictly bound the entire string with end-of-string anchor ($)
// to prevent prefix-match fail-open vulnerabilities (fail-closed invariant).
export const EMPTY_STATE_REGEX = /^[-*>\s]*(none(\s+(found|identified|detected|observed|at this time))?|n\/a|nil|no(\s+(warnings?|issues?))?(\s+found)?)\.?$/i;

const isCI = !!(process.env.CI || process.env.GITHUB_ACTIONS);
const isStrict = args.includes('--strict'); // exit(1) on Warnings too; used by pre-push hook
const mode = args.includes('--last') ? 'last'
           : args.includes('--head') ? 'head'
           : isCI                    ? 'last'
           : 'staged';

// ─── Git Diff Helper ──────────────────────────────────────────────────────────
function isGitRepo() {
  try {
    execSync('git rev-parse --git-dir', { cwd: ROOT, stdio: 'pipe' });
    return true;
  } catch (_) {
    return false;
  }
}

function ensureHistory() {
  try {
    const isShallow = execSync('git rev-parse --is-shallow-repository', { cwd: ROOT, encoding: 'utf-8' }).trim();
    if (isShallow === 'true') {
      console.log('ℹ️  Shallow clone detected — deepening history by 1 commit...');
      execSync('git fetch --deepen=1', { cwd: ROOT, stdio: 'pipe' });
    }
  } catch (_) { /* non-fatal */ }
}

const diffOpts = { ...GIT_DIFF_OPTIONS, cwd: ROOT };

function getDiff() {
  if (!isGitRepo()) {
    console.log('ℹ️  No git repository detected — skipping AI review.');
    process.exit(0);
  }

  // Exclude compiled hashed bundle assets (which are exact copies of public/zodiac-app.js and zodiac.css)
  // to avoid consuming 150KB of diff tokens and truncating real source code changes.
  const ASSET_EXCLUDES = '-- . ":!public/zodiac-app.*.js" ":!public/zodiac.*.css"';

  let diffCmd = `git diff HEAD ${ASSET_EXCLUDES}`;
  if (mode === 'staged') {
    diffCmd = `git diff --staged ${ASSET_EXCLUDES}`;
  } else if (mode === 'last') {
    ensureHistory();
    const before = process.env.GITHUB_BEFORE;
    const sha    = process.env.GITHUB_SHA;
    if (before && sha && before !== '0000000000000000000000000000000000000000') {
      diffCmd = `git diff ${before} ${sha} ${ASSET_EXCLUDES}`;
    } else {
      diffCmd = `git diff HEAD~1 HEAD ${ASSET_EXCLUDES}`;
    }
  }

  try {
    let diff = execSync(diffCmd, diffOpts);
    if (mode === 'staged' && !diff.trim()) {
      diffCmd = `git diff ${ASSET_EXCLUDES}`;
      diff = execSync(diffCmd, diffOpts);
      if (!diff.trim()) {
        console.log('ℹ️  No changes detected (nothing staged or unstaged).');
        process.exit(0);
      }
      console.log('ℹ️  Nothing staged — reviewing unstaged changes instead.\n');
    }
    return sanitizeDiff(diff);
  } catch (e) {
    console.warn('⚠️  git diff encountered an issue:', e.message);
    try {
      const fallbackDiff = execSync(`${diffCmd} -- . ":!*.png" ":!*.pdf" ":!*.txt" ":!*.html"`, diffOpts);
      return sanitizeDiff(fallbackDiff);
    } catch (_) {
      console.warn('🟡  Skipping AI review due to diff buffer limits.');
      process.exit(0);
    }
  }
}

const isCCIE = args.includes('--ccie');

// ─── Systems review system prompt ─────────────────────────────────────────────────
export const TECHNICAL_SYSTEM_PROMPT = `You are a Principal / Senior Staff Systems & Network Engineer conducting an exhaustive code review for the Agentic Era Networking repository (Zodiac).

You are a second reader. Your findings are hypotheses to be checked against the code, not proofs; cite the exact file and line, and say when you are unsure.

The repository is a real-hardware testbed and verifier for agent-proposed SDN policy:
- An OpenFlow 1.3 controller and a physical Zodiac FX switch (128-rule table, software flow lookup on a microcontroller).
- Static checks on flow rule sets (isolation, hairpin, table budget) that gate installation, plus switch readback comparison.
- A measured hardware cost model and a data-plane benchmark harness.
- Telemetry with provenance, a fail-closed DNS wire handler, and an anomaly detector with a quarantine path.

Review standards (the repository invariants):
- No suppression of errors: never allow error swallowing (empty catch), unhandled Promise rejections, loose any casts, or type suppression directives (@ts-*).
- Integer accounting: all packet/byte counters and bandwidth metering MUST use integer units or BigInt. Floating-point arithmetic on counters or SLA percentiles is forbidden. Monotonic clocks (hrtime) must be used for latency.
- Fail closed: unmatched flow queries, unauthenticated packets, or unresolvable DNS names must default to DROP/REJECT.
- Verify before actuating: anything an agent proposes must pass deterministic checks and a human gate before touching the data plane. Flag checks that cannot fail (vacuous), and claims of verification that the code does not perform.
- Provenance: synthetic or hardcoded values must never be presented as live telemetry. Flag fabricated counters, demo data in live views, and unlabeled simulations.
- Systems sanity: no blocking synchronous I/O in packet processing loops; bounded memory allocations and backpressure on queues; configurable limits instead of buried magic constants.
- Simplicity: flag unnecessary abstraction and indirection.

Structure your response EXACTLY as follows:

## 🔴 Critical Issues
List blocking problems: data corruption, non-deterministic state, packet counter float arithmetic, missing fail-closed defaults, fabricated telemetry, security vulnerabilities, or error suppressions. If none, write exactly "None." and nothing else.

## 🟠 Warnings
List significant architectural concerns: unbounded buffers without backpressure, missing timeout/retry bounds, fragile magic heuristic numbers, rule or quarantine flapping risks, vacuous verification, or excessive abstraction layers. If none, write exactly "None." and nothing else (no trailing commentary).

## 🟡 Suggestions
List code quality improvements: naming, readability, TypeScript type precision, latency optimizations, or test coverage expansion. If none, write exactly "None."

## ✅ Positives
Highlight exceptional engineering, clean invariants, and robust test patterns that satisfy the invariants.

## 📋 Summary
One paragraph overall assessment. Include an approval verdict:
- ✅ APPROVED — safe to merge
- 🟡 APPROVED WITH SUGGESTIONS — merge ok but address suggestions
- ❌ CHANGES REQUESTED — must fix critical issues before merging

Keep your language concise, technical, and grounded in first principles. Reference specific file names and line numbers from the diff where relevant.`;

// ─── Network engineering review system prompt ─────────────────────────────────────
export const CCIE_SYSTEM_PROMPT = `You are a Principal Network Architect conducting an exhaustive network engineering code review for the Agentic Era Networking repository.

You are a second reader. Your findings are hypotheses to be checked against the code, not proofs; cite the exact file and line, and say when you are unsure. Review against these principles: the end-to-end argument and fate-sharing, strict data/control plane separation, loop-free forwarding, match-action table budgets (TCAM/FIB), active queue management, and route/ACL flap damping.

The repository designs and operates physical and SDN networking infrastructure:
- Zodiac FX OpenFlow 1.3 physical switch (SAM4E8E MCU / KSZ8795CLX switch chip) with a strict hardware ceiling of 128 flow rules.
- Linux kernel networking (nftables interval sets, tc egress queuing, CoPP rate limiting).
- RFC 1035 UDP DNS wire protocol parsing and fail-closed resolution.
- Edge workload isolation, 802.1Q VLAN domains, physical tap monitoring, and multi-tenant rate transition bounds (IEEE 802.3x Flow Control).

Network Engineering Invariants to Enforce:
- NET-001 (Data vs Control Plane Separation & CoPP): Forwarding fast path must execute at wire rate in hardware/kernel (< 1 µs); slow path control plane must be strictly out-of-band. Control Plane Policing (CoPP) token buckets must rate-limit punted packets (OFPT_PACKET_IN, ICMP, ARP) to prevent switch CPU starvation.
- NET-002 (TCAM Silicon Quotas & Ternary Bitmasking): Hardware flow tables are strictly bounded (128 rules on Zodiac FX). Must enforce hierarchical CIDR aggregation (/24 or /16) to prevent range-expansion explosion; alert when approaching the 80% watermark (102 rules).
- NET-003 (End-to-End Principle & Fate-Sharing): Origin traffic must never share fate with monitoring sidecars or telemetry collection. If monitoring crashes, clean transit traffic must flow uninterrupted.
- NET-004 (Loop-Free Forwarding & Flap Prevention): Forwarding updates must not create loops or hairpins (no rule may output to its own ingress port; no flood loops across L2 domains). Dynamic quarantine rules must apply exponential backoff hysteresis damping to eliminate route/ACL flapping.
- NET-005 (Buffer Dynamics & Anti-Bufferbloat): Drop unwanted/malicious packets as early as possible (PREROUTING / hardware table-miss DROP) before socket buffer allocation. Use token-bucket meters on sister-site burst traffic.
- NET-006 (L2/L3 Boundary Discipline & MTU/MSS Integrity): Strict 802.1Q VLAN isolation between untrusted workloads, tap mirrors, and control channels. Clamp TCP MSS to 1460 bytes (or overlay budget) across tunnels.
- NET-010 (Intermediate Aggregation & Rate Transition Integrity): 802.3x Flow Control and host egress pacing across GbE-to-100M transitions to prevent unmonitored switch buffer tail-drops.

Structure your response EXACTLY as follows:

## 🔴 Critical Issues
List blocking network problems: data-plane forwarding loops, missing fail-closed/default-drop flow rules, unpoliced OFPT_PACKET_IN punting (missing CoPP), TCAM overflow risks (> 128 rules), cross-VLAN broadcast/L2 leaks, or synchronous RPCs in packet fast paths. If none, write exactly "None." and nothing else.

## 🟠 Warnings
List significant network architectural concerns: lack of CIDR supernet aggregation (excessive /32 rules), bufferbloat risks on rate transitions, missing timeout bounds on switch state transitions, fragile static MAC/IP bindings without reconciliation, or fate-sharing between data forwarding and telemetry daemons. If none, write exactly "None." and nothing else (no trailing commentary).

## 🟡 Suggestions
List network engineering improvements: wire efficiency, packet framing optimizations, TCAM minimization, telemetry fidelity, or test coverage for network edge cases. If none, write exactly "None."

## ✅ Positives
Highlight sound network architecture, strict control/data plane decoupling, robust match-action rule design, and wire-rate invariant enforcement that satisfy these principles.

## 📋 Summary
One paragraph overall assessment. Include an approval verdict:
- ✅ APPROVED — safe to merge
- 🟡 APPROVED WITH SUGGESTIONS — merge ok but address suggestions
- ❌ CHANGES REQUESTED — must fix critical issues before merging

Keep your language concise, technical, and grounded in network engineering principles. Reference specific file names and line numbers from the diff where relevant.`;

export const COUNCIL_CONFIGS = {
  technical: {
    title: 'Systems Review',
    titans: 'repository invariants (AGENTS.md)',
    label: 'systems review',
    systemPrompt: TECHNICAL_SYSTEM_PROMPT,
  },
  ccie: {
    title: 'Network Engineering Review',
    titans: 'network engineering invariants (.agents/rules/network-engineering-principles.md)',
    label: 'network engineering review',
    systemPrompt: CCIE_SYSTEM_PROMPT,
  },
};

const activeCouncil = isCCIE ? COUNCIL_CONFIGS.ccie : COUNCIL_CONFIGS.technical;
export const SYSTEM_PROMPT = activeCouncil.systemPrompt;

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const modeLabel = mode === 'staged' ? 'staged changes'
                  : mode === 'last'   ? 'last commit'
                  : 'uncommitted changes (HEAD)';

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  🌐  Agentic Era Networking — ${activeCouncil.title}  (${modeLabel})`);
  console.log(`  Rubric: ${activeCouncil.titans}`);
  console.log(`  Fallback chain: ${FALLBACKS.map(f => f.model).join(' → ')}`);
  if (isStrict) console.log(`  Mode: STRICT — Warnings block push, not just Critical Issues.`);
  console.log(`${'═'.repeat(70)}\n`);

  const diff = getDiff();

  const MAX_DIFF_CHARS = 80_000;
  const truncated = diff.length > MAX_DIFF_CHARS;
  const diffToSend = truncated
    ? diff.slice(0, MAX_DIFF_CHARS) + '\n\n[...diff truncated for context window...]'
    : diff;

  if (truncated) {
    console.log(`🟡  Diff is large (${(diff.length / 1000).toFixed(1)}k chars). Sending first ${MAX_DIFF_CHARS / 1000}k chars.\n`);
  }

  const userMessage = `Please review the following git diff for the Agentic Era Networking repository according to the ${activeCouncil.label} standards:\n\n\`\`\`diff\n${diffToSend}\n\`\`\``;

  let outcome;
  try {
    outcome = await runWithFallback(FALLBACKS, activeCouncil.systemPrompt, userMessage);
  } catch (err) {
    await flushPendingTelemetry();
    if (err instanceof NoAvailableModelsError) {
      console.error(`🚫 ${activeCouncil.title} failed: ${err.message}. Fail-closed verification enforced.`);
      console.log(`${'═'.repeat(70)}\n`);
      process.exit(1);
    }
    throw err;
  }

  // Ensure any background telemetry tasks queued during inference complete before process exits
  await flushPendingTelemetry();

  console.log(outcome.result);
  console.log(`\n${'═'.repeat(70)}\n`);

  const hasCritical = outcome.result.includes('❌ CHANGES REQUESTED');

  // Match the warnings section regardless of whether the 🟠 emoji rendered.
  // In strict mode, any non-empty Warnings section (that does not explicitly state "None")
  // must independently block the push, decoupled from the LLM's summary verdict string
  // (Zero Suppression of Reality & Fail-Closed Invariants).
  const warningsSection = outcome.result.match(
    /##\s*(?:🟠\s*)?Warnings?\s*\n+([\s\S]*?)(?=\n##|$)/i
  );
  const warningsBody = warningsSection?.[1]?.trim() ?? '';
  const shouldBlockForWarnings = warningsBody.length > 0 &&
                                 !EMPTY_STATE_REGEX.test(warningsBody);

  if (hasCritical) {
    console.error(`🚫 ${activeCouncil.title}: Critical Issues must be resolved before pushing.`);
    process.exit(1);
  }

  if (isStrict && shouldBlockForWarnings) {
    console.error(`🟠 ${activeCouncil.title} (strict): Warnings must be resolved before pushing.`);
    process.exit(2);
  }
}

export const MAX_SIGNAL_DRAIN_TIMEOUT_MS = 2000;

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let isTerminating = false;
  const SIGNAL_DRAIN_TIMEOUT_MS = Math.min(MAX_SIGNAL_DRAIN_TIMEOUT_MS, DEFAULT_TELEMETRY_DRAIN_TIMEOUT_MS);


  const onSignal = (sig) => {
    if (isTerminating) return;
    isTerminating = true;
    process.stderr.write(`\n[ai-reviewer] Received ${sig} — draining pending telemetry...\n`);
    flushPendingTelemetry(SIGNAL_DRAIN_TIMEOUT_MS)
      .catch((err) => {
        process.stderr.write(`[ai-reviewer] Error draining telemetry on ${sig}: ${err?.message ?? err}\n`);
      })
      .finally(() => {
        process.exit(130);
      });
  };

  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  main().catch((err) => {
    console.error('🚫 AI review crashed with unhandled exception:', err);
    process.exit(1);
  });
}

