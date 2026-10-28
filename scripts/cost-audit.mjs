/**
 * cost-audit.mjs — Anthropic Usage Admin API token report, plus this repo's own cloud-call telemetry.
 *
 * Why this exists: the two cost levers in scripts/ai-utils.mjs (cheap-tier-first model routing,
 * Anthropic prompt caching for the network review) are informed guesses about where spend goes.
 * This script pulls the actual numbers so they can be confirmed or corrected, instead of optimizing
 * blind (Invariant 6: measured, not assumed).
 *
 * Requires an Anthropic ADMIN API key. As of 2026-10-27 (confirmed via Anthropic support, ticket
 * re: org 2bcd120f-2675-4457-bcdd-667c3f311eb5), the Console's "Admin API keys" UI from older docs no
 * longer exists as a separate page on non-Enterprise plans: an admin-scoped key is created by (1)
 * Organization Settings -> API Keys -> Service Accounts -> create a service account with the Admin
 * role, then (2) Organization Settings -> API Keys -> Create Key -> set "Linked account" to that
 * service account. A regular personal-account key does not have access to this endpoint and gets a
 * 403 -- that is a real, reportable failure, not something this script papers over.
 *
 * Reports TOKEN usage, not dollar cost: the cost_report / spend-limits endpoints are Enterprise-plan
 * only (confirmed 403 "Missing permissions" on a Platform-plan Admin key, per the same ticket). The
 * Console's Usage page (platform.claude.com/usage) shows actual billed dollars with the same
 * breakdown and CSV export; this script's token counts are for cross-checking the caching/routing
 * levers (e.g. cache_read vs. uncached input tokens), not for an authoritative dollar figure.
 *
 * Response shape (confirmed 2026-10-28 against the live reference at
 * platform.claude.com/docs/en/api/admin/usage_report/retrieve_messages, not guessed): a top-level
 * { data: [ { starting_at, ending_at, results: [ { model, uncached_input_tokens,
 * cache_read_input_tokens, output_tokens, cache_creation: { ephemeral_1h_input_tokens,
 * ephemeral_5m_input_tokens }, ... } ] } ], has_more, next_page }. parseMessagesUsageReport below reads
 * these exact fields; see test/invariants/cost-audit-usage-schema.test.ts, which pins it against the
 * documentation's own example response, independent of live credentials.
 *
 * Usage:
 *   ANTHROPIC_ADMIN_KEY=sk-ant-... node scripts/cost-audit.mjs [--days N] [--bucket 1m|1h|1d]
 *
 * This only reports what Anthropic metered. It does NOT cover Google/OpenAI spend (check those
 * providers' own billing consoles) or local Ollama (zero marginal $ cost by construction).
 */

import { loadEnv, WORKSTATION_METRICS_FILE } from './ai-utils.mjs';
import { existsSync, readFileSync } from 'fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

loadEnv();

const args = process.argv.slice(2);
const daysArgIndex = args.indexOf('--days');
const DAYS = daysArgIndex >= 0 && args[daysArgIndex + 1] ? Math.max(1, Math.min(365, parseInt(args[daysArgIndex + 1], 10) || 30)) : 30;
const bucketArgIndex = args.indexOf('--bucket');
const VALID_BUCKETS = new Set(['1m', '1h', '1d']);
const BUCKET_WIDTH = bucketArgIndex >= 0 && VALID_BUCKETS.has(args[bucketArgIndex + 1]) ? args[bucketArgIndex + 1] : '1d';

const ADMIN_KEY = process.env.ANTHROPIC_ADMIN_KEY;

// Matches the live reference doc's own example request (platform.claude.com/docs/en/api/admin/usage_report/
// retrieve_messages, fetched 2026-10-28): Authorization: Bearer, not x-api-key, and this dated version string.
const ANTHROPIC_VERSION = '2026-10-21';
const API_BASE = 'https://api.anthropic.com/v1/organizations';

function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

async function fetchAllPages(url, headers) {
  const pages = [];
  let next = url;
  let guard = 0;
  while (next && guard < 50) { // guard: a report should never paginate past ~50 pages for a 30-90 day window
    guard += 1;
    const res = await fetch(next, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable body>');
      throw new Error(`${res.status} ${res.statusText} from ${next}: ${body.slice(0, 2000)}`);
    }
    const data = await res.json();
    pages.push(data);
    const nextPageToken = data.next_page;
    if (!nextPageToken) break;
    const u = new URL(url);
    u.searchParams.set('page', nextPageToken);
    next = u.toString();
  }
  return pages;
}

// The exact token-count fields on a Usage API result item, per the confirmed schema (module docstring).
// cache_creation's two fields are one level nested; everything else is a direct field on the result.
const DIRECT_TOKEN_FIELDS = ['uncached_input_tokens', 'cache_read_input_tokens', 'output_tokens'];
const CACHE_CREATION_FIELDS = ['ephemeral_1h_input_tokens', 'ephemeral_5m_input_tokens'];

/**
 * Parses a Messages Usage Report response (one or more pages of { data: [{ results: [...] }] }) into
 * per-model token-count totals, using the exact field names from the confirmed schema (module
 * docstring) rather than a generic/guessed walk. A `results` item with a non-string `model` (null,
 * when the request didn't group_by model) is skipped with a count in `unattributed`, since summing it
 * under a fabricated model label would misattribute real usage (Invariant 6).
 */
export function parseMessagesUsageReport(pages) {
  const byModelField = new Map(); // key: `${model} :: ${field}` -> summed count
  const models = new Set();
  let unattributed = 0;

  const add = (model, field, value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    const key = `${model} :: ${field}`;
    byModelField.set(key, (byModelField.get(key) ?? 0) + value);
  };

  for (const page of pages) {
    const buckets = Array.isArray(page?.data) ? page.data : [];
    for (const bucket of buckets) {
      const results = Array.isArray(bucket?.results) ? bucket.results : [];
      for (const result of results) {
        if (typeof result?.model !== 'string' || result.model.length === 0) {
          unattributed += 1;
          continue;
        }
        const model = result.model;
        models.add(model);
        for (const field of DIRECT_TOKEN_FIELDS) add(model, field, result[field]);
        if (result.cache_creation && typeof result.cache_creation === 'object') {
          for (const field of CACHE_CREATION_FIELDS) add(model, `cache_creation.${field}`, result.cache_creation[field]);
        }
      }
    }
  }
  return { byModelField, models, unattributed };
}

function printLocalTelemetry() {
  const metricsPath = WORKSTATION_METRICS_FILE;
  console.log(`\n── Local telemetry (${metricsPath}, this repo's own review-gate calls) ──`);
  if (!existsSync(metricsPath)) {
    console.log('  Not found -- no review-gate cloud calls have been made from this checkout yet.');
    return;
  }
  try {
    const data = JSON.parse(readFileSync(metricsPath, 'utf-8'));
    console.log(`  Edge (local Ollama) compute ratio: ${data.edgeComputeRatioPct ?? '?'}%  (target: >=80% per the cost-optimization review)`);
    console.log(`  Total cloud tokens (prompt+completion, all providers): ${data.totalCloudTokens ?? '0'}`);
    console.log(`  Anthropic cache-write tokens (paid ~1.25x once): ${data.totalCacheCreationTokens ?? '0'}`);
    console.log(`  Anthropic cache-read tokens (paid ~10% per hit):  ${data.totalCacheReadTokens ?? '0'}`);
    console.log(`  Last cloud call: ${data.lastCloudProvider ?? '?'} / ${data.lastCloudModel ?? '?'}`);
  } catch (err) {
    console.warn(`  Failed to read/parse: ${err.message}`);
  }
}

async function main() {
  printLocalTelemetry();

  if (!ADMIN_KEY) {
    console.log(`\n── Anthropic Usage API token report ──`);
    console.log('  Skipped: ANTHROPIC_ADMIN_KEY is not set.');
    console.log('  Create one: Organization Settings -> API Keys -> Service Accounts -> create one with the Admin');
    console.log('  role, then API Keys -> Create Key -> Linked account = that service account.');
    console.log('  Then re-run: ANTHROPIC_ADMIN_KEY=sk-ant-... node scripts/cost-audit.mjs');
    console.log('  For actual billed dollars (not just token counts), see platform.claude.com/usage directly --');
    console.log('  the cost_report Admin API endpoint is Enterprise-plan only.');
    return;
  }

  const headers = { Authorization: `Bearer ${ADMIN_KEY}`, 'anthropic-version': ANTHROPIC_VERSION };
  const startingAt = isoDaysAgo(DAYS);

  console.log(`\n── Anthropic Usage API token report (last ${DAYS} days, since ${startingAt}, bucket=${BUCKET_WIDTH}) ──`);
  console.log('  Token counts only -- for billed dollars, see platform.claude.com/usage.');
  try {
    const url = `${API_BASE}/usage_report/messages?starting_at=${encodeURIComponent(startingAt)}&bucket_width=${BUCKET_WIDTH}&group_by[]=model`;
    const pages = await fetchAllPages(url, headers);
    const { byModelField, models, unattributed } = parseMessagesUsageReport(pages);
    if (byModelField.size === 0) {
      console.log('  API responded but no model-attributed results were found (empty range, or a shape this script');
      console.log('  no longer matches -- see the module docstring for the schema this parser expects).');
      console.log('  Raw first page (for manual inspection):');
      console.log(JSON.stringify(pages[0], null, 2).slice(0, 4000));
      return;
    }
    for (const model of [...models].sort()) {
      console.log(`  ${model}:`);
      const fields = [...byModelField.entries()].filter(([k]) => k.startsWith(`${model} :: `)).sort((a, b) => b[1] - a[1]);
      for (const [key, count] of fields) {
        const field = key.slice(`${model} :: `.length);
        console.log(`    ${field.padEnd(32)} ${count.toString()}`);
      }
    }
    if (unattributed > 0) {
      console.log(`  (${unattributed} result item(s) had no model attribution -- re-run with the default group_by[]=model)`);
    }
  } catch (err) {
    console.error(`  🚫 Usage report request failed: ${err.message}`);
    console.error('  This is a real failure (bad/missing admin key, insufficient permissions, or an API shape change) -- not silently skipped.');
    process.exitCode = 1;
  }
}

// Guarded (not a bare top-level call) so this module can be imported for testing -- e.g.
// test/invariants/cost-audit-usage-schema.test.ts -- without running main()'s network/env side effects.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
