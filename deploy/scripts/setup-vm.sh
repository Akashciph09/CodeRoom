#!/usr/bin/env bash
# One-time preparation of a fresh Ubuntu 24.04 VM for CodeRoom (deploy/README.md, step 3).
#   sudo bash deploy/scripts/setup-vm.sh
# Safe to run again: every step checks whether it's already done.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo." >&2; exit 1; }
user=${SUDO_USER:-$(logname 2>/dev/null || echo root)}

echo "== Docker"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
usermod -aG docker "$user"
systemctl enable --now docker >/dev/null

echo "== Swap (2 GB): a 1 GB VM needs it for Postgres + Node + a sandbox at once"
if ! swapon --show=NAME --noheadings | grep -q '^/swapfile$'; then
  [ -f /swapfile ] || { fallocate -l 2G /swapfile; chmod 600 /swapfile; mkswap /swapfile >/dev/null; }
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
# Prefer RAM; swap is the safety net, not working memory.
echo 'vm.swappiness=10' > /etc/sysctl.d/90-coderoom.conf
sysctl -q --system

echo "== Automatic security updates, with a reboot at 04:00 when one needs it (containers restart themselves)"
apt-get install -yq unattended-upgrades >/dev/null
printf 'Unattended-Upgrade::Automatic-Reboot "true";\nUnattended-Upgrade::Automatic-Reboot-Time "04:00";\n' \
  > /etc/apt/apt.conf.d/52coderoom-reboot

echo "== Directory for submitted code (mounted read-only into each sandbox)"
install -d -m 0755 /var/lib/coderoom/runs

echo
free -h
echo
echo "Done. Log out and back in (so '$user' can use docker), then run deploy/scripts/gen-secrets.sh."
