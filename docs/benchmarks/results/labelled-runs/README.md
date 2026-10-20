# Labelled runs and the first detector scores (2026-10-17)

Runs recorded with `scripts/labelled-runs.py` at the Jetson's Zodiac P3 tap, each one class and one sender, and
scored with `scripts/score-labelled-runs.py` (`python3 scripts/score-labelled-runs.py docs/benchmarks/results/labelled-runs`).
Each run is a gzipped capture plus a label file naming the sender; `scores-2026-10-17.txt` and `.json` are the output
recorded here.

| Run (repeats are `-r2`, `-r3`) | Class | What it is |
| :--- | :--- | :--- |
| `benign-ping-5pps` (x3), `benign-ping-5pps-node01`, `benign-ping-20pps` (x2) | benign | ping from `node-02` (and once `node-01`) at 5 or 20 per second |
| `benign-idle-60s` (x2) | benign | nothing sent for 60 s: the capture alone |
| `benign-interactive-8eps` (x3) | benign | ssh-like (**modelled**, not ssh): 40 to 120 byte writes at irregular gaps averaging 8 per second, 30 s |
| `benign-http-burst-8conns` (x3) | benign | browsing-like: every 3 s, 8 parallel fetches of a 20 KB page plus a small request, 30 s |
| `benign-udp-burst-tailscale-like-ok` (valid) and `-drop-1`, `-drop-2`, `-drop-3` (**invalid**) | benign | **modelled** from the 2026-10-16 capture (a burst of 25 full-size UDP datagrams, then a small keepalive a second). Four recordings: one healthy (`-ok`, scored) and three during which the switch dropped its controller session (`-drop-1` from 2026-10-17, `-drop-2` and `-drop-3` the two 2026-10-18 repeats). The three are kept as evidence, labelled `rackHealthyAfter=false`, and left out of every rate. `-drop-1` was recorded under the id `benign-udp-burst-tailscale-like` until 2026-10-18 and renamed; the id was not reused for a different recording |
| `benign-bulk-tcp-2mbit` (x2) | benign | a rate-limited TCP stream to a sink on the Mac, 2 Mbit per second, 20 s (about 175 frames a second) |
| `benign-http-5rps` (x3), `benign-http-20rps` (x2) | benign | small HTTP GETs to a local web server on the Mac, 30 s |
| `benign-udp-small-10pps` (x3), `benign-udp-small-50pps` (x2) | benign | 60 to 100 byte UDP datagrams to port 53 on the Mac, 30 s |
| `attack-synflood-200pps`, `attack-synflood-1000pps` (x3 each) | attack | `hping3` SYN flood from `node-01`, 30 s and 10 s |
| `attack-udpflood-500pps-1400b` (and `-r3`) | attack | `hping3` UDP flood, 1400-byte payloads, 500 pps, 10 s |
| `attack-portscan-fast`, `attack-portscan-slow` (x3 each) | attack | `nmap -sS -T4` ports 1 to 1000 (all sent in 0.36 s); `-T2` ports 1 to 200 (80 s) |
| `attack-portscan-1pps` (x2), `attack-portscan-half-pps` (x2) | attack | `nmap` paced at 1 and 0.5 probes per second, 70 s |
| `attack-arpflood-200pps` (x3) | attack | `nping` ARP request flood, 200 per second, 12 s. ARP has no IPv4 header. **Not scored by the two replicas**: the deployed trt daemon keys on IPv4 sources and ignores ARP, so the replicas see 0 frames from the sender and list these as INVALID. The baseline prototype attributes ARP frames to their sender protocol address (forgeable) and scores them |

## Scores (45 scored runs by the two replicas: 27 benign, 18 attack; 6 recorded runs are left out: 3 ARP floods the daemon cannot see, 3 UDP bursts during a switch drop)

| Detector | Attacks detected with the right sender | Benign runs with an alert (false positives) |
| :--- | :--- | :--- |
| Rate rule (the trt daemon: 10 pps per source, 5 s window, judged after 0.5 s) | 8 of 18 | **21 of 27** |
| GPU sentinel (the arithmetic of the deployed kernel, 0.15 base threshold with an adaptive baseline) | 15 of 18 | **12 of 27** |

Benign false positives by workload (runs with any alert / runs):

| Workload (all to the Mac's `10.0.2.119` alias) | Rate rule | Sentinel |
| :--- | ---: | ---: |
| HTTP polls, 5 and 20 requests per second | 5 of 5 | 1 of 5 |
| Small UDP datagrams, 10 and 50 per second | 5 of 5 | 4 of 5 |
| Ping, 5 and 20 per second | 2 of 6 | 6 of 6 |
| Idle (nothing sent) | 0 of 2 | 0 of 2 |
| Bulk TCP stream, 2 Mbit per second | 2 of 2 | 0 of 2 |
| ssh-like interactive TCP (modelled), 8 writes per second | 3 of 3 | 0 of 3 |
| Browsing-like HTTP bursts (8 parallel connections every 3 s) | 3 of 3 | 0 of 3 |
| Tailscale-like UDP burst (modelled, 1 run) | 1 of 1 | 1 of 1 |

- **The rate rule's threshold is far below ordinary traffic.** One host making a few web requests a second sends more than
  10 frames per second (each request is about five frames), so every HTTP run, every UDP run and the 20 pps pings were
  flagged within about 0.5 s. It catches the floods, but it would also quarantine any chatty host.
- **The sentinel flags most benign traffic too**: every ping run, four of five small-UDP runs, and an occasional window in
  HTTP runs. It stays silent only on idle.
- **Ssh-like and browsing-like traffic is flagged by the rate rule in every run (6 of 6)** and by the sentinel in none: the
  sentinel's silences on bulk, interactive and browsing traffic and its alerts on ping and small UDP follow frame size and
  protocol, not behaviour.
- **Neither detector separates attack from ordinary use on this data.** The rate rule's misses are structural: it detects
  none of the 10 scan runs (the fast scan finishes in 0.36 s, before the rule's 0.5 s minimum; the slower scans run at 2.5
  pps or less, below 10 pps). The sentinel detects 15 of 18 attacks, but it also flags 12 of 27 benign runs, so its
  detections are not evidence that it detects attacks. It misses `attack-portscan-fast-r3` and both half-pps scans.
- **ARP flood is invisible to the deployed rate rule and to the sentinel replica.** Three runs, about 150 KB each at the tap, 0 frames attributed to the sender by the daemon's rules. Attributing ARP frames to their sender protocol address (an option of the parser, used only by the baseline prototype) shows the flood is separable: 195 non-TCP frames a second against a floor of 100.

## Correction to the earlier sentinel finding

`docs/benchmarks/results/sentinel-detection/` reported, from synthetic patterns, that the sentinel misses or barely
flags floods. The real `hping3` floods contradict that: it flags all three. The synthetic rows were my approximation of
the features (for example `hping3` increments the source port per packet, which is neither the fixed nor the random
pattern I used), and they were wrong about floods. What stands is the other half: it flags ping and every other benign
run, and it was never trained.

## Caveats

- 51 runs recorded (45 scored by the replicas; 3 ARP-flood runs are invisible to the daemon, 3 UDP-burst runs coincided with a switch drop), up to three repeats of each workload, one host pair, short durations: a
  scored comparison, not a distribution. Still missing: bulk TCP above 2 Mbit, real ssh sessions, real Tailscale traffic, a
  browser-like mix, address-spoofing attacks, and valid UDP-burst repeats: the UDP-burst workload has **one** valid run, and is the workload that hung the switch three times in four recordings (see the incident log). A 100 Mbit lab segment limits rates.
- **Bulk TCP was recorded only at 2 Mbit per second.** Attempts at 5 Mbit and above coincided with switch outages (see
  below), and 5, 10 and 20 Mbit are not in the data. The sentinel is silent on the 2 Mbit streams (large frames score low); the rate rule flags them.
- **Traffic that does not cross the Zodiac is invisible to the tap.** `node-01`, `node-02` and the Pi 5 are behind the
  same switch; HTTP and iperf3 runs between them left 0 frames at the tap (measured), so the receivers run on the Mac,
  on the uplink side. The scorer marks a run INVALID and leaves it out of every rate if the sender is seen fewer than
  20 times.
- Timing comes from capture timestamps. The live trt daemon dropped 3,458 frames above about 300 per second (its
  per-frame GPU inference is the limit), which this replay does not model, so the rate rule scored here is generous at
  high rates.
- The run labels are per run: a benign alert means any alert in a run that contained only benign traffic from one
  sender plus a few background frames (about 5 in 60 s).
- The captures hold lab MAC and IP addresses.

## Rack incident during recording

At 22:20:25 on 2026-10-17 the controller logged `Dead peer detected (10.0.1.99): no OFPT_ECHO_REPLY within timeout`: the
Zodiac FX stopped answering on its control address and the data path stopped forwarding (ARP across it failed). The
last valid HTTP run ended at 22:20:12, 13 s earlier; the first bulk-TCP attempt started at about that moment. The
switch's firmware was still running (its serial-reported uptime kept advancing, 145 h at the time), so it had not
power-cycled; its IP and OpenFlow stack was unresponsive. The cause is unknown and the recorded traffic cannot be excluded
as a trigger. The bulk-TCP runs were captured during the outage and are excluded.

A review suggested the switch's CPU was starved by `OFPT_PACKET_IN` table-miss punts. The flow probe argues against that:
the table-miss entry (priority 0) has no actions, so unmatched frames are dropped, not sent to the controller, and the
isolation policy's rules output only to ports. That is evidence against one mechanism, not an explanation; the cause is
still unknown. The bulk sender also paces with the operating system's sleep, which is coarse, so it may send in small
bursts; it has not run successfully, so that is untested.

### 2026-10-18: two more drops of the controller session

After the owner power cycled the switch (2026-10-17 evening, uptime then counted from about 00:26), the controller logged
`Dead peer detected (10.0.1.99)` at **12:28:15** and again at **12:31:34**. The first occurred while **nothing of mine was
running** (the batch started two minutes later); the second during the first 5 Mbit bulk-TCP run, whose sender's connection
timed out after 19 s, and the next run got no frames at all. The two 2 Mbit runs before it (12:30 to 12:31) completed
normally (3,458 and 3,463 sender frames). The switch's serial-reported uptime kept advancing, so it had not rebooted.

So there have been three drops in 14 hours of use after six quiet days: 2026-10-17 22:20:25 (13 s after an HTTP run), 12:28:15
(idle) and 12:31:34 (during a 5 Mbit stream). Two coincide with recorded traffic and one does not, so **the cause is
unknown and it may be intrinsic to the device**, not caused by the tests. The harness now also checks OpenFlow `Connected`
and a verified isolation readback **after** every run, records the verdict in the label (`rackHealthyAfter`), stops the batch
when it is false, and the scorer excludes such runs.

### 2026-10-18 later: a fourth drop, and what the link's own record shows

The recording resumed after the owner approved a serial restart (the switch came back at 13:21). Runs 1 to 6 (interactive,
browsing-like) were healthy; during run 7 (the Tailscale-like UDP burst) the switch dropped its controller session again at
about 14:14:40, after two bursts had crossed normally: the run's traffic reaches the tap until about 20 s in, the third burst
(frames at 18 to 20 s) is the last thing seen, and the bridge logged the dead peer at 14:14:44. The harness's post-run check
caught it, recorded `rackHealthyAfter: false` and stopped the batch.

The Jetson's kernel log separates two phenomena:

- **Type A, self-recovering:** the onboard NIC (r8168, the control link to the switch's Port 4) lost carrier for about 3 s and
  came back, 7 times in 24 hours (2026-10-17 11:45, 11:54, 15:40, 17:13, 19:40; 2026-10-18 08:17, 11:51), plus the ones caused
  by restarts. Each time the bridge logged a dead peer and the session recovered. None of these followed a recorded run.
- **Type B, not recovering:** 2026-10-17 22:20:25, 2026-10-18 12:28:15, 12:31:34 and 14:14:44. **No link event and no kernel
  message at all**; afterwards the Jetson cannot resolve the switch's address (ARP `FAILED`), the switch's serial console
  still answers (uptime advancing, ports up) and reports OpenFlow `Disconnected` with 0 flows; a serial `restart` of the
  switch clears it.

Energy-Efficient Ethernet is `enabled - active` on that link (100BASE-T, Tx LPI 123 microseconds), between a Realtek r8168 and
a small embedded PHY. EEE low-power-idle wake problems are a known cause of short carrier flaps and of a link that stops
carrying frames, so it is the leading **hypothesis**, not a finding: nothing here shows that EEE is the cause. Cheap test: turn
EEE off on the Jetson's NIC (`sudo ethtool --set-eee enP8p1s0 eee off`) and see whether the flaps and hangs stop; doing it
while the switch is hung also tests whether a link renegotiation alone recovers it without restarting the switch.

### 2026-10-18 15:00 to 15:35: the Tailscale-like UDP burst hung the controller session twice

After a serial restart at 15:02, `benign-udp-burst-tailscale-like-r2` (30 s from `node-02`; recorded as `-drop-2`) was followed by a dead-peer
event at about 15:21; after another serial restart, a second attempt at the same run was followed by one at 15:30. The
first run of the same pattern passed (recorded). With EEE off since 14:59 and no link event in the kernel log, this is
another type B hang; two in a row on the same run suggests this traffic as a trigger, but that is two observations of one
workload. The cause is unknown. The pattern was not tried again and the 16 remaining runs recorded without further drops.
