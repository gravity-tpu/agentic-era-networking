#!/usr/bin/env python3
"""
Jetson Orin Nano Super — Roboco Panini Case OLED Telemetry Daemon
Autonomous 6-Screen Rotational Hardware Monitor (Cycles every 15 seconds)

Hardware Substrates:
- NVIDIA Jetson Orin Nano Super (67 TOPS Ampere Architecture)
- 0.96" I2C 128x64 Monochrome OLED Display (SSD1306) on I2C Bus 7 (0x3c)
- Raspberry Pi 5 (`rpi-hailo`) with 26 TOPS Hailo-8 M.2 NPU
- Dual Raspberry Pi 3B+ Adversarial SDN Nodes (`agentic-node-01`, `agentic-node-02`)
- Northbound Networks Zodiac FX OpenFlow Switch

Governing Council Invariants:
- Dean Invariant: Nanosecond-to-millisecond latency budgets (<400ms HTTP timeout, direct sysfs read)
- Ghemawat Invariant: Radical simplicity, zero external bloat, graceful fallback
- Anti-Simulation Law (Invariant 6): Physical truth provenance — zero fabricated counters
"""

import sys
sys.path.insert(0, "/home/zodiac/.local/lib/python3.10/site-packages")

import time
import os
import socket
import urllib.request
import json
import board
import busio
from PIL import Image, ImageDraw, ImageFont
import adafruit_ssd1306
import psutil

# Hardware & Display Constants
I2C_BUS = 7
OLED_ADDR = 0x3c
WIDTH = 128
HEIGHT = 64
CYCLE_INTERVAL_SEC = 15
NUM_PAGES = 6

def fetch_telemetry_snapshot():
    """
    Attempt to fetch aggregated telemetry from the local Zodiac Bridge Server (:3003).
    If unreachable, fall back immediately to local sysfs and psutil without blocking.
    """
    try:
        req = urllib.request.Request("http://localhost:3003/api/zodiac", headers={"User-Agent": "OLED-Daemon"})
        with urllib.request.urlopen(req, timeout=0.4) as res:
            data = json.loads(res.read().decode())
            return parse_bridge_data(data)
    except Exception as e:
        sys.stderr.write(f"[oled-daemon] Bridge unreachable ({e}), falling back to sysfs\n")
    
    return parse_local_sysfs()

def parse_bridge_data(data):
    jetson = data.get("jetson", {})
    temps = jetson.get("temperatures", {})
    power = jetson.get("powerMw", {})
    rpi5 = data.get("rpi5", {})
    rpi3_1 = data.get("rpi3_1", {})
    rpi3_2 = data.get("rpi3_2", {})
    ports = data.get("ports", [])
    
    wifi_ip, eth_ip = get_local_ips()
    load = os.getloadavg()[0]
    uptime_str = jetson.get("uptime", get_uptime_fallback())
    
    cpu_pct = jetson.get("cpuUtilizationPct", psutil.cpu_percent(interval=None))
    ram_used_g = jetson.get("ramUsedBytes", 0) / (1024**3)
    ram_tot_g = jetson.get("ramTotalBytes", 8 * 1024**3) / (1024**3)
    ram_pct = int((ram_used_g / ram_tot_g * 100)) if ram_tot_g > 0 else 0
    
    nvme_used_g = jetson.get("nvmeUsedBytes", 0) / (1024**3)
    nvme_tot_g = jetson.get("nvmeTotalBytes", 500 * 1024**3) / (1024**3)
    nvme_pct = int((nvme_used_g / nvme_tot_g * 100)) if nvme_tot_g > 0 else 0
    
    cpu_c = temps.get("cpuC", 0)
    gpu_c = temps.get("gpuC", 0)
    soc_c = temps.get("socC", 0)
    tj_c = temps.get("junctionC", 0)
    
    vdd_in_w = (power.get("vddIn", 0) or 0) / 1000.0
    gpu_rail_w = (power.get("vddCpuGpuCv", 0) or 0) / 1000.0
    
    gpu_load, gpu_freq_mhz = get_gpu_sysfs()
    
    # RPi 5 + Hailo-8 Telemetry
    def fmt_temp(val):
        return f"{val:.1f}°C" if (isinstance(val, (int, float)) and not isinstance(val, bool)) else "--°C"

    rpi5_online = bool(rpi5 and rpi5.get("status") == "online")
    rpi5_status = "ONLINE" if rpi5_online else "OFFLINE"
    rpi5_temp_raw = rpi5.get("temperatures", {}).get("cpuC") if (rpi5 and rpi5_online) else None
    rpi5_temp_str = fmt_temp(rpi5_temp_raw)
    
    hailo = rpi5.get("hailo", {}) if (rpi5 and rpi5_online) else {}
    hailo_status = "ONLINE" if (rpi5_online and str(hailo.get("status", "")).lower() == "online") else "OFFLINE"
    hailo_temp_raw = rpi5.get("temperatures", {}).get("hailoTs0C") if (rpi5 and rpi5_online) else None
    hailo_temp_str = fmt_temp(hailo_temp_raw)
    hailo_rate = int(hailo.get("inferencesPerSecond", 0) or 0) if rpi5_online else 0
    hailo_lat_ms = int(hailo.get("avgInferenceLatencyMs", 0) or 0) if rpi5_online else 0

    # RPi 3 Nodes Telemetry
    node1_online = bool(rpi3_1 and rpi3_1.get("status") == "online")
    node1_status = "ONLINE" if node1_online else "OFFLINE"
    node1_temp_raw = rpi3_1.get("silicon", {}).get("cpuTempC") if rpi3_1 else None
    node1_temp_str = fmt_temp(node1_temp_raw)

    node2_online = bool(rpi3_2 and rpi3_2.get("status") == "online")
    node2_status = "ONLINE" if node2_online else "OFFLINE"
    node2_temp_raw = rpi3_2.get("silicon", {}).get("cpuTempC") if rpi3_2 else None
    node2_temp_str = fmt_temp(node2_temp_raw)

    up_ports = [f"P{p.get('port')}" for p in ports if p.get("status") == "UP"]
    zodiac_str = " ".join(up_ports) + " UP" if up_ports else "NO PORTS UP"
    
    return {
        "wifi_ip": wifi_ip,
        "eth_ip": eth_ip,
        "uptime": uptime_str,
        "load": load,
        "cpu_pct": cpu_pct,
        "ram_used_g": ram_used_g,
        "ram_tot_g": ram_tot_g,
        "ram_pct": ram_pct,
        "nvme_used_g": nvme_used_g,
        "nvme_tot_g": nvme_tot_g,
        "nvme_pct": nvme_pct,
        "cpu_c": cpu_c,
        "gpu_c": gpu_c,
        "soc_c": soc_c,
        "tj_c": tj_c,
        "power_w": vdd_in_w,
        "gpu_rail_w": gpu_rail_w,
        "gpu_load": gpu_load,
        "gpu_freq_mhz": gpu_freq_mhz,
        "rpi5_status": rpi5_status,
        "rpi5_temp_str": rpi5_temp_str,
        "hailo_status": hailo_status,
        "hailo_temp_str": hailo_temp_str,
        "hailo_rate": hailo_rate,
        "hailo_lat_ms": hailo_lat_ms,
        "node1_status": node1_status,
        "node1_temp_str": node1_temp_str,
        "node2_status": node2_status,
        "node2_temp_str": node2_temp_str,
        "zodiac_str": zodiac_str
    }

def get_gpu_sysfs():
    gpu_load = 0.0
    gpu_freq_mhz = 306
    try:
        with open("/sys/devices/platform/bus@0/17000000.gpu/load", "r") as f:
            val = int(f.read().strip())
            gpu_load = val / 10.0 if val > 100 else float(val)
    except Exception as e:
        sys.stderr.write(f"[oled-daemon] GPU load read failed: {e}\n")
    try:
        with open("/sys/class/devfreq/17000000.gpu/cur_freq", "r") as f:
            gpu_freq_mhz = int(f.read().strip()) // 1000000
    except Exception as e:
        sys.stderr.write(f"[oled-daemon] GPU freq read failed: {e}\n")
    return gpu_load, gpu_freq_mhz

def get_local_ips():
    wifi_ip, eth_ip = "Offline", "Unlinked"
    try:
        for iface, addrs in psutil.net_if_addrs().items():
            for addr in addrs:
                if addr.family == socket.AF_INET and not addr.address.startswith("127."):
                    if iface.startswith(("wlan", "wlP")):
                        wifi_ip = addr.address
                    elif iface.startswith(("eth", "en")):
                        eth_ip = addr.address
    except Exception as e:
        sys.stderr.write(f"[oled-daemon] Network interface read failed: {e}\n")
    return wifi_ip, eth_ip

def get_uptime_fallback():
    try:
        with open("/proc/uptime", "r") as f:
            total_sec = int(float(f.readline().split()[0]))
            h = total_sec // 3600
            m = (total_sec % 3600) // 60
            s = total_sec % 60
            return f"{h:02d}:{m:02d}:{s:02d}"
    except Exception as e:
        sys.stderr.write(f"[oled-daemon] Uptime fallback read failed: {e}\n")
        return "00:00:00"

def parse_local_sysfs():
    wifi_ip, eth_ip = get_local_ips()
    uptime_str = get_uptime_fallback()
    load = os.getloadavg()[0]
    
    cpu_pct = psutil.cpu_percent(interval=None)
    vm = psutil.virtual_memory()
    ram_used_g = vm.used / (1024**3)
    ram_tot_g = vm.total / (1024**3)
    ram_pct = int(vm.percent)
    
    du = psutil.disk_usage("/")
    nvme_used_g = du.used / (1024**3)
    nvme_tot_g = du.total / (1024**3)
    nvme_pct = int(du.percent)
    
    def read_tz(idx):
        try:
            with open(f"/sys/class/thermal/thermal_zone{idx}/temp", "r") as f:
                return round(int(f.read().strip()) / 1000.0, 1)
        except Exception:
            return 0.0
            
    cpu_c = read_tz(0)
    gpu_c = read_tz(1)
    soc_c = read_tz(5)
    tj_c = read_tz(8)
    
    gpu_rail_w = 0.0
    try:
        with open("/sys/class/hwmon/hwmon1/in2_input", "r") as f1, open("/sys/class/hwmon/hwmon1/curr2_input", "r") as f2:
            gpu_rail_w = (int(f1.read().strip()) * int(f2.read().strip())) / 1000000.0
    except Exception as e:
        sys.stderr.write(f"[oled-daemon] GPU rail power read failed: {e}\n")

    gpu_load, gpu_freq_mhz = get_gpu_sysfs()
    
    return {
        "wifi_ip": wifi_ip,
        "eth_ip": eth_ip,
        "uptime": uptime_str,
        "load": load,
        "cpu_pct": cpu_pct,
        "ram_used_g": ram_used_g,
        "ram_tot_g": ram_tot_g,
        "ram_pct": ram_pct,
        "nvme_used_g": nvme_used_g,
        "nvme_tot_g": nvme_tot_g,
        "nvme_pct": nvme_pct,
        "cpu_c": cpu_c,
        "gpu_c": gpu_c,
        "soc_c": soc_c,
        "tj_c": tj_c,
        "power_w": 0.0,
        "gpu_rail_w": gpu_rail_w,
        "gpu_load": gpu_load,
        "gpu_freq_mhz": gpu_freq_mhz,
        # local-only fallback cannot observe remote nodes; always OFFLINE by design (Invariant 6)
        "rpi5_status": "OFFLINE",
        "rpi5_temp_str": "--°C",
        "hailo_status": "OFFLINE",
        "hailo_temp_str": "--°C",
        "hailo_rate": 0,
        "hailo_lat_ms": 0,
        "node1_status": "OFFLINE",
        "node1_temp_str": "--°C",
        "node2_status": "OFFLINE",
        "node2_temp_str": "--°C",
        "zodiac_str": "Offline"
    }

def main():
    try:
        i2c = busio.I2C(board.SCL, board.SDA)
        display = adafruit_ssd1306.SSD1306_I2C(WIDTH, HEIGHT, i2c, addr=OLED_ADDR)
    except Exception as e:
        print(f"I2C initialization error: {e}")
        sys.exit(1)

    display.fill(0)
    display.show()

    image = Image.new("1", (WIDTH, HEIGHT))
    draw = ImageDraw.Draw(image)

    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 10)
    except IOError:
        font = ImageFont.load_default()

    page = 0
    last_cycle_time = time.time()
    
    print("6-screen OLED telemetry daemon active (cycling every 15s)...")
    
    while True:
        try:
            now = time.time()
            if now - last_cycle_time >= CYCLE_INTERVAL_SEC:
                page = (page + 1) % NUM_PAGES
                last_cycle_time = now

            metrics = fetch_telemetry_snapshot()

            # Clear buffer
            draw.rectangle((0, 0, WIDTH, HEIGHT), outline=0, fill=0)

            # Draw Inverted Header Bar
            draw.rectangle((0, 0, 127, 12), fill=1)

            if page == 0:
                # Screen 1: Network & Host
                draw.text((2, 0), "NET & HOST", font=font, fill=0)
                draw.text((104, 0), "1/6", font=font, fill=0)
                draw.text((1, 15), f"WiFi: {metrics['wifi_ip']}", font=font, fill=1)
                draw.text((1, 31), f"Eth:  {metrics['eth_ip']}", font=font, fill=1)
                draw.text((1, 47), f"Up:{metrics['uptime']} L:{metrics['load']:.2f}", font=font, fill=1)

            elif page == 1:
                # Screen 2: Compute & Memory
                draw.text((2, 0), "CPU & RAM", font=font, fill=0)
                draw.text((104, 0), "2/6", font=font, fill=0)
                draw.text((1, 15), f"CPU:  {metrics['cpu_pct']:04.1f}% (6-Core)", font=font, fill=1)
                draw.text((1, 31), f"RAM:  {metrics['ram_used_g']:.1f}G/{metrics['ram_tot_g']:.1f}G ({metrics['ram_pct']}%)", font=font, fill=1)
                draw.text((1, 47), f"NVMe: {metrics['nvme_used_g']:.0f}G/{metrics['nvme_tot_g']:.0f}G ({metrics['nvme_pct']}%)", font=font, fill=1)

            elif page == 2:
                # Screen 3: Dedicated GPU Telemetry
                draw.text((2, 0), "GPU AMPERE", font=font, fill=0)
                draw.text((104, 0), "3/6", font=font, fill=0)
                draw.text((1, 15), "Ampere: 1024-CUDA", font=font, fill=1)
                draw.text((1, 31), f"Load: {metrics['gpu_load']:.1f}% @{metrics['gpu_freq_mhz']}MHz", font=font, fill=1)
                pwr_gpu = f"{metrics['gpu_rail_w']:.2f}W" if metrics['gpu_rail_w'] > 0 else "Active"
                draw.text((1, 47), f"Temp: {metrics['gpu_c']:.1f}°C {pwr_gpu}", font=font, fill=1)

            elif page == 3:
                # Screen 4: Thermals & Power
                draw.text((2, 0), "THERM & PWR", font=font, fill=0)
                draw.text((104, 0), "4/6", font=font, fill=0)
                draw.text((1, 15), f"CPU: {metrics['cpu_c']:.1f}°C GPU:{metrics['gpu_c']:.0f}°", font=font, fill=1)
                draw.text((1, 31), f"SOC: {metrics['soc_c']:.1f}°C TJ :{metrics['tj_c']:.0f}°", font=font, fill=1)
                pwr_str = f"Pwr:  {metrics['power_w']:.2f}W (In)" if metrics["power_w"] > 0 else "Pwr:  Active (DC)"
                draw.text((1, 47), pwr_str, font=font, fill=1)

            elif page == 4:
                # Screen 5: RPi 5 & Hailo-8 NPU
                draw.text((2, 0), "RPI5 HAILO", font=font, fill=0)
                draw.text((104, 0), "5/6", font=font, fill=0)
                draw.text((1, 15), f"RPi5:  {metrics['rpi5_status']} {metrics['rpi5_temp_str']}", font=font, fill=1)
                draw.text((1, 31), f"Hailo: {metrics['hailo_status']} {metrics['hailo_temp_str']}", font=font, fill=1)
                draw.text((1, 47), f"Rate:  {metrics['hailo_rate']} ips  {metrics['hailo_lat_ms']}ms", font=font, fill=1)

            elif page == 5:
                # Screen 6: RPi 3 Nodes & SDN Switch
                draw.text((2, 0), "RPI3 NODES", font=font, fill=0)
                draw.text((104, 0), "6/6", font=font, fill=0)
                draw.text((1, 15), f"Node1: {metrics['node1_status']} {metrics['node1_temp_str']}", font=font, fill=1)
                draw.text((1, 31), f"Node2: {metrics['node2_status']} {metrics['node2_temp_str']}", font=font, fill=1)
                draw.text((1, 47), f"SDN:   {metrics['zodiac_str']}", font=font, fill=1)

            display.image(image)
            display.show()
            time.sleep(1.0)

        except KeyboardInterrupt:
            display.fill(0)
            display.show()
            break
        except Exception as err:
            print(f"Display loop iteration error: {err}")
            time.sleep(2.0)

if __name__ == "__main__":
    main()
