//create script the obtains the necessary information
//create daemon to periodically query script
//save queried information somewhere (disk first, then NEON)
//https://www.digitalocean.com/community/tutorials/how-to-write-a-linux-daemon-with-node-js-on-a-vps

import { createServer } from "node:http";
import os from 'node:os';

const KEEP_ALIVE_TIMEOUT_MS = 5_000
const HEADERS_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 15_000

type TelemetryVitals = {
    load1m: number
    load5m: number
    load15m: number
    // Byte counts serialized as decimal strings from BigInt values.
    memoryTotalBytes: string
    memoryAvailableBytes: string
}

type InterfaceTelemetry = {
    // /sys/class/net/<ifname>/carrier; null when unavailable.
    carrier: boolean | null
    // /proc/net/dev counters: validate as uint64 BigInts, then serialize as decimal strings.
    rxBytes: string
    rxPackets: string
    rxErrors: string
    rxDropped: string
    txBytes: string
    txPackets: string
    txErrors: string
    txDropped: string
}

type Telemetry = {
    uptime: number
    device: 'Raspberry_Pi_3B_Plus'
    role: 'Untrusted_SDN_Workload_Node'
    // Wall-clock nanoseconds since the Unix epoch, serialized as a decimal string.
    timestampNs: string
    // Monotonic nanoseconds from process.hrtime.bigint(), serialized as a decimal string.
    monotonicNs: string
    // Integer milliseconds since the Unix epoch.
    timestampMs: number
    // /sys/class/thermal/thermal_zone0/temp converted to degrees Celsius.
    temperatureC: number | null
    // vcgencmd get_throttled: refresh asynchronously with a 10s TTL; null when unavailable.
    throttled: `0x${string}` | null
    vitals: TelemetryVitals
    interfaces: Record<'eth0' | 'wlan0', InterfaceTelemetry>
}

const PORT = 3004

const server = createServer((req, res) => {
    const {headers, method, url} = req

    if (method === 'GET' && url === '/healthz') {
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        return res.end()
    }

    if (method === 'GET' && url === '/telemetry') {
        const telemetry = getTelemtry()
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        return res.end(JSON.stringify({ telemetry }))
    }
   
})

function getTelemetry(): Pick<Telemetry, "uptime" | "vitals"> {
    const uptime = os.uptime()
    const loadAvg = os.loadavg()

    return {
        uptime,
        vitals: {
            load1m: loadAvg[0],
            load5m: loadAvg[1],
            load15m: loadAvg[2],
            memoryTotalBytes: BigInt(os.totalmem()).toString(),
            memoryAvailableBytes: BigInt(os.freemem()).toString()
        }
    }
}

server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS
server.headersTimeout = HEADERS_TIMEOUT_MS
server.requestTimeout = REQUEST_TIMEOUT_MS
server.listen(PORT, '127.0.0.1')
