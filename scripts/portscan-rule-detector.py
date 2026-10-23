#!/usr/bin/env python3
"""
scripts/portscan-rule-detector.py
==================================
Deterministic port-scan detector: tracks, per (source IP, destination IP) pair, the set of
distinct destination TCP/UDP ports contacted within a trailing time window. Alerts when the
count of distinct ports reaches a threshold.

Why this exists (Track C scenario 3, docs/benchmarks/results/track-c-scenario3-portscan/): the
GPU sentinel (scripts/gpu-sdn-anomaly-sentinel.py) scores a generic four-feature traffic shape
(inter-arrival time, frame length, protocol/flags, port distance) and has no representation of
"one source touching many distinct destination ports," which is the defining signature of a port
scan. Measured live, this made its scan detection inconsistent run to run: an identical fast scan
fired strongly in one run and produced zero anomalies in an immediate back-to-back retry. A
distinct-destination-port count is the signature real NIDS tools (Snort, Suricata) use for this
attack class directly, deterministically, and explainably.

Threshold justification (see docs/benchmarks/results/portscan-rule/ for the full measurement):
run `--validate` against docs/benchmarks/results/labelled-runs/ (51 recorded runs, 27 benign / 18
attack). Every benign run's sender stays at or below 1 distinct destination port to any one
destination, in any window up to 60 s. Every port-scan attack profile (fast, slow, 1pps,
half-pps) reaches at least 15 distinct ports within 30 s — the slowest profile tested. The default
threshold (5) and window (30s) sit with a wide margin on both sides of that gap.

This does not replace the GPU sentinel or the rate rule: it is blind to anything that is not a
multi-port probe (floods, ARP spoofing, a single-port scan). It posts to the same
POST /api/sdn/quarantine endpoint as the other detectors; the bridge's quarantine envelope (mode,
protected hosts, cap, TTL; src/sdn/quarantine-envelope.ts) governs what happens to the alert, the
same as for every other detector. This script does not install anything itself.

Usage:
  python3 scripts/portscan-rule-detector.py --validate docs/benchmarks/results/labelled-runs
  python3 scripts/portscan-rule-detector.py --tap-iface enx9c69d39dd0a6 [--duration SECONDS]
"""

import argparse
import collections
import glob
import gzip
import json
import os
import queue
import socket
import struct
import sys
import threading
import time
import typing
import urllib.request

DEFAULT_CONTROLLER_URL = os.environ.get('SDN_CONTROLLER_URL', 'http://127.0.0.1:3003')
DEFAULT_TAP_IFACE = os.environ.get('TAP_IFACE', 'enx9c69d39dd0a6')

# Measured against docs/benchmarks/results/labelled-runs/ (see docstring above and
# docs/benchmarks/results/portscan-rule/README.md for the full table). Comfortable margin above
# the measured benign ceiling (1) and below the slowest measured attack's count (15 at 30s).
WINDOW_SECONDS = float(os.environ.get('PORTSCAN_WINDOW_SECONDS', '30'))
DISTINCT_PORT_THRESHOLD = int(os.environ.get('PORTSCAN_DISTINCT_PORT_THRESHOLD', '5'))
# Bounded tracking memory (Invariant 5: no unbounded growth). 4096 concurrent (src,dst) pairs is
# far above anything this lab topology produces; oldest-inserted pair is evicted first if hit.
MAX_TRACKED_PAIRS = int(os.environ.get('PORTSCAN_MAX_TRACKED_PAIRS', '4096'))
# Once a (src,dst) pair is over threshold, don't re-dispatch on every subsequent packet.
ALERT_COOLDOWN_SECONDS = float(os.environ.get('PORTSCAN_ALERT_COOLDOWN_SECONDS', '30'))
# Hard cap on packets tracked per (src,dst) pair, independent of WINDOW_SECONDS: a high-rate flood
# to a single port correctly keeps the distinct-port count at 1 (out of this rule's scope), but
# without this cap the deque backing that pair would still grow for the full window duration,
# unbounded in packet count (Invariant 5). 2048 is far more than the handful of packets any real
# scan profile in docs/benchmarks/results/labelled-runs/ needed to cross the threshold.
MAX_PACKETS_PER_PAIR = int(os.environ.get('PORTSCAN_MAX_PACKETS_PER_PAIR', '2048'))
EXPECTED_MAC_HEX_LEN = 17
DISPATCH_TIMEOUT_SECONDS = 1.0
DISPATCH_MAX_RETRIES = 3
QUARANTINE_PRIORITY = 65535


class PortScanTracker:
    """Per (src_ip, dst_ip): a time-and-count-bounded deque of (t, dst_port, src_mac) plus an
    incrementally-maintained port->count map, so the distinct-port count is O(1) to read instead
    of rebuilding a set from the whole deque on every packet. Bounded by max_pairs, and each
    pair's own history is bounded by both window_s and max_packets_per_pair."""

    def __init__(self, window_s=WINDOW_SECONDS, threshold=DISTINCT_PORT_THRESHOLD,
                 max_pairs=MAX_TRACKED_PAIRS, cooldown_s=ALERT_COOLDOWN_SECONDS,
                 max_packets_per_pair=MAX_PACKETS_PER_PAIR):
        self.window_s = window_s
        self.threshold = threshold
        self.max_pairs = max_pairs
        self.cooldown_s = cooldown_s
        self.max_packets_per_pair = max_packets_per_pair
        self._pairs = collections.OrderedDict()  # (src,dst) -> (deque[(t,port,mac)], Counter(port))
        self._last_alert = {}  # (src,dst) -> t of last dispatched alert

    def _evict(self, dq, counts, t):
        while dq and t - dq[0][0] > self.window_s:
            _, old_port, _ = dq.popleft()
            counts[old_port] -= 1
            if counts[old_port] <= 0:
                del counts[old_port]
        while len(dq) > self.max_packets_per_pair:
            _, old_port, _ = dq.popleft()
            counts[old_port] -= 1
            if counts[old_port] <= 0:
                del counts[old_port]

    def observe(self, t, src_ip, dst_ip, dst_port, src_mac):
        """Feed one TCP/UDP frame. Returns an alert dict if this pair just crossed threshold
        (and is not in cooldown), else None."""
        key = (src_ip, dst_ip)
        state = self._pairs.get(key)
        if state is None:
            if len(self._pairs) >= self.max_pairs:
                evicted_key, _ = self._pairs.popitem(last=False)
                # Keep _last_alert bounded in lockstep with _pairs (Invariant 5): otherwise a
                # long-running process accumulates one cooldown entry per distinct pair ever
                # seen, forever, even though the pair itself was evicted.
                self._last_alert.pop(evicted_key, None)
            state = (collections.deque(), collections.Counter())
            self._pairs[key] = state
        else:
            self._pairs.move_to_end(key)
        dq, counts = state
        dq.append((t, dst_port, src_mac))
        counts[dst_port] += 1
        self._evict(dq, counts, t)
        distinct = len(counts)
        if distinct < self.threshold:
            return None
        last = self._last_alert.get(key, float('-inf'))
        if t - last < self.cooldown_s:
            return None
        self._last_alert[key] = t
        return {
            'srcIp': src_ip, 'dstIp': dst_ip, 'srcMac': dq[-1][2],
            'distinctPorts': distinct, 'windowSeconds': self.window_s,
        }


def parse_frame(raw_data):
    """(proto, src_ip, dst_ip, dst_port, src_mac) from a raw Ethernet frame, or None for anything
    not a well-formed IPv4 TCP/UDP frame (this detector only tracks ports, so nothing else is
    useful to it). Mirrors the header-walk in scripts/gpu-sdn-anomaly-sentinel.py."""
    frame_len = len(raw_data)
    if frame_len < 14:
        return None
    eth_proto = struct.unpack('!H', raw_data[12:14])[0]
    l3_offset = 14
    if eth_proto == 0x8100 and frame_len >= 18:
        eth_proto = struct.unpack('!H', raw_data[16:18])[0]
        l3_offset = 18
    if eth_proto != 0x0800 or frame_len < l3_offset + 20:
        return None
    src_mac_raw = raw_data[6:12].hex(':')
    src_mac = src_mac_raw if len(src_mac_raw) == EXPECTED_MAC_HEX_LEN else 'unknown'
    ip_hdr = raw_data[l3_offset:l3_offset + 20]
    ihl = (ip_hdr[0] & 0x0F) * 4
    if ihl < 20 or frame_len < l3_offset + ihl:
        return None
    proto = ip_hdr[9]
    src_ip = socket.inet_ntoa(ip_hdr[12:16])
    dst_ip = socket.inet_ntoa(ip_hdr[16:20])
    l4_offset = l3_offset + ihl
    if proto == 6 and frame_len >= l4_offset + 20:
        _, dst_port = struct.unpack('!HH', raw_data[l4_offset:l4_offset + 4])
    elif proto == 17 and frame_len >= l4_offset + 8:
        _, dst_port = struct.unpack('!HH', raw_data[l4_offset:l4_offset + 4])
    else:
        return None
    return proto, src_ip, dst_ip, dst_port, src_mac


def dispatch_quarantine_alert(controller_url, alert, timeout=DISPATCH_TIMEOUT_SECONDS,
                               retries=DISPATCH_MAX_RETRIES):
    endpoint = f"{controller_url.rstrip('/')}/api/sdn/quarantine"
    reason = (f"Port-scan rule: {alert['srcIp']} contacted {alert['distinctPorts']} distinct "
              f"destination ports on {alert['dstIp']} within {alert['windowSeconds']:.0f}s")
    payload = {'reason': reason, 'priority': QUARANTINE_PRIORITY, 'targetIp': alert['srcIp']}
    if alert.get('srcMac') and alert['srcMac'] != 'unknown':
        payload['targetMac'] = alert['srcMac']
    data_bytes = json.dumps(payload).encode('utf-8')
    for attempt in range(retries):
        req = urllib.request.Request(
            endpoint, data=data_bytes,
            headers={'Content-Type': 'application/json', 'User-Agent': 'PortscanRuleDetector/1.0'},
            method='POST',
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode('utf-8')).get('ok', False)
        except Exception as exc:
            sys.stderr.write(f"[portscan-rule] dispatch to {endpoint} failed (attempt {attempt + 1}/{retries}): {exc}\n")
    return False


# --- validation against the recorded labelled-runs dataset -------------------------------------

def parse_pcap_frames(path):
    """(t_ns, raw_frame) for every frame in a (optionally gzipped) pcap file."""
    if path.endswith('.gz'):
        with gzip.open(path, mode='rb') as fh:
            d = typing.cast(bytes, fh.read())
    else:
        with open(path, 'rb') as fh:
            d = fh.read()
    magic = struct.unpack('<I', d[:4])[0]
    ns = magic == 0xa1b23c4d
    off = 24
    out = []
    while off + 16 <= len(d):
        sec, frac, cl, ol = struct.unpack('<IIII', d[off:off + 16])
        off += 16
        fr = d[off:off + cl]
        off += cl
        del ol  # original (pre-truncation) length, unused: cl is what was actually captured
        t_ns = sec * 1_000_000_000 + (frac if ns else frac * 1000)
        out.append((t_ns, fr))
    return out


def run_validation(datadir, window_s, threshold):
    results = []
    for label_path in sorted(glob.glob(os.path.join(datadir, '*.label.json'))):
        label = json.load(open(label_path))
        pcap_path = os.path.join(datadir, label['pcap'])
        if not os.path.exists(pcap_path) and os.path.exists(pcap_path + '.gz'):
            pcap_path += '.gz'
        if not os.path.exists(pcap_path):
            continue
        tracker = PortScanTracker(window_s=window_s, threshold=threshold, cooldown_s=0)
        alerted_srcs = set()
        for t_ns, raw in parse_pcap_frames(pcap_path):
            parsed = parse_frame(raw)
            if parsed is None:
                continue
            _proto, src_ip, dst_ip, dst_port, src_mac = parsed
            alert = tracker.observe(t_ns / 1e9, src_ip, dst_ip, dst_port, src_mac)
            if alert:
                alerted_srcs.add(src_ip)
        sender = label.get('senderIp')
        cls = label.get('class')
        fired_on_sender = sender is not None and sender in alerted_srcs
        is_false_positive = cls == 'benign' and bool(alerted_srcs)
        is_misattribution = bool(alerted_srcs) and sender is not None and not fired_on_sender
        results.append({
            'id': label['id'], 'class': cls, 'sender': sender,
            'alerted': sorted(alerted_srcs), 'detected': cls == 'attack' and fired_on_sender,
            'false_positive': is_false_positive, 'misattribution': is_misattribution,
        })
    return results


def print_validation_report(results):
    attacks = [r for r in results if r['class'] == 'attack']
    benign = [r for r in results if r['class'] == 'benign']
    det = sum(1 for r in attacks if r['detected'])
    fp = sum(1 for r in benign if r['false_positive'])
    print(f"{'id':38s} {'class':7s} {'detected':9s} {'alerted on'}")
    for r in results:
        print(f"{r['id']:38s} {r['class']:7s} {str(r['detected']):9s} {r['alerted']}")
    print()
    print(f"attack runs detected (right sender): {det}/{len(attacks)}")
    print(f"benign runs with any alert (false positives): {fp}/{len(benign)}")
    mis = sum(1 for r in results if r['misattribution'])
    print(f"runs naming a non-sender: {mis}/{len(results)}")


# --- live mode -----------------------------------------------------------------------------

def bind_tap_socket(iface):
    sock = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(0x0003))
    sock.bind((iface, 0))
    return sock


def run_live(tap_iface, controller_url, duration_s):
    tracker = PortScanTracker()
    sock = bind_tap_socket(tap_iface)
    print(f"[portscan-rule] Listening on {tap_iface}, window={tracker.window_s:.0f}s "
          f"threshold={tracker.threshold} -> {controller_url}")

    # Dispatch runs on its own thread so an HTTP timeout/retry (up to DISPATCH_TIMEOUT_SECONDS *
    # DISPATCH_MAX_RETRIES ~= 3s) never blocks the packet-capture loop from servicing the socket.
    # Alerts are already cooldown-gated per (src,dst) pair, so queue volume stays low; bounded
    # anyway, and a full queue drops the oldest-style overflow rather than blocking the capturer.
    alert_queue: "queue.Queue[dict]" = queue.Queue(maxsize=256)
    stop_event = threading.Event()
    dropped_alerts = 0

    def dispatcher_worker():
        while not stop_event.is_set() or not alert_queue.empty():
            try:
                alert = alert_queue.get(timeout=0.2)
            except queue.Empty:
                continue
            ok = dispatch_quarantine_alert(controller_url, alert)
            if not ok:
                sys.stderr.write(f"[portscan-rule] quarantine request for {alert['srcIp']} did not succeed\n")
            alert_queue.task_done()

    dispatch_thread = threading.Thread(target=dispatcher_worker, daemon=True)
    dispatch_thread.start()

    start = time.monotonic()
    packets = 0
    alerts = 0
    try:
        while duration_s <= 0 or (time.monotonic() - start) < duration_s:
            sock.settimeout(1.0)
            try:
                raw, _addr = sock.recvfrom(65535)
            except socket.timeout:
                continue
            packets += 1
            parsed = parse_frame(raw)
            if parsed is None:
                continue
            _proto, src_ip, dst_ip, dst_port, src_mac = parsed
            # Monotonic clock for the sliding-window/cooldown math (Invariant 2): time.time() can
            # jump on an NTP adjustment, which would corrupt the window-pruning comparison.
            alert = tracker.observe(time.monotonic(), src_ip, dst_ip, dst_port, src_mac)
            if alert:
                alerts += 1
                print(f"🚨 [PORTSCAN RULE] {alert['srcIp']} -> {alert['dstIp']}: "
                      f"{alert['distinctPorts']} distinct ports in {alert['windowSeconds']:.0f}s")
                try:
                    alert_queue.put_nowait(alert)
                except queue.Full:
                    dropped_alerts += 1
                    sys.stderr.write(f"[portscan-rule] alert queue full, dropped alert for {alert['srcIp']} "
                                      f"(total dropped: {dropped_alerts})\n")
    finally:
        stop_event.set()
        dispatch_thread.join(timeout=5.0)
        sock.close()
    print(f"[portscan-rule] stopped. packets={packets} alerts={alerts} dropped_alerts={dropped_alerts}")


def main():
    parser = argparse.ArgumentParser(description="Deterministic distinct-destination-port scan detector")
    parser.add_argument('--tap-iface', default=DEFAULT_TAP_IFACE)
    parser.add_argument('--controller-url', default=DEFAULT_CONTROLLER_URL)
    parser.add_argument('--duration', type=int, default=0, help="live mode run duration in seconds (0 = indefinite)")
    parser.add_argument('--validate', metavar='DATADIR', help="score against a labelled-runs directory instead of running live")
    parser.add_argument('--window-seconds', type=float, default=WINDOW_SECONDS)
    parser.add_argument('--threshold', type=int, default=DISTINCT_PORT_THRESHOLD)
    args = parser.parse_args()

    if args.validate:
        results = run_validation(args.validate, args.window_seconds, args.threshold)
        print_validation_report(results)
        return

    run_live(args.tap_iface, args.controller_url, args.duration)


if __name__ == '__main__':
    main()
