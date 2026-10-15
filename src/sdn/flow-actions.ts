/**
 * flow-actions.ts
 * Parses the instruction block of an OFPMP_FLOW reply entry (OpenFlow 1.3 section 7.3.5.2) into what the entry
 * does: which ports it outputs to, and whether it carries anything this project did not install.
 *
 * Flow-stats readback has so far proved only the MATCH half of a rule. This is the ACTION half. It parses what
 * the controller itself encodes (src/sdn/openflow-types.ts): one OFPIT_APPLY_ACTIONS instruction holding
 * OFPAT_OUTPUT actions, or no instruction at all for a DROP.
 *
 * Fail-closed (Invariant 3): the parser never throws and never guesses. A malformed, truncated or unfamiliar
 * block yields `complete: false`, and an instruction or action type other than APPLY_ACTIONS and OUTPUT is
 * recorded rather than skipped, so a caller cannot read "no outputs seen" as "drops" when the entry also carries
 * a GROUP, SET_FIELD or WRITE_ACTIONS it did not understand.
 *
 * Pure functions, no I/O. Bounded: the block cannot exceed the 16-bit entry length.
 */

export const OFPIT_APPLY_ACTIONS = 4;
export const OFPAT_OUTPUT = 0;

const INSTRUCTION_HEADER_LEN = 8;
const ACTION_HEADER_LEN = 4;
const OUTPUT_ACTION_LEN = 16;

/** Reserved OpenFlow 1.3 port numbers, for readable diagnostics. */
const RESERVED_PORTS: Readonly<Record<number, string>> = {
  0xfffffff8: 'IN_PORT',
  0xfffffff9: 'TABLE',
  0xfffffffa: 'NORMAL',
  0xfffffffb: 'FLOOD',
  0xfffffffc: 'ALL',
  0xfffffffd: 'CONTROLLER',
  0xfffffffe: 'LOCAL',
  0xffffffff: 'ANY',
};

export const portLabel = (port: number): string => RESERVED_PORTS[port] ?? String(port);

export interface FlowStatsActions {
  /** Output ports, in order, from OFPAT_OUTPUT actions inside OFPIT_APPLY_ACTIONS instructions. */
  readonly outputPorts: readonly number[];
  /** Action types other than OUTPUT found inside APPLY_ACTIONS (set-field, group, push-vlan, ...). */
  readonly otherActionTypes: readonly number[];
  /** Instruction types other than APPLY_ACTIONS (goto-table, write-actions, meter, ...). */
  readonly otherInstructionTypes: readonly number[];
  /** True when the entry carries any instruction bytes at all. False means the reply gave no action information. */
  readonly hasInstructions: boolean;
  /** True when the whole block parsed to its end. False means the outputs above cannot be trusted as complete. */
  readonly complete: boolean;
}

const EMPTY: FlowStatsActions = {
  outputPorts: [],
  otherActionTypes: [],
  otherInstructionTypes: [],
  hasInstructions: false,
  complete: true,
};

const incomplete = (hasInstructions: boolean): FlowStatsActions => ({ ...EMPTY, hasInstructions, complete: false });

/**
 * Parses the instructions of one flow-stats entry. `matchOff` is the offset of its ofp_match; instructions follow
 * the match, padded to an 8-byte boundary, and run to `entryEnd`.
 */
export function parseEntryActions(packet: Buffer, matchOff: number, entryEnd: number): FlowStatsActions {
  if (matchOff + 4 > entryEnd || entryEnd > packet.length) return incomplete(false);
  if (packet.readUInt16BE(matchOff) !== 1) return incomplete(false); // not OFPMT_OXM: cannot locate the instructions
  const matchLen = packet.readUInt16BE(matchOff + 2);
  if (matchLen < 4) return incomplete(false);
  const instrStart = matchOff + Math.max(8, Math.ceil(matchLen / 8) * 8);
  if (instrStart > entryEnd) return incomplete(false);
  if (instrStart === entryEnd) return EMPTY;

  const outputPorts: number[] = [];
  const otherActionTypes: number[] = [];
  const otherInstructionTypes: number[] = [];
  let ok = true;

  let p = instrStart;
  while (p < entryEnd) {
    if (p + INSTRUCTION_HEADER_LEN > entryEnd) {
      ok = false;
      break;
    }
    const type = packet.readUInt16BE(p);
    const len = packet.readUInt16BE(p + 2);
    if (len < INSTRUCTION_HEADER_LEN || len % 8 !== 0 || p + len > entryEnd) {
      ok = false;
      break;
    }
    if (type !== OFPIT_APPLY_ACTIONS) {
      otherInstructionTypes.push(type);
      p += len;
      continue;
    }
    const actionsEnd = p + len;
    let a = p + INSTRUCTION_HEADER_LEN;
    while (a < actionsEnd) {
      if (a + ACTION_HEADER_LEN > actionsEnd) {
        ok = false;
        break;
      }
      const aType = packet.readUInt16BE(a);
      const aLen = packet.readUInt16BE(a + 2);
      if (aLen < 8 || aLen % 8 !== 0 || a + aLen > actionsEnd) {
        ok = false;
        break;
      }
      if (aType === OFPAT_OUTPUT) {
        if (aLen !== OUTPUT_ACTION_LEN) {
          ok = false;
          break;
        }
        outputPorts.push(packet.readUInt32BE(a + 4));
      } else {
        otherActionTypes.push(aType);
      }
      a += aLen;
    }
    if (!ok) break;
    p = actionsEnd;
  }

  return { outputPorts, otherActionTypes, otherInstructionTypes, hasInstructions: true, complete: ok };
}
