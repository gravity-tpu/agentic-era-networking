/**
 * flow-stats-fixtures.ts
 * Builders for OFPMP_FLOW reply bytes used by the flow-readback and flow-probe tests.
 *
 * IMPORTANT (Invariant 6): everything built here is a FIXTURE made from the controller's own flow-mod encoding or
 * written by hand. None of it is a capture from the physical switch.
 */

/** One OUTPUT action (16 bytes). */
export function outputAction(port: number): Buffer {
  const b = Buffer.alloc(16);
  b.writeUInt16BE(0, 0);
  b.writeUInt16BE(16, 2);
  b.writeUInt32BE(port, 4);
  return b;
}

/** A non-output action of the given type (16 bytes; content irrelevant to the parser). */
export function otherAction(type: number): Buffer {
  const b = Buffer.alloc(16);
  b.writeUInt16BE(type, 0);
  b.writeUInt16BE(16, 2);
  return b;
}

/** An instruction: 8-byte header (type, len, 4 pad) + body. */
export function instruction(type: number, body: Buffer = Buffer.alloc(0)): Buffer {
  const b = Buffer.alloc(8 + body.length);
  b.writeUInt16BE(type, 0);
  b.writeUInt16BE(8 + body.length, 2);
  body.copy(b, 8);
  return b;
}

export const applyActions = (...actions: Buffer[]): Buffer => instruction(4, Buffer.concat(actions));

/** A flow-stats entry carrying the match bytes of `fm`, then `instructions` (default: what `fm` itself encodes). */
export function entryFrom(fm: Buffer, instructions?: Buffer): Buffer {
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

/** A multipart reply message; `more` sets OFPMPF_REPLY_MORE (more segments with this xid follow). */
export function replyOf(entries: readonly Buffer[], more = false): Buffer {
  const body = Buffer.concat(entries);
  const hdr = Buffer.alloc(16);
  hdr.writeUInt8(4, 0);
  hdr.writeUInt8(19, 1); // OFPT_MULTIPART_REPLY
  hdr.writeUInt16BE(16 + body.length, 2);
  hdr.writeUInt16BE(1, 8); // OFPMP_FLOW
  hdr.writeUInt16BE(more ? 1 : 0, 10);
  return Buffer.concat([hdr, body]);
}

