"""
scripts/sentinel-replay.py
==========================
Offline replica of the GPU sentinel's detection arithmetic (scripts/gpu-sdn-anomaly-sentinel.py and
src/gpu/gpu_anomaly_kernel.cu, default weights), run over captured frames and synthetic traffic patterns.
Frame timing comes from the capture timestamps (arrival), not from the sentinel's dequeue time.

The kernel replica was checked against the real native library on the Jetson (300 windows, largest difference
3e-8); test/invariants/sentinel-replay.test.ts keeps its constants equal to the ones in the .cu source.

Usage: python3 scripts/sentinel-replay.py docs/benchmarks/results/sentinel-detection
Needs numpy. The captures are expected under the names listed in main().
"""
import math, struct, sys, os, random
import numpy as np

W = np.array([0.20, 0.30, 0.25, 0.25, 0.05, 0.50, 0.02, 0.85, 1.50, 0.40], dtype=np.float32)
WIN = 64
MAX_L4_PORT = 65535.0
MAX_TCP_FLAGS = 0x3F
BASE_TAU = 0.15

def kernel_loss(window):
    x = np.asarray(window, dtype=np.float32).reshape(-1)           # 256, packet-major
    h = np.maximum(0.0, (x.reshape(64, 4) * W[:4]).sum(axis=1) - W[4])           # 64
    lat = np.maximum(0.0, h.reshape(16, 4).sum(axis=1) * W[5] - W[6])            # 16
    rh = np.maximum(0.0, lat[np.arange(64) % 16] * W[7])                         # 64
    rec = 1.0 / (1.0 + np.exp(-(rh[np.arange(256) % 64] * W[8] - W[9])))         # 256
    return float(np.mean((x - rec) ** 2))

class Extractor:
    def __init__(self):
        self.buf = []; self.last_us = None
        self.max_dt = 1000.0; self.max_len = 1518.0
    def feed(self, t_us, frame_len, proto, flags, sp, dp):
        dt = 0.0 if self.last_us is None else max(0.0, t_us - self.last_us)
        self.last_us = t_us
        self.max_dt = max(self.max_dt, dt); self.max_len = max(self.max_len, float(frame_len))
        dtn = min(1.0, math.log1p(dt) / math.log1p(max(1000.0, self.max_dt)))
        ln = min(1.0, frame_len / self.max_len)
        fl = min(1.0, (flags & MAX_TCP_FLAGS) / float(MAX_TCP_FLAGS)) if proto == 6 else (0.1 if proto == 17 else 0.0)
        pe = min(1.0, abs(sp - dp) / MAX_L4_PORT)
        self.buf.append([dtn, ln, fl, pe])
        if len(self.buf) > WIN: self.buf.pop(0)
        return list(self.buf) if len(self.buf) == WIN else None

def losses(frames):
    ex = Extractor(); out = []
    for t_us, flen, proto, flags, sp, dp in frames:
        w = ex.feed(t_us, flen, proto, flags, sp, dp)
        if w is not None: out.append(kernel_loss(w))
    return out

# Positions in a frame tuple returned by parse_pcap(..., with_src=True): (t_us, wire_len, proto, flags, src_port, dst_port, src_ip, t_ns).
FRAME_SRC_IP, FRAME_T_NS = 6, 7
MAX_PCAP_BYTES = 64 * 1024 * 1024  # offline analysis of small lab captures; refuse anything larger rather than load it

def parse_pcap(path, with_src=False, arp_src=False):
    """Frames as (t_us, wire_len, proto, tcp_flags, src_port, dst_port); with_src adds the IPv4 source (or None) and the exact
    integer-nanosecond timestamp as items 7 and 8.
    arp_src also attributes a well-formed Ethernet/IPv4 ARP frame to its sender protocol address. It is off by default because the
    deployed trt daemon keys on IPv4 sources and ignores ARP: the replicas of the daemon and the sentinel must see what they see.
    A path ending in .gz is decompressed in memory, with the same cap applied to the decompressed size."""
    if path.endswith('.gz'):
        import gzip
        with gzip.open(path, 'rb') as fh:
            d = fh.read(MAX_PCAP_BYTES + 1)
        if len(d) > MAX_PCAP_BYTES:
            raise SystemExit(f'{path} is larger than {MAX_PCAP_BYTES} bytes once decompressed; refusing to load it')
    else:
        if os.path.getsize(path) > MAX_PCAP_BYTES:
            raise SystemExit(f'{path} is larger than {MAX_PCAP_BYTES} bytes; refusing to load it into memory')
        with open(path, 'rb') as fh:
            d = fh.read()
    magic = struct.unpack('<I', d[:4])[0]
    ns = magic == 0xa1b23c4d
    off = 24; frames = []
    while off + 16 <= len(d):
        sec, frac, cl, ol = struct.unpack('<IIII', d[off:off+16]); off += 16
        fr = d[off:off+cl]; off += cl
        t_us = sec * 1e6 + (frac / 1000.0 if ns else frac)  # float microseconds: the sentinel's own feature math is float
        t_ns = sec * 1_000_000_000 + (frac if ns else frac * 1000)  # sec and frac are ints from struct.unpack: exact integer nanoseconds
        ln = ol
        proto = flags = sp = dp = 0
        src_ip = None
        if len(fr) >= 14:
            et = struct.unpack('!H', fr[12:14])[0]; l3 = 14
            if et == 0x8100 and len(fr) >= 18: et = struct.unpack('!H', fr[16:18])[0]; l3 = 18
            if arp_src and et == 0x0806 and len(fr) >= l3 + 28:
                # ARP has no IPv4 header. Attribute a well-formed Ethernet/IPv4 request or reply to its sender protocol address
                # (forgeable, like any source); a 0.0.0.0 probe, another hardware type or a short frame has no source.
                htype, ptype, hlen, plen = struct.unpack('!HHBB', fr[l3:l3 + 6])
                spa = fr[l3 + 14:l3 + 18]
                if htype == 1 and ptype == 0x0800 and hlen == 6 and plen == 4 and spa != bytes(4):
                    src_ip = '.'.join(str(b) for b in spa)
            if et == 0x0800 and len(fr) >= l3 + 20:
                ihl = (fr[l3] & 0x0F) * 4
                if ihl >= 20 and len(fr) >= l3 + ihl:
                    proto = fr[l3 + 9]; l4 = l3 + ihl
                    src_ip = '.'.join(str(b) for b in fr[l3 + 12:l3 + 16])
                    if proto == 6 and len(fr) >= l4 + 20: sp, dp = struct.unpack('!HH', fr[l4:l4+4]); flags = fr[l4 + 13]
                    elif proto == 17 and len(fr) >= l4 + 8: sp, dp = struct.unpack('!HH', fr[l4:l4+4])
        frames.append((t_us, ln, proto, flags, sp, dp, src_ip, t_ns) if with_src else (t_us, ln, proto, flags, sp, dp))
    return frames

class Adaptive:
    def __init__(self, tau=BASE_TAU, alpha=0.05, sig=2.5):
        self.base = tau; self.a = alpha; self.s = sig
        self.m = tau * 0.75; self.v = (tau * 0.15) ** 2
    def check(self, loss):
        std = math.sqrt(max(1e-6, self.v)); tau = max(self.base, self.m + self.s * std)
        an = loss >= tau
        if not an:
            diff = loss - self.m; self.m += self.a * diff; self.v = (1 - self.a) * self.v + self.a * diff * diff
        return an, tau

def summarize(name, ls):
    if not ls: print(f"{name:46s} (too few frames for a 64-packet window)"); return
    a = np.array(ls); ad = Adaptive(); fl = sum(ad.check(x)[0] for x in ls)
    print(f"{name:46s} n={len(a):4d}  loss min/med/max = {a.min():.3f}/{np.median(a):.3f}/{a.max():.3f}   static>=0.15: {100*np.mean(a>=BASE_TAU):5.1f}%   adaptive flags: {fl}")

def synth(n, gen, dt_us, seed=1):
    rnd = random.Random(seed); t = 0.0; out = []
    for i in range(n):
        t += dt_us(rnd) if callable(dt_us) else dt_us
        out.append((t,) + gen(rnd, i))
    return out

def main(datadir):
    print("== captured traffic (timing from capture timestamps)")
    for f, label in (("capture-idle-dev-server-polling-2026-10-17.pcap", "idle segment, dev-server polling (380 frames)"), ("capture-ping-and-tailscale-2026-10-16.pcap", "5 pps ping + Tailscale burst (125 frames)")):
        summarize(label, losses(parse_pcap(os.path.join(datadir, f))))
    N = 600
    print("\n== synthetic patterns, same feature and kernel arithmetic")
    G = {
      "benign: ICMP echo 5 pps (98 B)":            (lambda r,i:(98,1,0,0,0), 200_000),
      "benign: DNS-like UDP (80 B, ports 53/ephemeral)": (lambda r,i:(80,17,0,53,r.randint(1024,65535)), lambda r:r.uniform(5_000,500_000)),
      "benign: TCP bulk ACKs (1500 B, 443/50000)": (lambda r,i:(1500,6,0x10,443,50000), 100),
      "benign: TCP web mix (60-1500 B, ACK/PSH)":  (lambda r,i:(r.choice([60,66,1500,1400]),6,r.choice([0x10,0x18,0x02,0x11]),r.choice([443,80]),r.randint(1024,65535)), lambda r:r.uniform(200,50_000)),
      "ATTACK: SYN flood (60 B, random src ports)": (lambda r,i:(60,6,0x02,r.randint(1024,65535),80), 100),
      "ATTACK: SYN flood, fixed ports":            (lambda r,i:(60,6,0x02,40000,80), 100),
      "ATTACK: port scan, sequential dst, 10 ms":  (lambda r,i:(60,6,0x02,40000,1+i%65535), 10_000),
      "ATTACK: low-rate port scan, 500 ms":        (lambda r,i:(60,6,0x02,40000,1+i%65535), 500_000),
      "ATTACK: UDP flood (1400 B, random ports)":  (lambda r,i:(1400,17,0,r.randint(1024,65535),r.randint(1,65535)), 50),
      "ATTACK: ARP flood (42 B, non-IP)":          (lambda r,i:(42,0,0,0,0), 1_000),
    }
    for name,(gen,dt) in G.items():
        summarize(name, losses(synth(N, gen, dt)))

if __name__ == "__main__":
    main(sys.argv[1])
