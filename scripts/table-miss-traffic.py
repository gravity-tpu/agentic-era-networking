#!/usr/bin/env python3
"""What does a frame that matches no rule do while the table-miss is in a given state?

Sends FRAMES raw Ethernet frames with the IEEE 802 local experimental ethertype 0x88b5 (neither IPv4 nor ARP, so no rule of the isolation policy matches it and it
reaches the table-miss) from agentic-node-01's uplink NIC into the Zodiac's port 2, and counts what arrives at each observer:
  O3   the Jetson NIC on switch #2's mirror of the Zodiac P2 link (control: the frames really were on the link),
  O2   the Jetson NIC on the Zodiac P3 tap (a frame forwarded out of port 3),
  O4   agentic-node-01 eth0 and rpi-hailo eth0, both on the workload side (a frame forwarded out of port 1).
Needs ssh to jetson, agentic-node-01 and rpi-hailo (passwordless sudo on the last two), and the wire-campaign VLAN arrangement on switch #2: node-01's uplink NIC
(switch port 2) in the same VLAN as the Zodiac's P2 link (port 4), and port 3 (the mirror of that link) in its own VLAN. With the normal arrangement node-01 eth1 is on the household LAN and the
frames never reach the Zodiac; the O3 control then reads 0 and the run is not valid.
Usage: python3 scripts/table-miss-traffic.py LABEL [--wait-for-fault]    (--wait-for-fault: wait for the bridge's "TEST FAULT ACTIVE" line first, then send at once)
Prints one JSON line.
"""
import json, subprocess, sys, time

JETSON, NODE01, LISTENER = 'jetson', 'agentic-node-01', 'rpi-hailo'
UPLINK_IF = 'eth1'
O2_IF, O3_IF = 'enx9c69d39dd0a6', 'enx9c69d39ddcc0'
FRAMES, SPACING_S, CAPTURE_S = 20, 0.1, 22
ETHERTYPE = 0x88b5
SRC_MAC, DST_MAC = '02:00:00:00:00:77', '02:00:00:00:be:ef'  # locally administered; nothing on the lab answers either
WAIT_FOR_FAULT_S = 240

def ssh(host, cmd, timeout=90):
    return subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host, cmd], capture_output=True, text=True, timeout=timeout).stdout

def frame_hex(n):
    mac = lambda m: bytes(int(x, 16) for x in m.split(':'))
    payload = f'zodiac-table-miss-traffic {n:04d}'.encode().ljust(46, b'.')
    return (mac(DST_MAC) + mac(SRC_MAC) + ETHERTYPE.to_bytes(2, 'big') + payload).hex()

def status():
    try:
        d = json.loads(ssh(JETSON, 'curl -s -m 8 localhost:3003/api/zodiac/flows'))
        p = d['port1Isolation']
        return {'state': p.get('state'), 'tableMiss': (p.get('actions') or {}).get('tableMiss')}
    except Exception as e:  # report, never hide, a status that could not be read
        return {'error': str(e)[:120]}

def main():
    if len(sys.argv) < 2 or sys.argv[1].startswith('--'):
        print(__doc__); return 2
    label = sys.argv[1]
    if '--wait-for-fault' in sys.argv:
        t0 = ssh(JETSON, 'date +%s').strip()
        deadline = time.monotonic() + WAIT_FOR_FAULT_S
        while time.monotonic() < deadline:
            if int(ssh(JETSON, f'journalctl -u zodiac-bridge --no-pager --since @{t0} | grep -c "TEST FAULT ACTIVE"').strip() or 0) >= 1: break
            time.sleep(2)
        else:
            print(json.dumps({'label': label, 'error': 'no TEST FAULT ACTIVE line within the wait'})); return 1
    flt = f'ether proto 0x88b5 and ether src {SRC_MAC}'
    obs = {'O3_p2_mirror': (JETSON, O3_IF, False), 'O2_p3_tap': (JETSON, O2_IF, False), 'O4_node01_eth0': (NODE01, 'eth0', True), 'O4_rpi_hailo_eth0': (LISTENER, 'eth0', True)}
    for name, (host, iface, sudo) in obs.items():
        f = f'/tmp/tm-traffic-{name}'
        ssh(host, f"rm -f {f}.txt {f}.err; ({'sudo -n ' if sudo else ''}timeout {CAPTURE_S} tcpdump -i {iface} -nn -e -l '{flt}' > {f}.txt 2> {f}.err &)")
    time.sleep(4)  # captures are listening
    before = status()
    sender = "import socket, time\ns = socket.socket(socket.AF_PACKET, socket.SOCK_RAW)\ns.bind(('%s', 0))\nfor h in [%s]:\n    s.send(bytes.fromhex(h))\n    time.sleep(%s)\nprint('sent')\n" % (UPLINK_IF, ', '.join(repr(frame_hex(i)) for i in range(FRAMES)), SPACING_S)
    sent = subprocess.run(['ssh', '-o', 'BatchMode=yes', NODE01, 'sudo -n python3 -'], input=sender, capture_output=True, text=True, timeout=60).stdout.strip()
    after = status()
    time.sleep(max(1, CAPTURE_S - 4 - FRAMES * SPACING_S - 2))
    counts = {}
    for name, (host, iface, sudo) in obs.items():
        out = ssh(host, f"grep -c '88b5' /tmp/tm-traffic-{name}.txt; head -c 200 /tmp/tm-traffic-{name}.err | head -2").split('\n')  # count captured frame lines, not blank lines
        counts[name] = int(out[0].strip() or 0)
        if len(out) > 1 and 'error' in ' '.join(out[1:]).lower(): counts[name + '_capture_error'] = ' '.join(out[1:])[:120]
    print(json.dumps({'label': label, 'frames_sent': FRAMES, 'sender': sent, 'counts': counts, 'status_before': before, 'status_after': after, 'at': time.strftime('%H:%M:%S')}))
    return 0

if __name__ == '__main__':
    sys.exit(main())
