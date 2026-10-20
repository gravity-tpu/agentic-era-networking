#!/usr/bin/env python3
"""Live test (owner-authorized 2026-10-20) of WHEN an experimental rule disappears if the bridge cannot restore it.
Install ONE rule (in port 1, IPv4 -> port 3, priority 100) with a 10 s bridge-side limit (so the rule carries a 40 s switch-side hard timeout),
FREEZE the bridge with SIGSTOP (its OpenFlow connection stays up, but its restore cannot run), send one UDP datagram per second from node-01
for 70 s, and capture at O2 with epoch timestamps. While the rule exists the datagrams are copied to the tap (seen at O2); once it is gone the
table-miss drops them. The last second a datagram is seen at O2 is when the rule was removed. About 40 s after the install = the hard timeout;
earlier = something else (for example the switch flushing its table when the controller stops answering). The bridge is resumed afterwards."""
import json, subprocess, sys, time, urllib.request

BRIDGE = 'http://127.0.0.1:13003'
TOKEN = open('/Users/andymorven/.zodiac-experiment-token').read().strip()
O2 = 'enx9c69d39dd0a6'
TAG = 41999
SECONDS = 70


def post(path, body):
    req = urllib.request.Request(BRIDGE + path, data=json.dumps(body).encode(), headers={'x-experiment-token': TOKEN, 'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.status, json.loads(r.read())


def get(path):
    req = urllib.request.Request(BRIDGE + path, headers={'x-experiment-token': TOKEN})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def ssh(host, cmd, timeout=120):
    return subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, cmd], capture_output=True, text=True, timeout=timeout).stdout


mac_ip = subprocess.run(['ipconfig', 'getifaddr', 'en0'], capture_output=True, text=True).stdout.strip()
pid = ssh('jetson', 'ss -ltnp | grep ":3003" | sed -E "s/.*pid=([0-9]+).*/\\1/" | head -1').strip()
print('bridge pid', pid, '| Mac ip', mac_ip, flush=True)
# capture first (Jetson), then the sender on node-01, both running in the background on their hosts
ssh('jetson', f"rm -f /tmp/hardtimeout-O2.txt; (timeout {SECONDS + 12} tcpdump -tt -i {O2} -nn -l 'udp dst port {TAG}' > /tmp/hardtimeout-O2.txt 2>/dev/null &); sleep 1; echo capture-started")
status, rep = post('/api/experiment/install', {'label': 'hard-timeout freeze test: one rule, in 1 IPv4 -> port 3, 10 s limit', 'ttlSeconds': 10,
                   'rules': [{'id': 'probe-p1-ipv4-to-tap', 'priority': 100, 'outputPorts': [3], 'match': {'inPort': 1, 'etherType': 2048}}]})
t_install_jet = float(ssh('jetson', 'date +%s.%N').strip())
print('install:', status, rep.get('ok'), rep.get('detail'), flush=True)
if status != 200 or not rep.get('ok'):
    sys.exit('install did not verify; stopping before freezing anything')
sender = f"""
import socket,time
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET,socket.SO_BINDTODEVICE,b'eth0')
s.bind(('10.0.2.50',0))
for i in range({SECONDS}):
    s.sendto(b'hardtimeout-%d'%i,('{mac_ip}',{TAG}))
    time.sleep(1)
"""
import base64
b64 = base64.b64encode(sender.encode()).decode()
proc = subprocess.Popen(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'agentic-node-01', f'echo {b64} | base64 -d | python3 -'])
time.sleep(1)
ssh('jetson', f'kill -STOP {pid}')
t_freeze = time.time()
print('bridge FROZEN (SIGSTOP) at about +1 s after the install; sending 1 datagram/s for', SECONDS, 's', flush=True)
proc.wait(timeout=SECONDS + 30)
ssh('jetson', f'kill -CONT {pid}')
print('bridge RESUMED (SIGCONT) after the sender finished', flush=True)
time.sleep(14)
state = get('/api/experiment/state')
print('state after resume: phase', state['phase'], '| attention', state['attention'], '| last', state['last']['action'], state['last']['ok'], state['last']['detail'], flush=True)
raw = ssh('jetson', 'cat /tmp/hardtimeout-O2.txt')
ts = [float(l.split()[0]) for l in raw.splitlines() if l.strip()]
rel = [round(t - t_install_jet, 1) for t in ts]
print('datagrams seen at O2:', len(ts), 'of', SECONDS)
print('first seen at +%.1f s, last seen at +%.1f s after the install (clock: Jetson)' % (rel[0], rel[-1]) if rel else 'none seen')
buckets = {}
for r in rel:
    buckets[int(r // 5) * 5] = buckets.get(int(r // 5) * 5, 0) + 1
print('seen per 5 s bucket after the install:', dict(sorted(buckets.items())))
