#!/usr/bin/env python3
"""
scripts/baseline-detector.py
============================
Offline prototype of the per-source baseline detector (docs/design/per-source-baseline-detector.md), scored on the labelled
runs. Nothing here runs on the rack.

Per source IPv4 and per 1 s bucket (integer counts, the capture's integer-nanosecond clock):
  nontcp_pps    non-TCP IP frames          (a UDP or ICMP flood)
  nontcp_bytes  non-TCP wire bytes         (a volumetric flood)
  syn_per_s     TCP SYN-without-ACK frames (new connection attempts: a SYN flood, a fast scan)
  ports_10s     distinct destination ports in the last 10 s, TCP or UDP (a scan, fast or slow)
TCP data volume is deliberately NOT a feature (bulk transfers are benign and not yet recorded); that is a stated gap.

A threshold for each feature is max(FLOOR, MARGIN x the largest value that feature took in the benign training runs). A source
alerts when any feature is above its threshold in at least HITS of the last WINDOW buckets (damping, Invariant 5), or at
SEVERE times its threshold in a single bucket. A source
is reported again only after QUIET_BUCKETS quiet buckets (no "once until restart").

Two scorings: in-sample (thresholds from all benign runs) and leave-one-benign-workload-group-out (thresholds from the
other groups, tested on the held-out one), which shows how much of the result is the data and how much the floors.

Usage: python3 scripts/baseline-detector.py docs/benchmarks/results/labelled-runs
Needs numpy (through scripts/sentinel-replay.py).
"""

import collections
import glob
import importlib.util
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("sentinel_replay", os.path.join(HERE, "sentinel-replay.py"))
sr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sr)

SECOND_NS = 1_000_000_000
PORT_WINDOW_BUCKETS = 10
WINDOW, HITS, QUIET_BUCKETS = 3, 2, 5
MARGIN = 3
# A value this many times its threshold alerts on a single bucket: a burst that ends inside one second (a fast scan) would never
# collect HITS buckets, and a value ten times past the largest benign envelope needs no second opinion.
SEVERE = 10
# Floors are judgment, not measurement: no ordinary host is expected to sustain more than this on a small segment. The data
# only show the benign runs sit far below them and the attacks far above.
FLOORS = {"nontcp_pps": 100, "nontcp_bytes": 100_000, "syn_per_s": 30, "ports_10s": 10}
FEATURES = tuple(FLOORS)
# Benign tools grouped by how they behave, for the leave-one-out test: holding out only `http-get` while `http-burst` stays in the
# training data is not a test of an unseen kind of workload, because a near twin is still there.
GROUPS = {"ping": "ping", "idle": "idle", "http-get": "http", "http-burst": "http", "udp-small": "udp", "udp-burst": "udp",
          "tcp-stream": "tcp", "tcp-interactive": "tcp"}
TCP, UDP = 6, 17


def usable_source(ip):
    """A real unicast source. Loopback, unspecified, multicast and broadcast addresses are not hosts that can be quarantined, so
    they are not tracked (the trt daemon's parse_src_ip applies the same rule). scripts/baseline-features.py keys on the run's
    own sender, which is always a unicast host, so the two agree on every labelled run."""
    if ip is None:
        return False
    first = int(ip.split(".")[0])
    return first not in (0, 127, 255) and first < 224


def source_buckets(frames):
    """{src: {bucket: {feature: value}}} with one bucket per whole second since the capture's first frame."""
    if not frames:
        return {}
    t0 = frames[0][7]
    per = collections.defaultdict(lambda: collections.defaultdict(lambda: {"nontcp_pps": 0, "nontcp_bytes": 0, "syn_per_s": 0, "ports": set()}))
    for _t_us, wire_len, proto, flags, _sp, dp, src, t_ns in frames:
        if not usable_source(src):
            continue
        b = per[src][(t_ns - t0) // SECOND_NS]
        if proto != TCP:
            b["nontcp_pps"] += 1
            b["nontcp_bytes"] += wire_len
        elif (flags & 0x12) == 0x02:
            b["syn_per_s"] += 1
        if proto in (TCP, UDP):
            b["ports"].add(dp)
    out = {}
    for src, buckets in per.items():
        last = max(buckets)
        series = {}
        for b in range(last + 1):
            cur = buckets.get(b)
            ports = set()
            for k in range(max(0, b - PORT_WINDOW_BUCKETS + 1), b + 1):
                if k in buckets:
                    ports |= buckets[k]["ports"]
            series[b] = {"nontcp_pps": cur["nontcp_pps"] if cur else 0, "nontcp_bytes": cur["nontcp_bytes"] if cur else 0,
                         "syn_per_s": cur["syn_per_s"] if cur else 0, "ports_10s": len(ports)}
        out[src] = series
    return out


def thresholds(benign_series, floors=True):
    """max(FLOOR, MARGIN x largest benign value) per feature, over every source in the training runs (floors=False: data only)."""
    peak = {f: 0 for f in FEATURES}
    for per_src in benign_series:
        for series in per_src.values():
            for vals in series.values():
                for f in FEATURES:
                    peak[f] = max(peak[f], vals[f])
    return {f: max(FLOORS[f] if floors else 0, MARGIN * peak[f]) for f in FEATURES}


def alerts(series, thr):
    """
    [(bucket, [features over threshold])]. Damping: HITS of the last WINDOW buckets over threshold, or one bucket at SEVERE
    times a threshold. One report per episode: after a report the source is silent, however long it stays hot, and is re-armed
    only after QUIET_BUCKETS CONSECUTIVE buckets with no feature over its threshold.
    """
    out, recent = [], collections.deque(maxlen=WINDOW)
    armed, quiet_run = True, 0
    for b in sorted(series):
        over = [f for f in FEATURES if series[b][f] > thr[f]]
        recent.append(over)
        quiet_run = 0 if over else quiet_run + 1
        if quiet_run >= QUIET_BUCKETS:
            armed = True
        counts = collections.Counter(f for o in recent for f in o)
        hot = sorted(set([f for f, c in counts.items() if c >= HITS] + [f for f in over if series[b][f] >= SEVERE * max(1, thr[f])]))
        if hot and armed:
            out.append((b, hot))
            armed = False
    return out


_score_spec = importlib.util.spec_from_file_location("score_labelled_runs", os.path.join(HERE, "score-labelled-runs.py"))
_score = importlib.util.module_from_spec(_score_spec)
_score_spec.loader.exec_module(_score)


def sender_frame_count(frames, sender_ip):
    """How many of the run's frames came from its sender (the tuple position is named in sentinel-replay.py)."""
    return sum(1 for f in frames if f[sr.FRAME_SRC_IP] == sender_ip)


def load(datadir):
    """Labelled runs that count: a run recorded on an unhealthy rack, or in which the sender is barely seen, is left out here too,
    by the same rule the scorer uses (a run that tested nothing is not a clean benign run)."""
    runs = []
    for lp in sorted(glob.glob(os.path.join(datadir, "*.label.json"))):
        label = json.load(open(lp))
        pcap = os.path.join(datadir, label["pcap"])
        if not os.path.exists(pcap) and os.path.exists(pcap + ".gz"):
            pcap += ".gz"
        frames = sr.parse_pcap(pcap, with_src=True)
        sender_ip = label.get("senderIp")
        if not _score.rack_ok(label) or (sender_ip is not None and sender_frame_count(frames, sender_ip) < _score.MIN_SENDER_FRAMES):
            print(f"INVALID (left out): {label['id']}")
            continue
        pattern = label.get("pattern") or re.sub(r"-r\d+$", "", label["id"])  # earlier labels carry no pattern field
        runs.append({"label": label, "pattern": pattern, "family": GROUPS.get(label.get("tool"), label.get("tool")), "series": source_buckets(frames)})
    return runs


def score_run(run, thr):
    sender = run["label"]["senderIp"]
    res = []
    for src, series in run["series"].items():
        for b, feats in alerts(series, thr):
            res.append({"src": src, "second": b, "features": feats})
    named = [a for a in res if a["src"] == sender]
    others = sorted({a["src"] for a in res if a["src"] != sender})
    return {"alerts": len(res), "namedSender": bool(named), "namedOthers": others,
            "firstSenderAlertSecond": named[0]["second"] if named else None, "features": sorted({f for a in named for f in a["features"]})}


def summarize(label, runs, thr):
    att = [r for r in runs if r["label"]["class"] == "attack"]
    ben = [r for r in runs if r["label"]["class"] == "benign"]
    det = sum(1 for r in att if score_run(r, thr)["namedSender"])
    fp = sum(1 for r in ben if score_run(r, thr)["alerts"] > 0)
    mis = sum(1 for r in runs if score_run(r, thr)["namedOthers"])
    print(f"{label:46s} attacks detected with the right sender {det}/{len(att)}   benign runs with any alert {fp}/{len(ben)}   runs naming a non-sender {mis}/{len(runs)}")
    return det, len(att), fp, len(ben)


def main():
    runs = load(sys.argv[1])
    benign = [r for r in runs if r["label"]["class"] == "benign"]
    thr = thresholds([r["series"] for r in benign])
    print(f"margin {MARGIN}x, damping {HITS} of the last {WINDOW} one-second buckets, re-arm after {QUIET_BUCKETS} quiet buckets")
    print("thresholds from all benign runs:", {f: thr[f] for f in FEATURES}, "(floors", FLOORS, ")")
    print()
    print(f"{'run':32s} {'class':7s} {'alerts':>6s}  {'sender?':8s} {'first alert (s)':>15s}  features")
    for r in sorted(runs, key=lambda r: (r["label"]["class"], r["label"]["id"])):
        s = score_run(r, thr)
        sender = r["label"]["senderIp"] is not None
        first = "-" if s["firstSenderAlertSecond"] is None else str(s["firstSenderAlertSecond"])
        print(f"{r['label']['id']:32s} {r['label']['class']:7s} {s['alerts']:6d}  {('yes' if s['namedSender'] else 'no') if sender else 'idle':8s} {first:>15s}  {','.join(s['features'])}{'  names ' + ','.join(s['namedOthers']) if s['namedOthers'] else ''}")
    print()
    summarize("in-sample (thresholds from all benign runs)", runs, thr)
    print()
    print("leave one benign workload GROUP out (ping, idle, http = polls and bursts, udp = small and bursty, tcp = bulk and interactive: thresholds from the other groups; the held-out group and all attacks are scored):")
    patterns = sorted({r["family"] for r in benign})
    tot_fp = tot_n = tot_fp0 = 0
    for pat in patterns:
        held = [r for r in benign if r["family"] == pat]
        rest = [r for r in benign if r["family"] != pat]
        t = thresholds([r["series"] for r in rest])
        attack = [r for r in runs if r["label"]["class"] == "attack"]
        det = sum(1 for r in attack if score_run(r, t)["namedSender"])
        fp = sum(1 for r in held if score_run(r, t)["alerts"] > 0)
        tot_fp += fp
        tot_n += len(held)
        changed = {f: t[f] for f in FEATURES if t[f] != thr[f]}
        t0 = thresholds([r["series"] for r in rest], floors=False)
        fp0 = sum(1 for r in held if score_run(r, t0)["alerts"] > 0)
        tot_fp0 += fp0
        print(f"  hold out {pat:12s} ({len(held)} runs)  alerts {fp}/{len(held)}  attacks detected {det}/{len(attack)}  thresholds that moved: {changed or 'none'}   | WITHOUT floors: alerts {fp0}/{len(held)}")
    print(f"  held-out benign runs with any alert, all folds: {tot_fp}/{tot_n}   (without the floors, data-derived thresholds only: {tot_fp0}/{tot_n})")


if __name__ == "__main__":
    main()
