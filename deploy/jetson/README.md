# Jetson Orin Nano Super — Headless Deployment Guide

> **Autonomous Master Appliance Setup**: This guide provisions the NVIDIA Jetson Orin Nano Super
> as the permanent, headless SDN control-plane host. Once deployed, the Jetson runs 24/7 without
> any Mac attached. You plug in the MacBook only to push code changes or SSH debug.

---

## Hardware Wiring

```
[ISP Gateway / Mesh Node]
          │ 100BASE-TX Ethernet
          ▼
[Zodiac FX — Port 2]  ←→  [Port 4] ── Ethernet ──► [Jetson Orin Nano Super]
                                                          │
[Zodiac FX Micro-USB] ──────────────────────────────────►│ /dev/ttyACM0 (Serial CDC-ACM)
                                                          │
                                              [Google Coral USB 3.0]
                                              (plugged into Jetson USB-A)
```

**Port assignment:**

| Zodiac Port | Role | Cable |
|---|---|---|
| Port 1 | Test Agent / Workload Subnet | Ethernet (future) |
| Port 2 | ISP Gateway Uplink | Ethernet |
| Port 3 | Hardware Mirror Tap (DPI / Coral ingestion) | Loopback / Span |
| Port 4 | OpenFlow Controller Channel → Jetson | Ethernet |
| Micro-USB | Serial CDC-ACM management (115200 8N1) | USB-A → Jetson |

---

## 1. Prerequisites

On the Jetson (JetPack 6.x, Ubuntu 22.04 ARM64):

```bash
# Install Node.js 20 LTS via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify
node --version   # v20.x.x
npm --version    # 10.x.x

# Add your user to the dialout group for /dev/ttyACM0 access
sudo usermod -aG dialout $USER
# (Re-login or run: newgrp dialout)
```

---

## 2. Clone & Build

```bash
# Create a dedicated service user
sudo useradd -r -m -s /bin/bash zodiac

# Clone the repository
sudo -u zodiac git clone https://github.com/gravity-tpu/agentic-era-networking \
  /home/zodiac/agentic-era-networking

cd /home/zodiac/agentic-era-networking

# Install production dependencies only
sudo -u zodiac npm ci --omit=dev

# Compile TypeScript
sudo -u zodiac npm run build

# Verify bridge binary exists
ls -lh dist/sdn/zodiac-bridge-server.js
```

---

## 3. Configure Secrets

```bash
# Create secrets directory
sudo mkdir -p /etc/zodiac
sudo chown zodiac:zodiac /etc/zodiac
sudo chmod 700 /etc/zodiac

# Copy and populate the env template
sudo cp deploy/jetson/zodiac-bridge.env.template /etc/zodiac/zodiac-bridge.env
sudo chmod 600 /etc/zodiac/zodiac-bridge.env
sudo chown zodiac:zodiac /etc/zodiac/zodiac-bridge.env

# Edit secrets (replace all <REPLACE_ME> values)
sudo nano /etc/zodiac/zodiac-bridge.env
```

Required values to fill in:

| Variable | Where to get it |
|---|---|
| `ZODIAC_BRIDGE_SECRET` | Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `DATABASE_URL` | Neon Console → Project → Connection String (pooled) |
| `GOOGLE_CLIENT_ID` | Google Cloud Console → OAuth 2.0 Client IDs |
| `GOOGLE_CLIENT_SECRET` | Google Cloud Console → OAuth 2.0 Client IDs |
| `SESSION_SECRET` | Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

---

## 4. Install & Enable systemd Unit

```bash
# Install the service unit
sudo cp deploy/jetson/zodiac-bridge.service /etc/systemd/system/

# Reload systemd, enable on boot, start now
sudo systemctl daemon-reload
sudo systemctl enable --now zodiac-bridge

# Verify it's running
sudo systemctl status zodiac-bridge

# Tail live logs
journalctl -u zodiac-bridge -f
```

Expected log output when healthy:
```
zodiac-bridge[1234]: [ZodiacBridgeServer] Listening on :3003
zodiac-bridge[1234]: [OpenFlowServer] Controller listening on :6633
zodiac-bridge[1234]: [Relay] Pushed live snapshot → Vercel (HTTP 200, 87ms)
```

---

## 5. Verify End-to-End

```bash
# From the Jetson — confirm local telemetry endpoint
curl -s http://localhost:3003/api/zodiac | python3 -m json.tool | head -20

# From any browser / your Mac — confirm Vercel is receiving live hardware data
curl -s https://agentic-era-networking.vercel.app/api/zodiac | python3 -m json.tool | grep '"source"'
# Expected: "source": "live_hardware"
```

---

## 6. Updating the Firmware (Mac SSH Workflow)

```bash
# From MacBook (connect via WiFi to the same LAN, or direct Ethernet)
ssh zodiac@<JETSON_LAN_IP>

# Pull latest changes and rebuild
cd /home/zodiac/agentic-era-networking
git pull origin main
npm ci --omit=dev
npm run build

# Restart the daemon with zero-downtime intent
sudo systemctl restart zodiac-bridge
journalctl -u zodiac-bridge -f
```

---

## 7. Google Coral TPU (Phase 2A — Not Yet Active)

The Coral is physically connected to the Jetson USB 3.0 port. Phase 2A wiring is already
stubbed in [`zodiac-bridge.env.template`](zodiac-bridge.env.template). When Phase 2A begins:

1. Install PyCoral / libedgetpu runtime on the Jetson.
2. Populate `CORAL_DEVICE_PATH` and `CORAL_CONFIDENCE_THRESHOLD` in `/etc/zodiac/zodiac-bridge.env`.
3. The Zodiac Port 3 mirror tap stream feeds the Coral for sub-millisecond shallow classification;
   the Jetson TensorRT GPU handles deep anomaly models concurrently.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `No Zodiac FX serial device found` | USB cable not connected / power off | Reconnect Micro-USB, `lsusb` to verify `Northbound Networks` VID |
| `EACCES /dev/ttyACM0` | User not in `dialout` group | `sudo usermod -aG dialout zodiac && sudo systemctl restart zodiac-bridge` |
| `Connection refused :6633` | OpenFlow controller not bound | Check `journalctl -u zodiac-bridge` for bind errors; verify port not in use |
| `HTTP 401 from Vercel relay` | `ZODIAC_BRIDGE_SECRET` mismatch | Verify secret matches `ZODIAC_BRIDGE_SECRET` in Vercel environment variables |
| Service not restarting after crash | `StartLimitBurst` hit | `sudo systemctl reset-failed zodiac-bridge && sudo systemctl start zodiac-bridge` |
