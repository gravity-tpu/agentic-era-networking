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
The bridge also uses this port (it opens it briefly to poll); two openers at once can see garbled or lagging replies, so this tool
opens the port exclusively (an opener that arrives while it is running fails with `busy` and retries on its next poll), and
`--restart` first waits for any existing opener to let go. Needs pyserial and membership of the dialout group.
"""

import argparse
import os
import pwd
import sys
import time

DEFAULT_DEV = "/dev/ttyACM0"
BAUD = 115200
QUIET_SECONDS = 1.5
BRIDGE_USER = "zodiac"      # deploy/jetson/zodiac-bridge.service runs the bridge as this user
MAX_SECONDS_PER_COMMAND = 15  # hard cap: a device or a second opener that keeps streaming cannot hold a command open
OPENER_WAIT_SECONDS = 15      # how long --restart waits for another process to let go of the port
# Each step is (command, what it reads). Sub-menus are entered and left with `config`/`openflow` and `exit`.
DIAGNOSTICS = ("", "show status", "show ports", "config", "show config", "exit", "openflow", "show status", "exit")
RESTART = "restart"


def plan(restart):
    """The exact commands this run would send, in order. `restart` is last, and present only when asked for."""
    return list(DIAGNOSTICS) + ([RESTART] if restart else [])


def runs_as_bridge_user(uid=None, lookup=pwd.getpwnam):
    """True when this process runs as the bridge's own user. The opener scan only sees processes of the same user, so a restart
    from any other user could not see the bridge opening the port; --restart therefore requires this (diagnostics do not)."""
    try:
        return (os.getuid() if uid is None else uid) == lookup(BRIDGE_USER).pw_uid
    except KeyError:
        return False  # no such user on this machine: not the Jetson


def find_openers(dev, proc_root="/proc"):
    """PIDs (other than this process) that currently have `dev` open, read from /proc/<pid>/fd. Best effort: a process of another
    user cannot be inspected, and is not reported."""
    real = os.path.realpath(dev)
    pids = []
    try:
        entries = os.listdir(proc_root)
    except OSError:
        return pids
    for name in entries:
        if not name.isdigit() or int(name) == os.getpid():
            continue
        fd_dir = os.path.join(proc_root, name, "fd")
        try:
            fds = os.listdir(fd_dir)
        except OSError:
            continue
        for fd in fds:
            try:
                if os.path.realpath(os.path.join(fd_dir, fd)) == real or os.readlink(os.path.join(fd_dir, fd)) == real:
                    pids.append(int(name))
                    break
            except OSError:
                continue
    return sorted(pids)


def wait_for_exclusive_use(dev, seconds=OPENER_WAIT_SECONDS, proc_root="/proc"):
    """Wait until no other process has the device open (the bridge opens it only briefly to poll); return the PIDs still holding it."""
    deadline = time.monotonic() + seconds
    holders = find_openers(dev, proc_root)
    while holders and time.monotonic() < deadline:
        time.sleep(0.5)
        holders = find_openers(dev, proc_root)
    return holders


def run(dev, commands):
    import serial  # imported late so --dry-run and the tests need no pyserial

    # exclusive=True takes the port with TIOCEXCL: from the moment it is open, any other process that tries to open it (the bridge's
    # poll) gets EBUSY instead of interleaving with this session, which closes the gap between the check above and the use.
    ser = serial.Serial(dev, BAUD, timeout=0.3, write_timeout=2.0, rtscts=False, dsrdtr=False, exclusive=True)
    try:
        for cmd in commands:
            if cmd == RESTART:
                # One more look, with the port already held exclusively and just before the restart goes out: anyone who opened it
                # in the meantime is visible now. (A process of another user, root for instance, is never visible to this scan.)
                holders = find_openers(dev)
                if holders:
                    raise SystemExit(f"not restarting: process(es) {holders} opened {dev} while the diagnostics ran")
            ser.reset_input_buffer()
            ser.write((cmd + "\r\n").encode("ascii"))
            buf = b""
            started = time.monotonic()
            deadline = started + QUIET_SECONDS
            try:
                while time.monotonic() < deadline and time.monotonic() - started < MAX_SECONDS_PER_COMMAND:
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
    if a.restart:
        if not runs_as_bridge_user():
            print(f"refusing to restart: run this as the user the bridge runs as ({BRIDGE_USER}); from another user the check for "
                  "other openers of the port is blind to the bridge", file=sys.stderr)
            return 4
        holders = wait_for_exclusive_use(a.dev)
        if holders:
            print(f"refusing to restart: process(es) {holders} still have {a.dev} open after {OPENER_WAIT_SECONDS} s; "
                  "a restart issued against interleaved replies could act on stale state", file=sys.stderr)
            return 3
    run(a.dev, cmds)
    return 0


if __name__ == "__main__":
    sys.exit(main())
