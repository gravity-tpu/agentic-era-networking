#!/usr/bin/env python3
"""scripts/track-c-scenario1-arp-spoof.py: Track C scenario 1 (ARP spoofing across P1 and P2), run against the pre-registration at
docs/benchmarks/results/track-c-scenario1-arp-spoof/PREREGISTRATION.md. Do not change the method here without updating that file first and
noting why (same convention as the layout-capacity and conformance harnesses).

What it does: node-02 (the adversary) sends REPLY_COUNT unsolicited ARP replies claiming TARGET_IP (the Mac's workload-segment alias), bound
explicitly to its own workload interface, NODE02_WORKLOAD_IFACE below -- eth1, not eth0, on this host; see that constant's comment -- never
trusting routing-table defaults (see scripts/adversary-bind.py). Observed three ways: O3 (ground truth for
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

NODE02 = 'agentic-node-02'       # the adversary; see adversary-bind.py
# node-02's workload interface is eth1, NOT eth0 -- found 2026-10-22 while setting up its eth1 (USB-Ethernet) control channel: the
# onboard NIC (workload segment, 10.0.2.0/24) and the ASIX USB adapter (household network) have a persistent, reproducible kernel-level
# naming collision on this specific host (confirmed via journalctl: both try to rename to the other's current name on every boot, "File
# exists" every time, regardless of systemd .link MAC-based overrides -- the kernel's own initial enumeration deterministically assigns
# "eth0" to the ASIX adapter and "eth1" to the onboard NIC before any .link file gets a chance, so forcing the opposite literally requires
# non-"eth0"/"eth1" names, which just moves the problem elsewhere). Documented as a per-host quirk rather than fought further.
NODE02_WORKLOAD_IFACE = 'eth1'
# node-02's known, declared control channels: eth0 (the USB-Ethernet adapter reaching the household network, our SSH path) and tailscale0
# (which rides the same eth0 route). Declared so preflight() excuses exactly these two, by name, and still refuses on anything else up and
# routable that we did NOT expect -- the actual risk this check exists to catch.
NODE02_KNOWN_CONTROL_IFACES = ('eth0', 'tailscale0')
JETSON = 'jetson'
TARGET_IP = '10.0.2.119'         # the Mac's workload-segment alias (owner-approved scope: our own host, not the real gateway)
O3_IF = 'enx9c69d39ddcc0'        # ground truth: mirror of the Zodiac P2 link
O2_IF = 'enx9c69d39dd0a6'        # secondary check: the Zodiac P3 tap (p1-arp's declared second output)
REPLY_COUNT = 3
CAPTURE_SECONDS = 8            # how long AFTER the send we wait before reading the captures
CAPTURE_START_BUDGET_S = 5     # per capture: how long start_capture() will poll for "listening on" before giving up
PID_WAIT_BUDGET_S = 5          # how long start_capture() will poll for the detached launch to report its PID before giving up
CAPTURE_STARTS = 2             # O3 then O2, started one after the other -- both budgets can elapse (on O3's clock) before the send
MISC_SSH_BUDGET_S = 6          # the MAC fetch plus both capture_alive() liveness checks between the captures starting and the send itself.
# This is an ESTIMATE, not a measured bound -- actual SSH round-trip latency is not something this script controls. If it is exceeded, the
# remote capture can still expire before the send; capture_alive() then refuses the run rather than silently recording a false "no hits"
# (fail closed), so an underestimate here costs an aborted run, not a wrong result.
SEND_SETTLE_S = 2              # slack after the send, before checking the captures are done, for SSH round-trip jitter
# The remote tcpdump is told to run from ITS OWN start (O3's, the earlier of the two) through: both captures finishing their "listening on"
# poll, the MAC fetch and liveness checks, the send, the post-send wait, and settle slack. This is a worst-case upper bound, not a typical
# case (each polling step usually returns in well under its budget); it is sized to the slowest path actually exercised by this script, not
# an arbitrary margin.
REMOTE_CAPTURE_WINDOW_S = CAPTURE_START_BUDGET_S * CAPTURE_STARTS + MISC_SSH_BUDGET_S + CAPTURE_SECONDS + SEND_SETTLE_S
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
print(f'PID:{p.pid}', flush=True)  # read by capture_alive(): a kill -0 on this exact PID, not a name/interface guess
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


def start_capture(iface: str, tag: str) -> int:
    """Starts the remote capture and returns its PID (printed as the first line), for a deterministic liveness check later -- not a
    name/interface guess, which a leftover or manually-started tcpdump on the same interface could satisfy by coincidence."""
    out_path = f'/tmp/tc1-{tag}.txt'
    # py_on() blocks until SAMPLER_CAPTURE's own sleep(secs) finishes, i.e. until the capture ends -- so its PID line must be read via a
    # separate, immediately-returning SSH call to the same remote script's stdout as that sleep is still running. Launched detached:
    rm_stale = f"rm -f {out_path} {out_path}.err {out_path}.pidready"
    # setsid, not just nohup, is required: nohup alone only ignores SIGHUP, it does not leave the SSH session's process group, so sshd can
    # still wait on it even with every std stream redirected away. setsid + a backgrounded subshell is the pattern already proven elsewhere
    # in this repo for exactly this (the bridge restart recipe in the handoff memory); mirrored here rather than re-discovering it by trial.
    launch = (f"{rm_stale} && echo {base64.b64encode(SAMPLER_CAPTURE.encode()).decode()} | base64 -d > /tmp/tc1-sampler.py && "
              f"(setsid nohup python3 /tmp/tc1-sampler.py {iface} {REMOTE_CAPTURE_WINDOW_S} {out_path} > {out_path}.pidready 2>/dev/null < /dev/null &) && "
              f"for i in $(seq 1 {PID_WAIT_BUDGET_S * 10}); do grep -q PID: {out_path}.pidready 2>/dev/null && break; sleep 0.1; done; "
              f"cat {out_path}.pidready")
    pid_line = run(JETSON, launch)
    pid = next((int(l.split(':', 1)[1]) for l in pid_line.splitlines() if l.startswith('PID:')), None)
    if pid is None:
        raise RuntimeError(f'{tag} capture on {iface} never reported a PID; refusing to proceed without one')
    # One remote SSH call with its own polling loop, not a python-side loop making a fresh SSH connection per check: a new connection's
    # handshake overhead (easily 1-2s) would burn through CAPTURE_START_BUDGET_S in a couple of iterations without ever genuinely polling.
    status = run(JETSON, f'for i in $(seq 1 {CAPTURE_START_BUDGET_S * 10}); do grep -q "listening on" {out_path}.err 2>/dev/null && '
                          f'{{ echo ready; exit 0; }}; sleep 0.1; done; echo not-ready')
    if status.strip() != 'ready':
        raise RuntimeError(f'{tag} capture on {iface} did not confirm "listening on" within {CAPTURE_START_BUDGET_S}s; refusing to proceed without it')
    return pid


def capture_alive(pid: int) -> bool:
    """Whether the remote tcpdump process with this exact PID is still running right now (`kill -0`, deterministic -- not a name or
    interface guess that a leftover or manually-started tcpdump could satisfy by coincidence). Called right before the send: a capture that
    already exited (its REMOTE_CAPTURE_WINDOW_S ran out before we were ready to send) must not be allowed to silently produce a false "no
    hits". This still cannot close the gap between this check returning and the ARP replies actually arriving (an SSH round-trip for the
    send itself) -- SEND_SETTLE_S is the budget for that, not a claim this check removes the race entirely. It is also only meaningful
    close to when the PID was issued: Linux recycles PIDs, so a check made long after the process that held this PID has exited and been
    reaped could (in principle) match an unrelated later process. Every call site in this script calls it within seconds of start_capture(),
    not after an unbounded delay, so this is noted rather than guarded against."""
    out = run(JETSON, f'kill -0 {pid} 2>/dev/null && echo alive || echo dead')
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
    control_flags = ' '.join(f'--known-control-iface {i}' for i in NODE02_KNOWN_CONTROL_IFACES)
    preflight_raw = run(NODE02, f'python3 /tmp/adversary-bind.py preflight --iface {NODE02_WORKLOAD_IFACE} {control_flags}')
    preflight = json.loads(preflight_raw)
    result['preflight'] = preflight
    if not preflight['ok']:
        log(f'  REFUSED: {preflight["refusalReason"]}')
        log('  nothing was sent; the run stops here (Invariant 3: fail closed)')
        json.dump(result, open(os.path.join(a.out, 'result.json'), 'w'), indent=1)
        raise SystemExit(1)
    log(f'  ok: preflight passed, {NODE02_WORKLOAD_IFACE} is safe to send on')

    adversary_mac = run(NODE02, f"ip -o link show {NODE02_WORKLOAD_IFACE} | awk '{{print $(NF-2)}}'").strip()
    result['adversaryEth0Mac'] = adversary_mac
    log(f'  adversary {NODE02_WORKLOAD_IFACE} MAC: {adversary_mac}')

    log('step 2: baseline — the Mac\'s own ARP cache for the target, before anything is sent')
    before = local_arp(TARGET_IP)
    result['before'] = before
    log(f'  before: {before["raw"]}')

    log('step 3: starting O3 (ground truth, Zodiac P2 mirror) and O2 (Zodiac P3 tap) captures')
    o3_pid = start_capture(O3_IF, 'o3')
    o2_pid = start_capture(O2_IF, 'o2')

    if reply_count > 0:
        for pid, tag in [(o3_pid, 'o3'), (o2_pid, 'o2')]:
            if not capture_alive(pid):
                log(f'  REFUSED: the {tag} capture (pid {pid}) is not running anymore; a "no hits" result would be meaningless, not a finding')
                result['refusalReason'] = f'{tag} capture died before the send'
                json.dump(result, open(os.path.join(a.out, 'result.json'), 'w'), indent=1)
                raise SystemExit(1)
        log(f'step 4: sending {reply_count} unsolicited ARP replies from the adversary, bound to {NODE02_WORKLOAD_IFACE}, claiming {TARGET_IP}')
        try:
            out = run(NODE02, f'arping -A -I {NODE02_WORKLOAD_IFACE} -c {reply_count} -w 1 {TARGET_IP}; echo "__TC1_ARPING_EXIT__:$?"')
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
