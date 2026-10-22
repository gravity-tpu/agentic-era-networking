#!/usr/bin/env python3
"""scripts/track-c-scenario1-arp-spoof.py: Track C scenario 1 (ARP spoofing across P1 and P2), run against the pre-registration at
docs/benchmarks/results/track-c-scenario1-arp-spoof/PREREGISTRATION.md. Do not change the method here without updating that file first and
noting why (same convention as the layout-capacity and conformance harnesses).

What it does: node-02 (the adversary) sends REPLY_COUNT unsolicited ARP replies claiming TARGET_IP (the Mac's workload-segment alias), bound
explicitly to its own eth0 (never trusting routing-table defaults -- see scripts/adversary-bind.py). Observed three ways: O3 (ground truth for
"the switch sent it out of port 2"), O2 (the declared secondary output of the p1-arp rule), and the Mac's own ARP cache for TARGET_IP, read
before and after. A corrective step always runs afterward, success or failure, so the Mac's cache is not left wrong when the run ends.

Safety: refuses to send anything unless node-02's preflight() (adversary-bind.py) reports ok -- a leak risk on node-02 stops the run before the
first packet. REPLY_COUNT is fixed and small (not a flood; that is scenario 4). Requires `sudo setcap cap_net_raw+ep /usr/bin/arping` to have
been run once on node-02 (CAP_NET_RAW is a kernel requirement for raw ARP frames regardless of tool; this avoids needing sudo on every run).

Usage (run on the Mac, which is the target identity and the point of comparison):
    python3 scripts/track-c-scenario1-arp-spoof.py --out <results dir> [--dry-run]
`--dry-run` runs the preflight check and the capture/observation plumbing but sends 0 ARP replies (REPLY_COUNT forced to 0), to verify
connectivity and the harness itself before the first real packet.
"""

import argparse
import base64
import json
import os
import subprocess
import time
from datetime import datetime
from zoneinfo import ZoneInfo

NODE02 = 'agentic-node-02'       # the adversary (its own eth0; see adversary-bind.py)
JETSON = 'jetson'
TARGET_IP = '10.0.2.119'         # the Mac's workload-segment alias (owner-approved scope: our own host, not the real gateway)
O3_IF = 'enx9c69d39ddcc0'        # ground truth: mirror of the Zodiac P2 link
O2_IF = 'enx9c69d39dd0a6'        # secondary check: the Zodiac P3 tap (p1-arp's declared second output)
REPLY_COUNT = 3
CAPTURE_SECONDS = 8            # how long AFTER the send we wait before reading the captures
CAPTURE_START_BUDGET_S = 5     # per capture: how long start_capture() will poll for "listening on" before giving up
CAPTURE_STARTS = 2             # O3 then O2, started one after the other -- both budgets can elapse before the send
SEND_SETTLE_S = 2              # slack after the send, before checking the captures are done, for SSH round-trip jitter
# The remote tcpdump is told to run for long enough to cover both captures starting (worst case, back to back) PLUS the actual
# post-send wait PLUS settle -- not a guess: every term here is a budget already spent somewhere else in this script.
REMOTE_CAPTURE_WINDOW_S = CAPTURE_START_BUDGET_S * CAPTURE_STARTS + CAPTURE_SECONDS + SEND_SETTLE_S
SSH_TIMEOUT_S = 20
ADVERSARY_BIND_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'adversary-bind.py')


def read_adversary_bind_src() -> str:
    """Read lazily (not at import time), so --help/--dry-run usage errors surface before a missing-file error would. A clear message, not
    a bare FileNotFoundError traceback, if scripts/adversary-bind.py is not next to this script."""
    try:
        with open(ADVERSARY_BIND_PATH) as f:
            return f.read()
    except OSError as err:
        raise SystemExit(f'cannot read {ADVERSARY_BIND_PATH}: {err}; it must sit next to this script') from err


def now_et() -> str:
    return datetime.now(ZoneInfo('America/New_York')).strftime('%Y-%m-%d %H:%M:%S ET')


def run(host: str, remote: str, timeout: int = SSH_TIMEOUT_S) -> str:
    p = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', f'ConnectTimeout={min(timeout, 10)}', host, remote],
                        capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError(f'ssh {host} failed ({p.returncode}): {p.stderr.strip()[:300]}')
    return p.stdout


def py_on(host: str, code: str, args: list, timeout: int = SSH_TIMEOUT_S) -> str:
    """Runs a Python snippet on a remote host through base64 (quoting never matters)."""
    b64 = base64.b64encode(code.encode()).decode()
    return run(host, f'echo {b64} | base64 -d > /tmp/tc1-snippet.py && python3 /tmp/tc1-snippet.py {" ".join(args)}', timeout)


def local_arp(ip: str) -> dict:
    """The Mac's own ARP cache entry for `ip`, parsed from `arp -n`. {'raw': ..., 'mac': ... or None, 'flags': [...]}."""
    p = subprocess.run(['arp', '-n', ip], capture_output=True, text=True, timeout=5)
    raw = (p.stdout + p.stderr).strip()
    if 'no entry' in raw.lower() or p.returncode != 0:
        return {'raw': raw, 'mac': None, 'permanent': False}
    parts = raw.split()
    mac = next((t for t in parts if t.count(':') == 5), None)
    return {'raw': raw, 'mac': mac, 'permanent': 'permanent' in raw}


def correct_local_arp(ip: str) -> dict:
    """Deletes a possibly-poisoned local entry so macOS reinstates its own permanent mapping for an address it owns. Always attempted,
    success or failure of the rest of the run. Returns the entry read again after the correction, so the run's own fix is itself verified."""
    subprocess.run(['sudo', 'arp', '-d', ip], capture_output=True, text=True, timeout=5)
    time.sleep(1)
    return local_arp(ip)


SAMPLER_CAPTURE = '''
import subprocess, sys, time
iface, secs, out_path = sys.argv[1], float(sys.argv[2]), sys.argv[3]
err_path = out_path + '.err'
p = subprocess.Popen(['tcpdump', '-i', iface, '-nn', '-e', '-l', 'arp'], stdout=open(out_path, 'w'), stderr=open(err_path, 'w'))
start = time.monotonic()
ready = False
while time.monotonic() - start < 5:
    if 'listening on' in open(err_path).read():
        ready = True
        break
    time.sleep(0.1)
print('ready' if ready else 'not-ready')
time.sleep(secs)
p.terminate()
p.wait(timeout=3)
'''


def start_capture(iface: str, tag: str) -> None:
    out_path = f'/tmp/tc1-{tag}.txt'
    status = py_on(JETSON, SAMPLER_CAPTURE, [iface, str(REMOTE_CAPTURE_WINDOW_S), out_path], timeout=SSH_TIMEOUT_S)
    if status.strip() != 'ready':
        raise RuntimeError(f'{tag} capture on {iface} did not confirm "listening on" within 5 s; refusing to proceed without it')


def capture_alive(iface: str) -> bool:
    """Whether the remote tcpdump on `iface` is still running right now. Matches on the interface name, which is unique per capture (O3_IF
    != O2_IF): pgrep only sees tcpdump's own argv, not the python parent's file-redirection target, so a tag would never match here. Called
    right before the send: a capture that already exited (its REMOTE_CAPTURE_WINDOW_S ran out before we were ready to send) must not be
    allowed to silently produce a false "no hits"."""
    out = run(JETSON, f'pgrep -f "tcpdump -i {iface}" >/dev/null 2>&1 && echo alive || echo dead')
    return out.strip() == 'alive'


def fetch_capture(tag: str) -> list:
    text = run(JETSON, f'cat /tmp/tc1-{tag}.txt 2>/dev/null; rm -f /tmp/tc1-{tag}.txt /tmp/tc1-{tag}.txt.err') # cleanup, own line below
    return [l for l in text.split('\n') if l.strip() != '']


def frames_claiming(lines: list, target_ip: str, sender_mac: str) -> list:
    """ARP replies in tcpdump -e output where the Ethernet source matches the adversary's MAC and the target_ip appears (SPA in a reply)."""
    hits = []
    for l in lines:
        if sender_mac.lower() not in l.lower():
            continue
        if 'ARP, Reply' not in l and 'arp reply' not in l.lower():
            continue
        if target_ip not in l:
            continue
        hits.append(l)
    return hits


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    log_path = os.path.join(a.out, 'run.log')
    logf = open(log_path, 'a')

    def log(s: str) -> None:
        line = f'[{now_et()}] {s}'
        print(line, flush=True)
        logf.write(line + '\n')
        logf.flush()

    reply_count = 0 if a.dry_run else REPLY_COUNT
    result = {'startedEt': now_et(), 'dryRun': a.dry_run, 'targetIp': TARGET_IP, 'replyCount': reply_count}

    log('step 1: preflight on the adversary node (scripts/adversary-bind.py)')
    adversary_bind_src = read_adversary_bind_src()
    run(NODE02, f"echo {base64.b64encode(adversary_bind_src.encode()).decode()} | base64 -d > /tmp/adversary-bind.py")
    preflight_raw = run(NODE02, 'python3 /tmp/adversary-bind.py preflight')
    preflight = json.loads(preflight_raw)
    result['preflight'] = preflight
    if not preflight['ok']:
        log(f'  REFUSED: {preflight["refusalReason"]}')
        log('  nothing was sent; the run stops here (Invariant 3: fail closed)')
        json.dump(result, open(os.path.join(a.out, 'result.json'), 'w'), indent=1)
        raise SystemExit(1)
    log('  ok: preflight passed, eth0 is safe to send on')

    adversary_mac = run(NODE02, "ip -o link show eth0 | awk '{print $(NF-2)}'").strip()
    result['adversaryEth0Mac'] = adversary_mac
    log(f'  adversary eth0 MAC: {adversary_mac}')

    log('step 2: baseline — the Mac\'s own ARP cache for the target, before anything is sent')
    before = local_arp(TARGET_IP)
    result['before'] = before
    log(f'  before: {before["raw"]}')

    log('step 3: starting O3 (ground truth, Zodiac P2 mirror) and O2 (Zodiac P3 tap) captures')
    start_capture(O3_IF, 'o3')
    start_capture(O2_IF, 'o2')

    if reply_count > 0:
        for iface, tag in [(O3_IF, 'o3'), (O2_IF, 'o2')]:
            if not capture_alive(iface):
                log(f'  REFUSED: the {tag} capture on {iface} is not running anymore; a "no hits" result would be meaningless, not a finding')
                result['refusalReason'] = f'{tag} capture died before the send'
                json.dump(result, open(os.path.join(a.out, 'result.json'), 'w'), indent=1)
                raise SystemExit(1)
        log(f'step 4: sending {reply_count} unsolicited ARP replies from the adversary, bound to eth0, claiming {TARGET_IP}')
        try:
            out = run(NODE02, f'arping -A -I eth0 -c {reply_count} -w 1 {TARGET_IP}; echo "__TC1_ARPING_EXIT__:$?"')
            marker = next((l for l in out.splitlines() if l.startswith('__TC1_ARPING_EXIT__:')), None)
            log(f'  {out.replace(marker, "").strip()[:400] if marker else out.strip()[:400]}')
            result['sendOk'] = marker == '__TC1_ARPING_EXIT__:0'
            if marker is None:
                log('  WARNING: could not find the exit-code marker in arping\'s output; sendOk left False (fail closed, not assumed)')
        except RuntimeError as err:
            log(f'  SEND FAILED: {err}')
            result['sendOk'] = False
            result['sendError'] = str(err)
    else:
        log('step 4: dry run — sending 0 replies')
        result['sendOk'] = None

    log(f'  waiting out the {CAPTURE_SECONDS}s capture window')
    time.sleep(CAPTURE_SECONDS)

    o3_lines = fetch_capture('o3')
    o2_lines = fetch_capture('o2')
    o3_hits = frames_claiming(o3_lines, TARGET_IP, adversary_mac)
    o2_hits = frames_claiming(o2_lines, TARGET_IP, adversary_mac)
    result['o3'] = {'totalArpFrames': len(o3_lines), 'matchingHits': o3_hits}
    result['o2'] = {'totalArpFrames': len(o2_lines), 'matchingHits': o2_hits}
    log(f'  O3 (reached P2?): {len(o3_hits)} matching frame(s) of {len(o3_lines)} ARP frames seen')
    log(f'  O2 (Zodiac P3 tap): {len(o2_hits)} matching frame(s) of {len(o2_lines)} ARP frames seen')

    log('step 5: re-reading the Mac\'s ARP cache for the target, after the replies')
    after = local_arp(TARGET_IP)
    result['after'] = after
    log(f'  after: {after["raw"]}')
    result['cacheChangedToAdversary'] = bool(reply_count > 0 and (after.get('mac') or '').lower() == adversary_mac.lower())
    log(f'  cache changed to the adversary\'s MAC: {result["cacheChangedToAdversary"]}')

    log('step 6: corrective ARP cache fix (always run, regardless of outcome)')
    corrected = correct_local_arp(TARGET_IP)
    result['corrected'] = corrected
    still_poisoned = reply_count > 0 and (corrected.get('mac') or '').lower() == adversary_mac.lower()
    if before.get('mac') is not None:
        result['correctionOk'] = (not still_poisoned) and corrected.get('mac') == before.get('mac')
        log(f'  after correction: {corrected["raw"]} (matches the pre-run state: {result["correctionOk"]})')
    else:
        # No known-good baseline existed before the run (the pre-run read itself found nothing) -- "restored" cannot be claimed, only
        # "not still showing the adversary's MAC". Recorded as such rather than a vacuous True from comparing None to None.
        result['correctionOk'] = not still_poisoned
        log(f'  after correction: {corrected["raw"]} (no pre-run baseline to restore to; not still poisoned: {result["correctionOk"]})')
    if not result['correctionOk']:
        log('  WARNING: the corrective step did not clear the poisoned state; manual follow-up is needed')

    json.dump(result, open(os.path.join(a.out, 'result.json'), 'w'), indent=1)
    log(f'done; wrote {a.out}/result.json')


if __name__ == '__main__':
    main()
