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
  python3 scripts/labelled-runs.py --execute --out DIR (--only ID [ID ...] | --all) [--class benign|attack]   run (needs the one-time capture setup below)

One-time setup on the Jetson (needs root; lets the zodiac user capture the tap without root):
  sudo setcap cap_net_raw,cap_net_admin=eip /usr/bin/tcpdump
"""

import argparse
import ipaddress
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time

# --- bounds (named, so a change is a visible review item) -------------------------------------------------------
MAX_RUN_SECONDS = 120          # hard cap on how long any single run may last
MAX_PPS = 2000                 # most packets per second any run may be asked to send
MAX_PACKETS = 20000            # most packets any one run may send
MAX_PAYLOAD_BYTES = 1400       # largest payload any run may use
RACK_STATUS_MAX_AGE_MS = 180_000  # three of the bridge's 60 s re-read intervals: an older readback means it has stopped reading
POST_RUN_GRACE_SECONDS = 20   # the bridge declares a silent switch dead after about 15 s without an echo reply
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

BENIGN_TOOLS = ("ping", "http-get", "udp-small", "tcp-stream", "tcp-interactive", "http-burst", "udp-burst", "idle")
ATTACK_TOOLS = ("hping3", "nmap", "arp-flood")
TOOLS = BENIGN_TOOLS + ATTACK_TOOLS
# Traffic only reaches the tap if it CROSSES the Zodiac. node-01, node-02 and the Pi 5 are all on the workload side of the
# same switch, so traffic among them never does (measured 2026-10-17: HTTP and iperf3 runs to the Pi 5 left 0 sender frames
# at the tap). Receivers that must be started therefore run on THIS machine (the Mac), bound to its 10.0.2.119 alias on the
# uplink side, which every sender reaches through the Zodiac.
LOCAL_RECEIVER_TARGET = "10.0.2.119"
HTTP_TARGET = LOCAL_RECEIVER_TARGET  # a small local web server serving two tiny static files
HTTP_PORT = 8000
HTTP_PATHS = ("/health", "/models")
MAX_RPS = 20
MAX_UDP_SMALL_PPS = 50
STREAM_PORT = 5201
MAX_STREAM_MBIT = 20
MAX_INTERACTIVE_EPS = 30        # tcp-interactive: keystroke-sized writes per second
MAX_BURST_CONNS = 16            # http-burst: parallel connections per burst
MAX_UDP_BURST = 40              # udp-burst: datagrams back to back
MAX_ARP_PPS = 300
MAX_SCAN_DELAY_MS = 5000
UDP_BURST_PORT = 51820          # not 41641: the nodes drop Tailscale's own port on eth0 (see deploy/workload)
SPACING_SECONDS = 5            # quiet gap between consecutive runs, so one run's tail is not in the next capture
# Bulk TCP uses plain Python at both ends (the Mac's firewall silently dropped inbound connections to iperf3 while allowing
# Python, measured 2026-10-17). A sink on this machine and a rate-limited sender on the node, both fixed scripts.
TCP_SINK_SCRIPT = (
    "import socket,sys,time;"
    "h,p,s=sys.argv[1],int(sys.argv[2]),int(sys.argv[3]);"
    "k=socket.socket();k.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);k.bind((h,p));k.listen(4);k.settimeout(1.0);"
    "e=time.monotonic()+s\n"
    "while time.monotonic()<e:\n"
    " try: c,_=k.accept()\n"
    " except socket.timeout: continue\n"
    " c.settimeout(5)\n"
    " while time.monotonic()<e:\n"
    "  try: d=c.recv(65536)\n"
    "  except socket.timeout: break\n"
    "  if not d: break\n"
    " c.close()\n"
)
TCP_STREAM_SCRIPT = (
    "import socket,sys,time;"
    "t,p,m,s,b=sys.argv[1],int(sys.argv[2]),int(sys.argv[3]),int(sys.argv[4]),sys.argv[5];"
    "k=socket.socket();k.bind((b,0));k.settimeout(10);k.connect((t,p));k.settimeout(5);"
    "d=b'x'*1448;bps=m*125000;st=time.monotonic_ns();e=st+s*1_000_000_000;sent=0\n"
    "while time.monotonic_ns()<e:\n"
    " k.sendall(d);sent+=1448;w=st+sent*1_000_000_000//bps-time.monotonic_ns()\n"
    " if w>0: time.sleep(w/1e9)\n"
    "k.close()\n"
)
HTTP_LOOP_SCRIPT = 'end=$(( $(date +%s) + $3 )); while [ $(date +%s) -lt $end ]; do curl -s -m 2 --interface eth0 -o /dev/null "$1"; sleep "$2"; done'
# ssh-like traffic (modelled, not a real ssh session: there is no key from the nodes to anything reachable): small writes of
# 40 to 120 bytes at irregular gaps averaging 1/events-per-second, over one TCP connection. Integer nanoseconds throughout; the
# pseudo-random numbers are a fixed linear congruential generator so a run is repeatable.
TCP_INTERACTIVE_SCRIPT = (
    "import socket,sys,time;"
    "t,p,e,s,b=sys.argv[1],int(sys.argv[2]),int(sys.argv[3]),int(sys.argv[4]),sys.argv[5];"
    "k=socket.socket();k.bind((b,0));k.settimeout(10);k.connect((t,p));k.settimeout(5);k.setsockopt(socket.IPPROTO_TCP,socket.TCP_NODELAY,1);"
    "g=1_000_000_000//e;now=time.monotonic_ns();end=now+s*1_000_000_000;nxt=now;x=12345\n"
    "while time.monotonic_ns()<end:\n"
    " x=(x*1103515245+12345)%2147483648;k.sendall(b'k'*(40+x%81))\n"
    " x=(x*1103515245+12345)%2147483648;nxt+=g//2+x%g;w=nxt-time.monotonic_ns()\n"
    " if w>0: time.sleep(w/1e9)\n"
    "k.close()\n"
)
# Browsing-like traffic: every PERIOD seconds, a burst of parallel connections each fetching a 20 KB page, plus one small request.
# Arguments: base url, connections, period in seconds, duration in seconds. The text is constant; nothing is spliced into it.
HTTP_BURST_SCRIPT = ('end=$(( $(date +%s) + $4 )); while [ $(date +%s) -lt $end ]; do i=0; '
                     'while [ $i -lt $2 ]; do curl -s -m 3 --interface eth0 -o /dev/null "$1/page" & i=$((i+1)); done; '
                     'curl -s -m 3 --interface eth0 -o /dev/null "$1/health"; wait; sleep $3; done')
# Tailscale-like traffic (MODELLED from the 2026-10-16 capture: a burst of full-size UDP datagrams, then about one small
# keepalive a second). It is not Tailscale and not WireGuard. Arguments: target port burst payload period secs bind.
UDP_BURST_SCRIPT = (
    "import socket,sys,time;"
    "t,p,bu,n,pe,s,b=sys.argv[1],int(sys.argv[2]),int(sys.argv[3]),int(sys.argv[4]),int(sys.argv[5]),int(sys.argv[6]),sys.argv[7];"
    "k=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);k.bind((b,0));d=b'x'*n;ka=b'k'*148;end=time.monotonic_ns()+s*1_000_000_000\n"
    "while time.monotonic_ns()<end:\n"
    " for _ in range(bu): k.sendto(d,(t,p))\n"
    " for _ in range(pe-1):\n"
    "  time.sleep(1);k.sendto(ka,(t,p))\n"
)
# A fixed script: sends small UDP datagrams at a bounded rate for a bounded time. Arguments: target port pps seconds payload.
UDP_SMALL_SCRIPT = (
    "import socket,sys,time;"
    "t,p,r,s,n=sys.argv[1],int(sys.argv[2]),int(sys.argv[3]),int(sys.argv[4]),int(sys.argv[5]);"
    "k=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);k.bind((sys.argv[6],0));d=b'x'*n;"
    "g=1_000_000_000//r;now=time.monotonic_ns();e=now+s*1_000_000_000;nxt=now\n"
    "while time.monotonic_ns()<e:\n"
    " k.sendto(d,(t,p));nxt+=g;w=nxt-time.monotonic_ns()\n"
    " if w>0: time.sleep(w/1e9)\n"
)
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
    tool = run.get("tool")
    cls = run.get("class")
    if cls == BENIGN and tool in ATTACK_TOOLS:
        errors.append(f"{tool} is an attack tool and cannot be a benign run")
    if cls == ATTACK and tool in BENIGN_TOOLS:
        errors.append(f"{tool} is a benign tool and cannot be an attack run")
    sender = run.get("sender")
    if tool == "idle":
        if sender is not None or run.get("target") is not None:
            errors.append("an idle run has no sender and no target")
    else:
        if sender not in HOSTS:
            errors.append(f"sender must be one of {tuple(HOSTS)}")
        elif cls == ATTACK and sender != ADVERSARY:
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
        d = run.get("delay_ms", 0)
        if not isinstance(d, int) or isinstance(d, bool) or not 0 <= d <= MAX_SCAN_DELAY_MS:
            errors.append(f"nmap delay_ms must be an integer from 0 to {MAX_SCAN_DELAY_MS}")
    if tool == "http-get":
        if run.get("target") != HTTP_TARGET:
            errors.append(f"http-get only targets {HTTP_TARGET}")
        if run.get("path") not in HTTP_PATHS:
            errors.append(f"http-get path must be one of {HTTP_PATHS}")
        if not isinstance(run.get("rps"), int) or isinstance(run.get("rps"), bool) or not 1 <= run["rps"] <= MAX_RPS:
            errors.append(f"http-get rps must be 1 to {MAX_RPS}")
    if tool == "udp-small":
        if not isinstance(pps, int) or isinstance(pps, bool) or pps > MAX_UDP_SMALL_PPS:
            errors.append(f"udp-small pps must be a positive integer of at most {MAX_UDP_SMALL_PPS}")
        n = run.get("payload_bytes", 60)
        if not isinstance(n, int) or isinstance(n, bool) or not 20 <= n <= 200:
            errors.append("udp-small payload_bytes must be 20 to 200")
        if run.get("port", 53) != 53 and not (isinstance(run.get("port"), int) and 1 <= run["port"] <= 65535):
            errors.append("udp-small port must be 1 to 65535")
    if tool == "tcp-interactive":
        if run.get("target") != LOCAL_RECEIVER_TARGET:
            errors.append(f"tcp-interactive only targets {LOCAL_RECEIVER_TARGET}")
        if not isinstance(run.get("events_per_s"), int) or isinstance(run.get("events_per_s"), bool) or not 1 <= run["events_per_s"] <= MAX_INTERACTIVE_EPS:
            errors.append(f"tcp-interactive events_per_s must be 1 to {MAX_INTERACTIVE_EPS}")
    if tool == "http-burst":
        if run.get("target") != HTTP_TARGET:
            errors.append(f"http-burst only targets {HTTP_TARGET}")
        if not isinstance(run.get("conns"), int) or isinstance(run.get("conns"), bool) or not 1 <= run["conns"] <= MAX_BURST_CONNS:
            errors.append(f"http-burst conns must be 1 to {MAX_BURST_CONNS}")
        if not isinstance(run.get("period_s"), int) or isinstance(run.get("period_s"), bool) or not 1 <= run["period_s"] <= 10:
            errors.append("http-burst period_s must be 1 to 10")
    if tool == "udp-burst":
        if not isinstance(run.get("burst"), int) or isinstance(run.get("burst"), bool) or not 1 <= run["burst"] <= MAX_UDP_BURST:
            errors.append(f"udp-burst burst must be 1 to {MAX_UDP_BURST}")
        if not isinstance(run.get("payload_bytes"), int) or isinstance(run.get("payload_bytes"), bool) or not 600 <= run["payload_bytes"] <= MAX_PAYLOAD_BYTES:
            errors.append(f"udp-burst payload_bytes must be 600 to {MAX_PAYLOAD_BYTES}")
        if not isinstance(run.get("period_s"), int) or isinstance(run.get("period_s"), bool) or not 2 <= run["period_s"] <= 30:
            errors.append("udp-burst period_s must be 2 to 30")
    if tool == "arp-flood":
        if not isinstance(pps, int) or isinstance(pps, bool) or pps > MAX_ARP_PPS:
            errors.append(f"arp-flood pps must be a positive integer of at most {MAX_ARP_PPS}")
        if not isinstance(run.get("count"), int) or isinstance(run.get("count"), bool) or run["count"] <= 0:
            errors.append("arp-flood needs a positive integer count")
        elif isinstance(pps, int) and pps > 0 and run["count"] / pps > MAX_RUN_SECONDS:
            errors.append(f"arp-flood count/pps = {run['count'] / pps:.0f} s is above the {MAX_RUN_SECONDS} s limit")
    if tool == "tcp-stream":
        if run.get("target") != LOCAL_RECEIVER_TARGET:
            errors.append(f"tcp-stream needs a receiver this harness can start; its only target is {LOCAL_RECEIVER_TARGET}")
        if not isinstance(run.get("bandwidth_mbit"), int) or isinstance(run.get("bandwidth_mbit"), bool) or not 1 <= run["bandwidth_mbit"] <= MAX_STREAM_MBIT:
            errors.append(f"tcp-stream bandwidth_mbit must be 1 to {MAX_STREAM_MBIT}")
    if errors:
        raise RunRejected("; ".join(errors))
    return run


def interval_text(per_second):
    """The gap between events at `per_second` events a second, as the decimal text ping and sleep take: microsecond precision,
    by integer arithmetic (exact for rates that divide a million, such as every rate in the catalog; otherwise truncated)."""
    if not isinstance(per_second, int) or isinstance(per_second, bool) or not 1 <= per_second <= 1000:
        raise ValueError(f"per_second must be an integer from 1 to 1000 (got {per_second!r})")
    us = 1_000_000 // per_second
    return f"{us // 1_000_000}.{us % 1_000_000:06d}"


def remote_command(run):
    """The argv that runs on the sender, from fixed templates. Always under `timeout`. None for an idle run."""
    validate(run)
    tool = run["tool"]
    if tool == "idle":
        return None
    tgt = run["target"]
    secs = run["seconds"]
    if tool == "ping":
        inner = ["ping", "-I", "eth0", "-c", str(secs * run["pps"]), "-i", interval_text(run["pps"]), "-q", tgt]
    elif tool == "http-get":
        # Small GETs to the Pi 5's Hailo service at a bounded rate. Only validated integers and an allowlisted path are used.
        url = f"http://{tgt}:{HTTP_PORT}{run['path']}"
        gap = interval_text(run["rps"])
        # The loop text is a constant; the url, gap and duration are passed as arguments ($1, $2, $3), never spliced into it.
        return ["timeout", str(secs + 5), "sh", "-c", HTTP_LOOP_SCRIPT, "sh", url, gap, str(secs)]
    elif tool == "udp-small":
        return ["timeout", str(secs + 5), "python3", "-c", UDP_SMALL_SCRIPT, tgt, str(run.get("port", 53)), str(run["pps"]), str(secs),
                str(run.get("payload_bytes", 60)), HOSTS[run["sender"]]]
    elif tool == "tcp-stream":
        return ["timeout", str(secs + 10), "python3", "-c", TCP_STREAM_SCRIPT, tgt, str(STREAM_PORT), str(run["bandwidth_mbit"]), str(secs), HOSTS[run["sender"]]]
    elif tool == "tcp-interactive":
        return ["timeout", str(secs + 10), "python3", "-c", TCP_INTERACTIVE_SCRIPT, tgt, str(STREAM_PORT), str(run["events_per_s"]), str(secs), HOSTS[run["sender"]]]
    elif tool == "http-burst":
        return ["timeout", str(secs + 10), "sh", "-c", HTTP_BURST_SCRIPT, "sh", f"http://{tgt}:{HTTP_PORT}", str(run["conns"]), str(run["period_s"]), str(secs)]
    elif tool == "udp-burst":
        return ["timeout", str(secs + 10), "python3", "-c", UDP_BURST_SCRIPT, tgt, str(UDP_BURST_PORT), str(run["burst"]), str(run["payload_bytes"]),
                str(run["period_s"]), str(secs), HOSTS[run["sender"]]]
    elif tool == "arp-flood":
        inner = ["nping", "--arp", "--arp-type", "arp-request", "--arp-target-ip", tgt, "--rate", str(run["pps"]), "-c", str(run["count"]), "-e", "eth0", tgt]
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
        inner = ["nmap", "-sS", f"-T{run['timing']}", "-p", run["ports"], "-n", "-Pn", "--max-retries", "0"]
        if run.get("delay_ms"):
            inner += ["--scan-delay", f"{run['delay_ms']}ms"]
        inner.append(tgt)
    # hping3 and nmap need raw sockets: run them as root through passwordless sudo on the adversary node, with the
    # `timeout` INSIDE sudo so it is root that kills the tool when the limit is reached.
    if tool in ("hping3", "nmap", "arp-flood"):
        return ["sudo", "-n", "timeout", str(secs + 5)] + inner
    return ["timeout", str(secs + 5)] + inner


# The two files the local web server serves; the allowlisted request paths map to them.
HTTP_FILES = {"health": '{"status":"HEALTHY","hailo_device":"CONNECTED","active_model":"yolov8s_h8.hef"}',
              "page": "<html><body>" + ("The quick brown fox jumps over the lazy dog. " * 440)[:20000] + "</body></html>",
              "models": '{"active_model":"yolov8s_h8.hef","models":[' + ",".join('{"name":"m%d","filename":"m%d.hef"}' % (i, i) for i in range(12)) + "]}"}


def receiver_command(run, docroot=None):
    """
    The argv of a receiver this harness starts on THIS machine before the sender, or None when the target needs no server.
    http-get needs the directory the two static files are in (docroot); the harness creates it.
    """
    validate(run)
    if run["tool"] in ("tcp-stream", "tcp-interactive"):
        return ["python3", "-c", TCP_SINK_SCRIPT, LOCAL_RECEIVER_TARGET, str(STREAM_PORT), str(run["seconds"] + 15)]
    if run["tool"] in ("http-get", "http-burst"):
        return ["python3", "-m", "http.server", str(HTTP_PORT), "--bind", LOCAL_RECEIVER_TARGET, "--directory", docroot or "<docroot>"]
    return None


def capture_pidfile(run_id):
    return f"/tmp/labelled-{run_id}.pid"


def capture_command(run_id):
    """
    The argv that runs on the Jetson: record the pid, then become `timeout`, which runs tcpdump on the tap for the
    whole run. Stopping it is `kill -INT <pid>` from the pid file (timeout forwards the signal to tcpdump), not a
    match on the command line. run_id was validated to plain characters, so the script text holds nothing else.
    """
    inner = ["timeout", "-s", "INT", str(MAX_RUN_SECONDS + 2 * SETTLE_SECONDS + 10), "tcpdump", "-i", TAP_IFACE, "-n", "-U",
             "-w", f"/tmp/labelled-{run_id}.pcap", CAPTURE_FILTER]
    return ["sh", "-c", f"echo $$ > {capture_pidfile(run_id)}; exec {shlex.join(inner)}"]


# --- the catalog -----------------------------------------------------------------------------------------------
def _benign(id_, tool, sender, target, seconds, **kw):
    return {"id": id_, "class": BENIGN, "tool": tool, "sender": sender, "target": target, "seconds": seconds, **kw}


def _attack(id_, tool, target, seconds, **kw):
    return {"id": id_, "class": ATTACK, "tool": tool, "sender": ADVERSARY, "target": target, "seconds": seconds, **kw}


def _idle(id_, seconds):
    return {"id": id_, "class": BENIGN, "tool": "idle", "sender": None, "target": None, "seconds": seconds}


def repeats(run, n):
    """The run and n-1 repeats: the first keeps its id (so earlier recordings still match), the others get -r2, -r3, ..."""
    pattern = run["id"]
    return [{**run, "pattern": pattern}] + [{**run, "id": f"{pattern}-r{i}", "pattern": pattern} for i in range(2, n + 1)]


CATALOG = (
    # --- benign: ping (first recorded 2026-10-17)
    repeats(_benign("benign-ping-5pps", "ping", "agentic-node-02", "10.0.2.119", 60, pps=5), 3)
    + [_benign("benign-ping-5pps-node01", "ping", "agentic-node-01", "10.0.2.119", 60, pps=5)]
    + repeats(_benign("benign-ping-20pps", "ping", "agentic-node-02", "10.0.2.119", 30, pps=20), 2)
    # --- benign: the classes added for the next scoring round
    + repeats(_idle("benign-idle-60s", 60), 2)
    + repeats(_benign("benign-http-5rps", "http-get", "agentic-node-02", "10.0.2.119", 30, rps=5, path="/health"), 3)
    + repeats(_benign("benign-http-20rps", "http-get", "agentic-node-02", "10.0.2.119", 30, rps=20, path="/models"), 2)
    + repeats(_benign("benign-udp-small-10pps", "udp-small", "agentic-node-02", "10.0.2.119", 30, pps=10, payload_bytes=60, port=53), 3)
    + repeats(_benign("benign-udp-small-50pps", "udp-small", "agentic-node-02", "10.0.2.119", 30, pps=50, payload_bytes=100, port=53), 2)
    + repeats(_benign("benign-bulk-tcp-10mbit", "tcp-stream", "agentic-node-02", "10.0.2.119", 20, bandwidth_mbit=10, risky=True), 2)
    + repeats(_benign("benign-bulk-tcp-node01-10mbit", "tcp-stream", "agentic-node-01", "10.0.2.119", 20, bandwidth_mbit=10, risky=True), 2)
    # --- benign workloads added for the second recording (modelled where stated)
    + repeats(_benign("benign-bulk-tcp-2mbit", "tcp-stream", "agentic-node-02", "10.0.2.119", 20, bandwidth_mbit=2), 2)
    + repeats(_benign("benign-bulk-tcp-5mbit", "tcp-stream", "agentic-node-02", "10.0.2.119", 20, bandwidth_mbit=5, risky=True), 2)
    + repeats(_benign("benign-bulk-tcp-20mbit", "tcp-stream", "agentic-node-02", "10.0.2.119", 20, bandwidth_mbit=20, risky=True), 2)
    + repeats(_benign("benign-interactive-8eps", "tcp-interactive", "agentic-node-02", "10.0.2.119", 30, events_per_s=8), 3)  # ssh-like, modelled
    + repeats(_benign("benign-http-burst-8conns", "http-burst", "agentic-node-02", "10.0.2.119", 30, conns=8, period_s=3), 3)  # browsing-like
    + repeats(_benign("benign-udp-burst-tailscale-like", "udp-burst", "agentic-node-02", "10.0.2.119", 30, burst=25, payload_bytes=1300, period_s=10), 3)  # modelled
    # --- UDP-burst hang repro (2026-10-18): one factor at a time from the base pattern; risky (the base coincided with switch
    # drops in 3 of 4 recordings), so gated by --include-risky and kept out of the scored data
    + repeats(_benign("repro-udp-burst-base", "udp-burst", "agentic-node-02", "10.0.2.119", 30, burst=25, payload_bytes=1300, period_s=10, risky=True), 2)
    + [_benign("repro-udp-burst-600b", "udp-burst", "agentic-node-02", "10.0.2.119", 30, burst=25, payload_bytes=600, period_s=10, risky=True)]
    + [_benign("repro-udp-burst-5x", "udp-burst", "agentic-node-02", "10.0.2.119", 30, burst=5, payload_bytes=1300, period_s=10, risky=True)]
    + [_benign("repro-udp-burst-node01", "udp-burst", "agentic-node-01", "10.0.2.119", 30, burst=25, payload_bytes=1300, period_s=10, risky=True)]
    # --- attacks (first recorded 2026-10-17), repeated for the next round
    + repeats(_attack("attack-synflood-1000pps", "hping3", "10.0.2.119", 10, pps=1000, count=10000, flags_or_proto="syn", port=80), 3)
    + repeats(_attack("attack-synflood-200pps", "hping3", "10.0.2.119", 30, pps=200, count=6000, flags_or_proto="syn", port=80), 3)
    + repeats(_attack("attack-udpflood-500pps-1400b", "hping3", "10.0.2.119", 10, pps=500, count=5000, flags_or_proto="udp", payload_bytes=1400, port=5001), 3)
    + repeats(_attack("attack-portscan-fast", "nmap", "10.0.2.119", 20, timing=4, ports="1-1000"), 3)
    + repeats(_attack("attack-portscan-slow", "nmap", "10.0.2.119", 120, timing=2, ports="1-200"), 3)
    + repeats(_attack("attack-portscan-1pps", "nmap", "10.0.2.119", 70, timing=2, ports="1-60", delay_ms=1000), 2)
    + repeats(_attack("attack-portscan-half-pps", "nmap", "10.0.2.119", 70, timing=2, ports="1-30", delay_ms=2000), 2)
    + repeats(_attack("attack-arpflood-200pps", "arp-flood", "10.0.2.119", 12, pps=200, count=2000), 3)
)


for _run in CATALOG:
    _run.setdefault("pattern", _run["id"])  # a run with no repeats is its own pattern


def wait_listening(host, port, proc, seconds=8):
    """Wait until host:port accepts a TCP connection, or fail: a sender must not start against a receiver that is not up."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError("the local receiver exited while starting")
        try:
            with socket.create_connection((host, port), timeout=1):
                return
        except OSError:
            time.sleep(0.2)
    raise RuntimeError(f"the local receiver did not accept connections on {host}:{port} within {seconds} s")


def execute(run, outdir):
    ok, why = rack_healthy()
    if not ok:
        raise SystemExit(f"stopping before {run['id']}: {why}")
    rid = run["id"]
    who = f"from {run['sender']} -> {run['target']}" if run["tool"] != "idle" else "nothing sent"
    print(f"[run] {rid}: {run['class']} {who} for up to {run['seconds']} s", flush=True)
    window_start = jetson_epoch()
    cap = subprocess.Popen(["ssh", JETSON, shlex.join(capture_command(rid))], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    srv = None
    docroot = None
    if run["tool"] in ("http-get", "http-burst"):
        docroot = tempfile.mkdtemp(prefix="labelled-docroot-")
        for name, body in HTTP_FILES.items():
            with open(os.path.join(docroot, name), "w") as fh:
                fh.write(body)
    returncode, stderr_tail, t0, t1 = None, "", time.monotonic(), time.monotonic()
    healthy_after, why_after, drops = False, "the run did not finish", None
    try:
        time.sleep(SETTLE_SECONDS)
        if cap.poll() is not None:
            raise RuntimeError(f"capture exited early: {cap.stderr.read().decode()[:300]}")
        rcv = receiver_command(run, docroot)
        if rcv is not None:
            srv = subprocess.Popen(rcv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(1)
            if srv.poll() is not None:
                raise RuntimeError(f"the local receiver {rcv[0]} exited at once (is the port free and the alias up?)")
            # Proof it accepts connections, not just that its process exists (an intermittent miss was seen without this).
            wait_listening(LOCAL_RECEIVER_TARGET, HTTP_PORT if run["tool"] in ("http-get", "http-burst") else STREAM_PORT, srv)
        t0 = time.monotonic()
        cmd = remote_command(run)
        if cmd is None:
            time.sleep(run["seconds"])  # idle: the capture alone is the run
            returncode = 0
        else:
            res = subprocess.run(["ssh", run["sender"], shlex.join(cmd)], capture_output=True, text=True, timeout=run["seconds"] + 30)
            returncode, stderr_tail = res.returncode, res.stderr[-300:]
        t1 = time.monotonic()
        time.sleep(SETTLE_SECONDS)
        # Did the switch survive the run? Give the bridge's dead-peer detection time to notice a hung control plane first.
        time.sleep(POST_RUN_GRACE_SECONDS)
        healthy_after, why_after = rack_healthy()
        drops = controller_drops_since(window_start)
        if drops is None:
            healthy_after, why_after = False, "the bridge's journal could not be read for the run window"
        elif drops:
            healthy_after, why_after = False, f"the bridge logged {drops} dead-peer event(s) during the run window"
    finally:
        pidfile = capture_pidfile(rid)
        subprocess.run(["ssh", JETSON, f"kill -INT $(cat {pidfile}) 2>/dev/null; rm -f {pidfile}"], capture_output=True)
        try:
            cap.wait(timeout=10)
        except subprocess.TimeoutExpired:
            cap.kill()
        if srv is not None:
            srv.terminate()  # macOS has no `timeout`: stop the local receiver explicitly
            try:
                srv.wait(timeout=5)
            except subprocess.TimeoutExpired:
                srv.kill()
        if docroot is not None:
            shutil.rmtree(docroot, ignore_errors=True)
    os.makedirs(outdir, exist_ok=True)
    pcap = os.path.join(outdir, f"{rid}.pcap")
    subprocess.run(["scp", "-q", f"{JETSON}:/tmp/labelled-{rid}.pcap", pcap], check=True)
    label = {
        "id": rid, "class": run["class"], "tool": run["tool"], "sender": run["sender"],
        "senderIp": HOSTS.get(run["sender"]) if run["sender"] else None,
        "target": run["target"], "pattern": run.get("pattern", rid),
        "params": {k: v for k, v in run.items() if k not in ("id", "class", "tool", "sender", "target", "pattern")},
        "command": remote_command(run), "commandExit": returncode, "commandSeconds": round(t1 - t0, 1),
        "pcap": os.path.basename(pcap), "commandStderrTail": stderr_tail,
        "rackHealthyAfter": healthy_after, "rackNoteAfter": why_after, "controllerDropsDuringRun": drops,
    }
    with open(os.path.join(outdir, f"{rid}.label.json"), "w") as f:
        json.dump(label, f, indent=2)
    print(f"[run] {rid}: done, command exit {returncode}, {label['commandSeconds']} s, {os.path.getsize(pcap)} bytes captured", flush=True)
    if not healthy_after:
        # Stop the batch: this run is marked, nothing more is sent, and a person needs to look at the switch.
        raise SystemExit(f"STOPPED: the rack is unhealthy after {rid}: {why_after}. The run is recorded but marked rackHealthyAfter=false; it will not be scored.")
    time.sleep(SPACING_SECONDS)


def rack_healthy():
    """
    (ok, why). Before and after every run: the switch's OpenFlow session must be Connected and the isolation policy must read
    back verified, freshly. A run against a switch whose control plane is down tests nothing, and a switch that dropped
    during a run makes that run's capture meaningless. Read through the bridge on the Jetson. Fails closed: no answer, or an
    answer that is not exactly as expected, is unhealthy.
    """
    try:
        r = subprocess.run(["ssh", JETSON, "curl -s -m 8 localhost:3003/api/zodiac; echo; echo ---; curl -s -m 8 localhost:3003/api/zodiac/flows"],
                           capture_output=True, text=True, timeout=40)
    except subprocess.TimeoutExpired:
        return False, "the Jetson did not answer within 40 s"
    try:
        snap_text, flows_text = r.stdout.split("\n---\n", 1)
        snap = json.loads(snap_text)
        iso = json.loads(flows_text)["port1Isolation"]
        of_status = snap["openflow"]["status"]
    except (ValueError, KeyError, TypeError):
        return False, "the bridge on the Jetson did not return a usable status"
    if of_status != "Connected":
        return False, f"the switch's OpenFlow session is {of_status!r}, not 'Connected'"
    if not isinstance(iso, dict):
        return False, "the isolation status is not an object"
    if iso.get("state") != "verified":
        return False, f"the isolation policy reads {iso.get('state')!r}, not 'verified' (the switch's control plane may be down)"
    age = iso.get("checkedAgeMs")
    if not isinstance(age, int) or age > RACK_STATUS_MAX_AGE_MS:
        return False, f"the isolation readback is {age!r} ms old (limit {RACK_STATUS_MAX_AGE_MS})"
    return True, "OpenFlow connected, isolation verified"


def jetson_epoch():
    """Whole seconds since the epoch on the Jetson's own clock, so a journal window is not skewed by this machine's clock.
    Called before any traffic is sent, so a failure here stops the batch with nothing sent."""
    try:
        r = subprocess.run(["ssh", JETSON, "date +%s"], capture_output=True, text=True, timeout=30)
        return int(r.stdout.strip())
    except (subprocess.TimeoutExpired, ValueError) as e:
        raise SystemExit(f"could not read the Jetson's clock ({type(e).__name__}); nothing was sent")


def controller_drops_since(epoch):
    """
    How many times the bridge logged a dead OpenFlow peer since `epoch` (Jetson clock), or None when that cannot be read. A drop
    that recovered before the post-run health check still counts: the check of the current state cannot see it, the journal can.
    The journal text is fetched and counted here (a failed read is not mistaken for "zero matches"), and the caller treats
    None as unhealthy.
    """
    try:
        r = subprocess.run(["ssh", JETSON, f"journalctl -u zodiac-bridge --no-pager --since @{int(epoch)}"], capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        return None
    if r.returncode != 0:
        return None
    return sum(1 for line in r.stdout.splitlines() if "Dead peer detected" in line)


def preflight(runs):
    r = subprocess.run(["ssh", JETSON, "getcap /usr/bin/tcpdump"], capture_output=True, text=True, timeout=20)
    if "cap_net_raw" not in r.stdout:
        raise SystemExit("capture is not set up: on the Jetson run  sudo setcap cap_net_raw,cap_net_admin=eip /usr/bin/tcpdump")
    if any(x["tool"] in ("tcp-stream", "tcp-interactive", "http-get", "http-burst") for x in runs):
        r = subprocess.run(["ifconfig"], capture_output=True, text=True)
        if f"inet {LOCAL_RECEIVER_TARGET} " not in r.stdout:
            raise SystemExit(f"this machine does not have {LOCAL_RECEIVER_TARGET}, where the local receivers must bind")
    for host in sorted({x["sender"] for x in runs if x["tool"] in ("hping3", "nmap", "arp-flood")}):
        if subprocess.run(["ssh", host, "sudo -n true"], capture_output=True, timeout=20).returncode != 0:
            raise SystemExit(f"{host} has no passwordless sudo, which hping3 and nmap need for raw sockets")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--execute", action="store_true")
    ap.add_argument("--out")
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--class", dest="klass", choices=(BENIGN, ATTACK))
    ap.add_argument("--all", action="store_true", help="with --execute and no --only: run every non-risky run in the catalog")
    ap.add_argument("--include-risky", action="store_true",
                    help="also run the runs marked risky (bulk TCP at 5 Mbit and above, which coincided with switch outages)")
    a = ap.parse_args()
    if sum([a.list, a.dry_run, a.execute]) != 1:
        ap.error("choose exactly one of --list, --dry-run, --execute")
    # `--only` with no ids is a mistake (an empty shell expansion), not "everything": refuse it. A whole-catalog run is asked for by
    # leaving --only out, and --execute then needs --all as well, so a run of the catalog is never an accident.
    if a.only is not None and not a.only:
        ap.error("--only was given no run ids (an empty list is not 'all runs'; leave --only out and use --all for that)")
    if a.execute and a.only is None and not a.all:
        ap.error("--execute needs --only ID [ID ...] or --all (it will not default to running the whole catalog)")
    runs = [r for r in CATALOG if (a.only is None or r["id"] in a.only) and (a.klass is None or r["class"] == a.klass)]
    risky = [r["id"] for r in runs if r.get("risky")]
    if risky and not a.include_risky:
        if a.only is not None:
            ap.error(f"{', '.join(risky)} are marked risky (bulk TCP at 5 Mbit and above coincided with switch outages); add --include-risky to run them")
        runs = [r for r in runs if not r.get("risky")]  # a class or whole-catalog selection quietly leaves them out
    if a.only is not None and len(runs) != len(a.only) and not risky:
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
            print(f"{r['id']:34s} {r['class']:7s} {r['tool']:10s} {str(r['sender'] or '-'):16s} -> {str(r['target'] or '-'):11s} {r['seconds']:3d} s")
    elif a.dry_run:
        for r in runs:
            rcv, cmd = receiver_command(r), remote_command(r)
            print(f"# {r['id']}\n  jetson: {shlex.join(capture_command(r['id']))}")
            if rcv is not None:
                print(f"  this machine (receiver): {shlex.join(rcv)}")
            print(f"  {r['sender']}: {shlex.join(cmd)}" if cmd is not None else "  (idle: nothing is sent)")
    else:
        if not a.out:
            ap.error("--execute needs --out DIR")
        preflight(runs)
        for r in runs:
            execute(r, a.out)


if __name__ == "__main__":
    main()
