/**
 * controller-away-probe-cli.ts
 * Runs the read-only controller-away probe (src/sdn/controller-away-probe.ts) on the Jetson while the bridge is STOPPED:
 *
 *   node dist/sdn/controller-away-probe-cli.js [--port 6633] [--host 0.0.0.0] [--overall-ms N] [--reconnect-wait-ms N]
 *       [--readback-timeout-ms N] [--readbacks N] [--interval-ms N]
 *
 * Environment: ZODIAC_UPLINK_ARP_PEERS (optional, the same value the bridge runs with, so "equals the policy" means the policy the bridge installs).
 * Output: human lines, then one line `RESULT {json}`. Exit code: 0 equals the policy, 2 differs, 3 empty, 4 the switch never reconnected, 5 readback failed,
 * 6 overall timeout, 7 could not listen (the bridge is up), 1 bad arguments or an unexpected error. It writes nothing to the switch.
 */

import { fileURLToPath } from 'node:url';
import { EXIT_CODES, ReadOnlySwitchSession, parseProbeConfig, runAwayProbe, type ProbeSummary } from './controller-away-probe.js';
import { buildPort1IsolationPolicy, parseUplinkArpPeers } from './port1-isolation.js';

/** Margin after the overall limit before the backstop timer forces an exit; the run itself stops at the limit. */
const BACKSTOP_GRACE_MS = 5_000;

/** Closes the session, then exits with `code`. A close that rejects is reported on stderr and does not change the exit code or stop the exit. */
export async function closeAndExit(session: { close(): Promise<void> }, code: number, exit: (code: number) => void, errlog: (msg: string) => void): Promise<void> {
  try {
    await session.close();
  } catch (e: unknown) {
    errlog(`close failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  exit(code);
}

const log = (s: string): void => { console.log(`${new Date().toISOString()} ${s}`); };

function printSummary(s: ProbeSummary): void {
  for (const r of s.reads) {
    if (!r.ok) { log(`readback ${r.index} at ${r.startedAtMs} ms: FAILED ${r.error ?? ''}`); continue; }
    log(`readback ${r.index} at ${r.startedAtMs} ms (${r.durationMs} ms): ${r.entries?.length ?? 0} entries, ${r.assessment?.klass ?? 'unassessed'}`);
    for (const e of r.entries ?? []) log(`  prio ${e.priority} | ${e.match} | ${e.instructions} | packets ${e.packets} bytes ${e.bytes}`);
    const a = r.assessment;
    if (a !== undefined) {
      log(`  policy comparison: ${a.confirmed}/${a.policyRuleCount} rules confirmed, ${a.extraEntries} extra entries, actions ${a.actionStatus}, table-miss ${a.tableMiss}`);
      for (const m of a.mismatches) log(`  mismatch: ${m}`);
    }
  }
  for (const n of s.notes) log(`note: ${n}`);
  log(`server errors seen: ${s.serverErrorCount}${s.recentServerErrors.length > 0 ? ` (recent: ${s.recentServerErrors.join('; ')})` : ''}`);
  log(`OUTCOME ${s.outcome} (exit ${s.exitCode}): ${s.message}`);
  console.log(`RESULT ${JSON.stringify(s)}`);
}

async function main(): Promise<number> {
  const cfg = parseProbeConfig(process.argv.slice(2));
  const policy = buildPort1IsolationPolicy(undefined, undefined, undefined, parseUplinkArpPeers(process.env['ZODIAC_UPLINK_ARP_PEERS']));
  const session = new ReadOnlySwitchSession();
  const stop = (code: number): void => { void closeAndExit(session, code, (c) => process.exit(c), (m) => console.error(m)); };
  process.on('SIGTERM', () => { log('SIGTERM: closing'); stop(143); });
  process.on('SIGINT', () => { log('SIGINT: closing'); stop(130); });
  const backstop = setTimeout(() => {
    log(`OUTCOME overall_timeout (exit ${EXIT_CODES.overall_timeout}): the backstop timer fired; the run did not return by its limit`);
    stop(EXIT_CODES.overall_timeout);
  }, cfg.overallTimeoutMs + BACKSTOP_GRACE_MS);
  log(`controller-away probe (READ-ONLY): overall limit ${cfg.overallTimeoutMs} ms, ${cfg.readbacks} readback(s) every ${cfg.readbackIntervalMs} ms, policy ${policy.length} rules`);
  const summary = await runAwayProbe(session, cfg, policy, log);
  clearTimeout(backstop);
  printSummary(summary);
  return summary.exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => process.exit(code), (e: unknown) => { console.error(`FATAL: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
}
