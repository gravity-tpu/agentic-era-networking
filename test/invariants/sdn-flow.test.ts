import { describe, it, expect } from 'vitest';
import { SdnFlowTable, FlowRuleEntry, PacketHeader } from '../../src/sdn/flow-table.js';

describe('Invariant: SDN Flow Table & Fail-Closed Default Drop', () => {
  it('enforces Fail-Closed Default Drop when no rules match packet', () => {
    const table = new SdnFlowTable();

    const packet: PacketHeader = {
      srcIp: '192.168.1.100',
      dstIp: '10.0.0.5',
      protocol: 'TCP',
      srcPort: 54321,
      dstPort: 443,
    };

    const result = table.evaluate(packet);
    expect(result.action).toBe('DROP');
    expect(table.defaultDropCount).toBe(1n);
    expect(table.matchedCount).toBe(0n);
  });

  it('evaluates flow rules by descending priority order', () => {
    const table = new SdnFlowTable();

    // Lower priority allows all traffic
    table.addRule({
      id: 'rule-low-allow',
      priority: 10,
      srcCidr: '0.0.0.0/0',
      dstCidr: '0.0.0.0/0',
      protocol: 'ANY',
      action: 'FORWARD',
    });

    // Higher priority drops specific subnet
    table.addRule({
      id: 'rule-high-block',
      priority: 100,
      srcCidr: '10.200.0.0/16',
      dstCidr: '0.0.0.0/0',
      protocol: 'ANY',
      action: 'DROP',
    });

    const blockedPacket: PacketHeader = {
      srcIp: '10.200.4.12',
      dstIp: '8.8.8.8',
      protocol: 'UDP',
    };

    const allowedPacket: PacketHeader = {
      srcIp: '192.168.1.50',
      dstIp: '8.8.8.8',
      protocol: 'UDP',
    };

    const evalBlocked = table.evaluate(blockedPacket);
    expect(evalBlocked.action).toBe('DROP');
    expect(evalBlocked.matchedRuleId).toBe('rule-high-block');

    const evalAllowed = table.evaluate(allowedPacket);
    expect(evalAllowed.action).toBe('FORWARD');
    expect(evalAllowed.matchedRuleId).toBe('rule-low-allow');
  });

  it('matches CIDR subnets with bitwise precision', () => {
    const table = new SdnFlowTable();

    table.addRule({
      id: 'cluster-internal',
      priority: 50,
      srcCidr: '10.0.1.0/24',
      dstCidr: '10.0.2.0/24',
      protocol: 'TCP',
      dstPort: 8080,
      action: 'FORWARD',
    });

    // Matches subnet
    expect(table.evaluate({
      srcIp: '10.0.1.25',
      dstIp: '10.0.2.99',
      protocol: 'TCP',
      dstPort: 8080,
    }).action).toBe('FORWARD');

    // Mismatched destination subnet
    expect(table.evaluate({
      srcIp: '10.0.1.25',
      dstIp: '10.0.3.99',
      protocol: 'TCP',
      dstPort: 8080,
    }).action).toBe('DROP');

    // Mismatched port
    expect(table.evaluate({
      srcIp: '10.0.1.25',
      dstIp: '10.0.2.99',
      protocol: 'TCP',
      dstPort: 9000,
    }).action).toBe('DROP');
  });
});
