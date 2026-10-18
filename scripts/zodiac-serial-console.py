#!/usr/bin/env python3
"""
scripts/zodiac-serial-console.py
================================
Read the Zodiac FX's own state over its USB serial console, and, only when asked, restart it. Run on the Jetson (the switch's
USB port is on it). Written after the switch dropped its OpenFlow controller session three times in 14 hours (2026-10-17/18)
and a restart from this console brought it back (uptime reset, controller reconnected, isolation policy reinstalled and read
back verified by the bridge).

  python3 scripts/zodiac-serial-console.py                 diagnostics only: status, config, OpenFlow status, ports. Sends no restart.
  python3 scripts/zodiac-serial-console.py --restart       the same diagnostics FIRST (kept for the record), then `restart`.
  python3 scripts/zodiac-serial-console.py --dry-run [--restart]   print what it would send; open nothing

A restart empties the switch's flow table; the bridge reinstalls the isolation policy when the controller reconnects. Check
`curl localhost:3003/api/zodiac/flows` shows port1Isolation verified before sending any traffic through the rack.
The bridge also uses this port (it opens it briefly to poll); two openers at once can see garbled or lagging replies, so read
the output with that in mind. Needs pyserial and membership of the dialout group.
"""

import argparse
import sys
import time

DEFAULT_DEV = "/dev/ttyACM0"
BAUD = 115200
QUIET_SECONDS = 1.5
# Each step is (command, what it reads). Sub-menus are entered and left with `config`/`openflow` and `exit`.
DIAGNOSTICS = ("", "show status", "show ports", "config", "show config", "exit", "openflow", "show status", "exit")
RESTART = "restart"


def plan(restart):
    """The exact commands this run would send, in order. `restart` is last, and present only when asked for."""
    return list(DIAGNOSTICS) + ([RESTART] if restart else [])


def run(dev, commands):
    import serial  # imported late so --dry-run and the tests need no pyserial

    ser = serial.Serial(dev, BAUD, timeout=0.3, write_timeout=2.0, rtscts=False, dsrdtr=False)
    try:
        for cmd in commands:
            ser.reset_input_buffer()
            ser.write((cmd + "\r\n").encode("ascii"))
            buf = b""
            deadline = time.monotonic() + QUIET_SECONDS
            try:
                while time.monotonic() < deadline:
                    chunk = ser.read(4096)
                    if chunk:
                        buf += chunk
                        deadline = time.monotonic() + QUIET_SECONDS
            except serial.SerialException:
                if cmd == RESTART:
                    print(">>> restart\n(the serial port dropped as the device reset: expected)")
                    return
                raise
            print(">>> " + (cmd or "<enter>"))
            print(buf.decode("latin1", errors="replace").strip())
    finally:
        try:
            ser.close()
        except OSError:
            pass  # the device may already be gone after a restart


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--restart", action="store_true", help="after the diagnostics, restart the switch")
    ap.add_argument("--dry-run", action="store_true", help="print the commands and open nothing")
    ap.add_argument("--dev", default=DEFAULT_DEV, help=f"serial device (default {DEFAULT_DEV})")
    a = ap.parse_args()
    cmds = plan(a.restart)
    if a.dry_run:
        for c in cmds:
            print(c or "<enter>")
        return 0
    run(a.dev, cmds)
    return 0


if __name__ == "__main__":
    sys.exit(main())
