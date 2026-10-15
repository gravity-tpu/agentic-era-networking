/**
 * action-readback.test.ts
 * Invariant tests for action-level flow readback: the instruction parser and the verdict built on it.
 *
 * IMPORTANT (Invariant 6): every reply below is a FIXTURE built from the controller's own flow-mod encoding or
 * written by hand. None of it is a capture from the physical switch. Whether Zodiac FX firmware 0.86 reports
 * instructions in flow stats is unmeasured; these tests prove the parser and the verdict logic, not the firmware.
 */

import { describe, it, expect } from 'vitest';
import { buildOfpFlowMod, FlowModCommand } from '../../src/sdn/openflow-types.js';
import { parseFlowStatsReply } from '../../src/sdn/dataplane-benchmark.js';
import { parseEntryActions, portLabel } from '../../src/sdn/flow-actions.js';
import { verifyActionReadback } from '../../src/sdn/action-readback.js';
import {
  buildPort1IsolationPolicy,
  verifyIsolationReadback,
  type IsolationRule,
} from '../../src/sdn/port1-isolation.js';

const OFPP_CONTROLLER = 0xfffffffd;

/** One OUTPUT action (16 bytes). */
function outputAction(port: number): Buffer {
  const b = Buffer.alloc(16);
  b.writeUInt16BE(0, 0);
  b.writeUInt16BE(16, 2);
  b.writeUInt32BE(port, 4);
  return b;
}

/** A non-output action of the given type (16 bytes; content irrelevant to the parser). */
function otherAction(type: number): Buffer {
  const b = Buffer.alloc(16);
  b.writeUInt16BE(type, 0);
  b.writeUInt16BE(16, 2);
  return b;
}

/** An instruction: 8-byte header (type, len, 4 pad) + body. */
function instruction(type: number, body: Buffer = Buffer.alloc(0)): Buffer {
  const b = Buffer.alloc(8 + body.length);
  b.writeUInt16BE(type, 0);
  b.writeUInt16BE(8 + body.length, 2);
  body.copy(b, 8);
  return b;
}

const applyActions = (...actions: Buffer[]): Buffer => instruction(4, Buffer.concat(actions));

/** A flow-stats entry carrying the match bytes of `fm`, then `instructions` (default: what `fm` itself encodes). */
function entryFrom(fm: Buffer, instructions?: Buffer): Buffer {
  const priority = fm.readUInt16BE(30);
  const matchPadded = Math.max(8, Math.ceil(fm.readUInt16BE(50) / 8) * 8);
  const match = fm.subarray(48, 48 + matchPadded);
  const instr = instructions ?? fm.subarray(48 + matchPadded);
  const e = Buffer.alloc(48 + match.length + instr.length);
  e.writeUInt16BE(e.length, 0);
  e.writeUInt16BE(priority, 12);
  match.copy(e, 48);
  instr.copy(e, 48 + match.length);
  return e;
}

function replyOf(entries: readonly Buffer[]): Buffer {
  const body = Buffer.concat(entries);
  const hdr = Buffer.alloc(16);
  hdr.writeUInt8(4, 0);
  hdr.writeUInt8(19, 1); // OFPT_MULTIPART_REPLY
  hdr.writeUInt16BE(16 + body.length, 2);
  hdr.writeUInt16BE(1, 8); // OFPMP_FLOW
  return Buffer.concat([hdr, body]);
}

const policy = buildPort1IsolationPolicy();
const flowMods = policy.map((r, i) => buildOfpFlowMod(r.flowMod, i + 1));
const tableMissMod = buildOfpFlowMod({ command: FlowModCommand.OFPFC_ADD, priority: 0 }, 99);

/** The switch reports exactly what the controller sent. */
const faithful = (): Buffer[] => [entryFrom(tableMissMod), ...flowMods.map((fm) => entryFrom(fm))];

const readback = (entries: readonly Buffer[], rules: readonly IsolationRule[] = policy) =>
  verifyIsolationReadback(rules, parseFlowStatsReply(replyOf(entries)).entries);

describe('instruction parsing', () => {
  it('reads back the output ports of every isolation rule exactly as the controller encoded them', () => {
    const { entries } = parseFlowStatsReply(replyOf(flowMods.map((fm) => entryFrom(fm))));
    policy.forEach((rule, i) => {
      const a = entries[i]?.actions;
      expect(a?.complete, rule.id).toBe(true);
      expect(a?.outputPorts, rule.id).toEqual(rule.flowMod.outputPorts ?? []);
      expect(a?.otherActionTypes).toEqual([]);
      expect(a?.otherInstructionTypes).toEqual([]);
    });
  });

  it('a DROP carries no instruction bytes: hasInstructions is false and the block is complete', () => {
    const { entries } = parseFlowStatsReply(replyOf([entryFrom(tableMissMod)]));
    expect(entries[0]?.actions).toEqual({
      outputPorts: [],
      otherActionTypes: [],
      otherInstructionTypes: [],
      hasInstructions: false,
      complete: true,
    });
  });

  it('records instruction and action types it does not understand instead of skipping them', () => {
    const fm = flowMods[0] as Buffer;
    const withOthers = Buffer.concat([
      applyActions(outputAction(2), otherAction(25), otherAction(22)), // SET_FIELD, GROUP
      instruction(1, Buffer.alloc(8)), // GOTO_TABLE
      instruction(3, Buffer.alloc(0)), // WRITE_ACTIONS
    ]);
    const a = parseFlowStatsReply(replyOf([entryFrom(fm, withOthers)])).entries[0]?.actions;
    expect(a?.complete).toBe(true);
    expect(a?.outputPorts).toEqual([2]);
    expect(a?.otherActionTypes).toEqual([25, 22]);
    expect(a?.otherInstructionTypes).toEqual([1, 3]);
  });

  it('marks truncated or malformed blocks incomplete rather than throwing or guessing', () => {
    const fm = flowMods[0] as Buffer;
    const cases: Array<[string, Buffer]> = [
      ['instruction shorter than its header', Buffer.alloc(4)],
      ['instruction length not a multiple of 8', (() => { const i = applyActions(outputAction(2)); i.writeUInt16BE(20, 2); return i; })()],
      ['instruction length past the entry', (() => { const i = applyActions(outputAction(2)); i.writeUInt16BE(64, 2); return i; })()],
      ['action length past the instruction', (() => { const i = applyActions(outputAction(2)); i.writeUInt16BE(32, 8 + 2); return i; })()],
      ['output action with the wrong length', (() => { const i = applyActions(outputAction(2)); i.writeUInt16BE(24, 8 + 2); return i; })()],
      // Unaligned lengths that tile the block exactly, so no overrun check can catch them: only alignment does.
      ['two unaligned instructions that tile the block', (() => {
        const b = Buffer.alloc(24);
        for (const off of [0, 12]) { b.writeUInt16BE(1, off); b.writeUInt16BE(12, off + 2); }
        return b;
      })()],
      ['two unaligned actions that tile an instruction', (() => {
        const b = Buffer.alloc(8 + 24);
        b.writeUInt16BE(4, 0); b.writeUInt16BE(32, 2);
        for (const off of [8, 20]) { b.writeUInt16BE(25, off); b.writeUInt16BE(12, off + 2); }
        return b;
      })()],
      ['zero-length instruction', (() => { const i = applyActions(outputAction(2)); i.writeUInt16BE(0, 2); return i; })()],
    ];
    for (const [label, block] of cases) {
      const a = parseFlowStatsReply(replyOf([entryFrom(fm, block)])).entries[0]?.actions;
      expect(a?.complete, label).toBe(false);
    }
  });

  it('cannot locate instructions behind a non-OXM or missing match, and says so', () => {
    const e = entryFrom(flowMods[0] as Buffer);
    e.writeUInt16BE(0, 48); // not OFPMT_OXM
    expect(parseEntryActions(e, 48, e.length).complete).toBe(false);
    expect(parseEntryActions(Buffer.alloc(8), 4, 8).complete).toBe(false); // match header would not fit
  });

  it('never throws and never reads out of bounds on arbitrary instruction bytes', () => {
    let seed = 0x2545f491;
    const next = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; // fixed LCG: reproducible, integer only
      return seed >>> 16;
    };
    const fm = flowMods[0] as Buffer;
    for (let n = 0; n < 500; n++) {
      const tail = Buffer.alloc(8 * (1 + (next() % 8)));
      for (let i = 0; i < tail.length; i++) tail[i] = next() & 0xff;
      const e = entryFrom(fm, tail);
      const a = parseEntryActions(e, 48, e.length);
      expect(Array.isArray(a.outputPorts)).toBe(true);
      expect(typeof a.complete).toBe('boolean');
    }
  });

  it('labels reserved ports in diagnostics', () => {
    expect(portLabel(OFPP_CONTROLLER)).toBe('CONTROLLER');
    expect(portLabel(2)).toBe('2');
  });
});

describe('action-level readback verdict', () => {
  it('confirms every rule and the table-miss drop when the switch reports what was sent', () => {
    const v = readback(faithful());
    expect(v.verified).toBe(true);
    expect(v.actions.status).toBe('confirmed');
    expect(v.actions.confirmed).toHaveLength(policy.length);
    expect(v.actions.tableMiss).toBe('drops');
    expect(v.actions.switchReportsActions).toBe(true);
    expect(v.provenForwarding).toBe(true);
  });

  it('is unobservable, not confirmed, when the switch reports no instructions anywhere (match-only reply)', () => {
    const matchOnly = [entryFrom(tableMissMod), ...flowMods.map((fm) => entryFrom(fm, Buffer.alloc(0)))];
    const v = readback(matchOnly);
    expect(v.verified).toBe(true); // match level is unaffected
    expect(v.actions.status).toBe('unobservable');
    expect(v.actions.switchReportsActions).toBe(false);
    expect(v.actions.mismatches).toEqual([]);
    expect(v.provenForwarding).toBe(false);
  });

  it('flags a forwarding rule that lost its output when the switch does report actions elsewhere', () => {
    const entries = faithful();
    const idx = policy.findIndex((r) => r.id === 'p2-ipv4-to-segment') + 1; // +1: table-miss is first
    entries[idx] = entryFrom(flowMods[idx - 1] as Buffer, Buffer.alloc(0));
    const v = readback(entries);
    expect(v.verified).toBe(true); // the match is intact
    expect(v.actions.status).toBe('mismatch');
    expect(v.actions.mismatches.some((m) => m.startsWith('p2-ipv4-to-segment') && m.includes('nothing (drop)'))).toBe(true);
    expect(v.provenForwarding).toBe(false);
  });

  it('flags a tap-only rule that also outputs to the uplink (a leak the match level cannot see)', () => {
    const entries = faithful();
    const idx = policy.findIndex((r) => r.id === 'p1-default-tap-only') + 1;
    entries[idx] = entryFrom(flowMods[idx - 1] as Buffer, applyActions(outputAction(2), outputAction(3)));
    const v = readback(entries);
    expect(v.verified).toBe(true);
    expect(v.actions.status).toBe('mismatch');
    expect(v.actions.mismatches.some((m) => m.startsWith('p1-default-tap-only') && m.includes('[2, 3]') && m.includes('[3]'))).toBe(true);
  });

  it('compares output ports as a set, in any order', () => {
    const entries = faithful();
    const idx = policy.findIndex((r) => r.id === 'p1-arp') + 1; // intended [2, 3]
    entries[idx] = entryFrom(flowMods[idx - 1] as Buffer, applyActions(outputAction(3), outputAction(2)));
    expect(readback(entries).actions.status).toBe('confirmed');
  });

  it('does not accept a repeated port as equal to a single one', () => {
    const entries = faithful();
    const idx = policy.findIndex((r) => r.id === 'p3-tap-return') + 1; // intended [1]
    entries[idx] = entryFrom(flowMods[idx - 1] as Buffer, applyActions(outputAction(1), outputAction(1)));
    expect(readback(entries).actions.status).toBe('mismatch');
  });

  it('flags an extra action or instruction the policy never installed', () => {
    const entries = faithful();
    entries[1] = entryFrom(flowMods[0] as Buffer, applyActions(outputAction(2), outputAction(3), otherAction(25)));
    entries[2] = entryFrom(flowMods[1] as Buffer, Buffer.concat([applyActions(outputAction(2), outputAction(3)), instruction(1, Buffer.alloc(8))]));
    const v = readback(entries);
    expect(v.actions.status).toBe('mismatch');
    expect(v.actions.mismatches).toHaveLength(2);
    expect(v.actions.mismatches[0]).toContain('action type(s) [25]');
    expect(v.actions.mismatches[1]).toContain('instruction type(s) [1]');
  });

  it('flags an incomplete instruction block as a mismatch', () => {
    const entries = faithful();
    const bad = applyActions(outputAction(2), outputAction(3));
    bad.writeUInt16BE(20, 2);
    entries[1] = entryFrom(flowMods[0] as Buffer, bad);
    const v = readback(entries);
    expect(v.actions.status).toBe('mismatch');
    expect(v.actions.mismatches[0]).toContain('could not be parsed completely');
  });

  it('flags a table-miss that outputs anywhere, including a punt to the controller', () => {
    const entries = faithful();
    entries[0] = entryFrom(tableMissMod, applyActions(outputAction(OFPP_CONTROLLER)));
    const v = readback(entries);
    expect(v.verified).toBe(true);
    expect(v.actions.tableMiss).toBe('forwards');
    expect(v.actions.status).toBe('mismatch');
    expect(v.actions.mismatches.some((m) => m.startsWith('table-miss') && m.includes('CONTROLLER'))).toBe(true);
    expect(v.provenForwarding).toBe(false);
  });

  it('reports a missing table-miss as absent and does not confirm', () => {
    const v = readback(faithful().slice(1));
    expect(v.actions.tableMiss).toBe('absent');
    expect(v.actions.status).toBe('unobservable');
    expect(v.verified).toBe(false);
  });

  it('fails closed on two table-miss entries, whichever order the reply lists them in', () => {
    const forwarding = entryFrom(tableMissMod, applyActions(outputAction(OFPP_CONTROLLER)));
    for (const order of [[entryFrom(tableMissMod), forwarding], [forwarding, entryFrom(tableMissMod)]]) {
      const v = readback([...order, ...flowMods.map((fm) => entryFrom(fm))]);
      expect(v.actions.tableMiss).toBe('unrecognised');
      expect(v.actions.status).toBe('mismatch');
      expect(v.actions.mismatches.some((m) => m.includes('2 priority-0 wildcard entries'))).toBe(true);
    }
  });

  it('a real port mismatch outranks an absent table-miss: mismatch, not unobservable', () => {
    const entries = faithful();
    const idx = policy.findIndex((r) => r.id === 'p1-arp') + 1;
    entries[idx] = entryFrom(flowMods[idx - 1] as Buffer, applyActions(outputAction(2))); // intended [2, 3]
    const v = readback(entries.slice(1)); // and no table-miss entry
    expect(v.actions.tableMiss).toBe('absent');
    expect(v.actions.status).toBe('mismatch');
  });

  it('lists a rule with no unique switch entry as unconfirmed, never confirmed', () => {
    const v = readback(faithful().filter((_, i) => i !== 1)); // drop the first policy rule
    expect(v.verified).toBe(false);
    expect(v.actions.unconfirmed).toContain('p1-ipv4-intra-segment');
    expect(v.actions.status).toBe('unobservable');
    expect(v.provenForwarding).toBe(false);
  });

  it('treats hand-built entries that carry no action information as unconfirmed', () => {
    const entries = parseFlowStatsReply(replyOf(faithful())).entries.map(({ actions: _actions, ...rest }) => rest);
    const v = verifyIsolationReadback(policy, entries);
    expect(v.verified).toBe(true);
    expect(v.actions.status).toBe('unobservable');
    expect(v.actions.switchReportsActions).toBe(false);
  });

  it('verifyActionReadback alone: nothing intended and a clean table-miss is confirmed only if the switch reports', () => {
    const entries = parseFlowStatsReply(replyOf([entryFrom(tableMissMod), entryFrom(flowMods[0] as Buffer)])).entries;
    expect(verifyActionReadback([], new Map(), entries).status).toBe('confirmed');
    const matchOnly = parseFlowStatsReply(replyOf([entryFrom(tableMissMod)])).entries;
    expect(verifyActionReadback([], new Map(), matchOnly).status).toBe('unobservable');
  });
});
