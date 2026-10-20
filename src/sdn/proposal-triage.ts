/**
 * proposal-triage.ts
 * Turns the text a model proposes into a verdict under the pre-registered failure taxonomy
 * (docs/research/evaluation-plan.md section 7), using the existing deterministic checks. Pure: no I/O.
 *
 * What a verdict proves: the rule set parses, fits the table, and over every packet class the rules and the
 * intent can distinguish (src/sdn/intent-spec.ts) it has no hairpin, no equal-priority conflict, no shadowed
 * rule and no leak or omission. What it does not prove: anything about how the Zodiac FX firmware behaves (that is
 * the conformance probe, track B), and A8 (the cost model is `unverifiable` for most proposed shapes).
 *
 * Invariant 3 (fail closed): a proposal a check cannot evaluate is not admissible (`ERR_UNCHECKABLE`).
 * Deviation from the pre-registered taxonomy, disclosed where the results are published: `ERR_SHADOWED` (A5) and
 * `ERR_UNCHECKABLE` were not listed, so they are added rather than folded into another category.
 */

import { FlowModCommand } from './openflow-types.js';
import type { FlowModMatchOptions } from './openflow-types.js';
import type { IsolationRule } from './port1-isolation.js';
import { checkIntent } from './intent-spec.js';
import type { IntentSpec } from './intent-spec.js';
import { checkRuleHygiene } from './rule-hygiene.js';
import { checkRuleBudget } from './capacity-budget.js';
import { FLOW_TABLE_CAPACITY } from './dataplane-benchmark.js';

export const MAX_PROPOSAL_CHARS = 200_000;
export const MAX_PORT = 4;

export type FailureCategory =
  | 'ERR_SYNTAX'
  | 'ERR_TABLE_OVERFLOW'
  | 'ERR_PREREQUISITE'
  | 'ERR_HAIRPIN'
  | 'ERR_AMBIGUITY'
  | 'ERR_SHADOWED'
  | 'ERR_INTENT_LEAK'
  | 'ERR_INTENT_MISSING'
  | 'ERR_UNCHECKABLE';

/** Fixed precedence: the first applicable category is the primary one; all applicable ones are kept. */
export const CATEGORY_PRECEDENCE: readonly FailureCategory[] = [
  'ERR_SYNTAX', 'ERR_TABLE_OVERFLOW', 'ERR_PREREQUISITE', 'ERR_HAIRPIN', 'ERR_AMBIGUITY', 'ERR_SHADOWED', 'ERR_INTENT_LEAK', 'ERR_INTENT_MISSING', 'ERR_UNCHECKABLE',
];

export type ParsedProposal =
  | { readonly ok: true; readonly rules: readonly IsolationRule[] }
  | { readonly ok: false; readonly category: 'ERR_SYNTAX'; readonly detail: string };

export interface Triage {
  readonly category: 'ADMISSIBLE' | FailureCategory;
  readonly categories: readonly FailureCategory[];
  readonly details: readonly string[];
}

const RULE_KEYS = new Set(['id', 'priority', 'outputPorts', 'match']);
const MATCH_KEYS = new Set(['inPort', 'etherType', 'srcIp', 'srcIpPrefixLen', 'dstIp', 'dstIpPrefixLen', 'srcMac', 'dstMac']);
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const MAC = /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/;

const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const syntax = (detail: string): ParsedProposal => ({ ok: false, category: 'ERR_SYNTAX', detail });

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (c === undefined) continue;
    const start = c.search(/[[{]/);
    if (start < 0) continue;
    const body = c.slice(start);
    const end = Math.max(body.lastIndexOf(']'), body.lastIndexOf('}'));
    if (end < 0) continue;
    try {
      return JSON.parse(body.slice(0, end + 1)) as unknown;
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
    }
  }
  return undefined;
}

/** Strict schema check. Anything the verifiers would have to guess about is ERR_SYNTAX. */
export function parseProposal(text: string): ParsedProposal {
  if (text.length > MAX_PROPOSAL_CHARS) return syntax(`proposal longer than ${MAX_PROPOSAL_CHARS} characters`);
  const json = extractJson(text);
  if (json === undefined) return syntax('no JSON found');
  const list = Array.isArray(json) ? json : (json as { rules?: unknown }).rules;
  if (!Array.isArray(list) || list.length === 0) return syntax('expected a non-empty array of rules');
  const rules: IsolationRule[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of list.entries()) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return syntax(`rule ${i} is not an object`);
    const r = raw as Record<string, unknown>;
    for (const k of Object.keys(r)) if (!RULE_KEYS.has(k)) return syntax(`rule ${i}: unknown field ${k}`);
    if (typeof r['id'] !== 'string' || r['id'].length === 0 || r['id'].length > 80) return syntax(`rule ${i}: id must be a short string`);
    if (seen.has(r['id'])) return syntax(`rule ${i}: duplicate id ${r['id']}`);
    seen.add(r['id']);
    if (!isInt(r['priority'], 0, 65535)) return syntax(`rule ${r['id']}: priority must be an integer 0 to 65535`);
    const out = r['outputPorts'];
    if (!Array.isArray(out) || !out.every((p) => isInt(p, 1, MAX_PORT)) || out.length > MAX_PORT) return syntax(`rule ${r['id']}: outputPorts must be a list of ports 1 to ${MAX_PORT}`);
    const m = r['match'];
    if (m === null || typeof m !== 'object' || Array.isArray(m)) return syntax(`rule ${r['id']}: match must be an object`);
    const mm = m as Record<string, unknown>;
    for (const k of Object.keys(mm)) if (!MATCH_KEYS.has(k)) return syntax(`rule ${r['id']}: unknown match field ${k}`);
    if (mm['inPort'] !== undefined && !isInt(mm['inPort'], 1, MAX_PORT)) return syntax(`rule ${r['id']}: inPort must be 1 to ${MAX_PORT}`);
    if (mm['etherType'] !== undefined && !isInt(mm['etherType'], 0, 65535)) return syntax(`rule ${r['id']}: etherType must be an integer 0 to 65535 (decimal)`);
    for (const k of ['srcIp', 'dstIp'] as const) if (mm[k] !== undefined && (typeof mm[k] !== 'string' || !IPV4.test(mm[k] as string))) return syntax(`rule ${r['id']}: ${k} is not a dotted IPv4 address`);
    for (const k of ['srcIpPrefixLen', 'dstIpPrefixLen'] as const) if (mm[k] !== undefined && !isInt(mm[k], 1, 32)) return syntax(`rule ${r['id']}: ${k} must be 1 to 32`);
    for (const k of ['srcMac', 'dstMac'] as const) if (mm[k] !== undefined && (typeof mm[k] !== 'string' || !MAC.test(mm[k] as string))) return syntax(`rule ${r['id']}: ${k} is not a MAC address`);
    rules.push({
      id: r['id'],
      flowMod: { command: FlowModCommand.OFPFC_ADD, priority: r['priority'], outputPorts: out as number[], match: mm as FlowModMatchOptions },
    });
  }
  return { ok: true, rules };
}

/** The JSON a model is asked to produce, for a rule set (used by the prompt example and the tests). */
export function proposalFromRules(rules: readonly IsolationRule[]): string {
  return JSON.stringify(rules.map((r) => ({ id: r.id, priority: r.flowMod.priority, outputPorts: r.flowMod.outputPorts ?? [], match: r.flowMod.match ?? {} })));
}

export function triageProposal(rules: readonly IsolationRule[], spec: IntentSpec): Triage {
  const found = new Set<FailureCategory>();
  const details: string[] = [];
  const add = (c: FailureCategory, d: string): void => { found.add(c); details.push(`${c}: ${d}`); };

  // Table budget: the plan's limit is 128 rules; the quarantine reserve is not charged against a proposal here.
  if (checkRuleBudget(rules, { quarantineReserve: 0, capacity: FLOW_TABLE_CAPACITY - 1 }).satisfied === false) {
    add('ERR_TABLE_OVERFLOW', `${rules.length} rules plus the table-miss entry do not fit ${FLOW_TABLE_CAPACITY} entries`);
  }
  for (const r of rules) {
    const m = r.flowMod.match;
    if (m?.inPort !== undefined && (r.flowMod.outputPorts ?? []).includes(m.inPort)) add('ERR_HAIRPIN', `${r.id} outputs to its own ingress port ${m.inPort}`);
  }
  try {
    for (const v of checkRuleHygiene(rules).violations) {
      if (v.property === 'prerequisite') add('ERR_PREREQUISITE', `${v.ruleIds.join(',')}: ${v.detail}`);
      else if (v.kind === 'shadowed') add('ERR_SHADOWED', `${v.ruleIds.join(',')}: ${v.detail}`);
      else if (v.kind === 'conflict' || v.kind === 'duplicate-key') add('ERR_AMBIGUITY', `${v.ruleIds.join(',')}: ${v.detail}`);
      else add('ERR_UNCHECKABLE', `${v.ruleIds.join(',')}: ${v.detail}`);
    }
    for (const v of checkIntent(rules, spec).violations) {
      if (v.kind === 'leak') add('ERR_INTENT_LEAK', `${v.clauseId} via ${v.ruleIds.join(',') || 'table-miss'}: ${v.detail}`);
      else if (v.kind === 'missing') add('ERR_INTENT_MISSING', `${v.clauseId}: ${v.detail}`);
      else if (v.kind === 'ambiguous') add('ERR_AMBIGUITY', `${v.clauseId}: ${v.detail}`);
      else add('ERR_PREREQUISITE', `${v.ruleIds.join(',')}: ${v.detail}`);
    }
  } catch (e) {
    // A verifier refusing the input (class budget, malformed rule) means the proposal could not be checked: not admissible.
    add('ERR_UNCHECKABLE', e instanceof Error ? e.message : String(e));
  }
  const categories = CATEGORY_PRECEDENCE.filter((c) => found.has(c));
  return { category: categories[0] ?? 'ADMISSIBLE', categories, details };
}
