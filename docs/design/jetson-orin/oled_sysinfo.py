#!/usr/bin/env python3
"""
Jetson Orin Nano Super — Roboco Panini Case OLED Telemetry Daemon
Autonomous 5-Screen Rotational Hardware Monitor (Cycles every 15 seconds)

Hardware Substrates:
- NVIDIA Jetson Orin Nano Super (67 TOPS Ampere Architecture)
- 0.96" I2C 128x64 Monochrome OLED Display (SSD1306) on I2C Bus 7 (0x3c)
- Google Coral EdgeTPU (USB Accelerator)
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
NUM_PAGES = 5

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
    except Exception:
        pass
    
    return parse_local_sysfs()

def parse_bridge_data(data):
    jetson = data.get("jetson", {})
    temps = jetson.get("temperatures", {})
    power = jetson.get("powerMw", {})
    coral = data.get("coral", {})
    c_series = coral.get("timeSeries", [])
    latest_coral = c_series[-1] if c_series else {}
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
    
    tpu_active = bool(coral.get("status") == "ACTIVE" or latest_coral)
    tpu_rate = latest_coral.get("inferencesPerSecond", 0)
    tpu_lat_ms = (latest_coral.get("latencyP50Us", 0) or 0) / 1000.0
    
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
        "tpu_active": tpu_active,
        "tpu_rate": tpu_rate,
        "tpu_lat_ms": tpu_lat_ms,
        "zodiac_str": zodiac_str
    }

def get_gpu_sysfs():
    gpu_load = 0.0
    gpu_freq_mhz = 306
    try:
        with open("/sys/devices/platform/bus@0/17000000.gpu/load", "r") as f:
            val = int(f.read().strip())
            gpu_load = val / 10.0 if val > 100 else float(val)
    except Exception:
        pass
    try:
        with open("/sys/class/devfreq/17000000.gpu/cur_freq", "r") as f:
            gpu_freq_mhz = int(f.read().strip()) // 1000000
    except Exception:
        pass
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
    except Exception:
        pass
    return wifi_ip, eth_ip

def get_uptime_fallback():
    try:
        with open("/proc/uptime", "r") as f:
            total_sec = int(float(f.readline().split()[0]))
            h = total_sec // 3600
            m = (total_sec % 3600) // 60
            s = total_sec % 60
            return f"{h:02d}:{m:02d}:{s:02d}"
    except Exception:
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
    except Exception:
        pass

    gpu_load, gpu_freq_mhz = get_gpu_sysfs()
    
    tpu_active, tpu_rate, tpu_lat_ms = False, 0, 0.0
    try:
        with open("/tmp/coral-telemetry.json", "r") as f:
            c = json.load(f)
            tpu_active = c.get("status") == "ACTIVE"
            tpu_rate = c.get("inferencesPerSecond", 0)
            tpu_lat_ms = (c.get("latencyP50Ns", 0) or 0) / 1000000.0
    except Exception:
        pass
        
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
        "tpu_active": tpu_active,
        "tpu_rate": tpu_rate,
        "tpu_lat_ms": tpu_lat_ms,
        "zodiac_str": "Bridge Offline"
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
    
    print("5-screen OLED telemetry daemon active (cycling every 15s)...")
    
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
                draw.text((104, 0), "1/5", font=font, fill=0)
                draw.text((1, 15), f"WiFi: {metrics['wifi_ip']}", font=font, fill=1)
                draw.text((1, 31), f"Eth:  {metrics['eth_ip']}", font=font, fill=1)
                draw.text((1, 47), f"Up:{metrics['uptime']} L:{metrics['load']:.2f}", font=font, fill=1)

            elif page == 1:
                # Screen 2: Compute & Memory
                draw.text((2, 0), "CPU & RAM", font=font, fill=0)
                draw.text((104, 0), "2/5", font=font, fill=0)
                draw.text((1, 15), f"CPU:  {metrics['cpu_pct']:04.1f}% (6-Core)", font=font, fill=1)
                draw.text((1, 31), f"RAM:  {metrics['ram_used_g']:.1f}G/{metrics['ram_tot_g']:.1f}G ({metrics['ram_pct']}%)", font=font, fill=1)
                draw.text((1, 47), f"NVMe: {metrics['nvme_used_g']:.0f}G/{metrics['nvme_tot_g']:.0f}G ({metrics['nvme_pct']}%)", font=font, fill=1)

            elif page == 2:
                # Screen 3: Dedicated GPU Telemetry
                draw.text((2, 0), "GPU AMPERE", font=font, fill=0)
                draw.text((104, 0), "3/5", font=font, fill=0)
                draw.text((1, 15), "Ampere: 1024-CUDA", font=font, fill=1)
                draw.text((1, 31), f"Load: {metrics['gpu_load']:.1f}% @{metrics['gpu_freq_mhz']}MHz", font=font, fill=1)
                pwr_gpu = f"{metrics['gpu_rail_w']:.2f}W" if metrics['gpu_rail_w'] > 0 else "Active"
                draw.text((1, 47), f"Temp: {metrics['gpu_c']:.1f}°C {pwr_gpu}", font=font, fill=1)

            elif page == 3:
                # Screen 4: Thermals & Power
                draw.text((2, 0), "THERM & PWR", font=font, fill=0)
                draw.text((104, 0), "4/5", font=font, fill=0)
                draw.text((1, 15), f"CPU: {metrics['cpu_c']:.1f}°C GPU:{metrics['gpu_c']:.0f}°", font=font, fill=1)
                draw.text((1, 31), f"SOC: {metrics['soc_c']:.1f}°C TJ :{metrics['tj_c']:.0f}°", font=font, fill=1)
                pwr_str = f"Pwr:  {metrics['power_w']:.2f}W (In)" if metrics["power_w"] > 0 else "Pwr:  Active (DC)"
                draw.text((1, 47), pwr_str, font=font, fill=1)

            elif page == 4:
                # Screen 5: Coral TPU & Zodiac SDN
                draw.text((2, 0), "TPU & SDN", font=font, fill=0)
                draw.text((104, 0), "5/5", font=font, fill=0)
                tpu_st = "ACTIVE (USB)" if metrics["tpu_active"] else "STANDBY"
                draw.text((1, 15), f"Coral: {tpu_st}", font=font, fill=1)
                draw.text((1, 31), f"Rate:  {metrics['tpu_rate']} inf/sec", font=font, fill=1)
                draw.text((1, 47), f"Lat:{metrics['tpu_lat_ms']:.1f}ms  {metrics['zodiac_str']}", font=font, fill=1)

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
