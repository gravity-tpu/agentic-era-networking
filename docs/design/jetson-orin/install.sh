#!/usr/bin/env bash
# ==============================================================================
# Jetson Orin Nano Super — Roboco Panini Case OLED Telemetry Setup Script
# Installs dependencies, sets permissions, and enables systemd auto-start daemon
# ==============================================================================
set -euo pipefail

TARGET_USER="zodiac"
TARGET_HOME="/home/${TARGET_USER}"
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== [1/5] Installing APT Hardware & Python Dependencies ==="
sudo apt update -y
sudo apt install -y \
    i2c-tools \
    python3-smbus \
    python3-pil \
    python3-psutil \
    python3-pip \
    fonts-dejavu-core

echo "=== [2/5] Installing Adafruit CircuitPython SSD1306 ==="
sudo -u "${TARGET_USER}" pip3 install --no-cache-dir adafruit-circuitpython-ssd1306 netifaces

echo "=== [3/5] Configuring I2C Bus Permissions ==="
sudo usermod -aG i2c "${TARGET_USER}" || true

echo "=== [4/5] Deploying Daemon & Systemd Unit ==="
cp "${INSTALL_DIR}/oled_sysinfo.py" "${TARGET_HOME}/oled_sysinfo.py"
chown "${TARGET_USER}:${TARGET_USER}" "${TARGET_HOME}/oled_sysinfo.py"
chmod +x "${TARGET_HOME}/oled_sysinfo.py"

sudo cp "${INSTALL_DIR}/oled.service" /etc/systemd/system/oled.service
sudo systemctl daemon-reload
sudo systemctl enable oled.service
sudo systemctl restart oled.service

echo "=== [5/5] Verifying Service Status ==="
sleep 2
if systemctl is-active --quiet oled.service; then
    echo "✓ oled.service is ACTIVE and running!"
    sudo systemctl status oled.service --no-pager
else
    echo "✗ oled.service failed to start. Inspecting journal:"
    sudo journalctl -u oled.service -n 25 --no-pager
    exit 1
fi

echo "=============================================================================="
echo "OLED Telemetry Daemon installation complete! Display is cycling every 15s."
echo "=============================================================================="
