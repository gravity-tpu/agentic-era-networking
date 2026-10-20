#!/usr/bin/env python3
"""Live test of the switch-side hard timeout (owner-authorized 2026-10-20): install the six isolation rules plus one MARKER rule through the
experiment endpoint with a 10 s limit (so every experimental rule carries hard_timeout 40 s), kill the bridge so its own restore cannot run,
wait past the hard timeout, restart the bridge and read its startup readback: it re-adds table-miss + the six rules WITHOUT a wipe, so a total of
7 entries means the marker expired on its own and 8 means it did not."""
import json, subprocess, sys, time, urllib.request

BRIDGE = 'http://127.0.0.1:13003'
TOKEN = open('/Users/andymorven/.zodiac-experiment-token').read().strip()


def post(path, body):
    req = urllib.request.Request(BRIDGE + path, data=json.dumps(body).encode(), headers={'x-experiment-token': TOKEN, 'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.status, json.loads(r.read())


def ssh(cmd, stdin=None):
    return subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'jetson', cmd], capture_output=True, text=True, stdin=stdin, timeout=90).stdout


rules = json.load(open('/tmp/r0-identity-ruleset.json'))['rules']
rules.append({'id': 'marker-hard-timeout-test', 'priority': 250, 'outputPorts': [3], 'match': {'inPort': 1, 'etherType': 2048, 'srcIp': '10.0.2.77'}})
status, rep = post('/api/experiment/install', {'label': 'hard-timeout test: isolation + one marker rule, 10 s limit', 'ttlSeconds': 10, 'rules': rules})
print('install:', status, rep.get('ok'), rep.get('detail'), flush=True)
if status != 200 or not rep.get('ok'):
    sys.exit('install did not verify; not killing the bridge')
t_install = time.time()
time.sleep(1)
pid = ssh('ss -ltnp | grep ":3003" | sed -E "s/.*pid=([0-9]+).*/\\1/" | head -1').strip()
print('killing the bridge pid', pid, 'at +%.0f s after the install (its own 10 s restore must not run)' % (time.time() - t_install), flush=True)
ssh(f'kill {pid}')
time.sleep(max(0, 58 - (time.time() - t_install)))  # past the 40 s switch-side hard timeout, with margin
print('restarting the bridge at +%.0f s after the install' % (time.time() - t_install), flush=True)
with open('/Users/andymorven/.zodiac-experiment-token') as tf:
    ssh('read -r T; cd ~/agentic-era-networking && set -a && . /etc/zodiac/zodiac-bridge.env && set +a && export NODE_ENV=production WORKSTATION_AGENT_LAN_URL=http://10.0.0.119:11435 ZODIAC_EXPERIMENT_ENDPOINTS=1 ZODIAC_EXPERIMENT_TOKEN="$T" && unset T && (setsid nohup /usr/bin/env node --max-old-space-size=128 dist/sdn/zodiac-bridge-server.js serve 3003 >> /tmp/zodiac-bridge-manual.log 2>&1 < /dev/null &)', stdin=tf)
time.sleep(16)
print(ssh('grep -E "Isolation readback|total entries|Table-Miss flow rule" /tmp/zodiac-bridge-manual.log | tail -n 3 | cut -c1-200'))
