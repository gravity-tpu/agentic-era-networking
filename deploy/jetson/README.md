# Jetson Orin Nano Super — Headless Deployment Guide

> **Controller Host Setup**: This guide provisions the NVIDIA Jetson Orin Nano Super
> as the permanent, headless SDN control-plane host. Once deployed, the Jetson runs 24/7 without
> any Mac attached. You plug in the MacBook only to push code changes or SSH debug.

---

## Hardware Wiring

```text
[ISP Gateway / Mesh Node]
          │ 100BASE-TX Ethernet
          ▼
[Zodiac FX Port 2] ◄── Gateway Uplink
[Zodiac FX Port 1] ─── Ethernet RJ-45 ───► [NETGEAR GS105Ev2 Port 5 Uplink]
                                                    ├── Port 4 ──► [Raspberry Pi 5 eth0: <workload-subnet>] (Hailo-8 26T)
                                                    ├── Port 3 ──► [Raspberry Pi 3B+ eth0: <workload-subnet>]
                                                    └── Port 2 ──► [Raspberry Pi 5 USB GbE: capture NIC, mirror of P5 verified 2026-10-07]
[Zodiac FX Port 3] ─── Ethernet RJ-45 ───► [Jetson ASIX USB GbE: enx* (Promiscuous Tap)]
[Zodiac FX Port 4] ─── Ethernet RJ-45 ───► [Jetson Onboard GbE: enP8p1s0: <ctrl-subnet> (:6633)]
[Zodiac Micro-USB] ─── USB-A Cable ──────► [Jetson /dev/ttyACM0 (Serial CDC Telemetry)]
                                           │
                                           ├──► [Google Coral Edge TPU #1 (USB 3.0: Tap DPI)]
                                           ├──► [Google Coral Edge TPU #2 (USB 3.0: DNS Sentinel)]
                                           ├──► [SSD1306 0.96" OLED (I2C Bus 7, 0x3c)]
                                           └──► [wlP1p1s0: <mgmt-subnet> (Wi-Fi Mgmt/Relay)]
```

> [!NOTE]
> Detailed private IP allocations, hardware MAC addresses, and physical port assignments are documented in the local persistent context manager ([.agents/devices.local.md](file:///Users/andymorven/git/agentic-era-networking/.agents/devices.local.md)).

**Port assignment:**

| Zodiac Port | Connected Device | Interface Identity | Assigned Network / Role | Role & Invariant |
| --- | --- | --- | --- | --- |
| **Port 1** | NETGEAR GS105Ev2 | Port 5 Uplink | Isolated Workload Subnet | **Workload Aggregation Layer**: Intermediate GbE switch aggregating RPi 5 + Hailo-8 (Port 4), RPi 3B+ (Port 3), and the RPi 5 USB-GbE capture NIC (Port 2). |
| **Port 2** | ISP Gateway / Mesh Node | RJ-45 Uplink Cable | Gateway Bridged (VLAN 100) | **Gateway Transit**: Public Internet access. |
| **Port 3** | Jetson Orin Nano Super | `enx*` (ASIX AX88179) | Promiscuous Tap (No IP) | **Hardware Mirror Tap**: Wire-speed mirror for Coral DPI. |
| **Port 4** | Jetson Orin Nano Super | `enP8p1s0` | Dedicated Control Subnet | **OpenFlow Control Channel**: Controller target `:6633`. |
| **Micro-USB** | Jetson Orin Nano Super | USB CDC (VID 03eb PID 2404) | `/dev/ttyACM0` @ 115200 | **Hardware Register Telemetry**: 1–2 Hz hardware telemetry. |

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
| --- | --- |
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

```text
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

## 7. Dual Google Coral TPUs (Phase 2A — Pre-Wired)

Both Corals are physically connected to the Jetson USB 3.0 ports (8 TOPS INT8 total compute). Phase 2A wiring is already
stubbed in [`zodiac-bridge.env.template`](zodiac-bridge.env.template). When Phase 2A begins:

1. Install PyCoral / libedgetpu runtime on the Jetson.
2. Populate `CORAL_DEVICE_PATH` and `CORAL_CONFIDENCE_THRESHOLD` in `/etc/zodiac/zodiac-bridge.env`.
3. Dedicated Model Parallelism:
   - **TPU #1 (`usb:0`)**: Zodiac Port 3 mirror tap stream feeds the Coral for on-silicon inference (<100 µs); the output tensor is not yet consumed, so this is a throughput/latency path until a trained classifier lands (ROADMAP Milestone 2C).
   - **TPU #2 (`usb:1`)**: RFC 1035 transparent DNS Sentinel evaluates FQDN semantic intent and DGA likelihood (<300 µs).
   - The Jetson Ampere TensorRT engine (67 TOPS) handles deep 1D-CNN autoencoder scoring concurrently.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `No Zodiac FX serial device found` | USB cable not connected / power off | Reconnect Micro-USB, `lsusb` to verify `Northbound Networks` VID |
| `EACCES /dev/ttyACM0` | User not in `dialout` group | `sudo usermod -aG dialout zodiac && sudo systemctl restart zodiac-bridge` |
| `Connection refused :6633` | OpenFlow controller not bound | Check `journalctl -u zodiac-bridge` for bind errors; verify port not in use |
| `HTTP 401 from Vercel relay` | `ZODIAC_BRIDGE_SECRET` mismatch | Verify secret matches `ZODIAC_BRIDGE_SECRET` in Vercel environment variables |
| Service not restarting after crash | `StartLimitBurst` hit | `sudo systemctl reset-failed zodiac-bridge && sudo systemctl start zodiac-bridge` |
