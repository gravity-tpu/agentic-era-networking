#!/usr/bin/env python3
"""Summarize an ARP capture from `tcpdump -nne -tttt -r <pcap>` text on stdin: every distinct (sender MAC, kind, sender IP, target) with a count
and first and last time, the frames per hour, and any non-ARP line. Counts are integers; nothing is estimated. No packet is sent.

  tcpdump -nne -tttt -r p2-arp.pcap0 | python3 scripts/analyze-arp-capture.py > summary.json
"""
import collections
import json
import re
import sys

ARP = re.compile(r"^(\S+ \S+) (\S+) > (\S+), ethertype ARP")
REQUEST = re.compile(r"Request who-has (\S+) tell (\S+),")
REPLY = re.compile(r"Reply (\S+) is-at (\S+),")
ANNOUNCE = re.compile(r"Announcement (\S+),")


def parse_line(line):
    """Returns (time, key) for an ARP line, or None for anything else. A line that is ARP but neither a request nor a reply keeps its text."""
    m = ARP.match(line)
    if not m:
        return None
    ts, smac, dmac = m.groups()
    r, p, a = REQUEST.search(line), REPLY.search(line), ANNOUNCE.search(line)
    # An announcement is a request whose sender and target address are the same. Linux tcpdump words it as a request and macOS tcpdump as
    # "Announcement", so both are classified the same way and a summary does not depend on which tcpdump produced the text.
    if a:
        return ts, (smac, 'announcement', a.group(1), a.group(1), dmac)
    if r and r.group(1) == r.group(2):
        return ts, (smac, 'announcement', r.group(2), r.group(1), dmac)
    if r:
        return ts, (smac, 'request', r.group(2), r.group(1), dmac)
    if p:
        return ts, (smac, 'reply', p.group(1), p.group(2), dmac)
    return ts, (smac, 'other-arp', line.strip()[:100], '', dmac)


def summarize(lines):
    groups = collections.OrderedDict()
    hours = collections.Counter()
    non_arp = collections.Counter()
    total = 0
    for line in lines:
        if not line.strip():
            continue
        total += 1
        parsed = parse_line(line)
        if parsed is None:
            non_arp[line.strip()[:80]] += 1
            continue
        ts, key = parsed
        g = groups.setdefault(key, {'count': 0, 'first': ts[:19], 'last': ts[:19]})
        g['count'] += 1
        g['last'] = ts[:19]
        hours[ts[:13]] += 1
    senders = [
        {'senderMac': k[0], 'kind': k[1], 'senderIp': k[2], 'target': k[3], 'destMac': k[4], **v}
        for k, v in sorted(groups.items(), key=lambda kv: -kv[1]['count'])
    ]
    return {
        'schema': 'arp-capture-summary/v1', 'frames': total, 'arpFrames': sum(g['count'] for g in groups.values()),
        'nonArpLines': dict(non_arp), 'distinctKinds': len(senders), 'senders': senders, 'framesPerHour': dict(sorted(hours.items())),
    }


if __name__ == '__main__':
    json.dump(summarize(sys.stdin), sys.stdout, indent=2)
    sys.stdout.write('\n')
