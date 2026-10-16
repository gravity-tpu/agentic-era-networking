# Jetson Orin Nano Super — Headless Deployment Guide

> **Controller Host Setup**: This guide provisions the NVIDIA Jetson Orin Nano Super
> as the permanent, headless SDN control-plane host. Once deployed, the Jetson runs 24/7 without
> any Mac attached. You plug in the MacBook only to push code changes or SSH debug.

---

## Hardware Wiring

```text
[ISP Gateway / Mesh Node]
          │ Ethernet
          ▼
[NETGEAR GS105Ev2 #2 Port 5]   (uplink switch; installed 2026-10-09; its P4 mirrors to P3 = O3 capture NIC; P1-P2 free)
[NETGEAR GS105Ev2 #2 Port 4]
          │ 100BASE-TX Ethernet
          ▼
[Zodiac FX Port 2] ◄── Gateway Uplink
[Zodiac FX Port 1] ─── Ethernet RJ-45 ───► [NETGEAR GS105Ev2 Port 5 Uplink]
                                                    ├── Port 4 ──► [Raspberry Pi 5 eth0: <workload-subnet>] (Hailo-8 26T)
                                                    ├── Port 3 ──► [Raspberry Pi 3B+ agentic-node-01 eth0: <workload-subnet>]
                                                    ├── Port 1 ──► [Raspberry Pi 3B+ agentic-node-02 eth0: <workload-subnet>]
                                                    └── Port 2 ──► [Raspberry Pi 5 USB GbE: capture NIC, mirror of P5 verified 2026-10-07]
[Zodiac FX Port 3] ─── Ethernet RJ-45 ───► [Jetson ASIX USB GbE: enx* (Promiscuous Tap)]
[Zodiac FX Port 4] ─── Ethernet RJ-45 ───► [Jetson Onboard GbE: enP8p1s0: <ctrl-subnet> (:6633)]
[Zodiac Micro-USB] ─── USB-A Cable ──────► [Jetson /dev/ttyACM0 (Serial CDC Telemetry)]
                                           │
                                           ├──► [O3 capture NIC enx9c69d39ddcc0 (USB 3.0, cabled to switch #2 Port 3)]
                                           ├──► (Coral Edge TPUs removed 2026-10-11)
                                           ├──► [SSD1306 0.96" OLED (I2C Bus 7, 0x3c)]
                                           └──► [wlP1p1s0: <mgmt-subnet> (Wi-Fi Mgmt/Relay)]
```

> [!NOTE]
> Detailed private IP allocations, hardware MAC addresses, and physical port assignments are documented in the local persistent context manager ([.agents/devices.local.md](file:///Users/andymorven/git/agentic-era-networking/.agents/devices.local.md)).

**Port assignment:**

| Zodiac Port | Connected Device | Interface Identity | Assigned Network / Role | Role & Invariant |
| --- | --- | --- | --- | --- |
| **Port 1** | NETGEAR GS105Ev2 | Port 5 Uplink | Isolated Workload Subnet | **Workload Aggregation Layer**: Intermediate GbE switch aggregating RPi 5 + Hailo-8 (Port 4), RPi 3B+ (Port 3), and the RPi 5 USB-GbE capture NIC (Port 2). |
| **Port 2** | NETGEAR GS105Ev2 #2 (port 4); the ISP Gateway / Mesh Node is on its port 5 | RJ-45 Uplink Cable | Gateway Bridged (VLAN 100) | **Gateway Transit**: Public Internet access through the uplink switch. |
| **Port 3** | Jetson Orin Nano Super | `enx*` (ASIX AX88179) | Promiscuous Tap (No IP) | **Hardware Mirror Tap (O2)**: Wire-speed mirror for the Jetson capture; the detector runs on the Jetson GPU. |
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

### Flow-table probe (read-only)

Asks the live Zodiac FX what is in its flow table and keeps the raw bytes. Its job is to answer one question that is
currently unmeasured: **does firmware 0.86 include the instruction block (the output actions) in flow-stats
entries?** Until that is known, action-level readback (`actions.status` in the isolation readback) cannot be said to
prove forwarding intent on this hardware. See [docs/ROADMAP.md](../../docs/ROADMAP.md), track A.

The probe sends **one OFPMP_FLOW request and no FlowMod**. It does not change the switch.

1. Deploy the bridge build that contains the endpoint (the update steps above, with `npm ci` and
   `npm run build:server`, not `--omit=dev`, which cannot build). **Before starting or restarting the unit, check
   for a stray controller: `ss -ltnp | grep -E ':6633|:3003'`.** A hand-started bridge holds the ports. The unit's
   new instance then cannot bind 6633 and **exits with an error** (the unit shows `failed`, and systemd retries every
   5 s until the port is free), while the old one keeps the switch. Before 2026-10-15 it instead logged
   DEGRADED_FAULT and stayed `active`, which hid a stray controller for about 30 hours. For development only,
   `ZODIAC_ALLOW_DEGRADED_CONTROL_PLANE=1` restores that degraded mode.
   The restart drops the OpenFlow session and the bridge reinstalls the isolation policy on reconnect; until it
   does, the switch holds only table-miss DROP, so the workload is isolated, not exposed.
2. Wait for `Isolation readback VERIFIED` in `journalctl -u zodiac-bridge`. After that the bridge re-reads the table every 60 s (`ZODIAC_ISOLATION_RECHECK_INTERVAL_MS`) and logs `Isolation re-check:` only when something changes; the probe and the re-check never query the switch at the same time. Probing mid-install shows a partial table. The line now says whether forwarding is proven: `...; actions confirmed (output ports and table-miss drop).` is the healthy one, and `...MATCH LEVEL ONLY...` means the switch reported no actions. The same facts are in `curl -s http://127.0.0.1:3003/api/zodiac/flows` under `port1Isolation` (`state`, `actions.status`, `provenForwarding`, and `checkedAgeMs` with `ageStatus` (`ok`, `never_checked`, or `clock_error`): the readback runs once at install, so a `verified` is only as current as its age).
3. Run the client on the Jetson itself, where the bridge sees a loopback caller (no tunnel needed), then copy the
   evidence back. The endpoint accepts operators on loopback or private IPv4 only, so a direct Tailscale (`100.x`)
   connection from the Mac is refused with 401. It also refuses everything if `GOOGLE_CLIENT_ID` is set.

   ```bash
   ssh jetson
   cd ~/agentic-era-networking
   node --experimental-strip-types scripts/zodiac-flow-probe.ts --out ~/flow-probe-evidence --firmware 0.86
   # then, from the Mac:
   scp 'jetson:flow-probe-evidence/*' docs/benchmarks/results/flow-probe/
   ```

   From the Mac instead: `ssh -N -L 3003:127.0.0.1:3003 jetson &`, `npm run build`, `npm run probe:flows`.

   The first run (2026-10-15) found `reports-instructions`: see `docs/benchmarks/results/flow-probe/`.

4. Read the `finding` it prints:

   | Finding | Meaning |
   | :--- | :--- |
   | `reports-instructions` | The firmware reports actions. Check `action level`: `confirmed` means the readback matches the policy; `mismatch` lists what differs. |
   | `no-instructions-reported` | The firmware omits them (or every rule is a drop). Action-level readback stays `unobservable`; forwarding is proven only on the wire (O1, O3 captures). |
   | `unreadable-instructions` | It sends something the parser cannot read. The entry hex is in the report; extend `src/sdn/flow-actions.ts`. |
   | `no-entries` | The switch reported an empty table: the policy is not installed. |

The report and a `.meta.json` sidecar (origin `physical_readback`, hashes, tool commit) are saved to
`docs/benchmarks/results/flow-probe/`. Before saving, the script rebuilds the summary from the raw bytes and refuses
(exit 3) if the bridge's summary disagrees with them. `--analyze <file>` re-derives a saved report offline. The raw
reply bytes can later be turned into a parser test fixture, replacing the hand-built ones.

Limits: one request per `ZODIAC_FLOW_PROBE_MIN_INTERVAL_MS` (default 5000, bounded 1000 to 3600000), one at a time.

---

## 7. Dual Google Coral TPUs (historical: removed 2026-10-11)

> **Update 2026-10-11:** both Corals were physically removed from the Jetson and `zodiac-coral.service` is disabled. This section is kept as history.

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
