/**
 * Every test worker gets its own quarantine state file, so no test reads quarantines saved by another test (or by a real bridge
 * on the same machine) and no test writes into /var/lib/zodiac. Tests of the persistence itself set their own path.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const workerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zodiac-test-qstate-'));
process.env['ZODIAC_QUARANTINE_STATE_FILE'] = path.join(workerDir, 'quarantine-state.json');
// The install gate's audit trail goes to the worker's own directory too, never to /var/lib/zodiac.
process.env['ZODIAC_GATE_AUDIT_FILE'] = path.join(workerDir, 'install-gate-audit.jsonl');
process.env['ZODIAC_CALLER_AUDIT_FILE'] = path.join(workerDir, 'install-gate-callers.jsonl');

// A fresh bridge in the next test must not restore what the previous test's bridge saved.
beforeEach(() => {
  const file = process.env['ZODIAC_QUARANTINE_STATE_FILE'];
  if (file !== undefined && !file.startsWith(os.tmpdir())) return; // a test that points at its own path manages it itself
  if (file !== undefined) fs.rmSync(file, { force: true });
  const audit = process.env['ZODIAC_GATE_AUDIT_FILE'];
  if (audit !== undefined && audit.startsWith(os.tmpdir())) fs.rmSync(audit, { force: true });
  const callers = process.env['ZODIAC_CALLER_AUDIT_FILE'];
  if (callers !== undefined && callers.startsWith(os.tmpdir())) fs.rmSync(callers, { force: true });
});
