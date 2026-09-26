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
const IS_CI = !!(process.env.CI || process.env.GITHUB_ACTIONS);

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
  const ollamaConfig = config.ollama ?? {};
  const ollamaBaseUrl = ollamaConfig.baseUrl ?? 'http://localhost:11434';
  const ollamaTimeoutMs = typeof ollamaConfig.timeoutMs === 'number' ? ollamaConfig.timeoutMs : 150_000;
  const ollamaTemperature = typeof ollamaConfig.temperature === 'number' ? ollamaConfig.temperature : 0.2;
  const ollamaNumPredict = typeof ollamaConfig.numPredict === 'number' ? ollamaConfig.numPredict : 8192;
  const seen = new Set();
  const list = [];

  // Local Ollama tier: prepended first when running locally (not in CI).
  // Ollama is unreachable from GitHub Actions runners — skip entirely in CI.
  if (!IS_CI && !filterTier && routing.local?.ollama) {
    const model = routing.local.ollama;
    seen.add(model);
    list.push({
      model,
      provider: 'ollama',
      baseUrl: ollamaBaseUrl,
      timeoutMs: ollamaTimeoutMs,
      temperature: ollamaTemperature,
      numPredict: ollamaNumPredict,
    });
  }

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

/**
 * callOllama — OpenAI-compatible local inference via Ollama.
 * The Council system prompt is passed as the 'system' role message.
 * No API key required; model must be pulled locally via `ollama pull <model>`.
 */
export async function callOllama(
  model,
  systemPrompt,
  userMessage,
  signal,
  baseUrl = 'http://localhost:11434',
  options = {}
) {
  const url = `${baseUrl}/api/chat`;
  const temperature = options.temperature ?? 0.2;
  const num_predict = options.numPredict ?? 8192;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model,
      stream: false,
      options: { temperature, num_predict },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    throw new Error(`Ollama ${res.status} from ${url}: ${body}`);
  }
  const data = await res.json();
  const content = data.message?.content;
  if (!content || typeof content !== 'string' || !content.trim()) {
    throw new Error(`Ollama returned empty response for ${model}`);
  }
  return content;
}

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
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content || typeof content !== 'string' || !content.trim()) {
    throw new Error(`Gemini returned empty response for ${model}`);
  }
  return content;
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
  const content = data.content?.[0]?.text;
  if (!content || typeof content !== 'string' || !content.trim()) {
    throw new Error(`Anthropic returned empty response for ${model}`);
  }
  return content;
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
  const content = data.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string' || !content.trim()) {
    throw new Error(`OpenAI returned empty response for ${model}`);
  }
  return content;
}

// ─── Provider Registry ────────────────────────────────────────────────────────
const PROVIDER_DISPATCH = Object.freeze({
  ollama: (model, systemPrompt, userMessage, signal, item) =>
    callOllama(model, systemPrompt, userMessage, signal, item.baseUrl, {
      temperature: item.temperature,
      numPredict: item.numPredict,
    }),
  google: (model, systemPrompt, userMessage, signal) =>
    callGemini(model, systemPrompt, userMessage, signal),
  anthropic: (model, systemPrompt, userMessage, signal) =>
    callAnthropic(model, systemPrompt, userMessage, signal),
  openai: (model, systemPrompt, userMessage, signal) =>
    callOpenAI(model, systemPrompt, userMessage, signal),
});

export class NoAvailableModelsError extends Error {
  constructor(message = 'All model providers in fallback chain failed') {
    super(message);
    this.name = 'NoAvailableModelsError';
  }
}

// ─── Fallback runner ──────────────────────────────────────────────────────────
const PER_MODEL_TIMEOUT_MS = 90_000;

export async function runWithFallback(fallbacks, systemPrompt, userMessage) {
  for (const item of fallbacks) {
    const { model, provider, timeoutMs: itemTimeout } = item;
    const timeoutMs = itemTimeout ?? PER_MODEL_TIMEOUT_MS;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const label = provider === 'ollama' ? `${model} (local Ollama)` : `${model} (${provider})`;
      console.log(`  ⏳  Trying ${label}...`);
      const dispatch = PROVIDER_DISPATCH[provider];
      if (!dispatch) {
        throw new Error(`Unknown provider: ${provider}`);
      }
      const result = await dispatch(model, systemPrompt, userMessage, ac.signal, item);

      console.log(`  ✅  Success with ${model}\n`);
      return { result, model };
    } catch (e) {
      const reason = e.name === 'AbortError' ? `timed out after ${timeoutMs / 1000}s` : e.message;
      console.warn(`  🟡  ${model} failed: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new NoAvailableModelsError('All model providers in fallback chain failed');
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
