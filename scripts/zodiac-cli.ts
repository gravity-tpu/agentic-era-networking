#!/usr/bin/env node
/**
 * zodiac-cli.ts
 * Command Line Interface for Zodiac FX Physical Switch
 *
 * Usage:
 *   node --experimental-strip-types scripts/zodiac-cli.ts <command>
 *   npm run zodiac -- <command>
 *
 * Commands:
 *   status   - Query device firmware, temperature, uptime, and configuration.
 *   ports    - Display link status and VLAN mapping for Ports 1–4.
 *   listen   - Run the OpenFlow 1.3 SDN controller daemon on 10.0.1.8:6633.
 *   ping     - High-precision ping to Zodiac switch IP (10.0.1.99).
 *   reboot   - Restart the Zodiac FX switch via serial command.
 */

import { ZodiacController } from '../dist/sdn/zodiac-controller.js';
import { spawn } from 'node:child_process';

if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile();
  } catch (_) {
    // Non-fatal if .env doesn't exist
  }
}

const controller = new ZodiacController();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'help';

  switch (command) {
    case 'status': {
      console.log('\n🔭 Probing Zodiac FX Hardware Status...\n');
      const health = await controller.getComprehensiveHealth();

      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('  ZODIAC FX PHYSICAL SWITCH DIAGNOSTICS');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`  Serial Port     : ${health.serialPath ?? 'Not Detected'}`);
      console.log(`  Firmware        : ${health.deviceStatus?.firmwareVersion ?? 'N/A'}`);
      console.log(`  CPU Temperature : ${health.deviceStatus?.cpuTempC ?? 'N/A'} °C`);
      console.log(`  Device Uptime   : ${health.deviceStatus?.uptime ?? 'N/A'}`);
      console.log(`  OpenFlow Daemon : ${health.openFlowMetrics.state === 'ESTABLISHED' ? '🟢 Connected (10.0.1.8:6633)' : '⚪ Ready (10.0.1.8:6633)'}`);
      console.log('──────────────────────────────────────────────────────────────────');
      if (health.config) {
        console.log('  NETWORK CONFIGURATION:');
        console.log(`    Switch IP       : ${health.config.ipAddress} / ${health.config.netmask}`);
        console.log(`    Default Gateway : ${health.config.gateway}`);
        console.log(`    OF Controller   : ${health.config.controllerIp}:${health.config.controllerPort}`);
        console.log(`    Failstate       : ${health.config.failstate}`);
      }
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      break;
    }

    case 'ports': {
      console.log('\n🔌 Querying Zodiac FX Physical Ports...\n');
      const ports = await controller.serialClient.getPorts();

      console.log('┌──────┬────────┬───────────┬─────────┬──────────────────────────────────────────┐');
      console.log('│ Port │ Status │ VLAN Type │ VLAN ID │ Physical Description                     │');
      console.log('├──────┼────────┼───────────┼─────────┼──────────────────────────────────────────┤');
      for (const p of ports) {
        const statusStr = p.status === 'UP' ? '🟢 UP  ' : '⚪ DOWN';
        let desc = 'OpenFlow Data Plane Port';
        if (p.port === 1) desc += ' (Opposite USB connector)';
        if (p.port === 4) desc = 'SDN Controller / Native Management Port';

        console.log(
          `│  ${p.port}   │ ${statusStr}│ ${p.vlanType.padEnd(9)} │  ${String(p.vlanId).padEnd(6)} │ ${desc.padEnd(40)} │`
        );
      }
      console.log('└──────┴────────┴───────────┴─────────┴──────────────────────────────────────────┘\n');
      break;
    }

    case 'listen': {
      const port = 6633;
      const host = '10.0.1.8';
      console.log(`\n🚀 Starting OpenFlow 1.3 SDN Controller Daemon on ${host}:${port}...\n`);

      const of = controller.openFlow;

      of.on('connected', (addr) => {
        console.log(`[+] [OpenFlow] Switch connected from: ${addr}`);
      });

      of.on('rawMessage', (type, len, xid) => {
        console.log(`[>] [Packet] Received type=${type}, len=${len}B, xid=${xid}`);
      });

      of.on('ready', (features) => {
        console.log('\n✨ [OpenFlow] Handshake Established with Switch!');
        console.log(`    Datapath ID  : 0x${features.datapathId.toString(16)}`);
        console.log(`    Buffer Count : ${features.nBuffers}`);
        console.log(`    Flow Tables  : ${features.nTables}`);
        console.log(`    Capabilities : 0x${features.capabilities.toString(16)}`);
        console.log('    Status       : Installing Table-Miss Flow Entry (Option A: Controller Header-Sampling)...');

        try {
          of.sendTableMissRule(0, 'CONTROLLER', 128);
          console.log('    [+] Table-Miss Rule Dispatched -> Forward unhandled packet headers to Controller (bounded 128B)!\n');
        } catch (err) {
          console.error(`    [!] Failed to install Table-Miss rule: ${(err as Error).message}\n`);
        }
      });

      of.on('packetIn', (pkt) => {
        const ipInfo = pkt.srcIp ? ` | ${pkt.srcIp} -> ${pkt.dstIp}` : '';
        const arpInfo = pkt.arpSenderIp ? ` | ARP: ${pkt.arpSenderIp} -> ${pkt.arpTargetIp}` : '';
        console.log(`[📦 PACKET_IN] InPort: ${pkt.inPort ?? '?'} | EtherType: ${pkt.etherTypeStr} | Src MAC: ${pkt.srcMac} -> Dst: ${pkt.dstMac}${ipInfo}${arpInfo}`);
      });

      of.on('echoLatency', (latencyNs) => {
        const ms = (Number(latencyNs) / 1_000_000).toFixed(3);
        console.log(`[~] [Echo Heartbeat] Round-trip latency: ${ms} ms (${latencyNs} ns)`);
      });

      of.on('disconnected', (addr) => {
        console.log(`[-] [OpenFlow] Switch disconnected: ${addr}`);
      });

      of.on('error', (err) => {
        console.error(`[!] [OpenFlow Error] ${err.message}`);
      });

      await of.listen(port, host);
      console.log(`[*] Controller listening on ${host}:${port}. Waiting for Zodiac FX...`);
      console.log('    (Press Ctrl+C to exit)\n');

      // Send periodic echo keep-alive every 5 seconds once established
      const timer = setInterval(() => {
        if (of.metrics.state === 'ESTABLISHED') {
          of.pingEcho();
        }
      }, 5000);

      process.on('SIGINT', async () => {
        clearInterval(timer);
        console.log('\n[!] Stopping controller daemon...');
        await controller.stop();
        process.exit(0);
      });
      break;
    }

    case 'ping': {
      console.log('\n📡 Testing physical link latency to 10.0.1.99...\n');
      const ping = spawn('ping', ['-c', '5', '10.0.1.99'], { stdio: 'inherit' });
      ping.on('close', (code) => {
        process.exit(code ?? 0);
      });
      break;
    }

    case 'reboot': {
      console.log('\n⚠️  Sending restart command to Zodiac FX via serial...');
      await controller.serialClient.restart();
      console.log('✅ Restart command dispatched. Device is rebooting.\n');
      break;
    }

    case 'serve': {
      const port = parseInt(process.env['PORT'] ?? process.argv[3] ?? '3000', 10);
      const host = '0.0.0.0';
      const relayArg = process.argv.find((a) => a.startsWith('--relay=') || a === '--relay');
      let cloudRelayUrl: string | undefined = process.env['ZODIAC_CLOUD_RELAY_URL'];
      if (relayArg) {
        cloudRelayUrl = relayArg.includes('=') ? relayArg.split('=')[1] : (cloudRelayUrl ?? 'https://agentic-era-networking.vercel.app');
      }
      const bridgeSecret = process.env['ZODIAC_BRIDGE_SECRET'];

      console.log(`\n🚀 Starting Zodiac FX Web & REST Bridge Server on http://localhost:${port}...`);
      if (cloudRelayUrl) {
        console.log(`📡 Cloud Telemetry Relay Active: ${cloudRelayUrl} (Verified Epistemic Provenance)\n`);
      } else {
        console.log('');
      }

      const { ZodiacBridgeServer } = await import('../dist/sdn/zodiac-bridge-server.js');
      const bridge = new ZodiacBridgeServer(
        controller,
        undefined,
        undefined,
        cloudRelayUrl,
        bridgeSecret
      );
      const boundPort = await bridge.start(port, host);
      console.log(`✨ Dashboard is live at : http://localhost:${boundPort}`);
      console.log(`   - REST Telemetry API : http://localhost:${boundPort}/api/zodiac`);
      console.log(`   - OpenFlow 1.3 Daemon : 10.0.1.8:6633`);
      console.log(`   - Serial Management   : ${controller.serialClient.path}`);
      if (cloudRelayUrl) {
        console.log(`   - Cloud Production   : ${cloudRelayUrl}`);
      }
      console.log(`   - Press Ctrl+C to exit\n`);

      process.on('SIGINT', async () => {
        console.log('\n[!] Stopping bridge server...');
        await bridge.stop();
        process.exit(0);
      });
      break;
    }

    case 'help':
    default:
      console.log(`
Zodiac FX Physical Interface CLI

Usage:
  npm run zodiac -- <command>

Commands:
  status   - Query device firmware, temperature, uptime, and configuration
  ports    - Display link status and VLAN mapping for Ports 1–4
  listen   - Run the OpenFlow 1.3 SDN controller daemon on 10.0.1.8:6633
  ping     - High-precision ping to Zodiac switch IP (10.0.1.99)
  reboot   - Restart the Zodiac FX switch via serial command
  serve    - Launch the local web dashboard and REST bridge on http://localhost:3000
`);
      break;
  }
}

main().catch((err: unknown) => {
  console.error('\n❌ Fatal CLI Error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
