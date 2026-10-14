#!/usr/bin/env bash
# zodiac-backup-inventory.sh -- READ-ONLY survey of what the backup would cover on this machine.
# Changes nothing. Run it on the Jetson before the first backup, and compare with the candidate list in
# zodiac-backup.sh: anything important that is not listed here or there is a gap in the backup scope.
#   sudo ./zodiac-backup-inventory.sh
set -uo pipefail
export PATH="/usr/local/sbin:/usr/sbin:/sbin:${PATH}"
echo "== tools"; for t in restic rclone ovs-vsctl ovsdb-client ollama tailscale tcpdump ethtool tc; do printf '  %-12s %s\n' "$t" "$(command -v $t || echo missing)"; done
echo "== candidate paths (size, present or not)"
for p in /etc/zodiac /var/lib/zodiac /var/lib/zodiac/history /var/lib/zodiac/o3-captures /etc/openvswitch /etc/modprobe.d/openvswitch.conf \
         /etc/default/zodiac-o3-nic /etc/netplan /etc/ssh/sshd_config.d /etc/sudoers.d /etc/pam.d/sudo /etc/Yubico /home/zodiac/.ssh/authorized_keys; do
  if [ -e "$p" ]; then printf '  %-45s %s\n' "$p" "$(du -sh "$p" 2>/dev/null | cut -f1)"; else printf '  %-45s %s\n' "$p" "(absent)"; fi
done
for g in '/etc/systemd/system/zodiac-*' '/etc/systemd/system/hailo-*' '/etc/udev/rules.d/99-*' '/etc/NetworkManager/conf.d/99-*' '/usr/local/sbin/zodiac-*' '/etc/sysctl.d/99-*'; do
  for f in $g; do [ -e "$f" ] && printf '  %-45s %s\n' "$f" "$(du -sh "$f" | cut -f1)"; done
done
echo "== things deliberately NOT backed up (rebuildable): sizes"
for p in /usr/share/ollama /home/zodiac/.ollama /home/zodiac/agentic-era-networking /var/lib/tailscale; do [ -e "$p" ] && printf '  %-45s %s\n' "$p" "$(du -sh "$p" 2>/dev/null | cut -f1)"; done
for v in /home/zodiac/*-venv; do [ -d "$v" ] && printf '  %-45s %s\n' "$v" "$(du -sh "$v" | cut -f1)"; done
echo "== Open vSwitch"; ovs-vsctl show 2>&1 | head -15
echo "== listening services (so you can spot state you forgot about)"; ss -ltnp 2>/dev/null | awk 'NR==1||/LISTEN/' | head -20
echo "== zodiac-related units"; systemctl list-units 'zodiac-*' 'hailo-*' 'openvswitch*' 'tailscaled*' --all --no-pager --no-legend 2>/dev/null | head -20
echo "== disk"; df -h / /var 2>/dev/null
