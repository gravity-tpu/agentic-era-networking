#!/usr/bin/env python3
"""
scripts/cic-flood-margin-sampler.py
====================================
Draws bounded, capped samples of raw sentinel feature windows from a CIC-IDS2017 day's pcapng capture, for
docs/benchmarks/results/sentinel-training-margin-cic/ (see PREREGISTRATION.md for the exact scope, split and caps
this implements). Reuses, not reimplements: scripts/cic-ids2017-adapter.py's iter_pcapng_frames/scan_capture_window,
scripts/cic-ids2017-labels.py's FlowIndex, and scripts/sentinel-replay.py's Extractor (via the adapter's own imports).

Unlike scripts/cic-ids2017-adapter.py (which streams and scores every window against a fixed weight set), this
script stores each sampled window's *raw* 256-value feature vector (not a loss, which is weight-dependent), so the
same sample can be re-scored against multiple trained weight sets later without re-reading the multi-gigabyte pcap.

One sequential pass per day. Each (label -> capped bucket) is filled with the first N windows encountered in that
label in time order (no RNG; see PREREGISTRATION.md for why this sampling method was chosen and its limits). The pass
stops early once every requested bucket for that day is full, or the file ends - whichever comes first.

Usage:
  python3 scripts/cic-flood-margin-sampler.py <pcap> <flow-csv> [<flow-csv> ...] \\
      --bucket LABEL=CAP [--bucket LABEL=CAP ...] \\
      [--benign-cap N --benign-cutoff-epoch EPOCH] \\
      --out out.npz

Needs numpy and scapy, same as scripts/cic-ids2017-adapter.py.
"""
import argparse
import collections
import importlib.util
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


adapter = _load('cic_ids2017_adapter', os.path.join(HERE, 'cic-ids2017-adapter.py'))
sr = adapter.sr
lbl = adapter.lbl


class Bucket:
    """One capped collection of (features, window_end_epoch, majority_src_ip) for a single target label."""

    def __init__(self, label, cap):
        self.label = label
        self.cap = cap
        self.features = []
        self.epochs = []
        self.src_ips = []

    def full(self):
        return len(self.features) >= self.cap

    def add(self, feats, epoch, src_ip):
        if self.full():
            return
        self.features.append(np.asarray(feats, dtype=np.float32).reshape(-1))
        self.epochs.append(epoch)
        self.src_ips.append(src_ip or '')


def bucket_frames(frames, flow_index, attack_buckets, benign_bucket=None, benign_cutoff_epoch=None,
                   progress_every=500_000):
    """Core, pcap-independent bucketing loop: consumes an iterable of (t_us, wire_len, proto, flags, sp, dp, src_ip,
    dst_ip, t_epoch) frames (the same tuple shape scripts/cic-ids2017-adapter.py's iter_pcapng_frames yields) and a
    pre-built scripts/cic-ids2017-labels.py FlowIndex, and fills attack_buckets (dict label -> Bucket) and an
    optional benign_bucket the same way sample_day's real pcap path does. Pulled out as its own function so the
    bucketing/early-stop/cutoff logic can be exercised in a test with small synthetic frames, with no pcapng/scapy
    file needed (the same pattern test/invariants/cic-ids2017-adapter.test.ts already uses for stream_windows).
    Returns a stats dict; does not touch the filesystem."""
    if benign_bucket is not None and benign_cutoff_epoch is None:
        raise ValueError('benign_cutoff_epoch is required when benign_bucket is given')
    benign_closed = [benign_bucket is None]  # mutable cell: True once past the cutoff epoch (can no longer fill)

    def all_full():
        attacks_full = all(b.full() for b in attack_buckets.values())
        benign_done = benign_bucket is None or benign_bucket.full() or benign_closed[0]
        return attacks_full and benign_done

    ex = sr.Extractor()
    label_window = collections.deque(maxlen=sr.WIN)
    src_window = collections.deque(maxlen=sr.WIN)
    windows_seen = 0
    windows_by_label = collections.Counter()
    ip_packets = matched_packets = 0
    n = 0
    stopped_early = False
    last_t_epoch = None
    for t_us, wire_len, proto, flags, sp, dp, src_ip, dst_ip, t_epoch in frames:
        n += 1
        last_t_epoch = t_epoch
        if src_ip is not None:
            ip_packets += 1
            packet_label = flow_index.lookup(src_ip, dst_ip, sp, dp, proto, t_epoch)
            if packet_label is not None:
                matched_packets += 1
        else:
            packet_label = None
        label_window.append(packet_label)
        src_window.append(src_ip)
        feats = ex.feed(t_us, wire_len, proto, flags, sp, dp)
        if feats is not None:
            windows_seen += 1
            matched = [l for l in label_window if l is not None]
            majority = collections.Counter(matched).most_common(1)[0][0] if matched else None
            srcs = [s for s in src_window if s is not None]
            majority_src = collections.Counter(srcs).most_common(1)[0][0] if srcs else None
            windows_by_label[majority] += 1
            if majority is not None and majority in attack_buckets:
                attack_buckets[majority].add(feats, t_epoch, majority_src)
            if benign_bucket is not None and t_epoch >= benign_cutoff_epoch:
                benign_closed[0] = True
            if majority == 'BENIGN' and benign_bucket is not None and t_epoch < benign_cutoff_epoch:
                benign_bucket.add(feats, t_epoch, majority_src)
            if progress_every and n % progress_every == 0:
                fills = {k: f'{len(b.features)}/{b.cap}' for k, b in attack_buckets.items()}
                if benign_bucket is not None:
                    fills['BENIGN'] = f'{len(benign_bucket.features)}/{benign_bucket.cap}'
                print(f'      ... {n} packets, {windows_seen} windows, bucket fill: {fills}', file=sys.stderr)
            if all_full():
                stopped_early = True
                break
    return {
        'packets_processed': n, 'windows_seen': windows_seen, 'ip_packets': ip_packets,
        'matched_packets': matched_packets, 'windows_by_label': dict(windows_by_label),
        'stopped_early': stopped_early, 'last_t_epoch': last_t_epoch,
    }


def sample_day(pcap_path, flow_csvs, attack_buckets, benign_cap, benign_cutoff_epoch, max_packets=None):
    """attack_buckets: dict label -> Bucket (already constructed with its cap). Returns (buckets_dict_including_benign,
    stats_dict). Stops the streaming pass early once every bucket (attack buckets + the benign bucket, if requested)
    is full, or the file is exhausted. Thin wrapper around bucket_frames: handles the real pcap/CSV I/O that
    bucket_frames deliberately knows nothing about."""
    t0 = time.time()
    print(f'[1/3] measuring capture window: {pcap_path}', file=sys.stderr)
    window_start, window_end, scanned_packets = adapter.scan_capture_window(pcap_path)
    print(f'      first={window_start} last={window_end} span_h={(window_end-window_start)/3600:.2f} '
          f'packets={scanned_packets} ({time.time()-t0:.1f}s)', file=sys.stderr)

    print('[2/3] loading flow labels', file=sys.stderr)
    all_flows = []
    for csv_path in flow_csvs:
        flows, csv_stats = lbl.load_flow_csv(csv_path, window_start, window_end)
        print(f'      {csv_path}: {csv_stats}', file=sys.stderr)
        all_flows.extend(flows)
    flow_index = lbl.FlowIndex(all_flows)
    print(f'      {len(all_flows)} flows indexed', file=sys.stderr)

    benign_bucket = Bucket('BENIGN', benign_cap) if benign_cap else None
    print('[3/3] streaming frames, bucketing by majority label (early stop once every bucket is full)',
          file=sys.stderr)
    t1 = time.time()
    frames = adapter.iter_pcapng_frames(pcap_path, max_packets=max_packets)
    loop_stats = bucket_frames(frames, flow_index, attack_buckets, benign_bucket, benign_cutoff_epoch)
    elapsed = time.time() - t1
    if loop_stats['stopped_early']:
        print(f'      all buckets full after {loop_stats["packets_processed"]} packets '
              f'({loop_stats["last_t_epoch"] - window_start:.0f}s into capture); stopping early', file=sys.stderr)

    buckets = dict(attack_buckets)
    if benign_bucket is not None:
        buckets['BENIGN'] = benign_bucket
    stats = dict(loop_stats)
    stats.update({'elapsed_s': elapsed, 'capture_window': [window_start, window_end],
                  'scanned_packets': scanned_packets})
    return buckets, stats


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('pcap')
    ap.add_argument('flow_csvs', nargs='+')
    ap.add_argument('--bucket', action='append', default=[], metavar='LABEL=CAP',
                     help='an attack label to sample, and its cap; repeatable')
    ap.add_argument('--benign-cap', type=int, default=0, help='cap for the BENIGN generalization-check bucket (0: skip)')
    ap.add_argument('--benign-cutoff-epoch', type=float, default=None,
                     help='only BENIGN windows ending before this epoch are eligible (required if --benign-cap > 0)')
    ap.add_argument('--max-packets', type=int, default=None)
    ap.add_argument('--out', required=True, help='write all buckets to this .npz file')
    args = ap.parse_args()
    if args.benign_cap and args.benign_cutoff_epoch is None:
        ap.error('--benign-cap requires --benign-cutoff-epoch')

    attack_buckets = {}
    for spec in args.bucket:
        label, cap = spec.rsplit('=', 1)
        attack_buckets[label] = Bucket(label, int(cap))

    buckets, stats = sample_day(args.pcap, args.flow_csvs, attack_buckets, args.benign_cap,
                                 args.benign_cutoff_epoch, max_packets=args.max_packets)

    npz_payload = {}
    summary = {}
    for label, b in buckets.items():
        key = label.replace(' ', '_')
        arr = np.stack(b.features).astype(np.float32) if b.features else np.zeros((0, 256), dtype=np.float32)
        npz_payload[f'{key}__features'] = arr
        npz_payload[f'{key}__epochs'] = np.asarray(b.epochs, dtype=np.float64)
        npz_payload[f'{key}__src_ips'] = np.asarray(b.src_ips, dtype=object)
        summary[label] = {'cap': b.cap, 'collected': len(b.features)}
    npz_payload['__labels__'] = np.asarray(list(buckets.keys()), dtype=object)
    np.savez_compressed(args.out, **npz_payload)

    print('\n=== sampling summary ===')
    print(f'packets processed: {stats["packets_processed"]} of {stats["scanned_packets"]} in file '
          f'({stats["elapsed_s"]:.1f}s)')
    print(f'windows seen: {stats["windows_seen"]}  windows by majority label (within the processed prefix only): '
          f'{stats["windows_by_label"]}')
    for label, s in summary.items():
        print(f'  bucket {label!r}: collected {s["collected"]}/{s["cap"]}')
    print(f'wrote {args.out}')


if __name__ == '__main__':
    main()
