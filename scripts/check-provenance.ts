/**
 * scripts/check-provenance.ts
 * Programmatic Invariant Gate: Epistemic Telemetry Provenance & Goodhart's Law
 *
 * Council Invariant 6: Goodhart's Law & Epistemic Telemetry Provenance (Anti-Simulation Law)
 * Prevents synthetic telemetry, untagged mock device outputs, and artificial metric drift
 * from passing CI or pre-push gates.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = process.cwd();
const SCAN_DIRS = ['src', 'api', 'public'];
const EXCLUDE_DIRS = new Set(['node_modules', 'dist', '.git', 'test']);

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly message: string;
  readonly snippet: string;
}

function scanDirectory(dir: string, fileList: string[] = []): string[] {
  const fullDir = join(REPO_ROOT, dir);
  try {
    const entries = readdirSync(fullDir);
    for (const entry of entries) {
      if (EXCLUDE_DIRS.has(entry)) continue;
      const fullPath = join(fullDir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        scanDirectory(join(dir, entry), fileList);
      } else if (/\.(ts|js|mjs)$/.test(entry)) {
        fileList.push(fullPath);
      }
    }
  } catch {
    // Directory may not exist in some environments
  }
  return fileList;
}

function analyzeFile(filePath: string): Finding[] {
  const findings: Finding[] = [];
  const relPath = relative(REPO_ROOT, filePath);
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  // Rule 1: Check for mock hardware telemetry strings without simulation disclaimer
  const mockTempRegex = /CPU Temperature:\s*\d+/;
  const mockUidRegex = /CPU UID:\s*[\d-]+/;
  const hasSimulationDisclaimer = /(SIMULATION|SANDBOX|cloud_snapshot|disconnected)/i.test(content);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    // Check mock telemetry leaks
    if ((mockTempRegex.test(line) || mockUidRegex.test(line)) && !hasSimulationDisclaimer) {
      findings.push({
        file: relPath,
        line: lineNum,
        message: "Untagged mock hardware telemetry masquerading as live silicon (Goodhart's Law Invariant)",
        snippet: line.trim(),
      });
    }

    // Rule 2: Check for unverified source: 'live_hardware' assignment
    // Allowed strictly in zodiac-bridge-server.ts (physical socket verification) or via resolveVerifiedProvenance
    if (/source\s*:\s*['"]live_hardware['"]/.test(line)) {
      const isAuthorizedBridge = relPath.includes('zodiac-bridge-server.ts');
      const hasVerifiedGuard = content.includes('resolveVerifiedProvenance') || content.includes('assertVerifiedProvenance');
      if (!isAuthorizedBridge && !hasVerifiedGuard) {
        findings.push({
          file: relPath,
          line: lineNum,
          message: "Unverified assignment of 'live_hardware' without transport verification or bridge guard",
          snippet: line.trim(),
        });
      }
    }

    // Rule 3: Check for artificial constant counter increments (e.g. += 128n)
    const constIncRegex = /(rxBytes|txBytes|rxPackets|txPackets)\s*\+=\s*\d+n?/;
    if (constIncRegex.test(line)) {
      // Check if this is an accumulator loop over a dynamic collection (e.g. for (const p of snapshot.ports))
      const isAccumulator = /total(Rx|Tx)(Bytes|Pkts)\s*\+=/.test(line) || /accumulate/.test(line);
      if (!isAccumulator) {
        findings.push({
          file: relPath,
          line: lineNum,
          message: "Artificial constant counter increment detected (Anti-Simulation Law)",
          snippet: line.trim(),
        });
      }
    }

    // Rule 4: Hardware probes returning mock/connected defaults (Council Invariant 3 & 6)
    // Physical probes in hardware-probe.ts must fail closed to isDisconnected=true.
    if (relPath.includes('hardware-probe.ts') && /createDefault(Coral|Jetson)Snapshot\s*\(\s*false\s*\)/.test(line)) {
      findings.push({
        file: relPath,
        line: lineNum,
        message: "Hardware probe cannot return simulated default snapshot with isDisconnected=false; physical probe must fail-closed to disconnected (Invariant 6).",
        snippet: line.trim(),
      });
    }

    // Rule 5: Coral USB thermal simulation check
    // Physical truth: Coral USB does not expose an on-die thermal zone in sysfs; temperatureC must always be null.
    if (/coral/i.test(line) && /temperatureC\s*:\s*[0-9.]+/.test(line)) {
      findings.push({
        file: relPath,
        line: lineNum,
        message: "Coral USB Accelerator has no mapped sysfs thermal zone; temperatureC must evaluate to null, not a fabricated heuristic (Invariant 6).",
        snippet: line.trim(),
      });
    }

    // Rule 6: Jetson UI status coupling check (public/zodiac-app.js)
    // Jetson host liveness must not be coupled to the Zodiac switch serial connection (snapshot.source)
    if (relPath.includes('zodiac-app.js') && /orin.*snapshot\.source\s*!==\s*['"]disconnected['"]/i.test(line)) {
      findings.push({
        file: relPath,
        line: lineNum,
        message: "Jetson host liveness in UI must not be coupled to Zodiac switch serial connection state (Council Invariant 6).",
        snippet: line.trim(),
      });
    }

    // Rule 7: Hardware probe hardcoded fallback CPU temperatures (Council Invariant 6)
    if (relPath.includes('hardware-probe.ts') && /cpuC\s*:\s*[0-9]+(\.[0-9]+)?/.test(line)) {
      findings.push({
        file: relPath,
        line: lineNum,
        message: "Hardware probe cannot contain hardcoded fallback CPU temperatures; must evaluate to physical sysfs or null (Council Invariant 6).",
        snippet: line.trim(),
      });
    }
  }

  return findings;
}

export function runProvenanceAudit(): boolean {
  console.log('\n🔍 Senior Staff Overseer: Epistemic Telemetry Provenance Audit (Council Invariant 6)');
  const allFiles: string[] = [];
  for (const dir of SCAN_DIRS) {
    scanDirectory(dir, allFiles);
  }

  console.log(`   Scanning ${allFiles.length} source files across ${SCAN_DIRS.join(', ')}...`);

  const allFindings: Finding[] = [];
  for (const file of allFiles) {
    const findings = analyzeFile(file);
    allFindings.push(...findings);
  }

  if (allFindings.length === 0) {
    console.log('   ✓ 100% Epistemic Provenance Integrity: Zero untagged mocks or artificial counter drifts detected.\n');
    return true;
  }

  console.error(`\n❌ Epistemic Provenance Audit FAILED with ${allFindings.length} violation(s):`);
  for (const f of allFindings) {
    console.error(`   - ${f.file}:${f.line} [${f.message}]`);
    console.error(`     Snippet: ${f.snippet}`);
  }
  console.error('\nFix the above provenance violations before pushing. Every metric must carry verifiable physical origin.\n');
  return false;
}

// Direct CLI invocation
const isMain = process.argv[1]?.endsWith('check-provenance.ts') || process.argv[1]?.endsWith('check-provenance.js');
if (isMain) {
  const passed = runProvenanceAudit();
  process.exit(passed ? 0 : 1);
}
