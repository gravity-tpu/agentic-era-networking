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
[NETGEAR GS105Ev2 #2 Port 5]   (uplink switch; installed 2026-10-09; its P4 mirrors to P3 = O3 capture NIC; P1, P2 = wired management to agentic-node-01, -02)
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
> Private IP allocations and hardware MAC addresses are kept in a local, gitignored file (`.agents/devices.local.md`) and are not in this repository; use your own addressing (the `<...-subnet>` placeholders above). The topology, VLAN matrix, port assignments and the isolation policy are in [`.agents/network-context.md`](../../.agents/network-context.md), and the switch VLAN configuration is part of what the experiments depend on, not an optional detail.

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
# Install Node.js 22 via NodeSource (matches .nvmrc and package.json "engines")
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify
node --version   # v22.x.x
npm --version

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

### Only one bridge may push to production

The cloud dashboard shows whatever the bridge pushes. A second bridge started anywhere (a laptop running `npm run serve`
or `npm run dev` with `ZODIAC_CLOUD_RELAY_URL` set) has no hardware and pushes a `disconnected` view; before 2026-10-16 the
cloud let the last writer win, which made every device flicker. The cloud now ignores a non-live push while a live one is
fresh, and logs `[Relay] Ignored N non-live push(es) from bridge <id>` (visible with `npx vercel logs <domain>`), and a bridge
that is ignored logs `[Cloud Relay] The cloud IGNORED this bridge's snapshot` and pauses 60 s. To check for a stray pusher:
`npx vercel logs agentic-era-networking.vercel.app --json` for about a minute and look at the POST inter-arrival times. One
bridge shows one steady interval (about 5 s from the Jetson); intervals under a second or two mean another pusher. Do not
set `ZODIAC_CLOUD_RELAY_URL` in a development shell.

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

## 8. What is in this directory

Contents reflect what was running on the Jetson on 2026-11-07, exported from the live host. Paths on the right are install locations.

| File | Status | Install to / purpose |
| --- | --- | --- |
| `zodiac-bridge.service`, `zodiac-bridge.env.template` | Current | `/etc/systemd/system/`, `/etc/zodiac/zodiac-bridge.env` (sections 2 to 5). |
| `zodiac-bridge.service.d/workstation-wifi.conf.example` | Optional | Drop-in that points the bridge at an operator workstation agent. Copy without `.example`, edit the address. |
| `zodiac-isolation-watch.service`, `isolation-watch.env.example` | Current | Pushes isolation problems to ntfy; see [`docs/design/isolation-watch.md`](../../docs/design/isolation-watch.md). |
| `zodiac-trt.service` | Current | TensorRT wire-tap inference daemon (needs a TensorRT engine you build: `scripts/build-trt-engine.py`). Runs from `trt-venv`. |
| `gpu-sdn-sentinel.service` | Installed, disabled | GPU anomaly sentinel (`scripts/gpu-sdn-anomaly-sentinel.py`). Runs from `coral-venv`. |
| `zodiac-o3-nic.sh`, `zodiac-o3-nic-boot.service`, `zodiac-o3-nic@.service`, `99-zodiac-o3-nic.rules` | Current | O3 capture NIC: `/usr/local/sbin/`, `/etc/systemd/system/`, `/etc/udev/rules.d/`. Edit the MAC in the udev rule and in the helper for your NIC. Runbook: [`o3-nic-runbook.md`](o3-nic-runbook.md). |
| `oled.service`, `oled_sysinfo.py` | Optional | SSD1306 status display (I2C bus 7, 0x3c). Script goes in `/home/zodiac/`. |
| `sysctl.d/99-tailscale.conf`, `sysctl.d/99-jetson-ai-memory.conf` | Current | `/etc/sysctl.d/` (IP forwarding for the Tailscale subnet router; memory tuning). |
| `modprobe.d/openvswitch.conf` | Optional | `/etc/modprobe.d/`; see the Open vSwitch note below. |
| `requirements/` | Reference | What pip installed into `trt-venv` (Python 3.10), the one package the sentinel needs (`sentinel-venv.txt`), and the user site used by `oled.service`. OS packages (apt) and the retired Coral stack are deliberately not pinned here; see "Security notes". |
| `backup/` | Current (timer disabled) | Encrypted restic backup and restore drill; see [`backup/README.md`](backup/README.md). |
| `zodiac-coral.service`, `99-coral-usb-power.rules` | Historical | For the Coral Edge TPUs, removed 2026-10-11. Do not install unless you have Corals. |

### Host network configuration (NetworkManager)

| Interface | Profile | Settings |
| --- | --- | --- |
| `enP8p1s0` (onboard) | `Zodiac-OpenFlow` | IPv4 manual `10.0.1.8/24`, never-default. Controller channel to Zodiac P4 (`:6633`). |
| `wlP1p1s0` (Wi-Fi) | `Internet` | DHCP; management and cloud relay. |
| `enx...` (O2 tap, Zodiac P3) | per-NIC profile | Must carry no address in service: it is a promiscuous tap. The live interface had none on 2026-11-07, although a stored NetworkManager profile for it lists a manual `10.0.1.200/24` (never-default); treat the stored profile as stale and verify with `ip -br addr`. |
| O3 NIC (switch #2 P3) | none | Managed by `zodiac-o3-nic*`, not NetworkManager. |

Tailscale 1.104.4 is installed; the Jetson offers an exit node and, per `network-context.md`, advertises the lab and control subnets as a subnet router. The exact `tailscale up` flags were not captured; the live preferences could not be read without root.

### Security notes (2026-11-11)

The first export listed a full `pip freeze` of `trt-venv`, which is created with `--system-site-packages`, so it included Ubuntu 22.04's own Python packages (for example cryptography 3.4.8, Pillow 9.0.1, urllib3 1.26.5, PyJWT 2.3.0, requests 2.25.1) as if they were pip dependencies, and GitHub raised 166 advisories against them. The requirements files now list only what pip installed into each venv, which has no known advisory in the OSV database (checked 2026-11-11). What that leaves on the device:

- **OS Python packages (apt).** They are Ubuntu builds, which carry security fixes backported without changing the upstream version number, so a version-based advisory overstates the exposure; this was not checked CVE by CVE. Keep them current with `sudo apt update && sudo apt upgrade`. On 2026-11-11 one security update was pending (`python3-pil` 9.0.1-1ubuntu0.5 to 0.6, used by `oled.service`); it was not applied.
- **Pillow in `coral-venv`.** Pillow 11.3.0 is pip-installed there (Python 3.9), pulled in by `pycoral`. The patched Pillow (13.0.0) needs Python 3.11 or newer, so it cannot be installed in that venv. None of the services that run from it (the sentinel, the retired Coral daemon) imports Pillow. The exposure is closed by retiring the Coral stack or uninstalling Pillow from that venv; neither was done on the device.

### Things this export did not capture

- **Open vSwitch `br-sim`** (optional, software reference evaluation). JetPack 6.1's kernel has no `openvswitch.ko`, so the project runs OVS in userspace (`datapath_type: netdev`) with the `modprobe.d` file above, bound to `tcp:127.0.0.1:6634` and pinned to OpenFlow 1.3 (caveat 9 in [`.agents/network-context.md`](../../.agents/network-context.md)). The bridge definition lives in the OVS database, which needed root to read; no creation script is published.
- **Secrets and private addressing:** `/etc/zodiac/*.env` and similar are deliberately excluded.
- **Model binaries:** TensorRT engines, Coral models and Hailo HEFs.
- **Ollama:** installed on the host but stopped and unpopulated; the project runs no local LLM on the Jetson.
- **JetPack power mode:** `nvpmodel` reported 15W; no setting is captured here.
- Scratch and one-off files in the home directory (logs, screenshots, `stage-a10-uplink.sh`, a CUDA test) were left out.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `No Zodiac FX serial device found` | USB cable not connected / power off | Reconnect Micro-USB, `lsusb` to verify `Northbound Networks` VID |
| `EACCES /dev/ttyACM0` | User not in `dialout` group | `sudo usermod -aG dialout zodiac && sudo systemctl restart zodiac-bridge` |
| `Connection refused :6633` | OpenFlow controller not bound | Check `journalctl -u zodiac-bridge` for bind errors; verify port not in use |
| `HTTP 401 from Vercel relay` | `ZODIAC_BRIDGE_SECRET` mismatch | Verify secret matches `ZODIAC_BRIDGE_SECRET` in Vercel environment variables |
| Service not restarting after crash | `StartLimitBurst` hit | `sudo systemctl reset-failed zodiac-bridge && sudo systemctl start zodiac-bridge` |

## Recovering a switch whose controller session is dead

Symptom (2026-10-17 and 2026-10-18, three times): the bridge logs `Dead peer detected (10.0.1.99): no OFPT_ECHO_REPLY`,
`/api/zodiac` shows `openflow.status: Disconnected`, `port1Isolation` goes to `readback_failed`, ARP for `10.0.1.99` from the
Jetson fails, and traffic through the Zodiac stops (its flow table is empty and failstate is Secure). The switch's firmware is
still running: its serial-reported uptime keeps advancing.

Read its own state, then restart it, from the Jetson (the switch's USB port is on it):

```sh
python3 scripts/zodiac-serial-console.py              # diagnostics only: status, config, OpenFlow status, ports
python3 scripts/zodiac-serial-console.py --restart    # the same diagnostics first, then `restart`
```

What the console showed during the 2026-10-18 drop, before the restart: configuration correct (`10.0.1.99/24`, controller
`10.0.1.8:6633`, OpenFlow enabled, failstate Secure), OpenFlow status `Disconnected` with 0 flows and 0 lookups, ports 1 to 4
up, uptime 12 h 55 min. After `restart`: the serial port dropped as the device reset, uptime counted from 0, OpenFlow
`Connected` within 30 s, the bridge reinstalled the isolation policy (6 of 6 rules and their actions read back verified,
7 entries), `10.0.1.99` answered ARP and ping, and pings across the rack passed. No power cycle was needed.

**How far to trust this:** it worked once, on one of three drops (the first two were cleared by a power cycle), so it is a
recovery that has been seen to work, not a tested procedure. It clears the state; it does not explain or prevent the drops.
If the serial console does not answer at all (`--diagnostics` shows nothing, or the device node is missing), fall back to a
power cycle.

Run it as the `zodiac` user (the user the bridge runs as; `--restart` refuses from any other user, because its check for other
openers of the port can only see processes of its own user).

The tool's safeguards are best effort, not a guarantee: it opens the port exclusively and `--restart` waits for other
openers to let go and looks once more just before sending, but it can only see processes of its own user (a process of
another user, root for instance, is invisible to it), and the bridge opens the port to poll, so a poll can still collide with
the diagnostics (garbled or lagging replies). Read the diagnostics with that in mind, and do not restart while something
else is known to be working with the switch's serial console.

After any restart, confirm `curl localhost:3003/api/zodiac/flows` shows `port1Isolation` `verified` before sending traffic
(the labelled-run harness refuses to start otherwise). The cause of the drops is unknown.
