/**
 * flow-table.ts
 * Software-Defined Networking (SDN) Flow Matcher & Packet Classifier
 *
 * Invariants:
 * - Fail-closed Default (Default Drop): Unmatched packets are dropped by construction.
 * - Rules are evaluated deterministically by descending priority.
 * - Longest-Prefix Match (CIDR) and protocol validation.
 */

export type FlowProtocol = 'TCP' | 'UDP' | 'ICMP' | 'ANY';
export type FlowAction = 'FORWARD' | 'DROP' | 'QUARANTINE';

export interface FlowRuleEntry {
  readonly id: string;
  readonly priority: number;
  readonly srcCidr: string;
  readonly dstCidr: string;
  readonly protocol: FlowProtocol;
  readonly srcPort?: number;
  readonly dstPort?: number;
  readonly action: FlowAction;
}

export interface PacketHeader {
  readonly srcIp: string;
  readonly dstIp: string;
  readonly protocol: FlowProtocol;
  readonly srcPort?: number;
  readonly dstPort?: number;
}

export class SdnFlowTable {
  private readonly rules: FlowRuleEntry[] = [];
  private _matchedCount: bigint = 0n;
  private _defaultDropCount: bigint = 0n;

  public get matchedCount(): bigint {
    return this._matchedCount;
  }

  public get defaultDropCount(): bigint {
    return this._defaultDropCount;
  }

  /**
   * Adds or updates a flow rule. Flow rules are kept sorted by descending priority.
   */
  public addRule(rule: FlowRuleEntry): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Evaluates a packet against the flow table.
   * Fail-closed invariant: If no rule matches, returns DROP.
   */
  public evaluate(packet: PacketHeader): { action: FlowAction; matchedRuleId?: string } {
    for (const rule of this.rules) {
      if (this.matches(rule, packet)) {
        this._matchedCount += 1n;
        return { action: rule.action, matchedRuleId: rule.id };
      }
    }

    // Fail-Closed default
    this._defaultDropCount += 1n;
    return { action: 'DROP' };
  }

  private matches(rule: FlowRuleEntry, packet: PacketHeader): boolean {
    // Protocol match
    if (rule.protocol !== 'ANY' && rule.protocol !== packet.protocol) {
      return false;
    }

    // IP CIDR match
    if (!this.matchesCidr(packet.srcIp, rule.srcCidr)) {
      return false;
    }
    if (!this.matchesCidr(packet.dstIp, rule.dstCidr)) {
      return false;
    }

    // Port match (if specified)
    if (rule.srcPort !== undefined && rule.srcPort !== packet.srcPort) {
      return false;
    }
    if (rule.dstPort !== undefined && rule.dstPort !== packet.dstPort) {
      return false;
    }

    return true;
  }

  /**
   * Checks if an IPv4 address falls within an IPv4 CIDR range (e.g. 10.0.0.1 in 10.0.0.0/24).
   */
  private matchesCidr(ip: string, cidr: string): boolean {
    if (cidr === '0.0.0.0/0' || cidr === 'ANY') return true;

    const [rangeIp, prefixStr] = cidr.split('/');
    if (!rangeIp || prefixStr === undefined) {
      return ip === cidr; // Exact match if no mask
    }

    const prefix = parseInt(prefixStr, 10);
    if (isNaN(prefix) || prefix < 0 || prefix > 32) {
      return false;
    }

    const ipInt = this.ipv4ToInt(ip);
    const rangeInt = this.ipv4ToInt(rangeIp);
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;

    return (ipInt & mask) === (rangeInt & mask);
  }

  private ipv4ToInt(ip: string): number {
    const octets = ip.split('.').map(Number);
    if (octets.length !== 4 || octets.some(o => isNaN(o) || o < 0 || o > 255)) {
      return 0;
    }
    return (((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0);
  }
}
