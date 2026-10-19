# UDP-burst repro: which part of the Tailscale-like burst coincides with a controller-session drop (2026-10-18)

Five runs with `scripts/labelled-runs.py --include-risky` (ids `repro-udp-burst-*`, which the harness hides unless
`--include-risky` is given). Each is one factor away from the base pattern: from `node-02` to the Mac's `10.0.2.119`
alias, 30 s, every 10 s a burst of 25 datagrams of 1300 payload bytes back to back, plus a 148-byte keepalive every
second. The two earlier pairs of recordings are in `../labelled-runs/` as `benign-udp-burst-tailscale-like-{ok,drop-1,drop-2,drop-3}`.
After each hang the switch was restarted from the serial console (`scripts/zodiac-serial-console.py --restart`).

| Run | Change from the base | Controller session | Sender frames at the tap per 10 s window (full-size frames) | Last sender frame |
| :--- | :--- | :--- | :--- | ---: |
| `repro-udp-burst-base` | none | held | 34, 18, 17 | 36.1 s |
| `repro-udp-burst-base-r2` | none, repeated | **dropped** (dead peer 17:18:10) | 34, 17, 12 | 28.1 s |
| `repro-udp-burst-node01` | sent from `node-01` | **dropped** | 34, 12, 1 | 21.0 s |
| `repro-udp-burst-600b` | 600-byte payload | held | 39, 19, 19 | 36.0 s |
| `repro-udp-burst-5x` | bursts of 5 datagrams | held | 10, 5, 2 | 36.0 s |

Together with the earlier recordings of the same base pattern the base has now been recorded 7 times: **5 drops, 2
holds**. The two holds (`-ok` and `repro-udp-burst-base`) each came directly after a serial restart; `-drop-3` also came
directly after one, so that is not a rule.

## What this does and does not show

- In every dropped run the sender's frames stop **partway through a burst** (the last frame at the tap is 5.0 s, 20.0 s,
  21.0 s, 28.1 s, never between bursts), and the bridge's dead-peer event follows a few seconds later. The data path and
  the control session fail together, during a burst. This is read from the captures; the switch gives no log of why.
- Even held runs lose frames: a burst is 25 datagrams sent back to back, and the tap sees about 17 of them per burst
  in the later windows. The first window is not a clean count (it includes the keepalive that starts the run and one
  more partial burst). I did not establish where the others go; the likely place is the switch's receive path, but that
  is a guess, not a measurement.
- The 600-byte and 5-datagram variants each held **once**. With the base failing 5 of 7, one hold is weak evidence: it
  is consistent with a smaller burst (in bytes or in frames) being safer, and it does not show that. Telling the
  variants apart from chance needs several runs each, and each failure costs a serial restart.
- The sender host is not the factor: `node-01` dropped it too.
- This is one traffic shape from two hosts into one switch on a 100 Mbit link. It says nothing about the cause
  (firmware, receive-buffer overflow and the NIC's EEE setting, which was off for all of these, were not isolated).

## Consequence for the rest of the work

The Tailscale-like burst stays modelled and stays a workload that can take the switch's control plane away. Do not run it
unattended. Anything that lets a source emit back-to-back 1300-byte bursts on the untrusted segment can currently do the
same, so it is also a denial-of-service path against the control plane, whatever the detectors do. The fail-closed
posture (the switch's `Secure` fail state keeps the isolation policy while the controller is away) is what is
measured to hold during these drops; the isolation re-check after each restart passed.
