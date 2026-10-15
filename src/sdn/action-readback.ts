/**
 * action-readback.ts
 * Action-level flow readback: does the switch's own flow table forward each rule where the policy intended?
 *
 * verifyIsolationReadback proves the MATCH half of every rule. This proves the ACTION half, and the table-miss
 * entry, from the instruction block of the same OFPMP_FLOW reply (see flow-actions.ts).
 *
 * The verdict is deliberately three-valued:
 *   confirmed     every intended rule was found, the switch reports instructions, and each rule's output ports
 *                 equal the intent exactly, with nothing else attached (no set-field, group, goto-table ...);
 *                 the table-miss entry drops.
 *   mismatch      the switch reported something different: wrong ports, an extra action or instruction, an
 *                 incomplete block, or a table-miss that outputs somewhere.
 *   unobservable  the reply does not let us say. Either no entry in the reply carried any instruction bytes (the
 *                 switch, or this firmware, may not report them), or some intended rule had no unique entry to
 *                 read. This is NOT a pass.
 *
 * Why "no entry carries instructions" is its own case: a DROP legitimately has no instruction bytes, so on a
 * switch that reports nothing a forwarding rule is indistinguishable from a rule that was installed without its
 * output. Only when SOME entry in the reply does carry instructions can an absence on a forwarding rule be read
 * as a real discrepancy.
 *
 * Whether Zodiac FX firmware 0.86 reports instructions in flow stats has not been measured. Until it has, a live
 * result of `unobservable` is the expected and honest one, and the readback must not be described as proving
 * forwarding intent on that hardware.
 *
 * Pure function, no I/O.
 */

import type { FlowStatsEntry } from './dataplane-benchmark.js';
import { portLabel } from './flow-actions.js';

export interface IntendedActions {
  readonly id: string;
  /** Intended output ports; empty means DROP. */
  readonly outputPorts: readonly number[];
}

export type ActionReadbackStatus = 'confirmed' | 'mismatch' | 'unobservable';

export type TableMissReadback = 'drops' | 'forwards' | 'unrecognised' | 'absent' | 'unobservable';

export interface ActionReadbackVerdict {
  readonly status: ActionReadbackStatus;
  /** Rule ids whose output ports the switch reports exactly as intended. */
  readonly confirmed: readonly string[];
  /** Definitive discrepancies between the intent and what the switch reports. */
  readonly mismatches: readonly string[];
  /** Rule ids whose actions could not be read (no unique entry, or no action information in the reply). */
  readonly unconfirmed: readonly string[];
  /** True when at least one entry in the reply carried instruction bytes. */
  readonly switchReportsActions: boolean;
  readonly tableMiss: TableMissReadback;
}

const sorted = (ports: readonly number[]): number[] => [...ports].sort((a, b) => a - b);
const list = (ports: readonly number[]): string => `[${ports.map(portLabel).join(', ')}]`;

function isTableMiss(e: FlowStatsEntry): boolean {
  return (
    e.priority === 0 &&
    e.inPort === undefined &&
    e.ethType === undefined &&
    e.srcIp === undefined &&
    e.dstIp === undefined
  );
}

/**
 * @param intended rules the policy installed, with their intended outputs
 * @param matched  for each rule id, the single switch entry whose match equals the rule's (rules with no unique
 *                 entry are simply absent from the map; the match-level readback already reports them)
 * @param entries  every entry in the reply, used to decide whether the switch reports instructions at all
 */
export function verifyActionReadback(
  intended: readonly IntendedActions[],
  matched: ReadonlyMap<string, FlowStatsEntry>,
  entries: readonly FlowStatsEntry[],
): ActionReadbackVerdict {
  const switchReportsActions = entries.some((e) => e.actions?.hasInstructions === true);
  const confirmed: string[] = [];
  const mismatches: string[] = [];
  const unconfirmed: string[] = [];

  for (const rule of intended) {
    const entry = matched.get(rule.id);
    const actions = entry?.actions;
    if (entry === undefined || actions === undefined || !switchReportsActions) {
      unconfirmed.push(rule.id);
      continue;
    }
    if (!actions.complete) {
      mismatches.push(`${rule.id}: the switch's instruction block could not be parsed completely`);
      continue;
    }
    if (actions.otherInstructionTypes.length > 0 || actions.otherActionTypes.length > 0) {
      mismatches.push(
        `${rule.id}: switch carries instruction type(s) [${actions.otherInstructionTypes.join(', ')}] and action ` +
          `type(s) [${actions.otherActionTypes.join(', ')}] the policy did not install`,
      );
      continue;
    }
    const want = sorted(rule.outputPorts);
    const got = sorted(actions.outputPorts);
    if (want.length === got.length && want.every((p, i) => p === got[i])) {
      confirmed.push(rule.id);
    } else {
      mismatches.push(
        `${rule.id}: switch outputs to ${got.length === 0 ? 'nothing (drop)' : list(got)}, policy intended ` +
          `${want.length === 0 ? 'nothing (drop)' : list(want)}`,
      );
    }
  }

  let tableMiss: TableMissReadback;
  const miss = entries.find(isTableMiss);
  if (miss === undefined) {
    tableMiss = 'absent';
  } else if (!switchReportsActions || miss.actions === undefined) {
    tableMiss = 'unobservable';
  } else if (!miss.actions.complete || miss.actions.otherInstructionTypes.length > 0 || miss.actions.otherActionTypes.length > 0) {
    tableMiss = 'unrecognised';
    mismatches.push('table-miss: carries instructions or actions that could not be recognised as a drop');
  } else if (miss.actions.outputPorts.length > 0) {
    tableMiss = 'forwards';
    mismatches.push(
      `table-miss: outputs to ${list(sorted(miss.actions.outputPorts))}; the policy relies on table-miss DROP (default-drop)`,
    );
  } else {
    tableMiss = 'drops';
  }

  let status: ActionReadbackStatus;
  if (mismatches.length > 0) status = 'mismatch';
  else if (!switchReportsActions || unconfirmed.length > 0 || tableMiss === 'absent' || tableMiss === 'unobservable') status = 'unobservable';
  else status = 'confirmed';

  return { status, confirmed, mismatches, unconfirmed, switchReportsActions, tableMiss };
}
