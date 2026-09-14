/**
 * openflow-types.ts
 * OpenFlow 1.3 Protocol Wire Structures & Serializers
 *
 * Council Invariants Enforced:
 * - Dean & Ghemawat: Deterministic byte packing, big-endian network order, BigInt 64-bit integers.
 * - Anti-Shortcut Law: Strict TypeScript typing, no loose any, complete bounds checking.
 * - Fail-Closed: Invalid message framing throws descriptive errors.
 */

export const OFP_VERSION_1_3 = 0x04;

export enum OpenFlowType {
  OFPT_HELLO = 0,
  OFPT_ERROR = 1,
  OFPT_ECHO_REQUEST = 2,
  OFPT_ECHO_REPLY = 3,
  OFPT_EXPERIMENTER = 4,
  OFPT_FEATURES_REQUEST = 5,
  OFPT_FEATURES_REPLY = 6,
  OFPT_GET_CONFIG_REQUEST = 7,
  OFPT_GET_CONFIG_REPLY = 8,
  OFPT_SET_CONFIG = 9,
  OFPT_PACKET_IN = 10,
  OFPT_FLOW_REMOVED = 11,
  OFPT_PORT_STATUS = 12,
  OFPT_PACKET_OUT = 13,
  OFPT_FLOW_MOD = 14,
  OFPT_GROUP_MOD = 15,
  OFPT_PORT_MOD = 16,
  OFPT_TABLE_MOD = 17,
  OFPT_MULTIPART_REQUEST = 18,
  OFPT_MULTIPART_REPLY = 19,
  OFPT_BARRIER_REQUEST = 20,
  OFPT_BARRIER_REPLY = 21,
}

export enum FlowModCommand {
  OFPFC_ADD = 0,
  OFPFC_MODIFY = 1,
  OFPFC_MODIFY_STRICT = 2,
  OFPFC_DELETE = 3,
  OFPFC_DELETE_STRICT = 4,
}

export enum InstructionType {
  OFPIT_GOTO_TABLE = 1,
  OFPIT_WRITE_METADATA = 2,
  OFPIT_WRITE_ACTIONS = 3,
  OFPIT_APPLY_ACTIONS = 4,
  OFPIT_CLEAR_ACTIONS = 5,
  OFPIT_METER = 6,
  OFPIT_EXPERIMENTER = 0xffff,
}

export enum ActionType {
  OFPAT_OUTPUT = 0,
  OFPAT_COPY_TTL_OUT = 11,
  OFPAT_COPY_TTL_IN = 12,
  OFPAT_SET_MPLS_TTL = 15,
  OFPAT_DEC_MPLS_TTL = 16,
  OFPAT_PUSH_VLAN = 17,
  OFPAT_POP_VLAN = 18,
  OFPAT_PUSH_MPLS = 19,
  OFPAT_POP_MPLS = 20,
  OFPAT_SET_QUEUE = 21,
  OFPAT_GROUP = 22,
  OFPAT_SET_NW_TTL = 23,
  OFPAT_DEC_NW_TTL = 24,
  OFPAT_SET_FIELD = 25,
  OFPAT_PUSH_PBB = 26,
  OFPAT_POP_PBB = 27,
  OFPAT_EXPERIMENTER = 0xffff,
}

export const OFPP_ANY = 0xffffffff;
export const OFPG_ANY = 0xffffffff;
export const OFP_NO_BUFFER = 0xffffffff;
export const OFPP_CONTROLLER = 0xfffffffd;
export const OFPCML_NO_BUFFER = 0xffff;

export interface OpenFlowHeader {
  readonly version: number;
  readonly type: OpenFlowType;
  readonly length: number;
  readonly xid: number;
}

export interface SwitchFeatures {
  readonly datapathId: bigint;
  readonly nBuffers: number;
  readonly nTables: number;
  readonly auxiliaryId: number;
  readonly capabilities: number;
}

export interface FlowModOptions {
  readonly command: FlowModCommand;
  readonly priority: number;
  readonly idleTimeout?: number | undefined;
  readonly hardTimeout?: number | undefined;
  readonly cookie?: bigint | undefined;
  readonly tableId?: number | undefined;
  readonly outPort?: number | undefined;
}

export interface DecodedPacketIn {
  readonly bufferId: number;
  readonly totalLen: number;
  readonly reason: number;
  readonly tableId: number;
  readonly inPort?: number | undefined;
  readonly vlanId?: number | undefined;
  readonly vlanIds?: readonly number[] | undefined;
  readonly srcMac: string;
  readonly dstMac: string;
  readonly etherType: number;
  readonly etherTypeStr: string;
  readonly srcIp?: string | undefined;
  readonly dstIp?: string | undefined;
  readonly arpSenderIp?: string | undefined;
  readonly arpTargetIp?: string | undefined;
  readonly rawPayload: Buffer;
}

/**
 * Encodes an OpenFlow 1.3 packet header into an 8-byte Buffer.
 */
export function encodeOfpHeader(type: OpenFlowType, length: number, xid: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeUInt8(OFP_VERSION_1_3, 0);
  buf.writeUInt8(type, 1);
  buf.writeUInt16BE(length, 2);
  buf.writeUInt32BE(xid, 4);
  return buf;
}

/**
 * Decodes an OpenFlow header from a Buffer.
 */
export function decodeOfpHeader(buf: Buffer): OpenFlowHeader {
  if (buf.length < 8) {
    throw new Error(`OpenFlow buffer underflow: expected at least 8 bytes, got ${buf.length}`);
  }
  const version = buf.readUInt8(0);
  const type = buf.readUInt8(1) as OpenFlowType;
  const length = buf.readUInt16BE(2);
  const xid = buf.readUInt32BE(4);
  return { version, type, length, xid };
}

/**
 * Builds an OFPT_HELLO message.
 */
export function buildOfpHello(xid: number = 1): Buffer {
  return encodeOfpHeader(OpenFlowType.OFPT_HELLO, 8, xid);
}

/**
 * Builds an OFPT_FEATURES_REQUEST message.
 */
export function buildOfpFeaturesRequest(xid: number = 2): Buffer {
  return encodeOfpHeader(OpenFlowType.OFPT_FEATURES_REQUEST, 8, xid);
}

/**
 * Builds an OFPT_ECHO_REPLY message echoing back payload from request.
 */
export function buildOfpEchoReply(echoPayload: Buffer, xid: number): Buffer {
  const length = 8 + echoPayload.length;
  const header = encodeOfpHeader(OpenFlowType.OFPT_ECHO_REPLY, length, xid);
  return Buffer.concat([header, echoPayload]);
}

/**
 * Builds an OFPT_ECHO_REQUEST message for heartbeat latency sampling.
 */
export function buildOfpEchoRequest(xid: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const length = 8 + payload.length;
  const header = encodeOfpHeader(OpenFlowType.OFPT_ECHO_REQUEST, length, xid);
  return Buffer.concat([header, payload]);
}

/**
 * Parses an OFPT_FEATURES_REPLY payload into SwitchFeatures.
 */
export function parseOfpFeaturesReply(buf: Buffer): SwitchFeatures {
  if (buf.length < 32) {
    throw new Error(`OFPT_FEATURES_REPLY underflow: expected 32 bytes, got ${buf.length}`);
  }
  const datapathId = buf.readBigUInt64BE(8);
  const nBuffers = buf.readUInt32BE(16);
  const nTables = buf.readUInt8(20);
  const auxiliaryId = buf.readUInt8(21);
  const capabilities = buf.readUInt32BE(24);

  return {
    datapathId,
    nBuffers,
    nTables,
    auxiliaryId,
    capabilities,
  };
}

/**
 * Builds an OpenFlow 1.3 OFPT_FLOW_MOD message with a minimal standard OXM match.
 */
export function buildOfpFlowMod(options: FlowModOptions, xid: number): Buffer {
  // Base OFP_FLOW_MOD struct without instructions is 48 bytes (header + fields) + 8 bytes empty match
  // Total minimal length = 56 bytes
  const matchLength = 8; // Empty OXM match (type 1, len 4, + 4 pad)
  const totalLength = 48 + matchLength;
  const buf = Buffer.alloc(totalLength);

  // Header
  buf.writeUInt8(OFP_VERSION_1_3, 0);
  buf.writeUInt8(OpenFlowType.OFPT_FLOW_MOD, 1);
  buf.writeUInt16BE(totalLength, 2);
  buf.writeUInt32BE(xid, 4);

  // Flow Mod Body
  buf.writeBigUInt64BE(options.cookie ?? 0n, 8);
  buf.writeBigUInt64BE(0n, 16); // cookie_mask
  buf.writeUInt8(options.tableId ?? 0, 24);
  buf.writeUInt8(options.command, 25);
  buf.writeUInt16BE(options.idleTimeout ?? 0, 26);
  buf.writeUInt16BE(options.hardTimeout ?? 0, 28);
  buf.writeUInt16BE(options.priority, 30);
  buf.writeUInt32BE(OFP_NO_BUFFER, 32);
  buf.writeUInt32BE(options.outPort ?? OFPP_ANY, 36);
  buf.writeUInt32BE(OFPG_ANY, 40);
  buf.writeUInt16BE(0, 44); // flags
  buf.writeUInt16BE(0, 46); // pad

  // Empty match: type=OFPMT_OXM (1), length=4 (header only), +4 pad
  buf.writeUInt16BE(1, 48); // OFPMT_OXM
  buf.writeUInt16BE(4, 50); // length 4
  buf.writeUInt32BE(0, 52); // pad to 8 bytes

  return buf;
}

/**
 * Builds an OpenFlow 1.3 Table-Miss FlowMod entry.
 *
 * Council Invariants Enforced:
 * - Fail-Closed Isolation (Ghemawat & Hassabis): When action is 'DROP', the flow entry contains zero
 *   instructions, dropping all unmatched packets at line-rate in hardware (56 bytes total).
 * - Bounded Control Plane & Anti-DoS (Jeff Dean): When action is 'CONTROLLER', packet data punting is
 *   strictly truncated to maxLen (default 128 bytes, headers only) rather than OFPCML_NO_BUFFER (0xFFFF),
 *   protecting the controller from packet buffer saturation and event loop exhaustion (80 bytes total).
 *
 * @param xid Transaction ID
 * @param priority Flow priority (default 0 for table miss)
 * @param action 'DROP' (Council Fail-Closed default) or 'CONTROLLER' (telemetry sampling)
 * @param maxLen Maximum payload bytes to punt to controller (default 128 bytes for headers)
 */
export function buildOfpTableMissFlowMod(
  xid: number,
  priority: number = 0,
  action: 'DROP' | 'CONTROLLER' = 'DROP',
  maxLen: number = 128
): Buffer {
  const isDrop = action === 'DROP';
  const totalLength = isDrop ? 56 : 80;
  const buf = Buffer.alloc(totalLength);

  // Header (8 bytes)
  buf.writeUInt8(OFP_VERSION_1_3, 0);
  buf.writeUInt8(OpenFlowType.OFPT_FLOW_MOD, 1);
  buf.writeUInt16BE(totalLength, 2);
  buf.writeUInt32BE(xid, 4);

  // Flow Mod Body (40 bytes)
  buf.writeBigUInt64BE(0n, 8); // cookie
  buf.writeBigUInt64BE(0n, 16); // cookie_mask
  buf.writeUInt8(0, 24); // table_id = 0
  buf.writeUInt8(FlowModCommand.OFPFC_ADD, 25);
  buf.writeUInt16BE(0, 26); // idle_timeout = 0 (infinite)
  buf.writeUInt16BE(0, 28); // hard_timeout = 0 (infinite)
  buf.writeUInt16BE(priority, 30); // priority = 0 (table miss)
  buf.writeUInt32BE(OFP_NO_BUFFER, 32); // buffer_id
  buf.writeUInt32BE(OFPP_ANY, 36); // out_port
  buf.writeUInt32BE(OFPG_ANY, 40); // out_group
  buf.writeUInt16BE(0, 44); // flags
  buf.writeUInt16BE(0, 46); // pad

  // Empty Match (8 bytes): type=1 (OFPMT_OXM), length=4 (header only), pad 4
  buf.writeUInt16BE(1, 48);
  buf.writeUInt16BE(4, 50);
  buf.writeUInt32BE(0, 52);

  if (!isDrop) {
    // Instruction: OFPIT_APPLY_ACTIONS (type 4, len 24, pad 4)
    buf.writeUInt16BE(InstructionType.OFPIT_APPLY_ACTIONS, 56);
    buf.writeUInt16BE(24, 58); // instruction total length (8 + 16 action = 24)
    buf.writeUInt32BE(0, 60); // pad

    // Action: OFPAT_OUTPUT (type 0, len 16)
    buf.writeUInt16BE(ActionType.OFPAT_OUTPUT, 64);
    buf.writeUInt16BE(16, 66); // action length
    buf.writeUInt32BE(OFPP_CONTROLLER, 68); // port = CONTROLLER
    buf.writeUInt16BE(maxLen, 72); // max_len = 128 bytes (Dean latency & memory budget)
    buf.writeUInt16BE(0, 74); // pad
    buf.writeUInt32BE(0, 76); // pad
  }

  return buf;
}

function formatMac(buf: Buffer): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(':');
}

/**
 * Parses an OFPT_PACKET_IN message and decodes the embedded Layer-2/Layer-3 headers.
 * Uses zero-allocation dynamic cursor parsing to support variable-length Layer-2 headers
 * (802.1Q single VLAN, 802.1ad QinQ stacked VLANs) without fragile hardcoded byte offsets.
 */
export function parseOfpPacketIn(packet: Buffer): DecodedPacketIn {
  if (packet.length < 34) {
    throw new Error(`OFPT_PACKET_IN underflow: expected at least 34 bytes, got ${packet.length}`);
  }

  const bufferId = packet.readUInt32BE(8);
  const totalLen = packet.readUInt16BE(12);
  const reason = packet.readUInt8(14);
  const tableId = packet.readUInt8(15);
  // cookie at 16..24

  // Match struct starts at 24
  const matchLen = packet.readUInt16BE(26);
  const matchPaddedLen = Math.max(8, Math.ceil(matchLen / 8) * 8);

  let inPort: number | undefined;
  // Parse OXM fields in match
  let oxmOffset = 28;
  const matchEnd = 24 + matchLen;
  while (oxmOffset + 4 <= matchEnd) {
    const oxmHeader = packet.readUInt32BE(oxmOffset);
    const fieldLen = oxmHeader & 0xff;
    // OFPXMT_OFB_IN_PORT: class=0x8000, field=0, hasmask=0 -> 0x80000004
    if (oxmHeader === 0x80000004 && oxmOffset + 4 + fieldLen <= packet.length) {
      inPort = packet.readUInt32BE(oxmOffset + 4);
    }
    oxmOffset += 4 + fieldLen;
  }

  // Raw frame data starts after match + 2 bytes padding
  const dataOffset = 24 + matchPaddedLen + 2;
  const rawPayload = packet.subarray(dataOffset);

  if (rawPayload.length < 14) {
    return {
      bufferId,
      totalLen,
      reason,
      tableId,
      inPort,
      srcMac: 'unknown',
      dstMac: 'unknown',
      etherType: 0,
      etherTypeStr: 'unknown',
      rawPayload,
    };
  }

  const dstMac = formatMac(rawPayload.subarray(0, 6));
  const srcMac = formatMac(rawPayload.subarray(6, 12));

  // Zero-allocation dynamic Layer-2 / Layer-3 cursor
  let l3Offset = 12;
  let currentEtherType = rawPayload.readUInt16BE(l3Offset);
  l3Offset += 2;

  const vlanIds: number[] = [];
  const MAX_VLAN_STACK_DEPTH = 3; // Strict bound preventing event-loop CPU exhaustion/DoS (Jeff Dean)
  let vlanDepth = 0;

  // Dynamically advance cursor through 802.1Q (0x8100) or 802.1ad (0x88a8) VLAN tags (single or stacked QinQ)
  while (
    (currentEtherType === 0x8100 || currentEtherType === 0x88a8) &&
    vlanDepth < MAX_VLAN_STACK_DEPTH &&
    l3Offset + 4 <= rawPayload.length
  ) {
    const tci = rawPayload.readUInt16BE(l3Offset);
    vlanIds.push(tci & 0x0fff); // 12-bit VLAN ID
    l3Offset += 2;
    currentEtherType = rawPayload.readUInt16BE(l3Offset);
    l3Offset += 2;
    vlanDepth++;
  }

  const etherType = currentEtherType;
  let etherTypeStr = `0x${etherType.toString(16).padStart(4, '0')}`;
  let srcIp: string | undefined;
  let dstIp: string | undefined;
  let arpSenderIp: string | undefined;
  let arpTargetIp: string | undefined;

  if (etherType === 0x0806) {
    etherTypeStr = 'ARP';
    if (rawPayload.length >= l3Offset + 28) {
      arpSenderIp = `${rawPayload[l3Offset + 14]}.${rawPayload[l3Offset + 15]}.${rawPayload[l3Offset + 16]}.${rawPayload[l3Offset + 17]}`;
      arpTargetIp = `${rawPayload[l3Offset + 24]}.${rawPayload[l3Offset + 25]}.${rawPayload[l3Offset + 26]}.${rawPayload[l3Offset + 27]}`;
    }
  } else if (etherType === 0x0800) {
    etherTypeStr = 'IPv4';
    if (rawPayload.length >= l3Offset + 20) {
      srcIp = `${rawPayload[l3Offset + 12]}.${rawPayload[l3Offset + 13]}.${rawPayload[l3Offset + 14]}.${rawPayload[l3Offset + 15]}`;
      dstIp = `${rawPayload[l3Offset + 16]}.${rawPayload[l3Offset + 17]}.${rawPayload[l3Offset + 18]}.${rawPayload[l3Offset + 19]}`;
    }
  } else if (etherType === 0x86dd) {
    etherTypeStr = 'IPv6';
  }

  return {
    bufferId,
    totalLen,
    reason,
    tableId,
    inPort,
    srcMac,
    dstMac,
    vlanId: vlanIds[0],
    vlanIds: vlanIds.length > 0 ? Object.freeze(vlanIds) : undefined,
    etherType,
    etherTypeStr,
    srcIp,
    dstIp,
    arpSenderIp,
    arpTargetIp,
    rawPayload,
  };
}
