#!/usr/bin/env python3
"""
scripts/score-labelled-runs.py
==============================
Scores two detectors on the labelled runs recorded by scripts/labelled-runs.py, by replaying each run's capture:

  sentinel   the GPU sentinel's arithmetic (scripts/sentinel-replay.py, verified against the real kernel), 64-packet
             windows, the 0.15 base threshold with its adaptive baseline; an alert names the most frequent source IP in
             the window, as the sentinel does.
  rate rule  the trt daemon's rule: per source IPv4, a 5 s window, judged after 0.5 s of data, alert above 10 packets
             per second; one alert per source per run (the daemon reports a source once until it restarts).

For each run: did the detector alert, did the alert name the actual sender, and how long after the sender's first frame.
A benign run with any alert is a false positive; an alert naming a host other than the sender is a misattribution.

Timing comes from capture timestamps. The live daemon dropped frames above about 300 per second (its per-frame GPU
inference is the limit), which this replay does not model, so the rate rule here is generous at high rates.

Usage: python3 scripts/score-labelled-runs.py docs/benchmarks/results/labelled-runs [--json OUT]
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

# The trt daemon's rate rule (scripts/trt-inference-daemon.py). test/invariants/score-labelled-runs.test.ts keeps these equal.
RATE_WINDOW_NS = 5_000_000_000
RATE_MIN_ELAPSED_NS = 500_000_000
RATE_THRESHOLD_PPS = 10


def usable_source(ip):
    if ip is None:
        return False
    first = int(ip.split(".")[0])
    return first not in (0, 127, 255) and first < 224


def rate_rule_alerts(frames):
    """[(t_ns, src_ip, pps)], the daemon's logic (integer nanoseconds and integer packets per second) over frames."""
    start, count, reported, out = {}, {}, set(), []
    for fr in frames:
        src, t_ns = fr[6], fr[7]
        if not usable_source(src) or src in reported:
            continue
        ws = start.get(src)
        if ws is None or t_ns - ws >= RATE_WINDOW_NS:
            start[src], count[src] = t_ns, 1
            continue
        count[src] += 1
        elapsed = t_ns - ws
        if elapsed >= RATE_MIN_ELAPSED_NS:
            pps = (count[src] * 1_000_000_000) // elapsed
            if pps > RATE_THRESHOLD_PPS:
                reported.add(src)
                out.append((t_ns, src, pps))
    return out


def sentinel_alerts(frames):
    """[(t_ns, predominant_src, loss)], one per anomalous 64-packet window (the loss itself is the kernel's float math)."""
    ex, ad = sr.Extractor(), sr.Adaptive()
    srcs = collections.deque()
    out = []
    for t_us, flen, proto, flags, sp, dp, src, t_ns in frames:
        srcs.append(src or "unknown")
        if len(srcs) > sr.WIN:
            srcs.popleft()
        w = ex.feed(t_us, flen, proto, flags, sp, dp)
        if w is None:
            continue
        loss = sr.kernel_loss(w)
        is_anom, _tau = ad.check(loss)
        if is_anom:
            known = collections.Counter(s for s in srcs if s != "unknown")
            out.append((t_ns, known.most_common(1)[0][0] if known else "unknown", loss))
    return out


def load_runs(datadir):
    runs = []
    for lp in sorted(glob.glob(os.path.join(datadir, "*.label.json"))):
        label = json.load(open(lp))
        pcap = os.path.join(datadir, label["pcap"])
        if not os.path.exists(pcap) and os.path.exists(pcap + ".gz"):
            pcap += ".gz"
        runs.append((label, sr.parse_pcap(pcap, with_src=True)))
    return runs


def seconds_text(delta_ns):
    """Integer nanoseconds as seconds with two decimals, by integer arithmetic."""
    return f"{delta_ns // 1_000_000_000}.{(delta_ns % 1_000_000_000) // 10_000_000:02d}"


def score(label, frames):
    sender = label["senderIp"]
    sender_frames = [f for f in frames if f[6] == sender]
    t0 = sender_frames[0][7] if sender_frames else None
    res = {"id": label["id"], "class": label["class"], "sender": sender, "frames": len(frames), "senderFrames": len(sender_frames)}
    for name, alerts in (("rate", rate_rule_alerts(frames)), ("sentinel", sentinel_alerts(frames))):
        named_sender = [a for a in alerts if a[1] == sender]
        other = [a for a in alerts if a[1] != sender]
        res[name] = {
            "alerts": len(alerts),
            "namedSender": len(named_sender),
            "namedOthers": sorted({a[1] for a in other}),
            "firstSenderAlertSeconds": seconds_text(named_sender[0][0] - t0) if named_sender and t0 is not None else None,
        }
    return res


def main():
    args = sys.argv[1:]
    out_json = None
    if "--json" in args:
        i = args.index("--json")
        out_json = args[i + 1]
        del args[i:i + 2]
    runs = load_runs(args[0])
    results = [score(label, frames) for label, frames in runs]
    print(f"{'run':32s} {'class':7s} {'frames':>6s} | {'rate rule':30s} | {'sentinel':44s}")
    for r in results:
        def cell(d, adaptive_windows=False):
            if d["alerts"] == 0:
                return "no alert"
            who = "names sender" if d["namedSender"] else "names " + ",".join(d["namedOthers"])
            extra = f", first at {d['firstSenderAlertSeconds']} s" if d["firstSenderAlertSeconds"] is not None else ""
            return f"{who}{extra}" + (f" ({d['alerts']} alerts)" if adaptive_windows else "")
        print(f"{r['id']:32s} {r['class']:7s} {r['frames']:6d} | {cell(r['rate']):30s} | {cell(r['sentinel'], True):44s}")
    print()
    for name in ("rate", "sentinel"):
        att = [r for r in results if r["class"] == "attack"]
        ben = [r for r in results if r["class"] == "benign"]
        det = sum(1 for r in att if r[name]["namedSender"])
        fp = sum(1 for r in ben if r[name]["alerts"] > 0)
        mis = sum(1 for r in results if r[name]["namedOthers"])
        print(f"{name:9s} attack runs detected with the right sender: {det}/{len(att)}   benign runs with any alert (false positives): {fp}/{len(ben)}   runs naming a non-sender: {mis}/{len(results)}")
    if out_json:
        with open(out_json, "w") as f:
            json.dump(results, f, indent=2)


if __name__ == "__main__":
    main()
