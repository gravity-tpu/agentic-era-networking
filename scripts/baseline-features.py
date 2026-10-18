#!/usr/bin/env python3
"""
scripts/baseline-features.py
============================
Per-source traffic features for the labelled runs, to see which simple, explainable features separate the attack runs from
the benign ones, before any detector is built on them. For each run and the run's own sender: the largest value, over the run,
of
  pps         frames in any 1 s bucket
  bytes/s     wire bytes in any 1 s bucket
  syn/s       TCP SYN-without-ACK frames in any 1 s bucket (new connection attempts)
  ports/10s   distinct destination ports in any 10 s window (TCP or UDP)
  ports       distinct destination ports over the whole run
All counting is integer; times are the capture's integer nanoseconds. A frame's destination port is the transport header's.

Usage: python3 scripts/baseline-features.py docs/benchmarks/results/labelled-runs [--json OUT]
Needs numpy (through scripts/sentinel-replay.py).
"""

import collections
import glob
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("sentinel_replay", os.path.join(HERE, "sentinel-replay.py"))
sr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sr)

SECOND_NS = 1_000_000_000
PORT_WINDOW_NS = 10 * SECOND_NS
TCP, UDP = 6, 17


def run_features(frames, sender):
    """frames: sr.parse_pcap(..., with_src=True) tuples. Features of the sender's own frames."""
    mine = [f for f in frames if f[6] == sender]
    if not mine:
        return None
    t0 = mine[0][7]
    pps, byts, syns = collections.Counter(), collections.Counter(), collections.Counter()
    ports_all = set()
    ports_seen = collections.deque()  # (t_ns, port) within the last PORT_WINDOW_NS
    max_ports_10s = 0
    for _t_us, wire_len, proto, flags, _sp, dp, _src, t_ns in mine:
        b = (t_ns - t0) // SECOND_NS
        pps[b] += 1
        byts[b] += wire_len
        if proto == TCP and (flags & 0x12) == 0x02:
            syns[b] += 1
        if proto in (TCP, UDP):
            ports_all.add(dp)
            ports_seen.append((t_ns, dp))
            while ports_seen and t_ns - ports_seen[0][0] > PORT_WINDOW_NS:
                ports_seen.popleft()
            max_ports_10s = max(max_ports_10s, len({p for _t, p in ports_seen}))
    return {
        "frames": len(mine),
        "maxPps": max(pps.values()),
        "maxBytesPerSec": max(byts.values()),
        "maxSynPerSec": max(syns.values()) if syns else 0,
        "maxPorts10s": max_ports_10s,
        "ports": len(ports_all),
    }


_score_spec = importlib.util.spec_from_file_location("score_labelled_runs", os.path.join(HERE, "score-labelled-runs.py"))
_score = importlib.util.module_from_spec(_score_spec)
_score_spec.loader.exec_module(_score)


def load(datadir):
    rows = []
    for lp in sorted(glob.glob(os.path.join(datadir, "*.label.json"))):
        label = json.load(open(lp))
        if label.get("senderIp") is None:
            continue
        pcap = os.path.join(datadir, label["pcap"])
        if not os.path.exists(pcap) and os.path.exists(pcap + ".gz"):
            pcap += ".gz"
        feats = run_features(sr.parse_pcap(pcap, with_src=True), label["senderIp"])
        if not _score.rack_ok(label):
            continue  # recorded on an unhealthy rack: left out, as in the scorer
        if feats is not None and feats["frames"] >= _score.MIN_SENDER_FRAMES:
            pattern = label.get("pattern") or label["id"]
            rows.append({"id": label["id"], "class": label["class"], "tool": label["tool"], "pattern": pattern, **feats})
    return rows


def main():
    args = sys.argv[1:]
    out = None
    if "--json" in args:
        i = args.index("--json")
        out = args[i + 1]
        del args[i:i + 2]
    rows = load(args[0])
    print(f"{'run':32s} {'class':7s} {'frames':>6s} {'maxPps':>7s} {'maxB/s':>9s} {'maxSYN/s':>9s} {'ports/10s':>9s} {'ports':>6s}")
    for r in sorted(rows, key=lambda r: (r["class"], r["id"])):
        print(f"{r['id']:32s} {r['class']:7s} {r['frames']:6d} {r['maxPps']:7d} {r['maxBytesPerSec']:9d} {r['maxSynPerSec']:9d} {r['maxPorts10s']:9d} {r['ports']:6d}")
    print()
    print("Separation per feature (largest benign value vs smallest attack value; a margin > 1 means one threshold separates them on this data):")
    for key, name in (("maxPps", "pps"), ("maxBytesPerSec", "bytes/s"), ("maxSynPerSec", "SYN/s"), ("maxPorts10s", "distinct ports per 10 s"), ("ports", "distinct ports per run")):
        ben = max(r[key] for r in rows if r["class"] == "benign")
        atk = min(r[key] for r in rows if r["class"] == "attack")
        margin = f"{atk / ben:.1f}x" if ben > 0 else "benign is 0"
        weakest = min((r for r in rows if r["class"] == "attack"), key=lambda r: r[key])["id"]
        print(f"  {name:26s} largest benign {ben:>9d}   smallest attack {atk:>9d} ({weakest})   attack/benign {margin}")
    if out:
        with open(out, "w") as f:
            json.dump(rows, f, indent=2)


if __name__ == "__main__":
    main()
