#!/usr/bin/env python3
"""scripts/adversary-bind.py: forces every Track C scenario's traffic through the one interface under test, on the adversary node itself.

Why this exists (found 2026-10-22, docs/ROADMAP.md Track C): the adversary node has a second interface that reaches the lab LAN directly,
bypassing the Zodiac FX entirely. On `agentic-node-01` and `agentic-node-02` this was first `wlan0`; on `agentic-node-02` it is now also a USB
Ethernet adapter (`eth1`) added as a control channel for runs where `wlan0` must be off. **Whichever interface holds the default route is
irrelevant to this problem.** A scenario script that does not explicitly bind its traffic to the workload interface will have anything addressed
outside the workload subnet silently routed out the OTHER interface by the kernel, never touching the switch. A scenario like #1 (ARP spoofing
the gateway "toward the lab LAN") or #6 (uplink-side address aliasing) targets exactly those addresses, so this is not a hypothetical: it is the
single most likely way to get a false "attack succeeded" or "attack failed" that has nothing to do with the switch's policy.

The fix is not "turn the other interface off" (recommended anyway, but not sufficient on its own: a reconnect, a misconfigured service, or a
forgotten flag still leaks). The fix is: every scenario script calls `preflight()` once at the start and records its output in the run's
provenance, and every traffic-generating call in the script explicitly names the workload interface — never trusting the routing table's default
choice. How to do that varies by tool; see TOOL_BINDING_CONVENTIONS below. This module does not generate any traffic itself.

Usage (run ON the adversary node, Python 3 standard library only, no third-party dependencies):
    python3 adversary-bind.py preflight                 # prints the JSON report
    python3 adversary-bind.py preflight --enforce        # same, but exits 1 if the workload interface is down or any other interface could leak
    python3 adversary-bind.py preflight --iface eth0     # override the interface under test (default eth0)

As a library:
    from adversary_bind import WORKLOAD_IFACE, bind_socket, preflight
    report = preflight()
    if not report['ok']:
        raise SystemExit(f"refusing to run: {report['refusalReason']}")
"""

import argparse
import json
import socket
import subprocess
import sys

WORKLOAD_IFACE = 'eth0'

# How to force the workload interface on tools scenario scripts are likely to use. Keep this table honest: when a scenario adds a new tool,
# add its row here rather than assuming a flag "probably" exists. A tool with no reliable binding flag should not be used for scenario traffic.
TOOL_BINDING_CONVENTIONS = {
    'ping': ['-I', WORKLOAD_IFACE],
    'arping': ['-I', WORKLOAD_IFACE],
    'nmap': ['-e', WORKLOAD_IFACE],
    'hping3': ['-I', WORKLOAD_IFACE],
    'tcpdump': ['-i', WORKLOAD_IFACE],
    # scapy: set conf.iface = WORKLOAD_IFACE before building a conf.iroute entry, AND pass iface=WORKLOAD_IFACE to every send()/sendp()/srp()
    #   call explicitly. conf.iface alone is a default, not an enforcement; a call that takes an explicit iface kwarg must get one.
    # python socket (raw or UDP/TCP): call bind_socket(sock, WORKLOAD_IFACE) below, before connect()/sendto(). Requires root (CAP_NET_RAW).
}


def bind_socket(sock: socket.socket, iface: str = WORKLOAD_IFACE) -> None:
    """Binds a socket to one interface (Linux SO_BINDTODEVICE): traffic on it can leave only through `iface`, regardless of routing. Needs root."""
    if not hasattr(socket, 'SO_BINDTODEVICE'):
        raise RuntimeError('SO_BINDTODEVICE is not available on this platform (Linux only); refusing to send unbound')
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, iface.encode() + b'\0')


def _ip_json(*args: str) -> list:
    out = subprocess.run(['ip', '-json', *args], capture_output=True, text=True, timeout=10, check=True)
    return json.loads(out.stdout or '[]')


def iface_state() -> dict:
    """What every interface on this host is doing right now: up/down, addresses, and which one (if any) owns the default route."""
    links = {l['ifname']: l for l in _ip_json('link', 'show')}
    addrs = {a['ifname']: a.get('addr_info', []) for a in _ip_json('addr', 'show')}
    routes = _ip_json('route', 'show', 'default')
    default_devs = sorted({r['dev'] for r in routes if 'dev' in r})
    ifaces = {}
    for name, link in links.items():
        if name == 'lo':
            continue
        flags = link.get('flags', [])
        ifaces[name] = {
            # Administratively up is not the same as carrying traffic: an interface with UP but no LOWER_UP (no carrier - unplugged, no AP
            # association) cannot leak anything right now, even though it could come back without warning. Both are reported, not collapsed.
            'adminUp': 'UP' in flags,
            'up': 'UP' in flags and 'LOWER_UP' in flags,
            'addresses': [a['local'] for a in addrs.get(name, []) if a.get('family') in ('inet', 'inet6')],
        }
    return {'interfaces': ifaces, 'defaultRouteDevices': default_devs}


def preflight(iface: str = WORKLOAD_IFACE) -> dict:
    """
    Returns {ok, refusalReason, workloadIface, state}. `ok` is False when the workload interface is down (nothing can run) or when some OTHER
    up interface holds the default route (a leak risk: unbound traffic goes there, not through `iface`). `ok=False` is a refusal to run, not a
    warning the caller can choose to ignore — Invariant 3 (fail closed): a scenario whose containment cannot be guaranteed is not run.
    """
    state = iface_state()
    workload = state['interfaces'].get(iface)
    if workload is None or not workload['up']:
        return {'ok': False, 'refusalReason': f'the workload interface {iface} does not exist or is not up', 'workloadIface': iface, 'state': state}
    leak_devs = [d for d in state['defaultRouteDevices'] if d != iface]
    if leak_devs:
        others = ', '.join(f"{d} ({', '.join(state['interfaces'].get(d, {}).get('addresses', []) or ['no address'])})" for d in leak_devs)
        return {
            'ok': False,
            'refusalReason': f'{leak_devs[0] if len(leak_devs) == 1 else leak_devs} other than {iface} holds a default route ({others}); '
                              f'any traffic not explicitly bound to {iface} would leave through it instead, bypassing the switch under test',
            'workloadIface': iface, 'state': state,
        }
    return {'ok': True, 'refusalReason': None, 'workloadIface': iface, 'state': state}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('preflight', help='report (and optionally enforce) that scenario traffic can be safely confined to the workload interface')
    p.add_argument('--iface', default=WORKLOAD_IFACE)
    p.add_argument('--enforce', action='store_true', help='exit 1 instead of 0 when the report is not ok')
    args = ap.parse_args()
    if args.cmd == 'preflight':
        report = preflight(args.iface)
        print(json.dumps(report, indent=1))
        if args.enforce and not report['ok']:
            return 1
        return 0
    return 2


if __name__ == '__main__':
    sys.exit(main())
