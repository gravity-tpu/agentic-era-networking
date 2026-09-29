#!/bin/bash
# reset-coral-usb.sh
# Resets all Google Coral Edge TPU USB devices by de-authorizing and
# re-authorizing each one via sysfs.
#
# Dynamically discovers Coral devices by scanning for idVendor=18d1 and
# idProduct=9302 (uncompiled) or 9303 (compiled/delegate loaded). Only
# resets confirmed Coral devices — never touches other peripherals.
#
# Pre-firmware state: after a fresh physical replug Corals enumerate as
# 1a6e:089a (Global Unichip Corp.) before libedgetpu loads firmware. These
# devices are in a clean state — they do not need a sysfs reset. If only
# 1a6e:089a devices are found, the script exits 0 (nothing to reset).
# The script only exits 1 if no Coral device is present at all.
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
#   0 — all Coral devices reset and re-authorized successfully, OR devices
#       are in fresh pre-firmware state (1a6e:089a) and need no reset
#   1 — no Coral devices found at all, or a sysfs write failed

set -eu
# nullglob: empty /sys/bus/usb/devices/ yields an empty list, not a literal glob.
shopt -s nullglob

CORAL_VENDOR='18d1'
# 9302 = uncompiled (initial enumeration); 9303 = compiled (delegate loaded)
CORAL_PREFIRMWARE_VENDOR='1a6e'
CORAL_PREFIRMWARE_PRODUCT='089a'

USB_SYSFS='/sys/bus/usb/devices'
SLEEP_DEAUTH=1     # integer seconds between deauth and reauth (POSIX sleep requires integers)

found=0
prefirmware=0

for dev_path in "$USB_SYSFS"/*/; do
    vendor_file="$dev_path/idVendor"
    product_file="$dev_path/idProduct"
    authorized_file="$dev_path/authorized"

    [ -f "$vendor_file" ] || continue
    [ -f "$product_file" ] || continue
    [ -f "$authorized_file" ] || continue

    # TOCTOU guard: an unrelated device disconnecting between the -f check and
    # the cat read causes cat to fail. Swallow the read error and skip the
    # entry — only the Coral reset writes (below) must be fail-closed.
    vendor=$(cat "$vendor_file" 2>/dev/null) || continue
    product=$(cat "$product_file" 2>/dev/null) || continue

    # Track pre-firmware Coral devices (fresh post-replug state, no reset needed).
    if [ "$vendor" = "$CORAL_PREFIRMWARE_VENDOR" ] && [ "$product" = "$CORAL_PREFIRMWARE_PRODUCT" ]; then
        dev_name=$(basename "$dev_path")
        echo "[reset-coral-usb] Pre-firmware Coral at $dev_name ($CORAL_PREFIRMWARE_VENDOR:$CORAL_PREFIRMWARE_PRODUCT) — fresh state, no reset needed"
        prefirmware=$((prefirmware + 1))
        continue
    fi

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

if [ "$found" -eq 0 ] && [ "$prefirmware" -eq 0 ]; then
    echo "[reset-coral-usb] WARNING: No Coral TPU devices found (18d1:9302/9303 or 1a6e:089a)" >&2
    exit 1
fi

if [ "$found" -eq 0 ] && [ "$prefirmware" -gt 0 ]; then
    echo "[reset-coral-usb] $prefirmware pre-firmware Coral(s) present — skipping reset, udev will handle firmware load."
    exit 0
fi

echo "[reset-coral-usb] $found Coral TPU(s) reset. Waiting for udev to settle..."
# udevadm settle is deterministic: waits until all pending udev events are
# processed (device nodes created, symlinks updated) rather than sleeping a
# fixed interval that may be too short under kernel interrupt load.
udevadm settle --timeout=10
echo "[reset-coral-usb] Done."
