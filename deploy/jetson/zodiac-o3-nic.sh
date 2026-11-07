#!/usr/bin/env bash
# zodiac-o3-nic.sh  --  LOCAL helper (gitignored; not part of the repo). Run ON the Jetson.
#
# Puts the new USB NIC (plugged into NETGEAR switch #2 port 3, the mirror destination of
# port 4 = the Zodiac P2 link) into a deterministic, receive-only capture state:
#   GRO/LRO/checksum/SG offloads off, promiscuous, address-less (incl. IPv6), unmanaged by
#   NetworkManager, and a fail-closed kernel egress drop (clsact + matchall drop).
# Same checks as deploy/rpi5/sdn-capture-nic.sh, with separate names so it cannot collide with
# any existing capture NIC setup (env file, unit and udev rule are all "zodiac-o3-*").
#
# Usage (sudo):
#   zodiac-o3-nic.sh snapshot                  # BEFORE plugging in the NIC
#   zodiac-o3-nic.sh diff                      # AFTER: shows the new interface + MAC
#   zodiac-o3-nic.sh install <MAC>             # persistent config (udev -> systemd -> apply+verify)
#   zodiac-o3-nic.sh verify  <iface>           # re-check the live state
#   zodiac-o3-nic.sh selftest <iface>          # prove the egress drop works (counter must rise)
#   zodiac-o3-nic.sh diag <iface>              # dump qdisc/filter state, kernel support, unit logs
#   zodiac-o3-nic.sh capture <iface> <secs> <label> [note]   # pcap + provenance sidecar
#   zodiac-o3-nic.sh capture-o2 <iface> <secs> <label> [note]   # O2 tap capture with a provenance sidecar
#   zodiac-o3-nic.sh ingress-test <iface> [--tagged]   # test whether the mirror port accepts ingress (briefly lifts egress drop)
#   zodiac-o3-nic.sh meta <pcap> <iface> <label> <note> <secs>   # sidecar for an existing pcap
#   zodiac-o3-nic.sh uninstall
set -euo pipefail
export PATH="/usr/local/sbin:/usr/sbin:/sbin:${PATH}"

ENV_FILE=/etc/default/zodiac-o3-nic
SELF=/usr/local/sbin/zodiac-o3-nic.sh
UNIT=/etc/systemd/system/zodiac-o3-nic@.service
BOOTUNIT=/etc/systemd/system/zodiac-o3-nic-boot.service
UDEV=/etc/udev/rules.d/99-zodiac-o3-nic.rules
NMCONF=/etc/NetworkManager/conf.d/99-zodiac-o3-unmanaged.conf
SNAP=/var/tmp/zodiac-o3-ifaces-before.txt
OUT="${O3_OUT:-/var/lib/zodiac/o3-captures}"

die()       { echo "zodiac-o3-nic: $*" >&2; exit 1; }
need_root() { [ "$(id -u)" -eq 0 ] || die "run with sudo"; }
need_tools(){ for t in ip ethtool tc udevadm tcpdump python3; do command -v "$t" >/dev/null || die "missing '$t' (sudo apt install ethtool iproute2 tcpdump)"; done; }
valid_mac() { [[ "$1" =~ ^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$ ]] || die "'$1' is not a MAC address"; }

list_ifaces() {
  printf '%-20s %-18s %-9s %-7s %s\n' IFACE MAC STATE SPEED DRIVER
  for d in /sys/class/net/*; do
    n="${d##*/}"; [ "$n" = lo ] && continue
    drv="$(basename "$(readlink -f "$d/device/driver" 2>/dev/null)" 2>/dev/null || echo -)"
    printf '%-20s %-18s %-9s %-7s %s\n' "$n" "$(<"$d/address")" "$(<"$d/operstate")" \
      "$(cat "$d/speed" 2>/dev/null || echo -)" "$drv"
  done
}

load_env() { [ -r "$ENV_FILE" ] || die "$ENV_FILE missing (run install)"; . "$ENV_FILE"; : "${O3_MAC:?O3_MAC unset}"; }

identity_gate() {  # never touch an interface that is not the declared O3 NIC
  local i="$1" want have
  [ -r "/sys/class/net/$i/address" ] || die "interface $i not present"
  want="${O3_MAC,,}"; have="$(<"/sys/class/net/$i/address")"
  [ "${have,,}" = "$want" ] || die "$i has MAC $have, expected $want (refusing to configure)"
}

nic_apply() {
  local i="$1"; load_env; identity_gate "$i"
  for f in gro lro rx tx sg; do ethtool -K "$i" "$f" off 2>/dev/null || true; done
  ip link set dev "$i" promisc on up
  ip -4 addr flush dev "$i"; ip -6 addr flush dev "$i"
  sysctl -qw "net.ipv6.conf.${i}.disable_ipv6=1"
  if tc qdisc replace dev "$i" clsact 2>/dev/null \
     && tc filter replace dev "$i" egress protocol all pref 1 matchall action drop 2>/dev/null; then
    :
  else
    # Tegra kernels can lack cls_matchall/act_gact; a root blackhole qdisc drops everything enqueued.
    echo "zodiac-o3-nic[$i]: clsact drop filter unavailable, falling back to root blackhole qdisc" >&2
    tc qdisc del dev "$i" clsact 2>/dev/null || true
    tc qdisc replace dev "$i" root blackhole
  fi
}

nic_verify() {
  local i="$1" feats flags
  load_env; identity_gate "$i"
  feats="$(ethtool -k "$i")"
  grep -Eq '^generic-receive-offload: off' <<<"$feats" || die "GRO not off"
  grep -Eq '^large-receive-offload: off'   <<<"$feats" || die "LRO not off"
  grep -Eq '^rx-checksumming: off'         <<<"$feats" || die "RX checksumming not off"
  grep -Eq '^tx-checksumming: off'         <<<"$feats" || die "TX checksumming not off"
  grep -Eq '^scatter-gather: off'          <<<"$feats" || die "scatter-gather not off"
  flags="$(<"/sys/class/net/$i/flags")"; (( (flags & 0x100) != 0 )) || die "promiscuous not set"
  [ -z "$(ip -o addr show dev "$i")" ] || die "unexpected address: $(ip -o addr show dev "$i")"
  [ "$(<"/proc/sys/net/ipv6/conf/$i/disable_ipv6")" = 1 ] || die "IPv6 not disabled"
  if tc filter show dev "$i" egress 2>/dev/null | grep -Eq 'action.*drop'; then :
  elif tc qdisc show dev "$i" 2>/dev/null | grep -q 'qdisc blackhole'; then :
  else die "egress drop missing (neither a clsact drop filter nor a blackhole qdisc is present)"; fi
  if command -v nmcli >/dev/null; then
    nmcli -t -f DEVICE,STATE dev 2>/dev/null | grep -q "^${i}:unmanaged" || die "NetworkManager still manages $i"
  fi
}

dropped() { { tc -s qdisc show dev "$1"; tc -s filter show dev "$1" egress; } 2>/dev/null | grep -Eo 'dropped [0-9]+' | awk '{s+=$2} END{print s+0}' || true; }

write_meta() {  # write_meta <pcap> <iface> <label> <note> <secs>
  python3 - "$@" <<'PY'
import hashlib, json, os, platform, subprocess, sys, time
f, iface, label, note, secs = sys.argv[1:6]
mac = open(f"/sys/class/net/{iface}/address").read().strip()
env = {}
for l in open("/etc/default/zodiac-o3-nic"):
    if "=" in l:
        k, v = l.strip().split("=", 1); env[k] = v.strip('"')
pk = subprocess.run(["tcpdump", "-nn", "-r", f], capture_output=True, text=True).stdout.count("\n")
tv = subprocess.run(["tcpdump", "--version"], capture_output=True, text=True)
tv_lines = (tv.stderr + tv.stdout).splitlines()
meta = {
  "origin": "physical_capture", "label": label, "operator_note": note,
  "interface": iface, "interface_mac": mac, "host": platform.node(), "kernel": platform.release(),
  "vantage_point": os.environ.get("VANTAGE", "O3 (uplink switch #2, mirror of P4 = Zodiac P2 link)"),
  "mirror_config_declared_by_operator": env.get("O3_MIRROR", ""),
  "egress_protection": os.environ.get("EGRESS_NOTE", "root blackhole qdisc (this Tegra kernel has no cls_matchall)"),
  "duration_s": int(secs), "sidecar_written_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
  "monotonic_ns_at_write": time.monotonic_ns(), "packets": pk,
  "pcap_sha256": hashlib.sha256(open(f, "rb").read()).hexdigest(),
  "tcpdump": tv_lines[0] if tv_lines else "unknown",
}
json.dump(meta, open(f + ".meta.json", "w"), indent=2)
print(f, "->", pk, "packets;", f + ".meta.json")
PY
}

send_frame_et() {  # send_frame_et <iface> <ethertype-hex> <src-mac-last-octet-hex> <tag>   (experimental ethertypes only)
  python3 - "$@" <<'PY'
import socket, sys
iface, et, last, tag = sys.argv[1:5]
s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW)
s.bind((iface, 0))
s.send(b"\xff"*6 + bytes([0x02,0,0,0,0,int(last,16)]) + int(et,16).to_bytes(2,"big") + tag.encode().ljust(46, b"\0"))
PY
}
send_tagged() {  # send_tagged <iface> <vid> <tag>: 802.1Q-tagged frame, inner experimental ethertype 0x88b6
  python3 - "$@" <<'PY'
import socket, sys
iface, vid, tag = sys.argv[1:4]
s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW)
s.bind((iface, 0))
s.send(b"\xff"*6 + bytes([0x02,0,0,0,0,0x99]) + b"\x81\x00" + int(vid).to_bytes(2,"big") + b"\x88\xb6" + tag.encode().ljust(42, b"\0"))
PY
}
send_qinq() {  # send_qinq <iface> <outer-ethertype-hex: 8100|88a8> <outer-vid> <inner-vid> <tag>   (double-tagged, inner ethertype 0x88b6)
  python3 - "$@" <<'PY'
import socket, sys
iface, oet, ovid, ivid, tag = sys.argv[1:6]
s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW)
s.bind((iface, 0))
s.send(b"\xff"*6 + bytes([0x02,0,0,0,0,0x99]) + int(oet,16).to_bytes(2,"big") + int(ovid).to_bytes(2,"big") + b"\x81\x00" + int(ivid).to_bytes(2,"big") + b"\x88\xb6" + tag.encode().ljust(38, b"\0"))
PY
}
send_frame() { send_frame_et "$1" 88b5 01 zodiac-o3-egress-selftest; }

cmd="${1:-}"; shift || true
case "$cmd" in
  snapshot) list_ifaces | tee "$SNAP"; echo "saved to $SNAP -- now plug the NIC into switch #2 port 3, then run: diff" ;;
  diff)     [ -r "$SNAP" ] || die "run snapshot first"
            diff <(sort "$SNAP") <(list_ifaces | sort) | grep '^>' || echo "(no new interface yet)" ;;
  diag)
    need_root; i="${1:?usage: diag <iface>}"
    echo "== qdisc";  tc qdisc show dev "$i" 2>&1
    echo "== egress filters"; tc filter show dev "$i" egress 2>&1
    echo "== try the drop filter by hand (shows the kernel error, then restores)"
    tc qdisc replace dev "$i" clsact 2>&1 || true
    tc filter replace dev "$i" egress protocol all pref 1 matchall action drop 2>&1 || echo "(filter command failed, see above)"
    echo "== kernel support"
    (zcat /proc/config.gz 2>/dev/null || cat "/boot/config-$(uname -r)" 2>/dev/null) | grep -E 'CONFIG_NET_CLS_MATCHALL|CONFIG_NET_ACT_GACT|CONFIG_NET_CLS_ACT|CONFIG_NET_SCH_INGRESS|CONFIG_NET_SCH_CLSACT' || echo "(no kernel config available)"
    lsmod | grep -E 'cls_matchall|act_gact|sch_ingress' || echo "(no tc modules loaded)"
    echo "== unit"; systemctl status "zodiac-o3-nic@${i}.service" --no-pager 2>&1 | tail -8
    journalctl -u "zodiac-o3-nic@${i}.service" -n 15 --no-pager 2>&1 | tail -15 ;;
  boot)    # run by zodiac-o3-nic-boot.service: no dependence on udev timing or the interface name
    need_root; load_env
    want="${O3_MAC,,}"; iface=""
    for _ in $(seq 1 60); do
      iface="$(grep -il "$want" /sys/class/net/*/address 2>/dev/null | head -n1 | cut -d/ -f5 || true)"
      [ -n "$iface" ] && break
      sleep 1
    done
    [ -n "$iface" ] || die "no interface with MAC $want after 60s (is the NIC plugged in?)"
    nic_apply "$iface"; nic_verify "$iface"
    echo "zodiac-o3-nic[$iface]: boot apply ok" ;;
  nic-apply)  nic_apply "$1" ;;
  nic-verify) nic_verify "$1" ;;
  verify)     nic_verify "${1:?usage: verify <iface>}"; echo "zodiac-o3-nic[$1]: verify ok" ;;
  install)
    need_root; need_tools; valid_mac "${1:?usage: install <MAC>}"; mac="${1,,}"
    install -o root -g root -m 0755 "$0" "$SELF"
    printf 'O3_MAC=%s\nO3_MIRROR="switch2 P4(Zodiac P2 link) -> P3, both directions"\n' "$mac" > "$ENV_FILE"
    cat > "$UNIT" <<EOF
[Unit]
Description=Zodiac O3 capture NIC %I (receive-only, promiscuous, address-less, egress dropped)
After=sys-subsystem-net-devices-%i.device
BindsTo=sys-subsystem-net-devices-%i.device
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$SELF nic-apply %i
ExecStart=$SELF nic-verify %i
# ProtectKernelTunables is left off on purpose: apply writes net.ipv6.conf.<if>.disable_ipv6.
CapabilityBoundingSet=CAP_NET_ADMIN
AmbientCapabilities=CAP_NET_ADMIN
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_NETLINK
EOF
    cat > "$BOOTUNIT" <<EOF
[Unit]
Description=Zodiac O3 capture NIC: apply receive-only config at boot (found by MAC)
After=systemd-udevd.service
[Service]
Type=oneshot
RemainAfterExit=yes
TimeoutStartSec=120
ExecStart=$SELF boot
# ProtectKernelTunables is left off on purpose: apply writes net.ipv6.conf.<if>.disable_ipv6.
CapabilityBoundingSet=CAP_NET_ADMIN
AmbientCapabilities=CAP_NET_ADMIN
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_NETLINK
[Install]
WantedBy=multi-user.target
EOF
    echo "ACTION==\"add\", SUBSYSTEM==\"net\", ATTR{address}==\"$mac\", TAG+=\"systemd\", ENV{SYSTEMD_WANTS}=\"zodiac-o3-nic@%k.service\"" > "$UDEV"
    printf '[keyfile]\nunmanaged-devices=mac:%s\n' "$mac" > "$NMCONF"
    systemctl daemon-reload; systemctl enable zodiac-o3-nic-boot.service >/dev/null 2>&1 || true
    udevadm control --reload; systemctl reload NetworkManager 2>/dev/null || true
    udevadm trigger --action=add --subsystem-match=net --attr-match=address="$mac" || true
    # A udev "add" does not restart a unit for a device systemd already considers active, so apply explicitly.
    iface="$(grep -il "$mac" /sys/class/net/*/address 2>/dev/null | head -n1 | cut -d/ -f5 || true)"
    if [ -n "$iface" ]; then
      systemctl restart "zodiac-o3-nic@${iface}.service" || echo "unit failed: journalctl -u zodiac-o3-nic@${iface}" >&2
      echo "interface: $iface"
    else
      echo "NIC with MAC $mac not present yet; it will be configured when it is plugged in" >&2
    fi
    echo "installed for $mac. Next: $0 verify <iface>   then   $0 selftest <iface>" ;;
  selftest)
    need_root; i="${1:?usage: selftest <iface>}"; load_env; identity_gate "$i"
    if ! { tc filter show dev "$i" egress 2>/dev/null | grep -Eq 'action.*drop' || tc qdisc show dev "$i" 2>/dev/null | grep -q 'qdisc blackhole'; }; then
      die "no egress drop in place on $i (run: $0 diag $i); refusing to send a test frame"
    fi
    [ "$(cat "/sys/class/net/$i/carrier" 2>/dev/null || echo 0)" = 1 ] || die "no carrier on $i (link down): selftest would not be meaningful; check the cable/switch port"
    before="$(dropped "$i")"
    send_frame "$i"; sleep 0.3
    after="$(dropped "$i")"
    if [ "$after" -gt "$before" ]; then
      echo "selftest ok: egress drop counter $before -> $after"
    else
      # Counter did not move: decide from the wire side. tcpdump sees outgoing frames only AFTER the qdisc.
      tmp="$(mktemp)"; timeout 4 tcpdump -i "$i" -nn -e -Q out -c 1 ether proto 0x88b5 >"$tmp" 2>&1 & tp=$!
      sleep 1; send_frame "$i"; wait "$tp" 2>/dev/null || true
      if grep -q '88b5' "$tmp"; then rm -f "$tmp"; die "test frame ESCAPED onto the wire: NIC is NOT fail-closed"; fi
      rm -f "$tmp"
      die "drop counter did not rise ($before -> $after) but the frame was not seen leaving the NIC: inconclusive (run: $0 diag $i)"
    fi ;;
  capture)
    need_root; i="${1:?usage: capture <iface> <secs> <label> [note]}"; secs="${2:?secs}"; label="${3:?label}"; note="${4:-}"
    load_env; identity_gate "$i"; nic_verify "$i"
    mkdir -p "$OUT"; ts="$(date -u +%Y%m%dT%H%M%SZ)"; f="$OUT/o3-${label}-${ts}.pcap"
    timeout "$secs" tcpdump -i "$i" -nn -e -s 0 -U -w "$f" 2>/dev/null || true
    write_meta "$f" "$i" "$label" "$note" "$secs"
    [ -n "${SUDO_USER:-}" ] && chown -R "$SUDO_USER" "$OUT" || true ;;
  capture-o2)   # O2 = the existing tap NIC on Zodiac P3; same provenance sidecar as O3
    need_root; i="${1:?usage: capture-o2 <iface> <secs> <label> [note]}"; secs="${2:?secs}"; label="${3:?label}"; note="${4:-}"
    want="${O2_MAC:-9c:69:d3:9d:d0:a6}"; have="$(cat "/sys/class/net/$i/address" 2>/dev/null || true)"
    [ "${have,,}" = "${want,,}" ] || die "$i has MAC '$have', expected the O2 tap NIC $want (set O2_MAC to override)"
    load_env; mkdir -p "$OUT"; ts="$(date -u +%Y%m%dT%H%M%SZ)"; f="$OUT/o2-${label}-${ts}.pcap"
    timeout "$secs" tcpdump -i "$i" -nn -e -s 0 -U -w "$f" 2>/dev/null || true
    VANTAGE="O2 (Zodiac P3 tap: a policy-derived copy of P1 ingress)" EGRESS_NOTE="not managed by this helper (existing tap NIC)" \
      write_meta "$f" "$i" "$label" "$note" "$secs"
    [ -n "${SUDO_USER:-}" ] && chown -R "$SUDO_USER" "$OUT" || true ;;
  ingress-test)   # does switch #2's mirror destination port accept ingress? (closes the unverified-ingress-drop risk)
    need_root; i="${1:?usage: ingress-test <iface> [--tagged]}"; mode="${2:-}"; load_env; identity_gate "$i"; nic_verify "$i"
    echo "ingress-test: lifting the egress drop for a few seconds to send test frames (experimental ethertype 0x88b6${mode:+, plus 802.1Q-tagged VID 1 and VID 2 and double-tagged (outer 0x8100 and 0x88a8) frames}); it is restored afterwards."
    restore() { nic_apply "$i" >/dev/null 2>&1 || true; }
    trap restore EXIT
    tc qdisc replace dev "$i" root pfifo_fast 2>/dev/null || tc qdisc del dev "$i" root 2>/dev/null || true
    tmp="$(mktemp)"; timeout 7 tcpdump -i "$i" -nn -e -Q in 'ether proto 0x88b6 or ether proto 0x8100 or ether proto 0x88a8' >"$tmp" 2>&1 & tp=$!
    sleep 1; for _ in 1 2 3; do send_frame_et "$i" 88b6 99 zodiac-o3-ingress-test; sleep 0.3; done
    if [ "$mode" = "--tagged" ]; then for v in 1 2; do for _ in 1 2 3; do send_tagged "$i" "$v" zodiac-o3-ingress-vlan$v; sleep 0.3; done; done
      for oet in 8100 88a8; do for _ in 1 2 3; do send_qinq "$i" "$oet" 1 2 zodiac-o3-qinq-$oet; sleep 0.3; done; done; fi
    wait "$tp" 2>/dev/null || true
    restore; trap - EXIT
    nic_verify "$i" || die "egress drop was NOT restored: unplug the NIC from switch #2 and run: $0 install <MAC>"
    if grep -q '88b6' "$tmp"; then
      echo "RESULT: tagged frame came back through the mirror: the destination port ACCEPTS ingress (injection path exists). Record this and treat O3 as NOT receive-only by proof."
    else
      echo "RESULT: tagged frame was not seen coming back through the mirror: consistent with the destination port dropping ingress (receive-only by proof for this path)."
    fi
    rm -f "$tmp" ;;
  meta)   # write the sidecar for a capture that already exists
    need_root; f="${1:?usage: meta <pcap> <iface> <label> <note> <secs>}"; i="${2:?iface}"; load_env; identity_gate "$i"
    [ -r "$f" ] || die "no such pcap: $f"
    write_meta "$f" "$i" "${3:?label}" "${4:-}" "${5:-20}"
    [ -n "${SUDO_USER:-}" ] && chown -R "$SUDO_USER" "$OUT" || true ;;
  uninstall)
    need_root; systemctl disable zodiac-o3-nic-boot.service >/dev/null 2>&1 || true
    rm -f "$UDEV" "$UNIT" "$BOOTUNIT" "$NMCONF" "$ENV_FILE" "$SELF"
    systemctl daemon-reload; udevadm control --reload; systemctl reload NetworkManager 2>/dev/null || true
    echo "removed (captures in $OUT are kept)" ;;
  *) sed -n '2,19p' "$0"; exit 2 ;;
esac
