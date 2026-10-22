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
import ipaddress
import json
import socket
import subprocess
import sys

WORKLOAD_IFACE = 'eth0'
# Subnets allowed to appear anywhere without being flagged: the workload segment the Zodiac actually mediates when reached through the
# workload interface. Anything else -- another interface entirely, or a second subnet on the SAME interface (node-01's eth0 carries both the
# workload segment and the 10.0.1.0/24 controller segment, which the data-plane policy does not mediate) -- is a potential leak path.
EXPECTED_WORKLOAD_SUBNETS = ['10.0.2.0/24']
# IPv6 link-local: every interface gets one automatically, and the IPv6 spec forbids forwarding it off the local segment (RFC 4291 2.5.6). It
# cannot be used to reach the lab LAN or anywhere off-link, so it is excluded from both checks below rather than being an always-flagged false
# positive on every single interface on every host.
IPV6_LINK_LOCAL = ipaddress.ip_network('fe80::/10')

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
    """Binds a socket to one interface (Linux SO_BINDTODEVICE): traffic on it can leave only through `iface`, regardless of routing. Needs root.
    Refuses to bind to an interface that is not currently present and up, rather than risk a silent no-op or a bind to the wrong device on a typo.
    Raises ValueError for that refusal, RuntimeError if SO_BINDTODEVICE is unavailable, and NetworkStateError (a RuntimeError) if the interface
    state cannot even be read — callers catching RuntimeError get all three; callers catching only ValueError will not catch the state-read case."""
    if not hasattr(socket, 'SO_BINDTODEVICE'):
        raise RuntimeError('SO_BINDTODEVICE is not available on this platform (Linux only); refusing to send unbound')
    present = iface_state()['interfaces']
    if iface not in present or not present[iface]['up']:
        raise ValueError(f'refusing to bind to {iface!r}: it is not a currently up interface on this host (have: {sorted(present)})')
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, iface.encode() + b'\0')


class NetworkStateError(RuntimeError):
    """The host's network state could not be read at all (ip command missing, timed out, or gave unparseable output). preflight() turns this
    into a refusal rather than letting it propagate, per the documented contract: callers always get a dict back, never an exception."""


def _ip_json(*args: str) -> list:
    try:
        out = subprocess.run(['ip', '-json', *args], capture_output=True, text=True, timeout=10, check=True)
        return json.loads(out.stdout or '[]')
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, json.JSONDecodeError, FileNotFoundError) as err:
        raise NetworkStateError(f'`ip -json {" ".join(args)}` failed: {err}') from err


def iface_state() -> dict:
    """What every interface on this host is doing right now: up/down, addresses, and which one (if any) owns the default route. Raises
    NetworkStateError (never a bare exception from `ip` itself) if the state cannot be read; preflight() is the fail-closed wrapper around this."""
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


def _parse_ip(address: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    try:
        return ipaddress.ip_address(address)
    except ValueError:
        return None  # not a parseable IPv4/IPv6 address. Normal `ip -json addr show` output doesn't produce these, but nothing here depends on
        #  that holding for every `ip` version or OS: callers treat an unparseable address as neither link-local nor in any expected subnet,
        #  which is fail-closed in both the places this is used (an unexpected address on the workload interface, or a routable leak elsewhere).


def _is_link_local(address: str) -> bool:
    ip = _parse_ip(address)
    return ip is not None and ip in IPV6_LINK_LOCAL


def _in_any_subnet(address: str, subnets: list) -> bool:
    ip = _parse_ip(address)
    return ip is not None and (ip in IPV6_LINK_LOCAL or any(ip in ipaddress.ip_network(s) for s in subnets))


def _is_routable(address: str) -> bool:
    """False only for link-local (RFC 4291): the one address class that structurally cannot reach anywhere off the local segment, so its
    presence on a non-workload interface is not a leak. An unparseable address is treated as routable (fail-closed: flag it rather than ignore it)."""
    return not _is_link_local(address)


def preflight(iface: str = WORKLOAD_IFACE, expected_subnets: list = EXPECTED_WORKLOAD_SUBNETS) -> dict:
    """
    Returns {ok, refusalReason, workloadIface, state}, always a dict, never an exception (NetworkStateError and any other failure to read the
    state is itself a refusal). `ok` is False when:
      - the state could not be read at all;
      - the workload interface is down (nothing can run);
      - the workload interface itself carries an address outside `expected_subnets` (node-01's eth0 example: the 10.0.1.0/24 controller segment
        sits on the SAME interface as the workload subnet, and the data-plane policy does not mediate it either);
      - ANY other up interface carries ANY address at all. Not just the default-route holder: an on-link route to that interface's own subnet
        lets traffic reach hosts there without ever consulting the default route, so holding the default route is not what makes an interface
        dangerous — having any address reachable outside the workload interface is.
    `ok=False` is a refusal to run, not a warning the caller can choose to ignore — Invariant 3 (fail closed): a scenario whose containment
    cannot be guaranteed is not run.
    """
    try:
        state = iface_state()
    except NetworkStateError as err:
        return {'ok': False, 'refusalReason': f'could not read the network state: {err}', 'workloadIface': iface, 'state': None}

    workload = state['interfaces'].get(iface)
    if workload is None or not workload['up']:
        return {'ok': False, 'refusalReason': f'the workload interface {iface} does not exist or is not up', 'workloadIface': iface, 'state': state}

    unexpected_on_workload = [a for a in workload['addresses'] if not _in_any_subnet(a, expected_subnets)]
    # (link-local addresses are excluded inside _in_any_subnet, not filtered here, so the same rule applies everywhere this helper is used)
    if unexpected_on_workload:
        return {
            'ok': False,
            'refusalReason': f'{iface} itself carries address(es) outside the expected workload subnet(s) {expected_subnets}: '
                              f'{unexpected_on_workload} (not mediated by the data-plane policy either)',
            'workloadIface': iface, 'state': state,
        }

    leaking = {}
    for name, info in state['interfaces'].items():
        if name == iface or not info['up']:
            continue
        # Link-local-only is not a leak (see IPV6_LINK_LOCAL above): an interface with nothing but a link-local address cannot reach the lab
        # LAN or anywhere off-link, so it is not reported here even though it is "up" with "an address".
        routable = [a for a in info['addresses'] if _is_routable(a)]
        if routable:
            leaking[name] = routable
    if leaking:
        return {
            'ok': False,
            'refusalReason': f'interface(s) other than {iface} are up with an address and can reach their subnet without ever using the '
                              f'default route: {leaking}; any traffic not explicitly bound to {iface} may leave through one of these instead',
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
