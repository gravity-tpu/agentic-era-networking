#!/usr/bin/env python3
"""
scripts/cic-ids2017-adapter.py
================================
Streams the public CIC-IDS2017 benchmark's raw pcapng captures (Wednesday: DoS; Friday: Bot/PortScan/DDoS) through
the GPU sentinel's own feature math and kernel loss (scripts/sentinel-replay.py, imported unmodified - this file
does not reimplement that arithmetic), joining each 64-packet window to a benign/attack label reconstructed from the
dataset's CICFlowMeter CSVs (scripts/cic-ids2017-labels.py).

Why a separate module, and not an edit to sentinel-replay.py or portscan-rule-detector.py: those two parsers
whole-file-read a path and sentinel-replay.py's parse_pcap refuses anything over MAX_PCAP_BYTES (64 MiB) by design -
correct for this lab's own small captures, wrong for an 8.8-13.4 GB external pcapng file. This module streams
scapy's PcapNgReader packet-by-packet instead: memory use is bounded by one packet and a WIN=64-packet sliding
window, never the file size, regardless of how large the file is.

Frame tuple convention matches sentinel-replay.py's parse_pcap(with_src=True): proto/flags/ports are 0 and src/dst
IP are None for anything that is not Ethernet+IPv4 (ARP, IPv6, 802.1Q management chatter, etc.) - the same
"unrecognized EtherType returns no features, no crash" contract sentinel-replay.py already relies on.

Usage:
  python3 scripts/cic-ids2017-adapter.py <pcap> <flow-csv> [<flow-csv> ...] [--max-packets N] [--out windows.jsonl]

Needs numpy (via sentinel-replay.py) and scapy (`pip install --user scapy`; see docs/design/cic-ids2017-adapter.md
for why this is required and why it is not bundled as a repo dependency - it is read-only, offline tooling for an
external dataset, not part of the deployed sentinel or any CI path).
"""
import argparse
import collections
import importlib.util
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


sr = _load('sentinel_replay', os.path.join(HERE, 'sentinel-replay.py'))
lbl = _load('cic_ids2017_labels', os.path.join(HERE, 'cic-ids2017-labels.py'))


def scan_capture_window(path):
    """First and last packet epoch across the whole file - a single bounded-memory streaming pass (no dissection,
    just pkt.time), used as the ground-truth capture window that disambiguate_12h resolves AM/PM against. Returns
    (first_epoch, last_epoch, packet_count)."""
    from scapy.utils import PcapNgReader
    reader = PcapNgReader(path)
    first = last = None
    n = 0
    try:
        for pkt in reader:
            t = float(pkt.time)
            if first is None:
                first = t
            last = t
            n += 1
    finally:
        reader.close()
    if first is None:
        raise ValueError(f'{path}: no packets read')
    return first, last, n


def iter_pcapng_frames(path, max_packets=None):
    """Yields (t_us, wire_len, proto, flags, sp, dp, src_ip, dst_ip, t_epoch) one packet at a time, streaming
    (bounded memory: scapy's PcapNgReader reads one block at a time, never the whole file). Stops after
    max_packets if given, or when the file is exhausted - either way, a plain StopIteration, nothing else to
    detect which one happened from inside the generator itself."""
    from scapy.layers.inet import IP, TCP, UDP
    from scapy.layers.l2 import Ether
    from scapy.utils import PcapNgReader

    reader = PcapNgReader(path)
    n = 0
    try:
        for pkt in reader:
            if max_packets is not None and n >= max_packets:
                return
            t_epoch = float(pkt.time)
            t_us = t_epoch * 1_000_000.0
            wire_len = float(getattr(pkt, 'wirelen', None) or len(pkt))
            proto = flags = sp = dp = 0
            src_ip = dst_ip = None
            if Ether in pkt and IP in pkt:
                ip = pkt[IP]
                proto = int(ip.proto)
                src_ip, dst_ip = ip.src, ip.dst
                if TCP in pkt:
                    tcp = pkt[TCP]
                    sp, dp = int(tcp.sport), int(tcp.dport)
                    flags = int(tcp.flags)
                elif UDP in pkt:
                    udp = pkt[UDP]
                    sp, dp = int(udp.sport), int(udp.dport)
            yield (t_us, wire_len, proto, flags, sp, dp, src_ip, dst_ip, t_epoch)
            n += 1
    finally:
        reader.close()


WindowResult = collections.namedtuple(
    'WindowResult', ['loss', 'labels', 'matched', 'majority_label', 'majority_src_ip', 'window_end_t'])


def stream_windows(frames, flow_index):
    """Replays sentinel-replay.py's Extractor/kernel_loss over `frames` (an iterable of the tuples
    iter_pcapng_frames yields), one WIN=64-packet sliding window per input frame once warmed up - the same semantics
    as sentinel-replay.py's losses(). In lockstep, keeps its own WIN-deep deques of per-packet labels (looked up via
    flow_index) and source IPs, so each emitted window carries the labels and the dominant sender of exactly the
    packets that produced its loss value (the sentinel itself names the most frequent source IP in a window; this
    mirrors that for the spot-check)."""
    import collections as _c
    ex = sr.Extractor()
    label_window = _c.deque(maxlen=sr.WIN)
    src_window = _c.deque(maxlen=sr.WIN)
    counts = {'ip_tcp': 0, 'ip_udp': 0, 'ip_other': 0, 'non_ip': 0}
    matched_packets = 0
    ip_packets = 0
    for t_us, wire_len, proto, flags, sp, dp, src_ip, dst_ip, t_epoch in frames:
        if src_ip is None:
            counts['non_ip'] += 1
            packet_label = None
        else:
            ip_packets += 1
            if proto == 6:
                counts['ip_tcp'] += 1
            elif proto == 17:
                counts['ip_udp'] += 1
            else:
                counts['ip_other'] += 1
            packet_label = flow_index.lookup(src_ip, dst_ip, sp, dp, proto, t_epoch)
            if packet_label is not None:
                matched_packets += 1
        label_window.append(packet_label)
        src_window.append(src_ip)
        feats = ex.feed(t_us, wire_len, proto, flags, sp, dp)
        if feats is not None:
            loss = sr.kernel_loss(feats)
            labels = list(label_window)
            matched = [l for l in labels if l is not None]
            majority = collections.Counter(matched).most_common(1)[0][0] if matched else None
            srcs = [s for s in src_window if s is not None]
            majority_src = collections.Counter(srcs).most_common(1)[0][0] if srcs else None
            yield WindowResult(loss=loss, labels=labels, matched=len(matched), majority_label=majority,
                                majority_src_ip=majority_src, window_end_t=t_epoch)
    stream_windows.last_counts = counts  # exposed for the CLI's coverage report
    stream_windows.last_ip_packets = ip_packets
    stream_windows.last_matched_packets = matched_packets


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('pcap', help='path to a CIC-IDS2017 pcapng capture (left where it was downloaded; not copied)')
    ap.add_argument('flow_csvs', nargs='+', help='one or more GeneratedLabelledFlows CSVs for the same day')
    ap.add_argument('--max-packets', type=int, default=None,
                     help='stop after this many packets (bounded sample instead of a full pass)')
    ap.add_argument('--out', default=None, help='write windows as JSONL to this path')
    ap.add_argument('--skip-window-scan', action='store_true',
                     help='skip the full-file first/last-packet pass (use --window-start/--window-end instead); '
                          'only useful once that pass has been run once and the bounds recorded')
    ap.add_argument('--window-start', type=float, default=None)
    ap.add_argument('--window-end', type=float, default=None)
    args = ap.parse_args(argv)

    t0 = time.time()
    if args.skip_window_scan:
        if args.window_start is None or args.window_end is None:
            ap.error('--skip-window-scan requires --window-start and --window-end')
        window_start, window_end, scanned_packets = args.window_start, args.window_end, None
    else:
        print(f'[1/3] measuring capture window (full streaming pass, container-read only): {args.pcap}',
              file=sys.stderr)
        window_start, window_end, scanned_packets = scan_capture_window(args.pcap)
        scan_elapsed = time.time() - t0
        print(f'      first={window_start} last={window_end} span={(window_end-window_start)/3600:.2f}h '
              f'packets={scanned_packets} in {scan_elapsed:.1f}s ({scanned_packets/scan_elapsed:.0f} pps)',
              file=sys.stderr)

    print('[2/3] loading flow labels', file=sys.stderr)
    all_flows = []
    csv_stats = {}
    for csv_path in args.flow_csvs:
        flows, stats = lbl.load_flow_csv(csv_path, window_start, window_end)
        csv_stats[csv_path] = stats
        all_flows.extend(flows)
        print(f'      {csv_path}: {stats}', file=sys.stderr)
    flow_index = lbl.FlowIndex(all_flows)
    print(f'      {len(all_flows)} flows loaded into index (of {sum(s["rows"] for s in csv_stats.values())} rows)',
          file=sys.stderr)

    print('[3/3] streaming frames through the sentinel feature/kernel math', file=sys.stderr)
    t1 = time.time()
    out_fh = open(args.out, 'w') if args.out else None
    window_count = 0
    label_votes = collections.Counter()
    attack_spotcheck = []
    try:
        frames = iter_pcapng_frames(args.pcap, max_packets=args.max_packets)
        for w in stream_windows(frames, flow_index):
            window_count += 1
            label_votes[w.majority_label] += 1
            if w.majority_label not in (None, 'BENIGN') and len(attack_spotcheck) < 5:
                attack_spotcheck.append(w)
            if out_fh:
                out_fh.write(json.dumps({'loss': w.loss, 'majority_label': w.majority_label, 'matched': w.matched,
                                          'majority_src_ip': w.majority_src_ip,
                                          'window_end_epoch': w.window_end_t}) + '\n')
    finally:
        if out_fh:
            out_fh.close()
    elapsed = time.time() - t1
    counts = stream_windows.last_counts
    ip_packets = stream_windows.last_ip_packets
    matched_packets = stream_windows.last_matched_packets
    total_packets = sum(counts.values())

    print('\n=== coverage and throughput ===')
    print(f'packets processed: {total_packets} in {elapsed:.1f}s -> {total_packets/elapsed:.0f} pps '
          f'(extraction + feature math + label lookup)')
    print(f'frame categories: ip_tcp={counts["ip_tcp"]} ip_udp={counts["ip_udp"]} ip_other={counts["ip_other"]} '
          f'non_ip={counts["non_ip"]}')
    if ip_packets:
        print(f'label join: {matched_packets}/{ip_packets} IPv4 packets ({100*matched_packets/ip_packets:.1f}%) '
              f'matched a labelled flow within slack; {ip_packets - matched_packets} did not '
              f'(no flow in the CSV covered that 5-tuple + time, or it fell outside the slack window)')
    print(f'{window_count} windows emitted; majority-label distribution: {dict(label_votes)}')
    if scanned_packets:
        file_size = os.path.getsize(args.pcap)
        est_total = scanned_packets  # the window scan already read every packet in the file
        full_pass_s = est_total / (total_packets / elapsed) if total_packets else float('nan')
        print(f'estimated full-file pass at this run\'s extraction rate: {full_pass_s/60:.1f} min '
              f'for all {est_total} packets ({file_size/1e9:.1f} GB)')
    print('\n=== attack-window spot check (first up to 5 non-benign-majority windows) ===')
    for w in attack_spotcheck:
        print(f'  label={w.majority_label} majority_src_ip={w.majority_src_ip} matched={w.matched}/64 '
              f'window_end_epoch={w.window_end_t} loss={w.loss:.4f}')


if __name__ == '__main__':
    main()
