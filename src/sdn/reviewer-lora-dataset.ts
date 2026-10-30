/**
 * reviewer-lora-dataset.ts
 * Deterministic, format-verified SFT and DPO dataset generator for fine-tuning the local
 * pre-push code review model (`qwen3.8:27b` in `scripts/ai-reviewer.mjs`) across both the
 * Systems Review rubric (`INV-1`..`INV-6`) and the Network Engineering rubric (`NET-001`..`NET-010`).
 *
 * Invariant 3 & 4 (Fail closed & Verify before actuating):
 *   - `validateReviewFormat` enforces the exact section structure and `EMPTY_STATE_REGEX` rules
 *     that `scripts/ai-reviewer.mjs` uses in `--strict` mode:
 *       * An `APPROVED` review MUST have `None.` under both `## 🔴 Critical Issues` and `## 🟠 Warnings`
 *         (so `--strict` never blocks a clean push with a stylistic warning) and end with
 *         `- ✅ APPROVED — safe to merge`.
 *       * A `CHANGES_REQUESTED` review MUST have a non-empty `## 🔴 Critical Issues` body citing
 *         the file and invariant, and end with `- ❌ CHANGES REQUESTED — must fix critical issues before merging`.
 *   - Every generated SFT and DPO example is checked by `validateReviewFormat` before emission.
 *
 * Invariant 6 (Provenance):
 *   - Carries `source: 'synthetic_verifier_grounded'`. All example diffs are explicitly labeled
 *     synthetic review fixtures (`cloud_snapshot` / `disconnected` where telemetry is shown).
 *
 * Pure module: no I/O.
 */

import type { ChatMessage } from './proposer-lora-dataset.js';

export const REVIEWER_INVARIANTS = [
  'INV-1',
  'INV-2',
  'INV-3',
  'INV-4',
  'INV-5',
  'INV-6',
  'NET-001',
  'NET-002',
  'NET-003',
  'NET-004',
  'NET-005',
  'NET-006',
  'NET-010',
] as const;

export type ReviewerInvariantId = (typeof REVIEWER_INVARIANTS)[number];
export type ReviewCouncil = 'technical' | 'ccie';
export type ReviewVerdict = 'APPROVED' | 'CHANGES_REQUESTED';

/** Exact regex from scripts/ai-reviewer.mjs line 31 for bounded empty-state matching in strict mode. */
export const EMPTY_STATE_REGEX =
  /^[-*>\s]*(none(\s+(found|identified|detected|observed|at this time))?|n\/a|nil|no(\s+(warnings?|issues?))?(\s+found)?)\.?$/i;

export const REVIEWER_TECHNICAL_SYSTEM_PROMPT = `You are a strict Senior Network & Systems Architect acting as a code gatekeeper. Audit the git diff against the repository invariants below. Do not offer stylistic tips under Critical Issues or Warnings; those sections are only for violations and risks.

Hard rules (a violation is a Critical Issue, and the verdict MUST be ❌ CHANGES REQUESTED):
- Invariant 1 (No suppression of errors): never allow empty catch blocks, unhandled Promise rejections, loose any casts, or @ts-ignore/@ts-expect-error directives.
- Invariant 2 (Integer accounting and monotonic time): no floating-point arithmetic on packet counters, rates, budgets, thresholds, or rankings; use BigInt and process.hrtime.bigint().
- Invariant 3 (Fail closed): unmatched packets, rules, or DNS queries must default to DROP/REJECT.
- Invariant 4 (Verify before actuating): every proposed rule or policy must pass deterministic checks that can fail before touching the data plane.
- Invariant 5 (Configurable, bounded and damped limits): no unbounded queues/maps or buried magic numbers; adaptive loops must be damped.
- Invariant 6 (Provenance): when hardware is disconnected, report 0 rates, null thermals, and source 'disconnected'; never pass synthetic values off as live.

Structure your response EXACTLY with:
## 🔴 Critical Issues
## 🟠 Warnings
## 🟡 Suggestions
## ✅ Positives
## 📋 Summary`;

export const REVIEWER_CCIE_SYSTEM_PROMPT = `You are a Principal Network Architect conducting an exhaustive network engineering code review for the Agentic Era Networking repository.

Network Engineering Invariants to Enforce:
- NET-001 (Data vs Control Plane Separation & CoPP): Fast path in hardware/kernel; never punt unpoliced table-miss traffic (OFPT_PACKET_IN) to the controller CPU.
- NET-002 (TCAM & FIB Silicon Budgeting): Zodiac FX table holds 128 rules; enforce CIDR prefix aggregation (/24 or /16) and reserve headroom for quarantine DROPs.
- NET-003 (End-to-End Principle & Fate-Sharing): Data forwarding must never share fate with or block on telemetry sidecars or database writes.
- NET-004 (Loop-Free Forwarding & Flap Prevention): No hairpin rules (in_port == out_port); dynamic quarantine rules require hysteresis/cooldown damping.
- NET-005 (Buffer Dynamics & Anti-Bufferbloat): Drop unwanted packets at hardware ingress / PREROUTING before socket buffer allocation.
- NET-006 (L2/L3 Boundary & MTU/MSS Integrity): Isolate mirror destination ports in dedicated 802.1Q VLANs; clamp TCP MSS across tunnels.
- NET-010 (Intermediate Aggregation & Rate-Transition Integrity): Enforce 802.3x Flow Control and host egress pacing (95 Mbit/s) across GbE-to-100M transitions, and reconcile host tx vs switch rx counters.

Structure your response EXACTLY with:
## 🔴 Critical Issues
## 🟠 Warnings
## 🟡 Suggestions
## ✅ Positives
## 📋 Summary`;

export interface ReviewerSftExample {
  readonly id: string;
  readonly invariantId: ReviewerInvariantId;
  readonly council: ReviewCouncil;
  readonly expectedVerdict: ReviewVerdict;
  readonly messages: readonly ChatMessage[];
}

export interface ReviewerDpoPair {
  readonly id: string;
  readonly invariantId: ReviewerInvariantId;
  readonly council: ReviewCouncil;
  readonly expectedVerdict: ReviewVerdict;
  readonly prompt: readonly ChatMessage[];
  readonly chosen: string;
  readonly rejected: string;
}

export interface ReviewerDatasetSummary {
  readonly schema: 'reviewer-lora-dataset/v1';
  readonly source: 'synthetic_verifier_grounded';
  readonly sftExampleCount: number;
  readonly dpoPairCount: number;
  readonly invariantCounts: Readonly<
    Record<ReviewerInvariantId, { readonly changesRequested: number; readonly approved: number }>
  >;
}

export interface ReviewerLoraDataset {
  readonly sftExamples: readonly ReviewerSftExample[];
  readonly dpoPairs: readonly ReviewerDpoPair[];
  readonly summary: ReviewerDatasetSummary;
}

function extractSection(text: string, headingPattern: RegExp): string {
  const match = headingPattern.exec(text);
  if (match === null || match[1] === undefined) {
    throw new Error(`missing required section matching ${String(headingPattern)}`);
  }
  return match[1].trim();
}

/**
 * Validates that a review response strictly obeys the section structure and verdict semantics
 * enforced by `scripts/ai-reviewer.mjs` (including `--strict` empty-warning checks).
 */
export function validateReviewFormat(reviewText: string, expectedVerdict: ReviewVerdict): void {
  const criticalBody = extractSection(reviewText, /##\s*🔴\s*Critical Issues\s*\n+([\s\S]*?)(?=\n##|$)/i);
  const warningsBody = extractSection(reviewText, /##\s*🟠\s*Warnings\s*\n+([\s\S]*?)(?=\n##|$)/i);
  extractSection(reviewText, /##\s*🟡\s*Suggestions\s*\n+([\s\S]*?)(?=\n##|$)/i);
  const positivesBody = extractSection(reviewText, /##\s*✅\s*Positives\s*\n+([\s\S]*?)(?=\n##|$)/i);
  const summaryBody = extractSection(reviewText, /##\s*📋\s*Summary\s*\n+([\s\S]*?)(?=\n##|$)/i);

  if (positivesBody.length === 0) {
    throw new Error('Positives section must not be empty');
  }

  const criticalIsEmpty = EMPTY_STATE_REGEX.test(criticalBody);
  const warningsIsEmpty = EMPTY_STATE_REGEX.test(warningsBody);

  if (expectedVerdict === 'APPROVED') {
    if (!criticalIsEmpty) {
      throw new Error(`APPROVED review must have "None." under Critical Issues, got: ${criticalBody}`);
    }
    if (!warningsIsEmpty) {
      throw new Error(`APPROVED review must have "None." under Warnings (strict-mode safety), got: ${warningsBody}`);
    }
    if (!summaryBody.includes('✅ APPROVED — safe to merge')) {
      throw new Error('APPROVED review Summary must include "✅ APPROVED — safe to merge"');
    }
    if (summaryBody.includes('❌ CHANGES REQUESTED')) {
      throw new Error('APPROVED review Summary must not include "❌ CHANGES REQUESTED"');
    }
  } else {
    if (criticalIsEmpty) {
      throw new Error('CHANGES_REQUESTED review must list at least one concrete violation under Critical Issues');
    }
    if (!summaryBody.includes('❌ CHANGES REQUESTED — must fix critical issues before merging')) {
      throw new Error(
        'CHANGES_REQUESTED review Summary must include "❌ CHANGES REQUESTED — must fix critical issues before merging"',
      );
    }
    if (summaryBody.includes('✅ APPROVED')) {
      throw new Error('CHANGES_REQUESTED review Summary must not include "✅ APPROVED"');
    }
  }
}

interface InvariantFixture {
  readonly invariantId: ReviewerInvariantId;
  readonly council: ReviewCouncil;
  readonly file: string;
  readonly badDiff: string;
  readonly badFinding: string;
  readonly badSummary: string;
  readonly goodDiff: string;
  readonly goodPositive: string;
  readonly goodSummary: string;
  readonly falsePositiveWarning: string;
}

const FIXTURES: readonly InvariantFixture[] = [
  {
    invariantId: 'INV-1',
    council: 'technical',
    file: 'src/sdn/flow-readback.ts',
    badDiff: `--- a/src/sdn/flow-readback.ts
+++ b/src/sdn/flow-readback.ts
@@ -42,7 +42,9 @@ export function decodeFlowStats(buf: Buffer): readonly FlowStatsEntry[] {
-  return parseEntries(buf);
+  try {
+    return parseEntries(buf);
+  } catch (e) {
+    return [];
+  }
 }`,
    badFinding:
      '`src/sdn/flow-readback.ts:44`: Swallows `parseEntries(buf)` exceptions in an empty `catch (e)` and returns `[]`, masking malformed switch readback frames (violates Invariant 1: No suppression of errors, and Invariant 3: Fail closed).',
    badSummary:
      'The diff masks protocol parse errors with a catch-and-return-empty block in `src/sdn/flow-readback.ts`, violating Invariant 1.',
    goodDiff: `--- a/src/sdn/flow-readback.ts
+++ b/src/sdn/flow-readback.ts
@@ -42,4 +42,7 @@ export function decodeFlowStats(buf: Buffer): readonly FlowStatsEntry[] {
+  if (buf.byteLength < MIN_FLOW_STATS_BYTES) {
+    throw new Error(\`decodeFlowStats: short buffer (\${buf.byteLength} < \${MIN_FLOW_STATS_BYTES})\`);
+  }
   return parseEntries(buf);
 }`,
    goodPositive:
      '`src/sdn/flow-readback.ts:42`: Explicitly validates minimum buffer length and throws a deterministic boundary error without error suppression (Invariant 1).',
    goodSummary:
      'Deterministic bounds check added to `src/sdn/flow-readback.ts` in compliance with Invariant 1 and Invariant 3.',
    falsePositiveWarning: '`src/sdn/flow-readback.ts:43`: Throwing an Error on short buffers might interrupt callers.',
  },
  {
    invariantId: 'INV-2',
    council: 'technical',
    file: 'src/sdn/sla-meter.ts',
    badDiff: `--- a/src/sdn/sla-meter.ts
+++ b/src/sdn/sla-meter.ts
@@ -18,5 +18,6 @@ export function isLossBudgetExceeded(dropped: bigint, sent: bigint): boolean {
-  return dropped * 100n > sent * 5n;
+  const ratio = Number(dropped) / Number(sent);
+  return ratio > 0.05;
 }`,
    badFinding:
      '`src/sdn/sla-meter.ts:18`: Converts `BigInt` packet counters to `Number` and uses floating-point division `Number(dropped) / Number(sent) > 0.05` to gate the loss budget check (violates Invariant 2: Integer accounting and monotonic time).',
    badSummary:
      'Replaces exact `BigInt` cross-multiplication with floating-point division in `src/sdn/sla-meter.ts`, violating Invariant 2.',
    goodDiff: `--- a/src/sdn/sla-meter.ts
+++ b/src/sdn/sla-meter.ts
@@ -18,5 +18,7 @@ export function isLossBudgetExceeded(dropped: bigint, sent: bigint, maxLossBps: bigint): boolean {
+  if (sent <= 0n) return true;
+  return dropped * 10_000n > sent * maxLossBps;
 }`,
    goodPositive:
      '`src/sdn/sla-meter.ts:19`: Evaluates the basis-point loss budget strictly via `BigInt` cross-multiplication (`dropped * 10_000n > sent * maxLossBps`) and fails closed when `sent <= 0n` (Invariants 2 & 3).',
    goodSummary:
      'Pure `BigInt` integer accounting and fail-closed zero-traffic handling in `src/sdn/sla-meter.ts`.',
    falsePositiveWarning: '`src/sdn/sla-meter.ts:19`: Multiplication by `10_000n` could be replaced by a helper.',
  },
  {
    invariantId: 'INV-3',
    council: 'technical',
    file: 'src/dns/dns-policy.ts',
    badDiff: `--- a/src/dns/dns-policy.ts
+++ b/src/dns/dns-policy.ts
@@ -29,5 +29,5 @@ export function evaluateDnsQuery(qname: string, allowlist: ReadonlySet<string>): 'ALLOW' | 'DROP' {
   if (allowlist.has(qname)) return 'ALLOW';
-  return 'DROP';
+  return 'ALLOW';
 }`,
    badFinding:
      '`src/dns/dns-policy.ts:31`: Returns `ALLOW` when `qname` is not present in `allowlist`, turning the DNS filter fail-open on unrecognized domains (violates Invariant 3: Fail closed).',
    badSummary:
      'Unrecognized DNS queries default to `ALLOW` in `src/dns/dns-policy.ts`, directly violating Invariant 3.',
    goodDiff: `--- a/src/dns/dns-policy.ts
+++ b/src/dns/dns-policy.ts
@@ -29,5 +29,7 @@ export function evaluateDnsQuery(qname: string, allowlist: ReadonlySet<string>): 'ALLOW' | 'DROP' {
+  const normalized = qname.trim().toLowerCase();
+  if (normalized.length === 0) return 'DROP';
   if (allowlist.has(normalized)) return 'ALLOW';
   return 'DROP';
 }`,
    goodPositive:
      '`src/dns/dns-policy.ts:30`: Normalizes query names and defaults to `DROP` on empty or unrecognized domains (Invariant 3: Fail closed).',
    goodSummary:
      'Preserves strict fail-closed DNS evaluation in `src/dns/dns-policy.ts`.',
    falsePositiveWarning: '`src/dns/dns-policy.ts:30`: Calling `.toLowerCase()` allocates a string per query.',
  },
  {
    invariantId: 'INV-4',
    council: 'technical',
    file: 'src/sdn/allow-route.ts',
    badDiff: `--- a/src/sdn/allow-route.ts
+++ b/src/sdn/allow-route.ts
@@ -51,6 +51,4 @@ export async function installProposedRules(current: readonly IsolationRule[], proposed: readonly IsolationRule[]): Promise<void> {
-  const gate = admitInstall({ current, proposed });
-  if (!gate.admitted) throw new Error('Install refused by gate');
   await sendFlowModsToSwitch(proposed);
 }`,
    badFinding:
      '`src/sdn/allow-route.ts:51`: Removes the deterministic `admitInstall` verification gate and sends proposed `FlowMod` entries directly to the switch without verification (violates Invariant 4: Verify before actuating).',
    badSummary:
      'Bypasses `admitInstall` in `src/sdn/allow-route.ts`, actuating unverified rules on the switch in violation of Invariant 4.',
    goodDiff: `--- a/src/sdn/allow-route.ts
+++ b/src/sdn/allow-route.ts
@@ -51,6 +51,8 @@ export async function installProposedRules(current: readonly IsolationRule[], proposed: readonly IsolationRule[], intent: IntentSpec): Promise<void> {
-  const gate = admitInstall({ current, proposed });
+  const gate = admitInstall({ current, proposed, intent });
   if (!gate.admitted) {
     throw new Error(\`Install refused: \${gate.violations.map((v) => v.property).join(', ')}\`);
   }
   await sendFlowModsToSwitch(proposed);
 }`,
    goodPositive:
      '`src/sdn/allow-route.ts:52`: Enforces `admitInstall` with explicit `intent` compliance (`A11`) before `sendFlowModsToSwitch` is called (Invariant 4).',
    goodSummary:
      'Strengthens pre-install verification in `src/sdn/allow-route.ts` by passing `intent` to `admitInstall`.',
    falsePositiveWarning: '`src/sdn/allow-route.ts:53`: Joining violation properties into an Error string is terse.',
  },
  {
    invariantId: 'INV-5',
    council: 'technical',
    file: 'src/sdn/quarantine-history.ts',
    badDiff: `--- a/src/sdn/quarantine-history.ts
+++ b/src/sdn/quarantine-history.ts
@@ -12,6 +12,5 @@ export class QuarantineHistory {
   private readonly events: string[] = [];
   public record(line: string): void {
-    if (this.events.length >= this.maxEntries) this.events.shift();
     this.events.push(line);
   }
 }`,
    badFinding:
      '`src/sdn/quarantine-history.ts:14`: Removes the `maxEntries` eviction bound on `this.events`, allowing unbounded array growth under sustained quarantine alerts (violates Invariant 5: Configurable, bounded and damped limits).',
    badSummary:
      'Introduces an unbounded in-memory array in `src/sdn/quarantine-history.ts`, violating Invariant 5.',
    goodDiff: `--- a/src/sdn/quarantine-history.ts
+++ b/src/sdn/quarantine-history.ts
@@ -8,9 +8,11 @@ export const DEFAULT_MAX_QUARANTINE_EVENTS = 1024;
 export class QuarantineHistory {
   private readonly events: string[] = [];
+  public constructor(private readonly maxEntries: number = DEFAULT_MAX_QUARANTINE_EVENTS) {
+    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 16384) {
+      throw new Error('maxEntries must be an integer 1..16384');
+    }
+  }
   public record(line: string): void {
     if (this.events.length >= this.maxEntries) this.events.shift();
     this.events.push(line);
   }
 }`,
    goodPositive:
      '`src/sdn/quarantine-history.ts:10`: Enforces a named, configurable, and bounded capacity (`DEFAULT_MAX_QUARANTINE_EVENTS`, capped at `16384`) on `QuarantineHistory` (Invariant 5).',
    goodSummary:
      'Adds explicit bounds validation to `QuarantineHistory` in compliance with Invariant 5.',
    falsePositiveWarning: '`src/sdn/quarantine-history.ts:16`: `Array.shift()` is O(n) for up to 16384 elements.',
  },
  {
    invariantId: 'INV-6',
    council: 'technical',
    file: 'src/sdn/telemetry-fallback.ts',
    badDiff: `--- a/src/sdn/telemetry-fallback.ts
+++ b/src/sdn/telemetry-fallback.ts
@@ -20,6 +20,6 @@ export function disconnectedSwitchSnapshot() {
   return {
-    source: 'disconnected' as const,
-    rxPps: 0n,
-    tempCelsius: null,
+    status: 'ONLINE' as const,
+    rxPps: 420n,
+    tempCelsius: 48,
   };
 }`,
    badFinding:
      '`src/sdn/telemetry-fallback.ts:21`: Reports `status: "ONLINE"`, fabricated `rxPps: 420n`, and `tempCelsius: 48` inside `disconnectedSwitchSnapshot()` when hardware is offline (violates Invariant 6: Provenance — no simulation passed off as live).',
    badSummary:
      'Fabricates live telemetry counters and thermals when the switch is disconnected in `src/sdn/telemetry-fallback.ts`, violating Invariant 6.',
    goodDiff: `--- a/src/sdn/telemetry-fallback.ts
+++ b/src/sdn/telemetry-fallback.ts
@@ -20,6 +20,7 @@ export function disconnectedSwitchSnapshot() {
   return {
     source: 'disconnected' as const,
     rxPps: 0n,
+    txPps: 0n,
     tempCelsius: null,
   };
 }`,
    goodPositive:
      '`src/sdn/telemetry-fallback.ts:21`: Preserves `source: "disconnected"`, zero `BigInt` packet rates, and `null` thermals when hardware is offline (Invariant 6).',
    goodSummary:
      'Maintains strict epistemic telemetry provenance for disconnected hardware state in `src/sdn/telemetry-fallback.ts`.',
    falsePositiveWarning: '`src/sdn/telemetry-fallback.ts:23`: `txPps` could be omitted when `0n`.',
  },
  {
    invariantId: 'NET-001',
    council: 'ccie',
    file: 'src/sdn/table-miss.ts',
    badDiff: `--- a/src/sdn/table-miss.ts
+++ b/src/sdn/table-miss.ts
@@ -14,5 +14,5 @@ export function buildTableMissRule(): IsolationRule {
   return {
     id: 'table-miss',
-    flowMod: { command: FlowModCommand.OFPFC_ADD, priority: 0, outputPorts: [], match: {} },
+    flowMod: { command: FlowModCommand.OFPFC_ADD, priority: 0, outputPorts: [OFPP_CONTROLLER], match: {} },
   };
 }`,
    badFinding:
      '`src/sdn/table-miss.ts:17`: Changes the priority-0 table-miss rule from an empty action list (`DROP`) to `outputPorts: [OFPP_CONTROLLER]`, punting every unmatched frame across the 100 Mbps workload segment to the 120 MHz SAM4E8E MCU and OpenFlow control channel without CoPP policing (violates NET-001 and Invariant 3).',
    badSummary:
      'Unpoliced table-miss punting to `OFPP_CONTROLLER` in `src/sdn/table-miss.ts` creates a control-plane DoS vector on the Zodiac FX MCU (violates NET-001).',
    goodDiff: `--- a/src/sdn/table-miss.ts
+++ b/src/sdn/table-miss.ts
@@ -14,5 +14,6 @@ export function buildTableMissRule(): IsolationRule {
   return {
     id: 'table-miss-drop',
     flowMod: { command: FlowModCommand.OFPFC_ADD, priority: 0, outputPorts: [], match: {} },
   };
 }`,
    goodPositive:
      '`src/sdn/table-miss.ts:16`: Keeps the priority-0 table-miss rule as an explicit hardware `DROP` (`outputPorts: []`), preventing unpoliced `OFPT_PACKET_IN` punts to the controller (NET-001 & Invariant 3).',
    goodSummary:
      'Preserves control/data plane decoupling and fail-closed table-miss drop behavior in `src/sdn/table-miss.ts` (NET-001).',
    falsePositiveWarning: '`src/sdn/table-miss.ts:15`: Renaming `table-miss` to `table-miss-drop` changes log output.',
  },
  {
    invariantId: 'NET-002',
    council: 'ccie',
    file: 'src/sdn/subnet-policy.ts',
    badDiff: `--- a/src/sdn/subnet-policy.ts
+++ b/src/sdn/subnet-policy.ts
@@ -22,6 +22,9 @@ export function buildSegmentAllowRules(subnetPrefix: string): readonly IsolationRule[] {
-  return [makeRule('p1-subnet', 200, [2], { inPort: 1, etherType: 0x0800, srcIp: \`\${subnetPrefix}.0\`, srcIpPrefixLen: 24 })];
+  const rules: IsolationRule[] = [];
+  for (let host = 1; host <= 254; host++) {
+    rules.push(makeRule(\`p1-host-\${host}\`, 200, [2], { inPort: 1, etherType: 0x0800, srcIp: \`\${subnetPrefix}.\${host}\` }));
+  }
+  return rules;
 }`,
    badFinding:
      '`src/sdn/subnet-policy.ts:24`: Expands a `/24` subnet rule into 254 individual `/32` host rules, exceeding the physical 128-rule flow table ceiling of the Zodiac FX switch and adding `254 * 4.24 µs` of software MCU lookup latency (violates NET-002 and A7).',
    badSummary:
      'Unaggregated `/32` rule expansion in `src/sdn/subnet-policy.ts` overflows the 128-rule Zodiac FX flow table (violates NET-002).',
    goodDiff: `--- a/src/sdn/subnet-policy.ts
+++ b/src/sdn/subnet-policy.ts
@@ -22,5 +22,12 @@ export function buildSegmentAllowRules(subnet: string, prefixLen: number): readonly IsolationRule[] {
+  if (prefixLen < 16 || prefixLen > 28) {
+    throw new Error(\`prefixLen \${prefixLen} outside aggregated range 16..28\`);
+  }
   return [
     makeRule('p1-intra-subnet', 200, [2, 3], { inPort: 1, etherType: 0x0800, srcIp: subnet, srcIpPrefixLen: prefixLen, dstIp: subnet, dstIpPrefixLen: prefixLen }),
   ];
 }`,
    goodPositive:
      '`src/sdn/subnet-policy.ts:25`: Enforces CIDR prefix aggregation (`16..28`) in a single masked OpenFlow rule, preserving the 128-entry Zodiac FX table budget (NET-002).',
    goodSummary:
      'Enforces CIDR supernet aggregation in `src/sdn/subnet-policy.ts` in compliance with NET-002.',
    falsePositiveWarning: '`src/sdn/subnet-policy.ts:23`: Restricting `prefixLen` to `16..28` disallows `/30` point-to-point links.',
  },
  {
    invariantId: 'NET-003',
    council: 'ccie',
    file: 'src/sdn/openflow-handshake.ts',
    badDiff: `--- a/src/sdn/openflow-handshake.ts
+++ b/src/sdn/openflow-handshake.ts
@@ -31,5 +31,6 @@ export async function onFeaturesReply(session: SwitchSession): Promise<void> {
+  await persistTelemetryEventOrThrow({ event: 'switch_ready', dpid: session.dpid });
   await installPort1IsolationPolicy(session);
 }`,
    badFinding:
      '`src/sdn/openflow-handshake.ts:31`: Blocks `installPort1IsolationPolicy(session)` behind `await persistTelemetryEventOrThrow(...)`, coupling OpenFlow data-plane policy installation to external telemetry database availability (violates NET-003: End-to-End Principle & Fate-Sharing).',
    badSummary:
      'Couples switch flow-table installation to a throwing telemetry database write in `src/sdn/openflow-handshake.ts`, violating NET-003.',
    goodDiff: `--- a/src/sdn/openflow-handshake.ts
+++ b/src/sdn/openflow-handshake.ts
@@ -31,5 +31,6 @@ export async function onFeaturesReply(session: SwitchSession): Promise<void> {
   await installPort1IsolationPolicy(session);
+  void recordSwitchReadyNonBlocking(session.dpid);
 }`,
    goodPositive:
      '`src/sdn/openflow-handshake.ts:31`: Installs the data-plane isolation policy first and dispatches telemetry recording non-blockingly so forwarding never shares fate with telemetry storage (NET-003).',
    goodSummary:
      'Preserves strict fate-sharing isolation between OpenFlow policy installation and telemetry persistence in `src/sdn/openflow-handshake.ts` (NET-003).',
    falsePositiveWarning: '`src/sdn/openflow-handshake.ts:32`: Using `void` on an async telemetry helper does not await completion.',
  },
  {
    invariantId: 'NET-004',
    council: 'ccie',
    file: 'src/sdn/tap-return.ts',
    badDiff: `--- a/src/sdn/tap-return.ts
+++ b/src/sdn/tap-return.ts
@@ -15,5 +15,5 @@ export function buildTapReturnRule(): IsolationRule {
   return {
     id: 'p3-tap-return',
-    flowMod: { command: FlowModCommand.OFPFC_ADD, priority: 100, outputPorts: [1], match: { inPort: 3 } },
+    flowMod: { command: FlowModCommand.OFPFC_ADD, priority: 100, outputPorts: [1, 3], match: { inPort: 3 } },
   };
 }`,
    badFinding:
      '`src/sdn/tap-return.ts:17`: Sets `outputPorts: [1, 3]` on a rule matching `inPort: 3`, creating a hairpin forwarding loop out of Port 3 back into the tap interface (violates NET-004 and property A2).',
    badSummary:
      'Introduces a Port 3 hairpin loop (`inPort: 3 -> outputPorts: [1, 3]`) in `src/sdn/tap-return.ts`, violating NET-004 and A2.',
    goodDiff: `--- a/src/sdn/tap-return.ts
+++ b/src/sdn/tap-return.ts
@@ -15,5 +15,8 @@ export function buildTapReturnRule(): IsolationRule {
   const outputPorts = [1];
+  if (outputPorts.includes(3)) {
+    throw new Error('p3-tap-return must never output back to ingress port 3 (A2 / NET-004)');
+  }
   return {
     id: 'p3-tap-return',
     flowMod: { command: FlowModCommand.OFPFC_ADD, priority: 100, outputPorts, match: { inPort: 3 } },
   };
 }`,
    goodPositive:
      '`src/sdn/tap-return.ts:16`: Explicitly guards against Port 3 hairpin forwarding and returns tap frames strictly to Port 1 (NET-004 & A2).',
    goodSummary:
      'Enforces loop-free tap return forwarding in `src/sdn/tap-return.ts` (NET-004).',
    falsePositiveWarning: '`src/sdn/tap-return.ts:16`: Checking `outputPorts.includes(3)` on a constant array is redundant.',
  },
  {
    invariantId: 'NET-005',
    council: 'ccie',
    file: 'src/sdn/quarantine-priority.ts',
    badDiff: `--- a/src/sdn/quarantine-priority.ts
+++ b/src/sdn/quarantine-priority.ts
@@ -10,5 +10,5 @@ export function buildQuarantineDropRule(srcIp: string): IsolationRule {
   return {
     id: \`quarantine-\${srcIp}\`,
-    flowMod: { command: FlowModCommand.OFPFC_ADD, priority: 65535, outputPorts: [], match: { inPort: 1, etherType: 0x0800, srcIp } },
+    flowMod: { command: FlowModCommand.OFPFC_ADD, priority: 100, outputPorts: [3], match: { inPort: 1, etherType: 0x0800, srcIp } },
   };
 }`,
    badFinding:
      '`src/sdn/quarantine-priority.ts:12`: Lowers quarantine priority from `65535` to `100` (below `PRIORITY_ISOLATION_ALLOW = 200`) and forwards quarantined flood packets to the tap port `[3]` instead of dropping them at ingress (`outputPorts: []`), allowing quarantined traffic to transit Port 2 and consume tap socket buffers (violates NET-005 and A4).',
    badSummary:
      'Places quarantine rule below forwarding priority and copies flood frames to the tap instead of dropping at ingress in `src/sdn/quarantine-priority.ts` (violates NET-005 and A4).',
    goodDiff: `--- a/src/sdn/quarantine-priority.ts
+++ b/src/sdn/quarantine-priority.ts
@@ -10,5 +10,6 @@ export const QUARANTINE_DROP_PRIORITY = 65535;
 export function buildQuarantineDropRule(srcIp: string): IsolationRule {
   return {
     id: \`quarantine-\${srcIp}\`,
     flowMod: { command: FlowModCommand.OFPFC_ADD, priority: QUARANTINE_DROP_PRIORITY, outputPorts: [], match: { inPort: 1, etherType: 0x0800, srcIp } },
   };
 }`,
    goodPositive:
      '`src/sdn/quarantine-priority.ts:13`: Installs quarantine rules at `QUARANTINE_DROP_PRIORITY = 65535` with `outputPorts: []` so malicious traffic is dropped at switch ingress before forwarding or tap buffer allocation (NET-005 & A4).',
    goodSummary:
      'Preserves priority-65535 hardware ingress drop semantics for quarantined sources in `src/sdn/quarantine-priority.ts` (NET-005 & A4).',
    falsePositiveWarning: '`src/sdn/quarantine-priority.ts:10`: Exporting `QUARANTINE_DROP_PRIORITY` increases module surface area.',
  },
  {
    invariantId: 'NET-006',
    council: 'ccie',
    file: 'src/sdn/mirror-vlan-guard.ts',
    badDiff: `--- a/src/sdn/mirror-vlan-guard.ts
+++ b/src/sdn/mirror-vlan-guard.ts
@@ -19,5 +19,5 @@ export function verifyMirrorPortVlanIsolated(mirrorPortVlan: number, dataPlaneVlans: ReadonlySet<number>): boolean {
-  return !dataPlaneVlans.has(mirrorPortVlan);
+  return true;
 }`,
    badFinding:
      '`src/sdn/mirror-vlan-guard.ts:20`: Replaces `!dataPlaneVlans.has(mirrorPortVlan)` with `return true`, allowing a mirror destination port (which accepts ingress on GS105Ev2 silicon) to share an 802.1Q VLAN with the workload or uplink data plane (violates NET-006 and Invariant 4).',
    badSummary:
      'Makes `verifyMirrorPortVlanIsolated` vacuous in `src/sdn/mirror-vlan-guard.ts`, permitting cross-VLAN frame injection via the mirror destination port (violates NET-006 & Invariant 4).',
    goodDiff: `--- a/src/sdn/mirror-vlan-guard.ts
+++ b/src/sdn/mirror-vlan-guard.ts
@@ -19,5 +19,6 @@ export function verifyMirrorPortVlanIsolated(mirrorPortVlan: number, dataPlaneVlans: ReadonlySet<number>): boolean {
+  if (!Number.isInteger(mirrorPortVlan) || mirrorPortVlan < 2 || mirrorPortVlan > 4094) return false;
   return !dataPlaneVlans.has(mirrorPortVlan);
 }`,
    goodPositive:
      '`src/sdn/mirror-vlan-guard.ts:19`: Rejects invalid or default VLAN 1 IDs (`< 2`) and verifies the mirror destination port VLAN is disjoint from all data-plane VLANs (NET-006).',
    goodSummary:
      'Enforces 802.1Q VLAN isolation for mirror destination ports in `src/sdn/mirror-vlan-guard.ts` (NET-006).',
    falsePositiveWarning: '`src/sdn/mirror-vlan-guard.ts:19`: Disallowing VLAN 1 assumes data-plane ports use VLAN 1.',
  },
  {
    invariantId: 'NET-010',
    council: 'ccie',
    file: 'src/sdn/drop-reconciliation.ts',
    badDiff: `--- a/src/sdn/drop-reconciliation.ts
+++ b/src/sdn/drop-reconciliation.ts
@@ -25,6 +25,4 @@ export function reconcileAggregationDrops(hostTxPackets: bigint, switchRxPackets: bigint): bigint {
-  if (hostTxPackets < switchRxPackets) throw new Error('counter regression');
-  return hostTxPackets - switchRxPackets;
+  return 0n;
 }`,
    badFinding:
      '`src/sdn/drop-reconciliation.ts:25`: Hardcodes `return 0n` instead of computing `hostTxPackets - switchRxPackets`, hiding silent buffer tail-drops across the NETGEAR GS105Ev2 1 Gbps -> 100 Mbps Zodiac Port 1 rate transition (violates NET-010 and Invariant 6).',
    badSummary:
      'Suppresses host-to-switch drop reconciliation across the GbE-to-100M speed boundary in `src/sdn/drop-reconciliation.ts`, violating NET-010 and Invariant 6.',
    goodDiff: `--- a/src/sdn/drop-reconciliation.ts
+++ b/src/sdn/drop-reconciliation.ts
@@ -25,5 +25,6 @@ export function reconcileAggregationDrops(hostTxPackets: bigint, switchRxPackets: bigint): bigint {
-  if (hostTxPackets < switchRxPackets) throw new Error('counter regression');
+  if (hostTxPackets < 0n || switchRxPackets < 0n || hostTxPackets < switchRxPackets) {
+    throw new Error(\`reconcileAggregationDrops: invalid counters (hostTx=\${hostTxPackets}, switchRx=\${switchRxPackets})\`);
+  }
   return hostTxPackets - switchRxPackets;
 }`,
    goodPositive:
      '`src/sdn/drop-reconciliation.ts:25`: Validates `BigInt` counter monotonicity and computes exact intervening drops (`hostTxPackets - switchRxPackets`) across the GbE-to-100M aggregation boundary (NET-010 & Invariant 2).',
    goodSummary:
      'Preserves exact `BigInt` host-to-switch drop reconciliation in `src/sdn/drop-reconciliation.ts` (NET-010).',
    falsePositiveWarning: '`src/sdn/drop-reconciliation.ts:26`: Throwing on `hostTxPackets < switchRxPackets` does not account for broadcast frames from other ports.',
  },
];

function formatChangesRequestedReview(finding: string, positive: string, summary: string): string {
  return `## 🔴 Critical Issues
- ${finding}

## 🟠 Warnings
None.

## 🟡 Suggestions
None.

## ✅ Positives
- ${positive}

## 📋 Summary
${summary}
- ❌ CHANGES REQUESTED — must fix critical issues before merging`;
}

function formatApprovedReview(positive: string, summary: string): string {
  return `## 🔴 Critical Issues
None.

## 🟠 Warnings
None.

## 🟡 Suggestions
None.

## ✅ Positives
- ${positive}

## 📋 Summary
${summary}
- ✅ APPROVED — safe to merge`;
}

function buildReviewUserMessage(council: ReviewCouncil, diff: string): string {
  const label = council === 'ccie' ? 'network engineering review' : 'systems review';
  return (
    'Today\'s date is 2026-10-29 (UTC). Timestamps in the diff up to and including today are real, not future dates; flag a date only if it is later than today.\n\n' +
    `Please review the following git diff for the Agentic Era Networking repository according to the ${label} standards:\n\n` +
    `\`\`\`diff\n${diff}\n\`\`\``
  );
}

export function buildReviewerLoraDataset(): ReviewerLoraDataset {
  const sftExamples: ReviewerSftExample[] = [];
  const dpoPairs: ReviewerDpoPair[] = [];
  const counts = new Map<ReviewerInvariantId, { changesRequested: number; approved: number }>(
    REVIEWER_INVARIANTS.map((id) => [id, { changesRequested: 0, approved: 0 }]),
  );

  for (const f of FIXTURES) {
    const sysPrompt = f.council === 'ccie' ? REVIEWER_CCIE_SYSTEM_PROMPT : REVIEWER_TECHNICAL_SYSTEM_PROMPT;

    // 1. Bad diff -> CHANGES_REQUESTED (chosen) vs false approval (rejected)
    const badPrompt: readonly ChatMessage[] = [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: buildReviewUserMessage(f.council, f.badDiff) },
    ];
    const badChosen = formatChangesRequestedReview(
      f.badFinding,
      `Diff is scoped to \`${f.file}\`.`,
      f.badSummary,
    );
    const badRejected = formatApprovedReview(
      `Diff in \`${f.file}\` is concise.`,
      `No blocking issues identified in \`${f.file}\`.`,
    );
    validateReviewFormat(badChosen, 'CHANGES_REQUESTED');
    validateReviewFormat(badRejected, 'APPROVED');

    sftExamples.push({
      id: `${f.invariantId}::bad-diff`,
      invariantId: f.invariantId,
      council: f.council,
      expectedVerdict: 'CHANGES_REQUESTED',
      messages: [...badPrompt, { role: 'assistant', content: badChosen }],
    });
    dpoPairs.push({
      id: `${f.invariantId}::bad-diff`,
      invariantId: f.invariantId,
      council: f.council,
      expectedVerdict: 'CHANGES_REQUESTED',
      prompt: badPrompt,
      chosen: badChosen,
      rejected: badRejected,
    });

    // 2. Good diff -> APPROVED (chosen) vs false-positive CHANGES_REQUESTED (rejected)
    const goodPrompt: readonly ChatMessage[] = [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: buildReviewUserMessage(f.council, f.goodDiff) },
    ];
    const goodChosen = formatApprovedReview(f.goodPositive, f.goodSummary);
    const goodRejected = formatChangesRequestedReview(
      f.falsePositiveWarning,
      f.goodPositive,
      `Flagged a false-positive issue in \`${f.file}\`.`,
    );
    validateReviewFormat(goodChosen, 'APPROVED');
    validateReviewFormat(goodRejected, 'CHANGES_REQUESTED');

    sftExamples.push({
      id: `${f.invariantId}::good-diff`,
      invariantId: f.invariantId,
      council: f.council,
      expectedVerdict: 'APPROVED',
      messages: [...goodPrompt, { role: 'assistant', content: goodChosen }],
    });
    dpoPairs.push({
      id: `${f.invariantId}::good-diff`,
      invariantId: f.invariantId,
      council: f.council,
      expectedVerdict: 'APPROVED',
      prompt: goodPrompt,
      chosen: goodChosen,
      rejected: goodRejected,
    });

    const cur = counts.get(f.invariantId)!;
    counts.set(f.invariantId, {
      changesRequested: cur.changesRequested + 1,
      approved: cur.approved + 1,
    });
  }

  const invariantCounts = Object.fromEntries(
    REVIEWER_INVARIANTS.map((id) => [id, counts.get(id)!]),
  ) as Record<ReviewerInvariantId, { readonly changesRequested: number; readonly approved: number }>;

  return {
    sftExamples,
    dpoPairs,
    summary: {
      schema: 'reviewer-lora-dataset/v1',
      source: 'synthetic_verifier_grounded',
      sftExampleCount: sftExamples.length,
      dpoPairCount: dpoPairs.length,
      invariantCounts,
    },
  };
}
