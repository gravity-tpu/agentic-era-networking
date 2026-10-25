# Jetson Orin Nano Super & Roboco Panini Case Architecture

> **Hardware Specification, Assembly Guide & 6-Screen OLED Telemetry Daemon**  
> **Substrates:** NVIDIA Jetson Orin Nano Super Developer Kit (67 TOPS Ampere Architecture) + Roboco Panini Case + 0.96" I2C OLED (SSD1306) + Raspberry Pi 5 (`rpi-hailo`) with 26 TOPS Hailo-8 NPU + Dual Raspberry Pi 3B+ Adversarial SDN Nodes  
> **Governing invariants:** latency budgets, fail-closed simplicity and provenance (Invariant 6); see [AGENTS.md](../../../AGENTS.md).

---

## 1. Executive Summary

The **controller host** operates 24/7 as the centralized edge orchestrator for the `gravity-tpu/agentic-era-networking` infrastructure. Housed within the machined aluminum **Roboco Panini Chassis**, it consolidates:

- Real-time OpenFlow 1.3 control over the Northbound Networks Zodiac FX switch.
- Transparent RFC 1035 DNS resolution and agent anomaly isolation.
- Integration with Raspberry Pi 5 (`rpi-hailo`) hosting 26 TOPS Hailo-8 M.2 NPU neural inference acceleration.
- Telemetry aggregation from dual Raspberry Pi 3B+ nodes (`agentic-node-01`, `agentic-node-02`) generating adversarial workloads.
- Physical OLED front-panel hardware diagnostics and network telemetry.

This document details the physical wiring pinouts, button jumper configurations, I2C bus mappings, and the production-grade 6-screen rotational telemetry daemon.

---

## 2. Physical Wiring & Pinout Specification

### 2.1 4-Pin I2C OLED Display Wiring

The front bezel houses a 0.96" 128x64 monochrome OLED module based on the SSD1306 controller. Looking directly at the display header pins from left to right (with the cooling fan toward you and rear I/O ports facing away):

```text
                     0.96" I2C OLED Display Header
                      ┌─────┬─────┬─────┬─────┐
                      │ GND │ VCC │ SCL │ SDA │
                      └──┬──┴──┬──┴──┬──┴──┬──┘
                         │     │     │     │
          Wire Colors:  BLACK RED  GREEN WHITE
                         │     │     │     │
                         v     v     v     v
    Jetson 40-Pin GPIO: Pin 6 Pin 1 Pin 5 Pin 3
                        (GND) (3.3V)(SCL1)(SDA1)
```

#### Pin Mapping Table

| OLED Pin | Cable Color | Signal Function | Jetson 40-Pin Header | Header Function |
| :--- | :--- | :--- | :--- | :--- |
| **GND** | **Black** | Ground | **Pin 6** | `GND` |
| **VCC** | **Red** | 3.3V DC Power | **Pin 1** | `3.3V PWR` |
| **SCL** | **Green** | I2C Clock | **Pin 5** | `I2C1_SCL` (Bus 7) |
| **SDA** | **White** | I2C Data | **Pin 3** | `I2C1_SDA` (Bus 7) |

> [!CAUTION]
> Connect VCC exclusively to **Pin 1 (3.3V)**. Never connect the OLED VCC to the 5V rail (Pins 2 or 4), as this will permanently damage the SSD1306 level-shifting circuitry on 3.3V logic lines.

---

### 2.2 12-Pin Front Panel Button Header & 2-Pin Jumper

The Jetson Orin carrier board features a 12-pin button header (`J14`) adjacent to the M.2 Key-E slot.

```text
       Jetson 12-Pin Front Panel Header (J14)
                   Pin 2  4  6  8 10 12
                   ┌──┬──┬──┬──┬──┬──┐
                   │  │  │■ │  │  │  │
                   ├──┼──┼──┼──┼──┼──┤
                   │  │  │■ │  │  │  │
                   └──┴──┴──┴──┴──┴──┘
                   Pin 1  3  5  7  9 11
                             ▲  ▲
                             └──┴── 2-Pin Jumper Bridges Pin 5 & Pin 6
```

#### Jumper Function & Behavioral Rule

- **Pin 5 (`DIS`) & Pin 6 (`AUTO ON`)**: Bridging Pins 5 and 6 disables the factory hardware auto-power-on mode.
- **Why this is mandatory**: In factory configuration, the Jetson powers on automatically the moment DC power is attached, bypassing the front panel power switch. Bridging Pins 5 and 6 transfers power-on signaling to the front-panel momentary switch (Pins 1 and 2), allowing safe power cycles and graceful hardware shutdowns.

---

## 3. I2C Bus Architecture & Discovery

On the NVIDIA Jetson Orin Nano Super running Linux Kernel 5.15 (Tegra), the 40-pin expansion header I2C pins (Pins 3 and 5) map to hardware bus controller `c250000.i2c`:

- **Operating System Node**: `/dev/i2c-7` (Bus 7)
- **CircuitPython / Blinka Alias**: `board.SCL` and `board.SDA`
- **I2C Device Address**: `0x3c` (7-bit slave address)

### Hardware Verification

Run `i2cdetect` to verify the display is acknowledged on the bus:

```bash
zodiac@jetson-orin:~$ sudo i2cdetect -y -r 7
     0  1  2  3  4  5  6  7  8  9  a  b  c  d  e  f
00:                         -- -- -- -- -- -- -- -- 
10: -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- 
20: -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- 
30: -- -- -- -- -- -- -- -- -- -- -- -- 3c -- -- -- 
40: -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- 
50: -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- 
60: -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- 
70: -- -- -- -- -- -- -- --                         
```

The presence of `3c` confirms proper electrical continuity and clock arbitration.

---

## 4. The 6-Screen Rotational Telemetry Architecture

The OLED daemon cycles across 6 purpose-built screens every 15 seconds (90-second full cycle). Each screen features an **inverted top banner** (128x12 px) indicating the operational subsystem and page index (`X/6`), followed by 3 monospace data rows.

```text
+-------------------------------------------------------------------------------+
| SCREEN 1/6: NET & HOST   | SCREEN 2/6: CPU & RAM    | SCREEN 3/6: GPU AMPERE  |
| ┌──────────────────────┐ | ┌──────────────────────┐ | ┌─────────────────────┐ |
| │NET & HOST        1/6 │ | │CPU & RAM         2/6 │ | │GPU AMPERE       3/6 │ |
| ├──────────────────────┤ | ├──────────────────────┤ | ├─────────────────────┤ |
| │WiFi: <mgmt-ip>       │ | │CPU:  14.2% (6-Core)  │ | │Ampere: 1024-CUDA    │ |
| │Eth:  <ctrl-ip>       │ | │RAM:  4.1G/7.4G 55%   │ | │Load: 0.0% @306MHz   │ |
| │Up:02:14:32 L:0.42    │ | │NVMe: 42G/476G 9%     │ | │Temp: 41.2°C 4.85W   │ |
| └──────────────────────┘ | └──────────────────────┘ | └─────────────────────┘ |
+-------------------------------------------------------------------------------+
| SCREEN 4/6: THERM & PWR  | SCREEN 5/6: RPI5 HAILO   | SCREEN 6/6: RPI3 NODES  |
| ┌──────────────────────┐ | ┌──────────────────────┐ | ┌─────────────────────┐ |
| │THERM & PWR       4/6 │ | │RPI5 HAILO        5/6 │ | │RPI3 NODES       6/6 │ |
| ├──────────────────────┤ | ├──────────────────────┤ | ├─────────────────────┤ |
| │CPU: 43.1°C GPU:41°   │ | │RPi5:  ONLINE 49.6°C  │ | │Node1: ONLINE 36.5°C │ |
| │SOC: 39.8°C TJ :44°   │ | │Hailo: ONLINE 46.5°C  │ | │Node2: OFFLINE  --°C │ |
| │Pwr:  11.42W (In)     │ | │Rate:  0 ips  11ms    │ | │SDN:   P2 P4 UP      │ |
| └──────────────────────┘ | └──────────────────────┘ | └─────────────────────┘ |
+-------------------------------------------------------------------------------+
```

### Metrics Breakdown

| Screen | Title | Field | Telemetry Source | Unit / Range |
| :--- | :--- | :--- | :--- | :--- |
| **1/6** | `NET & HOST` | WiFi IP | `psutil.net_if_addrs()` (`wlan0`/`wlP*`) | IPv4 Address |
| | | Eth IP | `psutil.net_if_addrs()` (`eth0`/`en*`) | IPv4 Address |
| | | Uptime | `/proc/uptime` | `HH:MM:SS` |
| | | Load Avg | `os.getloadavg()[0]` | 1-minute load |
| **2/6** | `CPU & RAM` | CPU % | `psutil.cpu_percent()` | 6-Core Arm Cortex-A78AE |
| | | RAM | `psutil.virtual_memory()` | Used / Total GiB (%) |
| | | NVMe SSD | `psutil.disk_usage('/')` | Used / Total GiB (%) |
| **3/6** | `GPU AMPERE` | Architecture | Hardware Spec | `Ampere: 1024-CUDA` |
| | | GPU Load | `/sys/devices/platform/bus@0/17000000.gpu/load` | `0.0%`–`100.0%` |
| | | Dynamic Freq | `/sys/class/devfreq/17000000.gpu/cur_freq` | `306`–`624 MHz` |
| | | GPU Thermal | `/sys/class/thermal/thermal_zone1/temp` | Degrees Celsius (`°C`) |
| | | Rail Power | INA3221 Ch 2 (`VDD_CPU_GPU_CV`) | Watts (`W`) |
| **4/6** | `THERM & PWR` | Thermal Zones | `/sys/class/thermal/thermal_zone{0,1,5,8}/temp` | CPU, GPU, SOC, Junction TJ |
| | | Total DC Power | INA3221 Ch 1 (`VDD_IN`) | Total Appliance Power (`W`) |
| **5/6** | `RPI5 HAILO` | RPi 5 Host & Temp | Bridge API (`rpi5.status`, `temperatures.cpuC`) | `ONLINE` / `OFFLINE`, Temp (`°C`) |
| | | Hailo-8 NPU State | Bridge API (`rpi5.hailo.status`, `temperatures.hailoTs0C`) | `ONLINE` / `OFFLINE`, Temp (`°C`) |
| | | Inference Rate & Latency | Bridge API (`inferencesPerSecond`, `avgInferenceLatencyMs`) | `Rate: N ips Nms` |
| **6/6** | `RPI3 NODES` | Node 1 Telemetry | Bridge API (`rpi3_1.status`, `silicon.cpuTempC`) | `ONLINE` / `OFFLINE`, Temp (`°C`) |
| | | Node 2 Telemetry | Bridge API (`rpi3_2.status`, `silicon.cpuTempC`) | `ONLINE` / `OFFLINE`, Temp (`°C`) |
| | | Zodiac Ports | Switch CDC Telemetry (`:3003`) | Active OpenFlow Ports (e.g. `P2 P4 UP`) |

---

## 5. Architectural Invariants & Epistemic Provenance

1. **Anti-Simulation Law (Invariant 6)**:
   - Telemetry must always reflect physical truth.
   - If the RPi 5 or Hailo-8 NPU is disconnected, the display shifts to `OFFLINE` and reports null thermals (`--°C`).
   - If an adversarial RPi 3 node is unreachable, the display reports `OFFLINE --°C` (never fabricated metrics).
   - If the Zodiac FX switch serial link is disconnected, port status transitions to `NO PORTS UP`.
   - No synthetic or simulated values may be rendered on the physical display.
2. **Nanosecond Latency Budgets (Jeff Dean Invariant)**:
   - The display daemon queries `http://localhost:3003/api/zodiac` with an aggressive `0.4s` timeout.
   - If the local bridge is busy or restarting, the daemon drops immediately to local `/sys/` and `/proc/` filesystem nodes without blocking.
3. **Fail-Closed Simplicity (Sanjay Ghemawat Invariant)**:
   - Monolithic, single-process Python daemon with zero heavy third-party framework overhead.
   - Runs natively under `systemd` with automatic 3-second restart backoff on fault.

---

## 6. Deployment & Systemd Service Configuration

### 6.1 Automated Quickstart

Clone the repository on the Jetson Orin and run the setup script:

```bash
cd /home/zodiac/agentic-era-networking/docs/design/jetson-orin
./install.sh
```

### 6.2 Manual Service Deployment

If deploying manually:

1. Install system prerequisites:

   ```bash
   sudo apt update
   sudo apt install -y i2c-tools python3-smbus python3-pil python3-psutil fonts-dejavu-core
   pip3 install adafruit-circuitpython-ssd1306 netifaces
   ```

2. Copy the Python daemon and service definition:

   ```bash
   cp oled_sysinfo.py /home/zodiac/oled_sysinfo.py
   chmod +x /home/zodiac/oled_sysinfo.py
   sudo cp oled.service /etc/systemd/system/oled.service
   ```

3. Enable and start the service:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable oled.service
   sudo systemctl restart oled.service
   ```

4. Verify service operation:

   ```bash
   systemctl status oled.service
   journalctl -u oled.service -f
   ```

---

## 7. File Manifest

The `docs/design/jetson-orin/` folder contains all source files required to build, operate, and maintain the appliance display:

| File | Purpose |
| :--- | :--- |
| [README.md](file:///Users/andymorven/git/agentic-era-networking/docs/design/jetson-orin/README.md) | Complete hardware wiring, jumper configuration, and telemetry architecture |
| [oled_sysinfo.py](file:///Users/andymorven/git/agentic-era-networking/docs/design/jetson-orin/oled_sysinfo.py) | Standalone 6-page OLED telemetry rotation daemon |
| [oled.service](file:///Users/andymorven/git/agentic-era-networking/docs/design/jetson-orin/oled.service) | Systemd unit file for autostart and supervision |
| [install.sh](file:///Users/andymorven/git/agentic-era-networking/docs/design/jetson-orin/install.sh) | Automated idempotent deployment script |
