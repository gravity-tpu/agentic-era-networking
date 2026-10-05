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

export interface FlowModMatchOptions {
  readonly srcMac?: string | undefined;
  readonly dstMac?: string | undefined;
  readonly srcIp?: string | undefined;
  /** CIDR prefix length for `srcIp` (1..32). Omitted or 32 = exact host match. */
  readonly srcIpPrefixLen?: number | undefined;
  readonly dstIp?: string | undefined;
  readonly etherType?: number | undefined;
  readonly inPort?: number | undefined;
}

export interface FlowModOptions {
  readonly command: FlowModCommand;
  readonly priority: number;
  readonly idleTimeout?: number | undefined;
  readonly hardTimeout?: number | undefined;
  readonly cookie?: bigint | undefined;
  readonly tableId?: number | undefined;
  readonly outPort?: number | undefined;
  readonly outputPorts?: readonly number[] | undefined;
  readonly match?: FlowModMatchOptions | undefined;
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

function parseMacToBuffer(mac: string): Buffer {
  const isAllColons = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(mac);
  const isAllHyphens = /^([0-9A-Fa-f]{2}-){5}[0-9A-Fa-f]{2}$/.test(mac);
  if (!isAllColons && !isAllHyphens) {
    throw new Error(`Invalid MAC address format (expected uniform colon or hyphen-separated 6 two-hex-digit octets): "${mac}"`);
  }
  const parts = isAllColons ? mac.split(':') : mac.split('-');
  const bytes = parts.map((hex) => parseInt(hex, 16));
  return Buffer.from(bytes);
}

function parseIpv4ToBuffer(ip: string): Buffer {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p))) {
    throw new Error(`Invalid IPv4 address format (expected 4 decimal octets): "${ip}"`);
  }
  const octets = parts.map(Number);
  if (octets.some((o) => isNaN(o) || o < 0 || o > 255)) {
    throw new Error(`IPv4 octet out of range [0-255]: "${ip}"`);
  }
  return Buffer.from(octets);
}

/**
 * Builds an OpenFlow 1.3 OFPT_FLOW_MOD message with typed OXM match fields
 * (ETH_SRC, ETH_DST, ETH_TYPE, IPV4_SRC, IPV4_DST) and fail-closed instruction encoding.
 *
 * Council Invariant 3 (Fail-Closed Isolation):
 * If a requested match field cannot be parsed, this function strictly throws an error rather than
 * omitting the field. Omitting match criteria would degrade the rule to a wildcard match,
 * causing a targeted quarantine rule to blackhole all network traffic.
 */
export function buildOfpFlowMod(options: FlowModOptions, xid: number): Buffer {
  const oxmTlvs: Buffer[] = [];
  const match = options.match;

  if (match) {
    if (match.srcMac) {
      const macBuf = parseMacToBuffer(match.srcMac);
      // OFPXMT_OFB_ETH_SRC: class 0x8000, field 4 (<< 9), length 6 -> 0x80000806
      const tlv = Buffer.alloc(10);
      tlv.writeUInt32BE(0x80000806, 0);
      macBuf.copy(tlv, 4);
      oxmTlvs.push(tlv);
    }

    if (match.dstMac) {
      const macBuf = parseMacToBuffer(match.dstMac);
      // OFPXMT_OFB_ETH_DST: class 0x8000, field 3 (<< 9), length 6 -> 0x80000606
      const tlv = Buffer.alloc(10);
      tlv.writeUInt32BE(0x80000606, 0);
      macBuf.copy(tlv, 4);
      oxmTlvs.push(tlv);
    }

    let ethType = match.etherType;
    if (ethType === undefined && (match.srcIp || match.dstIp)) {
      ethType = 0x0800; // IPv4 required before L3 match in OpenFlow 1.3
    }

    if (ethType !== undefined) {
      // OFPXMT_OFB_ETH_TYPE: class 0x8000, field 5 (<< 9), length 2 -> 0x80000a02
      const tlv = Buffer.alloc(6);
      tlv.writeUInt32BE(0x80000a02, 0);
      tlv.writeUInt16BE(ethType, 4);
      oxmTlvs.push(tlv);
    }

    if (match.srcIp) {
      const ipBuf = parseIpv4ToBuffer(match.srcIp);
      const prefixLen = match.srcIpPrefixLen;
      if (prefixLen === undefined || prefixLen === 32) {
        // OFPXMT_OFB_IPV4_SRC: class 0x8000, field 11 (<< 9), length 4 -> 0x80001604
        const tlv = Buffer.alloc(8);
        tlv.writeUInt32BE(0x80001604, 0);
        ipBuf.copy(tlv, 4);
        oxmTlvs.push(tlv);
      } else {
        if (!Number.isInteger(prefixLen) || prefixLen < 1 || prefixLen > 31) {
          throw new Error(`srcIpPrefixLen must be an integer in 1..32, got ${prefixLen}`);
        }
        const mask = (0xffffffff << (32 - prefixLen)) >>> 0;
        // OpenFlow 1.3 requires value bits outside the mask to be zero; a silently
        // widened/narrowed match would change which traffic a DROP rule hits.
        if ((ipBuf.readUInt32BE(0) & ~mask) >>> 0 !== 0) {
          throw new Error(`srcIp ${match.srcIp} has host bits set outside /${prefixLen}`);
        }
        // OFPXMT_OFB_IPV4_SRC with HASMASK: field 11 -> (11 << 1) | 1 = 0x17, length 8 -> 0x80001708
        const tlv = Buffer.alloc(12);
        tlv.writeUInt32BE(0x80001708, 0);
        ipBuf.copy(tlv, 4);
        tlv.writeUInt32BE(mask, 8);
        oxmTlvs.push(tlv);
      }
    }

    if (match.dstIp) {
      const ipBuf = parseIpv4ToBuffer(match.dstIp);
      // OFPXMT_OFB_IPV4_DST: class 0x8000, field 12 (<< 9), length 4 -> 0x80001804
      const tlv = Buffer.alloc(8);
      tlv.writeUInt32BE(0x80001804, 0);
      ipBuf.copy(tlv, 4);
      oxmTlvs.push(tlv);
    }

    if (match.inPort !== undefined) {
      // OFPXMT_OFB_IN_PORT: class 0x8000, field 0 (<< 9), length 4 -> 0x80000004
      const tlv = Buffer.alloc(8);
      tlv.writeUInt32BE(0x80000004, 0);
      tlv.writeUInt32BE(match.inPort, 4);
      oxmTlvs.push(tlv);
    }
  }

  const oxmPayload = Buffer.concat(oxmTlvs);
  // Match header is 4 bytes: type (2B) + length (2B).
  // Total matchLen = 4 + oxmPayload.length.
  const matchLen = 4 + oxmPayload.length;
  // Padded to 8-byte boundary per OpenFlow 1.3 spec
  const matchPaddedLen = Math.max(8, Math.ceil(matchLen / 8) * 8);

  // Each OUTPUT action is 16 bytes; each instruction header is 8 bytes.
  // OFPIT_APPLY_ACTIONS instruction: 8-byte header + (16 bytes × N output ports).
  const ports = options.outputPorts ?? [];
  const hasOutputActions = ports.length > 0;
  const instructionLen = hasOutputActions ? 8 + 16 * ports.length : 0;

  const totalLength = 48 + matchPaddedLen + instructionLen;
  const buf = Buffer.alloc(totalLength);

  // Header (8 bytes)
  buf.writeUInt8(OFP_VERSION_1_3, 0);
  buf.writeUInt8(OpenFlowType.OFPT_FLOW_MOD, 1);
  buf.writeUInt16BE(totalLength, 2);
  buf.writeUInt32BE(xid, 4);

  // Flow Mod Body (40 bytes)
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

  // Match header: type=1 (OFPMT_OXM), length=matchLen
  buf.writeUInt16BE(1, 48);
  buf.writeUInt16BE(matchLen, 50);
  if (oxmPayload.length > 0) {
    oxmPayload.copy(buf, 52);
  }

  if (hasOutputActions) {
    // Guard: OFPP_CONTROLLER in outputPorts would send 0 bytes of the frame (max_len=0) to the
    // controller, which is almost certainly a bug. Use sendTableMissRule for controller output.
    for (const port of ports) {
      if (port === OFPP_CONTROLLER) {
        throw new Error('buildOfpFlowMod outputPorts must not include OFPP_CONTROLLER; use sendTableMissRule instead');
      }
    }

    // OFPIT_APPLY_ACTIONS instruction (OpenFlow 1.3 §7.2.5)
    const instrOffset = 48 + matchPaddedLen;
    buf.writeUInt16BE(InstructionType.OFPIT_APPLY_ACTIONS, instrOffset);
    buf.writeUInt16BE(instructionLen, instrOffset + 2);
    buf.writeUInt32BE(0, instrOffset + 4); // pad

    let actionOffset = instrOffset + 8;
    for (const port of ports) {
      // OFPAT_OUTPUT action: type(2) + len(2) + port(4) + max_len(2) + pad(6) = 16 bytes
      buf.writeUInt16BE(ActionType.OFPAT_OUTPUT, actionOffset);
      buf.writeUInt16BE(16, actionOffset + 2);
      buf.writeUInt32BE(port, actionOffset + 4);
      buf.writeUInt16BE(0, actionOffset + 8); // max_len = 0 (full frame, non-controller)
      buf.writeUInt32BE(0, actionOffset + 10); // pad
      buf.writeUInt16BE(0, actionOffset + 14); // pad
      actionOffset += 16;
    }
  }

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
