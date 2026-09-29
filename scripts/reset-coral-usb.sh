#!/bin/bash
# reset-coral-usb.sh
# Resets all Google Coral Edge TPU USB devices by de-authorizing and
# re-authorizing each one via sysfs.
#
# Dynamically discovers Coral devices by scanning for idVendor=18d1 and
# idProduct=9302 (uncompiled) or 9303 (compiled/delegate loaded). Only
# resets confirmed Coral devices — never touches other peripherals.
#
# Council Invariants:
#   INV-1 (Anti-Shortcut): set -eu — no suppressed errors, no silent failures.
#   INV-3 (Fail-Closed): exits non-zero if any reset step fails, so the
#         calling service (zodiac-coral.service ExecStartPre) fails rather
#         than starting the daemon against a potentially wedged device.
#
# Usage (run as root):
#   /home/zodiac/agentic-era-networking/scripts/reset-coral-usb.sh
#
# Exit codes:
#   0 — all Coral devices reset and re-authorized successfully
#   1 — no Coral devices found, or a sysfs write failed

set -eu

CORAL_VENDOR='18d1'
# 9302 = uncompiled (initial enumeration); 9303 = compiled (delegate loaded)

USB_SYSFS='/sys/bus/usb/devices'
SLEEP_DEAUTH=1     # integer seconds between deauth and reauth (POSIX sleep requires integers)

found=0

for dev_path in "$USB_SYSFS"/*/; do
    vendor_file="$dev_path/idVendor"
    product_file="$dev_path/idProduct"
    authorized_file="$dev_path/authorized"

    [ -f "$vendor_file" ] || continue
    [ -f "$product_file" ] || continue
    [ -f "$authorized_file" ] || continue

    vendor=$(cat "$vendor_file")
    product=$(cat "$product_file")

    [ "$vendor" = "$CORAL_VENDOR" ] || continue

    case "$product" in
        9302|9303) ;;
        *) continue ;;
    esac

    dev_name=$(basename "$dev_path")
    echo "[reset-coral-usb] Resetting Coral TPU at $dev_name (idVendor=$vendor idProduct=$product)"

    printf '0' > "$authorized_file"
    sleep $SLEEP_DEAUTH
    printf '1' > "$authorized_file"

    echo "[reset-coral-usb] Reset complete: $dev_name"
    found=$((found + 1))
done

if [ "$found" -eq 0 ]; then
    echo "[reset-coral-usb] WARNING: No Coral TPU devices found (idVendor=$CORAL_VENDOR)" >&2
    exit 1
fi

echo "[reset-coral-usb] $found Coral TPU(s) reset. Waiting for udev to settle..."
# udevadm settle is deterministic: waits until all pending udev events are
# processed (device nodes created, symlinks updated) rather than sleeping a
# fixed interval that may be too short under kernel interrupt load.
udevadm settle --timeout=10
echo "[reset-coral-usb] Done."
