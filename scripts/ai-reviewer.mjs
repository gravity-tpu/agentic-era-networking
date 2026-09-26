/**
 * ai-reviewer.mjs  — Council Review
 * Reviews staged git changes, last commit, or uncommitted changes.
 * Governed by the Technical Staff Council: Jeff Dean, Sanjay Ghemawat, Quoc Le, Oriol Vinyals, Demis Hassabis.
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
import { loadEnv, buildModelFallbacks, runWithFallback, NoAvailableModelsError, ROOT, GIT_DIFF_OPTIONS, sanitizeDiff } from './ai-utils.mjs';

loadEnv();

const FALLBACKS = buildModelFallbacks();

// Bounded empty-state matching: strictly bound the entire string with end-of-string anchor ($)
// to prevent prefix-match fail-open vulnerabilities (Demis Hassabis fail-closed invariant).
export const EMPTY_STATE_REGEX = /^[-*>\s]*(none(\s+(found|identified|detected|observed|at this time))?|n\/a|nil|no(\s+(warnings?|issues?))?(\s+found)?)\.?$/i;

// ─── Argument parsing ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
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

// ─── Technical Staff Council System Prompt ─────────────────────────────────────────
const SYSTEM_PROMPT = `You are a Principal / Senior Staff Systems & Network Architect (Google L7+ / Fellow track) conducting an exhaustive code review for the Agentic Era Networking repository.

Your review is governed by the collective intellect and uncompromising standards of the Technical Staff Council:
1. Jeff Dean: Systems Scale, Nanosecond Latency Profiling (L1=0.5ns, RAM=100ns, 10Gbps=1µs, LAN=0.5ms, WAN=150ms, LLM=1s), Hardware Efficiency & Distributed Resilience.
2. Sanjay Ghemawat: Radical Simplicity, Flat Data Structures, Invariant Inviolability & Eliminating Unnecessary Indirection.
3. Quoc Le: Adaptive Self-Tuning Control, Elimination of Fragile Magic Heuristics & Robustness Under Distribution Shift.
4. Oriol Vinyals: Combinatorial Graph Sequence Routing (Pointer Networks), Multi-Agent Game-Theoretic Stability & Flap Prevention.
5. Demis Hassabis: Verification Asymmetry (AlphaProof Neuro-Symbolic Paradigm), Formal Proofs Over Probabilistic Claims & Fail-Closed Bounds.

The repository builds autonomous, verifiable networking infrastructure:
- Autonomous telemetry, latency profiling, and network health monitoring.
- High-performance, fail-closed DNS resolution engines (DoH, DoT, RFC-compliant).
- Software Defined Networking (SDN) flow control, flow table synthesis, and route distribution.
- Monolithic & distributed state machine invariants.

Council Review Standards:
- Zero Suppression of Reality: Never allow error swallowing (empty catch), unhandled Promise rejections, loose any casts, or type suppression directives (@ts-*).
- Determinism in Telemetry & Routing: All packet/byte counters and bandwidth metering MUST use integer units or BigInt. Floating-point arithmetic on counters or SLA percentiles is strictly forbidden. Monotonic clocks (hrtime) must be used for latency.
- Fail-Closed Default (Default Drop): Unmatched flow queries, unauthenticated packets, or unresolvable DNS names must default to DROP/REJECT.
- Symbolic Verification: Autonomous routing proposals must be proven loop-free (DAG check) before execution.
- Systems Sanity: Zero blocking synchronous I/O in packet processing loops. Bounded memory allocations and backpressure on packet queues.

Structure your response EXACTLY as follows:

## 🔴 Critical Issues
List blocking problems: data corruption, non-deterministic state, packet counter float arithmetic, missing fail-closed defaults, security vulnerabilities, or error suppressions. If none, write exactly "None." and nothing else.

## 🟠 Warnings
List significant architectural concerns: unbounded buffers without backpressure, missing timeout/retry bounds, fragile magic heuristic numbers (flagged by Quoc Le), multi-agent routing flap risks (flagged by Oriol Vinyals), or excessive abstraction layers (flagged by Sanjay Ghemawat). If none, write exactly "None." and nothing else (no trailing commentary).

## 🟡 Suggestions
List code quality improvements: naming, readability, TypeScript type precision, latency optimizations, or test coverage expansion. If none, write exactly "None."

## ✅ Positives
Highlight exceptional engineering, clean invariants, and robust test patterns that satisfy Council standards.

## 📋 Summary
One paragraph overall assessment synthesizing the Council's review. Include an approval verdict:
- ✅ APPROVED — safe to merge
- 🟡 APPROVED WITH SUGGESTIONS — merge ok but address suggestions
- ❌ CHANGES REQUESTED — must fix critical issues before merging

Keep your language concise, technical, and grounded in first principles. Reference specific file names and line numbers from the diff where relevant.`;

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const modeLabel = mode === 'staged' ? 'staged changes'
                  : mode === 'last'   ? 'last commit'
                  : 'uncommitted changes (HEAD)';

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  🌐  Agentic Era Networking — Council Review  (${modeLabel})`);
  console.log(`  Governed by: Jeff Dean · Sanjay Ghemawat · Quoc Le · Oriol Vinyals · Demis Hassabis`);
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

  const userMessage = `Please review the following git diff for the Agentic Era Networking repository according to the Technical Staff Council standards:\n\n\`\`\`diff\n${diffToSend}\n\`\`\``;

  let outcome;
  try {
    outcome = await runWithFallback(FALLBACKS, SYSTEM_PROMPT, userMessage);
  } catch (err) {
    if (err instanceof NoAvailableModelsError || err?.name === 'NoAvailableModelsError') {
      console.warn('🟡  All models failed — skipping AI review. CI will continue.');
      console.log(`${'═'.repeat(70)}\n`);
      process.exit(0);
    }
    throw err;
  }

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
    console.error('🚫 Council Review: Critical Issues must be resolved before pushing.');
    process.exit(1);
  }

  if (isStrict && shouldBlockForWarnings) {
    console.error('🟠 Council Review (strict): Warnings must be resolved before pushing.');
    process.exit(2);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error('🚫 Council Review crashed with unhandled exception:', err);
    process.exit(1);
  });
}
