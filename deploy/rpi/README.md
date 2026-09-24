# Raspberry Pi workload-node telemetry

This guide copies the dependency-free telemetry collector to the Raspberry Pi,
installs it as a `systemd` service, and verifies its HTTP endpoint on port `3004`.

## Prerequisites

- Run the local commands from the repository root.
- The Raspberry Pi is reachable over SSH as `agent@<workload-node-ip>`.
- The `agent` account has `sudo` access.
- Node.js 22 and `curl` are installed on the Raspberry Pi.

## 1. Set the workload-node address

On the development machine, replace the placeholder with the Raspberry Pi's
management IP address:

```bash
export WORKLOAD_NODE_IP="<workload-node-ip>"
```

Confirm SSH access and the required Node.js major version:

```bash
ssh "agent@${WORKLOAD_NODE_IP}" 'node --version && command -v node'
```

The Node.js version must begin with `v22.`. The executable should be installed
under `/usr/bin` or `/usr/local/bin` so that `systemd` can find it.

## 2. Create the remote directories

```bash
ssh "agent@${WORKLOAD_NODE_IP}" \
  'mkdir -p /home/agent/agentic-era-networking/scripts /home/agent/agentic-era-networking/deploy/rpi'
```

## 3. Copy the collector and service unit

```bash
scp scripts/rpi-telemetry.ts \
  "agent@${WORKLOAD_NODE_IP}:/home/agent/agentic-era-networking/scripts/"

scp deploy/rpi/rpi-telemetry.service \
  "agent@${WORKLOAD_NODE_IP}:/home/agent/agentic-era-networking/deploy/rpi/"
```

These commands copy only the files required by this service; installing the
repository's npm dependencies is not necessary.

## 4. Install and start the service

Connect to the Raspberry Pi:

```bash
ssh "agent@${WORKLOAD_NODE_IP}"
```

Then run the following commands on the Raspberry Pi:

```bash
sudo install -o root -g root -m 0644 \
  /home/agent/agentic-era-networking/deploy/rpi/rpi-telemetry.service \
  /etc/systemd/system/rpi-telemetry.service

sudo systemd-analyze verify /etc/systemd/system/rpi-telemetry.service
sudo systemctl daemon-reload
sudo systemctl enable --now rpi-telemetry.service
sudo systemctl status --no-pager --full rpi-telemetry.service
```

The status should show `Active: active (running)`. If startup fails, inspect the
service logs:

```bash
sudo journalctl -u rpi-telemetry.service -n 100 --no-pager
```

## 5. Verify telemetry with `curl`

While still connected to the Raspberry Pi, query the local endpoint:

```bash
curl -fsS http://127.0.0.1:3004/telemetry | python3 -m json.tool
```

A successful response has this shape, with values taken from the live workload
node:

```json
{
    "telemetry": {
        "uptime": 12345.67,
        "vitals": {
            "load1m": 0.1,
            "load5m": 0.08,
            "load15m": 0.05,
            "memoryTotalBytes": 987654321,
            "memoryAvailableBytes": 456789012
        }
    }
}
```

Exit the SSH session and verify access from the development machine:

```bash
exit
curl -fsS "http://${WORKLOAD_NODE_IP}:3004/telemetry" | python3 -m json.tool
```

If the local request succeeds but the remote request fails, confirm that the
service is listening and that TCP port `3004` is permitted on the Raspberry
Pi's management interface:

```bash
ssh "agent@${WORKLOAD_NODE_IP}" 'sudo ss -ltnp "sport = :3004"'
```

When a host firewall is enabled, allow port `3004` only from the trusted
management machine or management subnet rather than exposing it broadly.

## Updating the collector

After changing `scripts/rpi-telemetry.ts`, copy it again and restart the service:

```bash
scp scripts/rpi-telemetry.ts \
  "agent@${WORKLOAD_NODE_IP}:/home/agent/agentic-era-networking/scripts/"
ssh "agent@${WORKLOAD_NODE_IP}" \
  'sudo systemctl restart rpi-telemetry.service && sudo systemctl status --no-pager rpi-telemetry.service'
```
