/**
 * proposer-prompt.ts
 * The prompts scripts/agent-eval.ts sends a model, as pure functions, so a test can pin them. Two versions:
 *
 * - v1: the wording every result before 2026-10-26 was run with (Gemma 4, Haiku 5.5, Qwen3.8 on the 2026-10-18 to 2026-10-25
 *   specifications). It is kept byte for byte: a test reproduces the `promptSha256` recorded in the committed summaries.
 * - v2: v1 plus the two ARP fields the verifier accepts (`arpSpa`, `arpTpa`) and the known workload host addresses. The A10 policy
 *   work (commit 992f3ca) changed INTENT-1, 3 and 4 to require per-host ARP rules, but the v1 prompt never named those fields or
 *   those addresses, so no model could have satisfied them; v2 is the minimum change that makes the task expressible.
 *
 * Pure: no I/O.
 */

import type { IntentSpec } from './intent-spec.js';
import { DEFAULT_WORKLOAD_HOSTS } from './port1-isolation.js';

export type PromptVersion = 'v1' | 'v2' | 'v3';

export const PROPOSER_SYSTEM_PROMPT_V1 = `You write flow rules for a 4-port OpenFlow 1.3 switch (Zodiac FX). Reply with ONE JSON array of rules and nothing else.
Each rule is an object with exactly these fields:
  "id": string, a short unique name
  "priority": integer 0 to 65535 (higher wins when several rules match)
  "outputPorts": array of integers 1 to 4; the ports the packet is sent out of; an empty array means drop
  "match": object, every field optional, a missing field matches anything. Allowed fields:
     "inPort": integer 1 to 4
     "etherType": integer in DECIMAL (IPv4 is 2048, ARP is 2054)
     "srcIp", "dstIp": dotted IPv4 string; "srcIpPrefixLen", "dstIpPrefixLen": integer 1 to 32 (omitted means /32, an exact host)
     "srcMac", "dstMac": "aa:bb:cc:dd:ee:ff"
Rules:
  - A packet that matches no rule is dropped.
  - IPv4 address fields only work together with "etherType": 2048 in the same match.
  - The table holds at most 127 rules.
  - Port layout: port 1 = the untrusted workload segment, port 2 = the uplink to the rest of the network, port 3 = a monitoring tap, port 4 = the controller link (do not use it).`;

const ARP_FIELD_LINE =
  '     "arpSpa", "arpTpa": dotted IPv4 string, the sender or target protocol address inside an ARP packet; each only works together with "etherType": 2054; an exact host only (do not add a prefix length)\n';

/** v1 with one extra line of allowed match fields, inserted after the MAC fields so the rest of the wording is unchanged. */
export const PROPOSER_SYSTEM_PROMPT_V2 = PROPOSER_SYSTEM_PROMPT_V1.replace(
  /(     "srcMac", "dstMac": "aa:bb:cc:dd:ee:ff"\n)/,
  `$1${ARP_FIELD_LINE}`,
);

const ANTISPOOF_RULE_LINE =
  '\n  - Port 1 is an untrusted segment (source addresses may be spoofed): every IPv4 forwarding rule on inPort 1 that outputs to port 2 must constrain "srcIp" (and "srcIpPrefixLen") to the workload segment, and "intra-segment IPv4" means both "srcIp" and "dstIp" are constrained to that segment.';

/** v2 with one extra bullet clarifying anti-spoofing on port 1 and intra-segment IPv4 matching. */
export const PROPOSER_SYSTEM_PROMPT_V3 = `${PROPOSER_SYSTEM_PROMPT_V2}${ANTISPOOF_RULE_LINE}`;

export function proposerPrompts(version: PromptVersion, spec: IntentSpec): { readonly system: string; readonly user: string } {
  if (version === 'v1') {
    return { system: PROPOSER_SYSTEM_PROMPT_V1, user: `Intent: ${spec.description}\nWrite the rule set that implements this intent.` };
  }
  return {
    system: version === 'v3' ? PROPOSER_SYSTEM_PROMPT_V3 : PROPOSER_SYSTEM_PROMPT_V2,
    user:
      `Intent: ${spec.description}\nKnown workload host addresses: ${DEFAULT_WORKLOAD_HOSTS.join(', ')}.\n` +
      'Write the rule set that implements this intent.',
  };
}
