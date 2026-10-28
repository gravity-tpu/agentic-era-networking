/**
 * cost-audit.mjs — Anthropic Admin API cost/usage report, plus this repo's own cloud-call telemetry.
 *
 * Why this exists: the two cost levers in scripts/ai-utils.mjs (cheap-tier-first model routing,
 * Anthropic prompt caching for the network review) are informed guesses about where spend goes.
 * This script pulls the actual numbers so they can be confirmed or corrected, instead of optimizing
 * blind (Invariant 6: measured, not assumed).
 *
 * Requires an Anthropic ADMIN API key (starts with sk-ant-admin..., distinct from a regular
 * ANTHROPIC_API_KEY; created by an organization admin in the Anthropic Console under
 * Settings -> Admin API keys). A regular API key does not have access to these endpoints and will
 * get a 403/404 -- that is a real, reportable failure, not something this script papers over.
 *
 * Usage:
 *   ANTHROPIC_ADMIN_KEY=sk-ant-admin-... node scripts/cost-audit.mjs [--days N]
 *
 * This only reports what Anthropic billed. It does NOT cover Google/OpenAI spend (check those
 * providers' own billing consoles) or local Ollama (zero marginal $ cost by construction).
 */

import { loadEnv, WORKSTATION_METRICS_FILE } from './ai-utils.mjs';
import { existsSync, readFileSync } from 'fs';

loadEnv();

const args = process.argv.slice(2);
const daysArgIndex = args.indexOf('--days');
const DAYS = daysArgIndex >= 0 && args[daysArgIndex + 1] ? Math.max(1, Math.min(365, parseInt(args[daysArgIndex + 1], 10) || 30)) : 30;

const ADMIN_KEY = process.env.ANTHROPIC_ADMIN_KEY;

const ANTHROPIC_VERSION = '2023-06-01';
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

/** Sums every numeric `amount`-shaped field it can find, grouped by the clearest available
 * dimension (model, then workspace, then 'unlabeled'). Walks generically rather than assuming a
 * fixed response shape, since this script's job is to surface what the API actually returns. */
function summarizeCostPages(pages) {
  const byKey = new Map();
  let total = 0;
  let currency = null;

  function visit(node) {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    // Require `currency` alongside `amount`, not just any numeric `amount` field: a billable cost
    // line item always reports its currency, so this excludes unrelated amount-shaped fields (e.g.
    // a credit-adjustment or quota count) that would otherwise silently inflate the total.
    if ((typeof node.amount === 'string' || typeof node.amount === 'number') && typeof node.currency === 'string' && node.currency.length > 0) {
      const amount = Number(node.amount);
      if (Number.isFinite(amount)) {
        const key = node.model || node.workspace_id || node.description || 'unlabeled';
        byKey.set(key, (byKey.get(key) ?? 0) + amount);
        total += amount;
        currency = node.currency;
      }
    }
    for (const v of Object.values(node)) visit(v);
  }
  pages.forEach(visit);
  return { byKey, total, currency: currency ?? 'USD (assumed; API did not report a currency field)' };
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
    console.log(`\n── Anthropic Admin API cost report ──`);
    console.log('  Skipped: ANTHROPIC_ADMIN_KEY is not set.');
    console.log('  Create one at console.anthropic.com -> Settings -> Admin API keys (requires an org admin role),');
    console.log('  then re-run: ANTHROPIC_ADMIN_KEY=sk-ant-admin-... node scripts/cost-audit.mjs');
    return;
  }

  const headers = { 'x-api-key': ADMIN_KEY, 'anthropic-version': ANTHROPIC_VERSION };
  const startingAt = isoDaysAgo(DAYS);

  console.log(`\n── Anthropic Admin API cost report (last ${DAYS} days, since ${startingAt}) ──`);
  try {
    const url = `${API_BASE}/cost_report?starting_at=${encodeURIComponent(startingAt)}&group_by[]=model`;
    const pages = await fetchAllPages(url, headers);
    const { byKey, total, currency } = summarizeCostPages(pages);
    if (byKey.size === 0) {
      console.log('  API responded but no cost line items were found in the expected shape.');
      console.log('  Raw first page (for manual inspection):');
      console.log(JSON.stringify(pages[0], null, 2).slice(0, 4000));
      return;
    }
    const sorted = [...byKey.entries()].sort((a, b) => b[1] - a[1]);
    for (const [key, amount] of sorted) {
      console.log(`  ${key.padEnd(28)} ${amount.toFixed(2)} ${currency}`);
    }
    console.log(`  ${'TOTAL'.padEnd(28)} ${total.toFixed(2)} ${currency}`);
  } catch (err) {
    console.error(`  🚫 Cost report request failed: ${err.message}`);
    console.error('  This is a real failure (bad/missing admin key, no admin role, or an API shape change) -- not silently skipped.');
    process.exitCode = 1;
  }
}

main();
