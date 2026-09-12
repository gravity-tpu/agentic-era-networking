/**
 * ai-utils.mjs
 * Shared utilities for AI code review scripts in Agentic Era Networking.
 * Uses only Node built-ins so it executes in CI without a prior build step.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');

// ─── Node version guard ───────────────────────────────────────────────────────
if (typeof process.loadEnvFile !== 'function') {
  throw new Error(
    `process.loadEnvFile() is not available. Node ${process.version} detected. ` +
    'Please upgrade to Node >=20.12.0.'
  );
}

// ─── Env loading ──────────────────────────────────────────────────────────────
export function loadEnv() {
  for (const name of ['.env.local', '.env']) {
    const envPath = join(ROOT, name);
    if (existsSync(envPath)) {
      try {
        process.loadEnvFile(envPath);
      } catch (err) {
        console.warn(`⚠️  Failed to load env file at ${envPath}:`, err.message);
      }
    }
  }
}

// ─── Model config ─────────────────────────────────────────────────────────────
export function buildModelFallbacks(filterTier = null) {
  const configPath = join(ROOT, 'config', 'models.json');

  if (!existsSync(configPath)) {
    console.warn('🟡  config/models.json not found — using hardcoded fallbacks.');
    return [
      { model: 'gemini-3.8-flash',  provider: 'google' },
      { model: 'gemini-pro-latest', provider: 'google' },
    ];
  }

  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  const routing = config.routing ?? {};
  const seen = new Set();
  const list = [];

  const tiers = filterTier ? [filterTier] : ['pro', 'fast'];

  for (const tier of tiers) {
    const entry = routing[tier] ?? {};
    for (const provider of ['google', 'anthropic', 'openai']) {
      const model = entry[provider];
      if (model && !seen.has(model)) {
        seen.add(model);
        list.push({ model, provider });
      }
    }
  }

  return list;
}

// ─── Provider API calls ───────────────────────────────────────────────────────
export async function callGemini(model, systemPrompt, userMessage, signal) {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY not set (also checked GEMINI_API_KEY)');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '(No response)';
}

export async function callAnthropic(model, systemPrompt, userMessage, signal) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    signal,
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content?.[0]?.text ?? '(No response)';
}

export async function callOpenAI(model, systemPrompt, userMessage, signal) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    signal,
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '(No response)';
}

// ─── Fallback runner ──────────────────────────────────────────────────────────
const PER_MODEL_TIMEOUT_MS = 90_000;

export async function runWithFallback(fallbacks, systemPrompt, userMessage) {
  for (const { model, provider } of fallbacks) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), PER_MODEL_TIMEOUT_MS);
    try {
      console.log(`  ⏳  Trying ${model} (${provider})...`);
      let result;
      if (provider === 'google')         result = await callGemini(model, systemPrompt, userMessage, ac.signal);
      else if (provider === 'anthropic') result = await callAnthropic(model, systemPrompt, userMessage, ac.signal);
      else if (provider === 'openai')    result = await callOpenAI(model, systemPrompt, userMessage, ac.signal);
      else throw new Error(`Unknown provider: ${provider}`);

      console.log(`  ✅  Success with ${model}\n`);
      return { result, model };
    } catch (e) {
      const reason = e.name === 'AbortError' ? `timed out after ${PER_MODEL_TIMEOUT_MS / 1000}s` : e.message;
      console.warn(`  🟡  ${model} failed: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// ─── Diff processing & sanitization ──────────────────────────────────────────
export const GIT_DIFF_OPTIONS = {
  encoding: 'utf-8',
  maxBuffer: 50 * 1024 * 1024,
};

export function sanitizeDiff(rawDiff) {
  if (!rawDiff) return '';
  return rawDiff
    .split('\n')
    .map(line => {
      if (line.length > 500 && /data:image\/[^;]+;base64,/.test(line)) {
        return line.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, 'data:image/...[base64 image omitted]');
      }
      if (line.length > 500 && /^[+-][A-Za-z0-9+/=]{200,}\s*$/.test(line)) {
        return `${line[0]}[large base64/binary string omitted (${line.trim().length} chars)]`;
      }
      return line;
    })
    .join('\n');
}
