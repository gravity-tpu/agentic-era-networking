#!/usr/bin/env python3
"""
scripts/labelled-runs.py
========================
Records labelled traffic runs at the Jetson's Zodiac P3 tap, so a detector can be scored on traffic whose class is
known. Each run is ONE class (benign or attack), with ONE attacker or sender, captured to its own pcap, so the label is
the run itself plus the sender's address: no clock alignment between machines is needed.

Safety (Invariants 3 and 5): every run is validated before anything is sent. Duration, packet rate and packet count are
capped by named constants; attacks may only come from the adversary node and only target the two allowed receivers on
the workload segment; commands are built from fixed templates, never from free text; every remote command runs under
`timeout`. Nothing runs without --execute, and --execute refuses to start if the tap capture is not set up.

Usage:
  python3 scripts/labelled-runs.py --list                  show the catalog and the validation verdict for each run
  python3 scripts/labelled-runs.py --dry-run               print every command that would run, run nothing
  python3 scripts/labelled-runs.py --execute --out DIR [--only ID ...]   run (needs the one-time capture setup below)

One-time setup on the Jetson (needs root; lets the zodiac user capture the tap without root):
  sudo setcap cap_net_raw,cap_net_admin=eip /usr/bin/tcpdump
"""

import argparse
import ipaddress
import json
import os
import re
import shlex
import subprocess
import sys
import time

# --- bounds (named, so a change is a visible review item) -------------------------------------------------------
MAX_RUN_SECONDS = 120          # hard cap on how long any single run may last
MAX_PPS = 2000                 # most packets per second any run may be asked to send
MAX_PACKETS = 20000            # most packets any one run may send
MAX_PAYLOAD_BYTES = 1400       # largest payload any run may use
SETTLE_SECONDS = 3             # quiet time before and after each run inside the capture
CAPTURE_FILTER = "ip or arp"

TAP_IFACE = "enx9c69d39dd0a6"
JETSON = "jetson"
HOSTS = {  # ssh alias -> its address on the workload segment
    "agentic-node-01": "10.0.2.50",  # the adversary node
    "agentic-node-02": "10.0.2.52",  # the legitimate client
}
ADVERSARY = "agentic-node-01"
ALLOWED_TARGETS = ("10.0.2.119", "10.0.2.51")  # the Mac's benchmark alias and the Pi 5
SEGMENT = ipaddress.ip_network("10.0.2.0/24")

TOOLS = ("ping", "hping3", "nmap", "iperf3-udp")
BENIGN, ATTACK = "benign", "attack"


class RunRejected(ValueError):
    """A run that breaks a bound. Carries every reason, not just the first."""


def _positive_int(run, key, errors, upper):
    v = run.get(key)
    if not isinstance(v, int) or isinstance(v, bool) or v <= 0:
        errors.append(f"{key} must be a positive integer (got {v!r})")
        return None
    if v > upper:
        errors.append(f"{key}={v} is above the limit {upper}")
    return v


def validate(run):
    """Return the run if it is inside every bound, else raise RunRejected listing every problem."""
    errors = []
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,47}", str(run.get("id", ""))):
        errors.append("id must be 1 to 48 characters of lowercase letters, digits and '-'")
    if run.get("class") not in (BENIGN, ATTACK):
        errors.append(f"class must be {BENIGN!r} or {ATTACK!r}")
    if run.get("tool") not in TOOLS:
        errors.append(f"tool must be one of {TOOLS}")
    sender = run.get("sender")
    if sender not in HOSTS:
        errors.append(f"sender must be one of {tuple(HOSTS)}")
    elif run.get("class") == ATTACK and sender != ADVERSARY:
        errors.append(f"an attack may only come from {ADVERSARY}")
    target = run.get("target")
    try:
        t_ip = ipaddress.ip_address(target)
    except ValueError:
        errors.append(f"target {target!r} is not an IP address")
    else:
        if target not in ALLOWED_TARGETS or t_ip not in SEGMENT:
            errors.append(f"target {target} is not one of the allowed receivers {ALLOWED_TARGETS}")
    seconds = _positive_int(run, "seconds", errors, MAX_RUN_SECONDS)
    pps = run.get("pps")
    if pps is not None:
        _positive_int(run, "pps", errors, MAX_PPS)
    count = run.get("count")
    if count is not None:
        _positive_int(run, "count", errors, MAX_PACKETS)
    if run.get("tool") == "hping3":
        for key in ("pps", "count", "flags_or_proto"):
            if run.get(key) is None:
                errors.append(f"hping3 runs need {key}")
        if run.get("flags_or_proto") not in ("syn", "udp"):
            errors.append("hping3 flags_or_proto must be 'syn' or 'udp'")
        if isinstance(pps, int) and isinstance(count, int) and pps > 0 and count / pps > MAX_RUN_SECONDS:
            errors.append(f"count/pps = {count / pps:.0f} s is above the {MAX_RUN_SECONDS} s limit")
        payload = run.get("payload_bytes", 0)
        if not isinstance(payload, int) or isinstance(payload, bool) or not 0 <= payload <= MAX_PAYLOAD_BYTES:
            errors.append(f"payload_bytes must be an integer from 0 to {MAX_PAYLOAD_BYTES}")
        if run.get("port") is not None and (not isinstance(run["port"], int) or not 1 <= run["port"] <= 65535):
            errors.append("port must be 1 to 65535")
    if run.get("tool") == "ping" and (not isinstance(pps, int) or pps > 20):
        errors.append("ping runs need pps of at most 20")
    if run.get("tool") == "nmap":
        if run.get("timing") not in (2, 3, 4):
            errors.append("nmap timing must be 2, 3 or 4 (never 5)")
        pr = run.get("ports", "")
        if not re.fullmatch(r"\d{1,5}-\d{1,5}", str(pr)) or int(str(pr).split("-")[1]) - int(str(pr).split("-")[0]) > 2000:
            errors.append("nmap ports must be a range of at most 2000 ports, like 1-1000")
    if run.get("tool") == "iperf3-udp":
        for key in ("bandwidth_mbit",):
            if not isinstance(run.get(key), int) or not 1 <= run[key] <= 20:
                errors.append("iperf3-udp bandwidth_mbit must be 1 to 20")
        errors.append("iperf3-udp needs a receiver running on the target, which this harness does not start; not in the catalog")
    if errors:
        raise RunRejected("; ".join(errors))
    return run


def remote_command(run):
    """The argv that runs on the sender, from fixed templates. Always under `timeout`."""
    validate(run)
    tgt = run["target"]
    secs = run["seconds"]
    tool = run["tool"]
    if tool == "ping":
        inner = ["ping", "-I", "eth0", "-c", str(secs * run["pps"]), "-i", f"{1 / run['pps']:.3f}", "-q", tgt]
    elif tool == "hping3":
        interval_us = max(1, 1_000_000 // run["pps"])
        inner = ["hping3", "-c", str(run["count"]), "-i", f"u{interval_us}", "-I", "eth0", "-d", str(run.get("payload_bytes", 0)), "-q"]
        if run["flags_or_proto"] == "syn":
            # hping3's default is a source port that increases by one per packet (not random, not fixed).
            inner += ["-S", "-p", str(run.get("port", 80))]
        else:
            inner += ["--udp", "-p", str(run.get("port", 5001))]
        inner.append(tgt)
    else:  # nmap
        inner = ["nmap", "-sS", f"-T{run['timing']}", "-p", run["ports"], "-n", "-Pn", "--max-retries", "0", tgt]
    # hping3 and nmap need raw sockets: run them as root through passwordless sudo on the adversary node, with the
    # `timeout` INSIDE sudo so it is root that kills the tool when the limit is reached.
    if tool in ("hping3", "nmap"):
        return ["sudo", "-n", "timeout", str(secs + 5)] + inner
    return ["timeout", str(secs + 5)] + inner


def capture_command(run_id):
    """The argv that runs on the Jetson: capture the tap to a file, under timeout, for the whole run."""
    return ["timeout", "-s", "INT", str(MAX_RUN_SECONDS + 2 * SETTLE_SECONDS + 10), "tcpdump", "-i", TAP_IFACE, "-n", "-U",
            "-w", f"/tmp/labelled-{run_id}.pcap", CAPTURE_FILTER]


# --- the catalog -----------------------------------------------------------------------------------------------
def _benign(id_, tool, sender, target, seconds, **kw):
    return {"id": id_, "class": BENIGN, "tool": tool, "sender": sender, "target": target, "seconds": seconds, **kw}


def _attack(id_, tool, target, seconds, **kw):
    return {"id": id_, "class": ATTACK, "tool": tool, "sender": ADVERSARY, "target": target, "seconds": seconds, **kw}


CATALOG = [
    _benign("benign-ping-5pps", "ping", "agentic-node-02", "10.0.2.119", 60, pps=5),
    _benign("benign-ping-5pps-node01", "ping", "agentic-node-01", "10.0.2.119", 60, pps=5),
    _benign("benign-ping-20pps", "ping", "agentic-node-02", "10.0.2.119", 30, pps=20),
    _attack("attack-synflood-1000pps", "hping3", "10.0.2.119", 10, pps=1000, count=10000, flags_or_proto="syn", port=80),
    _attack("attack-synflood-200pps", "hping3", "10.0.2.119", 30, pps=200, count=6000, flags_or_proto="syn", port=80),
    _attack("attack-udpflood-500pps-1400b", "hping3", "10.0.2.119", 10, pps=500, count=5000, flags_or_proto="udp", payload_bytes=1400, port=5001),
    _attack("attack-portscan-fast", "nmap", "10.0.2.119", 20, timing=4, ports="1-1000"),
    _attack("attack-portscan-slow", "nmap", "10.0.2.119", 120, timing=2, ports="1-200"),
]


def execute(run, outdir):
    rid = run["id"]
    print(f"[run] {rid}: {run['class']} from {run['sender']} -> {run['target']} for up to {run['seconds']} s", flush=True)
    cap = subprocess.Popen(["ssh", JETSON, shlex.join(capture_command(rid))], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        time.sleep(SETTLE_SECONDS)
        if cap.poll() is not None:
            raise RuntimeError(f"capture exited early: {cap.stderr.read().decode()[:300]}")
        t0 = time.time()
        res = subprocess.run(["ssh", run["sender"], shlex.join(remote_command(run))], capture_output=True, text=True,
                             timeout=run["seconds"] + 30)
        t1 = time.time()
        time.sleep(SETTLE_SECONDS)
    finally:
        subprocess.run(["ssh", JETSON, "pkill -INT -f 'tcpdump -i " + TAP_IFACE + " -n -U -w /tmp/labelled-" + rid + ".pcap'"], capture_output=True)
        try:
            cap.wait(timeout=10)
        except subprocess.TimeoutExpired:
            cap.kill()
    os.makedirs(outdir, exist_ok=True)
    pcap = os.path.join(outdir, f"{rid}.pcap")
    subprocess.run(["scp", "-q", f"{JETSON}:/tmp/labelled-{rid}.pcap", pcap], check=True)
    label = {
        "id": rid, "class": run["class"], "tool": run["tool"], "sender": run["sender"], "senderIp": HOSTS[run["sender"]],
        "target": run["target"], "params": {k: v for k, v in run.items() if k not in ("id", "class", "tool", "sender", "target")},
        "command": remote_command(run), "commandExit": res.returncode, "commandSeconds": round(t1 - t0, 1),
        "pcap": os.path.basename(pcap), "commandStderrTail": res.stderr[-300:],
    }
    with open(os.path.join(outdir, f"{rid}.label.json"), "w") as f:
        json.dump(label, f, indent=2)
    print(f"[run] {rid}: done, command exit {res.returncode}, {label['commandSeconds']} s, {os.path.getsize(pcap)} bytes captured", flush=True)


def preflight(runs):
    r = subprocess.run(["ssh", JETSON, "getcap /usr/bin/tcpdump"], capture_output=True, text=True, timeout=20)
    if "cap_net_raw" not in r.stdout:
        raise SystemExit("capture is not set up: on the Jetson run  sudo setcap cap_net_raw,cap_net_admin=eip /usr/bin/tcpdump")
    for host in sorted({x["sender"] for x in runs if x["tool"] in ("hping3", "nmap")}):
        if subprocess.run(["ssh", host, "sudo -n true"], capture_output=True, timeout=20).returncode != 0:
            raise SystemExit(f"{host} has no passwordless sudo, which hping3 and nmap need for raw sockets")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--execute", action="store_true")
    ap.add_argument("--out")
    ap.add_argument("--only", nargs="*")
    a = ap.parse_args()
    if sum([a.list, a.dry_run, a.execute]) != 1:
        ap.error("choose exactly one of --list, --dry-run, --execute")
    runs = [r for r in CATALOG if not a.only or r["id"] in a.only]
    if a.only and len(runs) != len(a.only):
        ap.error("unknown run id in --only")
    bad = 0
    for r in CATALOG:
        try:
            validate(r)
        except RunRejected as e:
            bad += 1
            print(f"REJECTED {r.get('id')}: {e}", file=sys.stderr)
    if bad:
        raise SystemExit(f"{bad} catalog run(s) break a bound; nothing will run")
    if a.list:
        for r in runs:
            print(f"{r['id']:34s} {r['class']:7s} {r['tool']:7s} {r['sender']:16s} -> {r['target']:11s} {r['seconds']:3d} s")
    elif a.dry_run:
        for r in runs:
            print(f"# {r['id']}\n  jetson: {shlex.join(capture_command(r['id']))}\n  {r['sender']}: {shlex.join(remote_command(r))}")
    else:
        if not a.out:
            ap.error("--execute needs --out DIR")
        preflight(runs)
        for r in runs:
            execute(r, a.out)


if __name__ == "__main__":
    main()
