/**
 * ai-utils.mjs
 * Shared utilities for AI code review scripts in Agentic Era Networking.
 * Uses only Node built-ins so it executes in CI without a prior build step.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, watch, promises as fsPromises } from 'fs';
import { join, dirname, basename } from 'path';
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

// Cached config singleton to eliminate redundant disk I/O on CLI utility calls
let _cachedConfig = null;

// Note: loadModelsConfig uses synchronous readFileSync on startup. This module is strictly CLI review
// and developer tooling (off-critical-path) and is never invoked on high-performance packet pathways.
export function loadModelsConfig() {
  if (_cachedConfig) return _cachedConfig;
  const configPath = join(ROOT, 'config', 'models.json');
  if (!existsSync(configPath)) {
    return null;
  }
  try {
    _cachedConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    return _cachedConfig;
  } catch (err) {
    console.warn('⚠️  Failed to parse config/models.json:', err.message);
    return null;
  }
}

export function buildModelFallbacks(filterTier = null) {
  const config = loadModelsConfig();

  if (!config) {
    console.warn('🟡  config/models.json not found — using hardcoded fallbacks.');
    return [
      { model: 'gemini-3.8-flash',  provider: 'google' },
      { model: 'gemini-pro-latest', provider: 'google' },
    ];
  }

  const routing = config.routing ?? {};
  const ollamaConfig = config.ollama ?? {};
  // OLLAMA_BASE_URL overrides config/models.json so a machine-specific bind address
  // (e.g. a Tailscale IP) never has to be hardcoded as the shared default for every host.
  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || ollamaConfig.baseUrl || 'http://localhost:11434';
  const ollamaTimeoutMs = typeof ollamaConfig.timeoutMs === 'number' ? ollamaConfig.timeoutMs : 150_000;
  const ollamaTemperature = typeof ollamaConfig.temperature === 'number' ? ollamaConfig.temperature : 0.2;
  const ollamaNumPredict = typeof ollamaConfig.numPredict === 'number' ? ollamaConfig.numPredict : 8192;
  const seen = new Set();
  const list = [];

  // Local Ollama tier: prepended first when running locally (not in CI), unless explicitly skipped
  // or a cloud provider is explicitly requested (e.g. SKIP_OLLAMA=1 or AI_PROVIDER=google).
  // Ollama is unreachable from GitHub Actions runners — skip entirely in CI.
  const skipOllama = !!(
    process.env.SKIP_OLLAMA === '1' ||
    process.env.SKIP_OLLAMA === 'true' ||
    process.env.AI_PROVIDER === 'google' ||
    process.env.PREFER_GEMINI === '1' ||
    process.env.PREFER_GEMINI === 'true'
  );
  if (!IS_CI && !skipOllama && !filterTier && routing.local?.ollama) {
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

export const DEFAULT_GLOBAL_TIMEOUT_MS = 180_000;
export const DEFAULT_GLOBAL_TIMEOUT_MS_BIGINT = 180_000n;
export const PER_MODEL_TIMEOUT_MS = 90_000;
export const PER_MODEL_TIMEOUT_MS_BIGINT = 90_000n;
/**
 * Maximum timeout representable as a signed 32-bit integer in milliseconds (2^31 - 1 = 2,147,483,647 ms ≈ 24.8 days).
 * Node.js and libuv timers wrap when timeout values exceed 32-bit signed integers, causing setTimeout to fire immediately (defaulting to 1ms).
 * This constant protects against 32-bit overflow while preserving strict BigInt precision. Do not change to Number.MAX_SAFE_INTEGER.
 */
export const MAX_TIMEOUT_MS_BIGINT = 2_147_483_647n;

/**
 * Normalizes a timeout value (in milliseconds) to BigInt.
 * Enforces strict integer typing: rejects negative values, non-integers, and non-numeric types.
 * Avoids magic heuristic coercion or silent fallbacks.
 */
export function toTimeoutBigInt(value, defaultValueBigInt, label = 'timeout') {
  if (value === undefined || value === null) {
    return defaultValueBigInt;
  }
  if (typeof value === 'bigint') {
    if (value <= 0n) throw new RangeError(`${label} must be positive, got ${value}`);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0) {
      throw new TypeError(`${label} must be a positive integer, got ${value}`);
    }
    return BigInt(value);
  }
  throw new TypeError(`${label} must be a positive integer number or bigint, got ${typeof value}`);
}

export function getGlobalTimeoutMs() {
  const config = loadModelsConfig();
  if (!config) return DEFAULT_GLOBAL_TIMEOUT_MS;
  const timeout = config.globalTimeoutMs;
  return typeof timeout === 'number' && Number.isInteger(timeout) && timeout > 0
    ? timeout
    : DEFAULT_GLOBAL_TIMEOUT_MS;
}

// ─── Provider API calls ───────────────────────────────────────────────────────

export const MAX_ERROR_BODY_BYTES = 8192; // 8KB bound to prevent OOM on malicious or malformed response streams

/**
 * Safely extracts a bounded slice of error details from an HTTP response without
 * risking unbounded memory allocation (OOM) or swallowing stream read errors.
 */
export async function readErrorBody(res, maxBytes = MAX_ERROR_BODY_BYTES) {
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json') && !contentType.includes('text/')) {
    return `[non-text content-type: ${contentType || 'none'}]`;
  }
  if (!res.body) {
    return '(empty body)';
  }
  try {
    const reader = res.body.getReader();
    const chunks = [];
    let bytesRead = 0;
    let isTruncated = false;
    let cancelDiagnostic = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done || !value) break;

      const remainingBudget = maxBytes - bytesRead;
      if (value.length <= remainingBudget) {
        chunks.push(value);
        bytesRead += value.length;
      } else {
        const slice = value.subarray(0, remainingBudget);
        chunks.push(slice);
        bytesRead += slice.length;
        try {
          await reader.cancel('Error body size limit exceeded');
        } catch (cancelErr) {
          // Embed diagnostic into telemetry string rather than blocking stdout/stderr in packet/stream path
          cancelDiagnostic = `; stream-cancel error: ${cancelErr?.message ?? cancelErr}`;
        }
        isTruncated = true;
        break;
      }
    }

    // Allocate flat Uint8Array and decode once to avoid O(N^2) string allocations
    const combined = new Uint8Array(bytesRead);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    // If truncated, avoid splitting a multi-byte UTF-8 code point at the boundary.
    // In UTF-8:
    // - Continuation bytes match bit pattern 10xxxxxx (byte & 0xC0 === 0x80)
    // - 2-byte sequence lead byte matches 110xxxxx (byte & 0xE0 === 0xC0)
    // - 3-byte sequence lead byte matches 1110xxxx (byte & 0xF0 === 0xE0)
    // - 4-byte sequence lead byte matches 11110xxx (byte & 0xF8 === 0xF0)
    let validLength = bytesRead;
    if (isTruncated && validLength > 0) {
      let i = validLength - 1;
      let continuationBytes = 0;
      while (i >= 0 && (combined[i] & 0xc0) === 0x80 && continuationBytes < 3) {
        continuationBytes++;
        i--;
      }
      if (i >= 0) {
        const lead = combined[i];
        let expectedTotal = 1;
        if ((lead & 0xe0) === 0xc0) expectedTotal = 2;
        else if ((lead & 0xf0) === 0xe0) expectedTotal = 3;
        else if ((lead & 0xf8) === 0xf0) expectedTotal = 4;

        if (continuationBytes + 1 < expectedTotal) {
          validLength = i; // drop incomplete trailing multi-byte sequence to prevent \uFFFD corruption
        }
      }
    }

    // Strict fatal: true ensures any genuinely corrupt byte stream fails closed rather than producing silent \uFFFD artifacts
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const text = decoder.decode(combined.subarray(0, validLength));
    return isTruncated ? `${text} ...[truncated at ${maxBytes} bytes${cancelDiagnostic}]` : text;
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    return `[stream read error: ${errMsg}]`;
  }
}

export const WORKSTATION_METRICS_FILE = '/tmp/zodiac-workstation-telemetry.json';

function parseBigIntSafe(val, fallback = 0n) {
  if (typeof val === 'bigint') return val < 0n ? 0n : val;
  if (typeof val === 'number') {
    if (!Number.isFinite(val) || !Number.isInteger(val) || val < 0) {
      return fallback;
    }
    return BigInt(val);
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!/^\d+$/.test(trimmed)) {
      return fallback;
    }
    try {
      const n = BigInt(trimmed);
      return n < 0n ? 0n : n;
    } catch (err) {
      process.stderr.write(`[ai-utils] Warning parsing BigInt string "${trimmed}": ${err?.message ?? err}\n`);
      return fallback;
    }
  }
  return fallback;
}

// ─── Serialized Telemetry Mutation Queue & Cross-Process File Lock ──────────
// Council Invariant 2 (Determinism in Telemetry & Metering)
// Eliminates Read-Modify-Write race conditions across concurrent inferences.

let telemetryMutationQueue = Promise.resolve();

export const DEFAULT_TELEMETRY_LOCK_TIMEOUT_NS = 5_000_000_000n; // 5.0 seconds in monotonic nanoseconds (Jeff Dean Latency Standard)

/**
 * Event-driven lock acquisition: waits for file release events using fs.watch on parent directory,
 * backed by a bounded Dean latency budget timeout to eliminate magic polling heuristics (Council Invariant 5).
 */
function waitForLockRelease(lockPath, timeoutMs = 50) {
  return new Promise((resolve) => {
    const dir = dirname(lockPath);
    const targetFile = basename(lockPath);
    let watcher = null;
    let timer = null;
    let resolved = false;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (watcher) {
        try {
          watcher.close();
        } catch (watchErr) {
          process.stderr.write(`[ai-utils] Warning closing lock watcher on ${lockPath}: ${watchErr?.message ?? watchErr}\n`);
        }
        watcher = null;
      }
    };

    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);

    try {
      watcher = watch(dir, (eventType, filename) => {
        if (!filename || filename === targetFile) {
          cleanup();
          resolve();
        }
      });
      watcher.on('error', (err) => {
        process.stderr.write(`[ai-utils] Warning on lock watcher for ${lockPath}: ${err?.message ?? err}\n`);
        cleanup();
        resolve();
      });
    } catch (err) {
      process.stderr.write(`[ai-utils] Warning initializing watch on ${dir}: ${err?.message ?? err}\n`);
      cleanup();
      resolve();
    }
  });
}

/**
 * Acquires a cross-process mutual exclusion lock using 'wx' atomic file creation,
 * executes the given async mutation, and safely releases the lock.
 * Uses monotonic process.hrtime.bigint() to prevent clock jump vulnerabilities (Jeff Dean Invariant)
 * and verifies process liveness via OS kernel signal 0 (ESRCH) to recover genuinely
 * orphaned locks without relying on brittle timing heuristics (Quoc Le Invariant).
 */
async function withTelemetryFileLock(filePath, fn) {
  const lockPath = `${filePath}.lock`;
  const maxWaitNs = process.env['ZODIAC_TELEMETRY_LOCK_TIMEOUT_NS']
    ? BigInt(process.env['ZODIAC_TELEMETRY_LOCK_TIMEOUT_NS'])
    : DEFAULT_TELEMETRY_LOCK_TIMEOUT_NS;
  const startNs = process.hrtime.bigint();

  while (true) {
    try {
      const handle = await fsPromises.open(lockPath, 'wx');
      try {
        await handle.write(JSON.stringify({ pid: process.pid, createdAtNs: process.hrtime.bigint().toString() }));
      } finally {
        await handle.close();
      }
      break; // Lock acquired
    } catch (lockErr) {
      if (lockErr && lockErr.code === 'EEXIST') {
        // Epistemic Liveness Check: verify if the lock holder process is still alive in the OS kernel
        try {
          const stats = await fsPromises.stat(lockPath);
          const lockRaw = await fsPromises.readFile(lockPath, 'utf-8');
          let orphaned = false;

          if (!lockRaw.trim()) {
            // 0-byte or empty lockfile older than 500ms indicates crashed initializer
            if (Date.now() - stats.mtimeMs > 500) {
              orphaned = true;
            }
          } else {
            try {
              const lockData = JSON.parse(lockRaw);
              if (lockData && typeof lockData.pid === 'number') {
                try {
                  // Signal 0 tests for process existence without sending an actual kill signal
                  process.kill(lockData.pid, 0);
                } catch (sigErr) {
                  if (sigErr && sigErr.code === 'ESRCH') {
                    // Process no longer exists — lock is genuinely orphaned
                    orphaned = true;
                  } else {
                    process.stderr.write(`[ai-utils] Warning testing lock PID ${lockData.pid}: ${sigErr?.message ?? sigErr}\n`);
                  }
                }
              }
            } catch (jsonErr) {
              process.stderr.write(`[ai-utils] Warning parsing lockfile JSON ${lockPath}: ${jsonErr?.message ?? jsonErr}\n`);
              if (Date.now() - stats.mtimeMs > 500) {
                orphaned = true;
              }
            }
          }

          if (orphaned) {
            try {
              await fsPromises.unlink(lockPath);
            } catch (unlinkOrphanErr) {
              if (unlinkOrphanErr && unlinkOrphanErr.code !== 'ENOENT') {
                process.stderr.write(`[ai-utils] Warning unlinking orphaned lockfile ${lockPath}: ${unlinkOrphanErr?.message ?? unlinkOrphanErr}\n`);
              }
            }
          }
        } catch (statErr) {
          if (statErr && statErr.code !== 'ENOENT') {
            process.stderr.write(`[ai-utils] Warning stating lockfile ${lockPath}: ${statErr?.message ?? statErr}\n`);
          }
        }

        if (process.hrtime.bigint() - startNs > maxWaitNs) {
          throw new Error(`Timed out waiting for telemetry lock: ${lockPath}`);
        }
        // Event-driven lock acquisition (Oriol Vinyals & Jeff Dean): wait for directory file change/deletion event via fs.watch
        await waitForLockRelease(lockPath, 50);
      } else {
        throw lockErr;
      }
    }
  }

  try {
    return await fn();
  } finally {
    try {
      await fsPromises.unlink(lockPath);
    } catch (unlinkErr) {
      if (unlinkErr && unlinkErr.code !== 'ENOENT') {
        process.stderr.write(`[ai-utils] Warning unlinking lockfile ${lockPath}: ${unlinkErr?.message ?? unlinkErr}\n`);
      }
    }
  }
}

/**
 * Enqueues a telemetry mutation into a serialized Promise chain and executes it under
 * cross-process file-level mutual exclusion. Guarantees deterministic, sequential RMW.
 */
export function enqueueTelemetryMutation(filePath, mutateFn) {
  const task = async () => {
    try {
      return await withTelemetryFileLock(filePath, mutateFn);
    } catch (err) {
      process.stderr.write(`[ai-utils] Telemetry file lock failure: ${err?.message ?? err}\n`);
      return undefined;
    }
  };
  const next = telemetryMutationQueue.then(task, task);
  telemetryMutationQueue = next.catch((err) => {
    process.stderr.write(`[ai-utils] Telemetry mutation queue error: ${err?.message ?? err}\n`);
  });
  return next;
}

// ─── Asynchronous Telemetry Task Registry ────────────────────────────────────
// Jeff Dean Latency Budget & Systems Decoupling:
// Recording metrics to disk must NEVER block the inference response microtask
// on the critical path. Background tasks are tracked in a set and drained via
// flushPendingTelemetry() before process exit to prevent floating promise drops.
//
// Sanjay Ghemawat Invariant (Bounded Flat Resource Bounds):
// Hard concurrency cap on in-flight telemetry tasks prevents unbounded heap growth
// or memory leaks during high-frequency inference loops or degraded I/O sinks.
export const MAX_PENDING_TELEMETRY_TASKS = 64;
export const DEFAULT_TELEMETRY_DRAIN_TIMEOUT_MS = 5000;

const pendingTelemetryTasks = new Set();

/**
 * Returns current count of in-flight telemetry mutation promises.
 * @returns {number}
 */
export function getPendingTelemetryTaskCount() {
  return pendingTelemetryTasks.size;
}

/**
 * Tracks a non-critical background telemetry promise to allow graceful draining
 * without blocking critical-path TTFT latency budgets.
 * Applies backpressure fail-closed if pending task queue reaches capacity.
 *
 * @param {Promise<unknown>} promise
 */
export function trackTelemetryTask(promise) {
  if (!promise || typeof promise.then !== 'function') return;

  if (pendingTelemetryTasks.size >= MAX_PENDING_TELEMETRY_TASKS) {
    process.stderr.write(`[ai-utils] Warning: telemetry queue saturated (${pendingTelemetryTasks.size}/${MAX_PENDING_TELEMETRY_TASKS}), dropping newest task\n`);
    promise.catch((err) => {
      process.stderr.write(`[ai-utils] Dropped telemetry task rejected: ${String(err?.message ?? err)}\n`);
    });
    return;
  }

  pendingTelemetryTasks.add(promise);
  // Guarantee task pruning upon resolution or rejection to prevent monotonic queue saturation
  promise
    .catch((err) => {
      process.stderr.write(`[ai-utils] Pending telemetry task rejected: ${String(err?.message ?? err)}\n`);
    })
    .finally(() => {
      pendingTelemetryTasks.delete(promise);
    });
}


/**
 * Drains all in-flight background telemetry mutations prior to process exit.
 * Prevents process shutdown from dropping active file locks or partial atomic writes.
 *
 * @param {number} [timeoutMs=DEFAULT_TELEMETRY_DRAIN_TIMEOUT_MS]
 */
export async function flushPendingTelemetry(timeoutMs = DEFAULT_TELEMETRY_DRAIN_TIMEOUT_MS) {
  if (pendingTelemetryTasks.size === 0) return;
  const tasks = Array.from(pendingTelemetryTasks);
  let timerId;
  const timeoutPromise = new Promise((resolve) => {
    timerId = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([
      Promise.allSettled(tasks),
      timeoutPromise,
    ]);
  } catch (err) {
    process.stderr.write(`[ai-utils] Error flushing telemetry tasks: ${err?.message ?? err}\n`);
  } finally {
    clearTimeout(timerId);
  }
}


/**
 * Records Ollama inference token metrics into local telemetry file asynchronously.
 * Used by probeWorkstationHardware to report physical token velocities and totals.
 * Council Invariant 2: Uses BigInt counters to prevent precision loss for counts > 2^53 - 1.
 * Council Invariant 1: Serialized transaction queue eliminates Read-Modify-Write race conditions.
 * Jeff Dean Latency Budget: Non-blocking asynchronous I/O; serialized queue guarantees atomic increments.
 */
export async function recordOllamaInferenceMetrics(data, model = 'gemma4:26b', filePath = WORKSTATION_METRICS_FILE) {
  if (!data || typeof data !== 'object') return;
  return enqueueTelemetryMutation(filePath, async () => {
    let totalPromptTokens = 0n;
    let totalCompletionTokens = 0n;
    let totalInferences = 0n;
    let peakTokensPerSecond = 0;
    let peakPromptTokensPerSecond = 0;
    let cloudTokens = 0n;

    if (existsSync(filePath)) {
      try {
        const raw = await fsPromises.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          totalPromptTokens = parseBigIntSafe(parsed.totalPromptTokens);
          totalCompletionTokens = parseBigIntSafe(parsed.totalCompletionTokens);
          totalInferences = parseBigIntSafe(parsed.totalInferences);
          peakTokensPerSecond = typeof parsed.peakTokensPerSecond === 'number' ? parsed.peakTokensPerSecond : Number(parsed.peakTokensPerSecond || 0);
          peakPromptTokensPerSecond = typeof parsed.peakPromptTokensPerSecond === 'number' ? parsed.peakPromptTokensPerSecond : Number(parsed.peakPromptTokensPerSecond || 0);
          cloudTokens = parseBigIntSafe(parsed.totalCloudTokens);
        }
      } catch (readErr) {
        if (readErr?.code !== 'ENOENT') {
          process.stderr.write(`[ai-utils] Warning reading telemetry state file: ${readErr?.message ?? readErr}\n`);
        }
      }
    }

    const promptTokens = parseBigIntSafe(data.prompt_eval_count);
    const completionTokens = parseBigIntSafe(data.eval_count);
    const evalDurationNs = parseBigIntSafe(data.eval_duration);
    const promptEvalDurationNs = parseBigIntSafe(data.prompt_eval_duration);
    const totalDurationNs = parseBigIntSafe(data.total_duration);
    const loadDurationNs = parseBigIntSafe(data.load_duration);

    // Council Invariant 2 (Determinism in Telemetry & Metering): Integer arithmetic only.
    // Velocity is measured in integer tokens per second: (tokens * 1_000_000_000n) / durationNs
    const tokPerSecBigInt = evalDurationNs > 0n
      ? (completionTokens * 1_000_000_000n) / evalDurationNs
      : 0n;
    const promptTokPerSecBigInt = promptEvalDurationNs > 0n
      ? (promptTokens * 1_000_000_000n) / promptEvalDurationNs
      : 0n;

    const tokPerSec = Number(tokPerSecBigInt);
    const promptTokPerSec = Number(promptTokPerSecBigInt);

    peakTokensPerSecond = Math.max(peakTokensPerSecond, tokPerSec);
    peakPromptTokensPerSecond = Math.max(peakPromptTokensPerSecond, promptTokPerSec);

    const newTotalPromptTokens = totalPromptTokens + promptTokens;
    const newTotalCompletionTokens = totalCompletionTokens + completionTokens;
    const newTotalInferences = totalInferences + 1n;
    const totalLocalTokens = newTotalPromptTokens + newTotalCompletionTokens;
    const allTokens = totalLocalTokens + cloudTokens;
    const edgeComputeRatioPct = allTokens > 0n
      ? Number((totalLocalTokens * 100n) / allTokens)
      : 100;

    const perTokenLatencyNs = completionTokens > 0n ? evalDurationNs / completionTokens : 0n;

    const updated = {
      totalPromptTokens: newTotalPromptTokens.toString(),
      totalCompletionTokens: newTotalCompletionTokens.toString(),
      totalTokens: totalLocalTokens.toString(),
      totalInferences: newTotalInferences.toString(),
      tokensPerSecond: tokPerSec,
      promptTokensPerSecond: promptTokPerSec,
      peakTokensPerSecond,
      peakPromptTokensPerSecond,
      lastInferenceLatencyNs: totalDurationNs.toString(),
      lastPromptEvalDurationNs: promptEvalDurationNs.toString(),
      lastEvalDurationNs: evalDurationNs.toString(),
      lastLoadDurationNs: loadDurationNs.toString(),
      timeToFirstTokenNs: promptEvalDurationNs.toString(),
      perTokenLatencyNs: perTokenLatencyNs.toString(),
      lastTokenCount: Number(completionTokens),
      lastPromptTokenCount: Number(promptTokens),
      lastTotalTokenCount: Number(promptTokens + completionTokens),
      activeModel: model,
      edgeComputeRatioPct,
      lastUpdatedMs: Date.now(),
    };

    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fsPromises.writeFile(tmpPath, JSON.stringify(updated, null, 2), 'utf-8');
    await fsPromises.rename(tmpPath, filePath);
    return updated;
  });
}

/**
 * Records cloud fallback tokens into telemetry file to accurately account for edge offload ratio.
 * Council Invariant 6: Physical truth & Epistemic Telemetry Provenance.
 * Council Invariant 2: Deterministic BigInt counters guarded by serialized queue.
 */
export async function recordCloudInferenceMetrics(provider, model, promptTokensCount, completionTokensCount, filePath = WORKSTATION_METRICS_FILE) {
  return enqueueTelemetryMutation(filePath, async () => {
    let totalPromptTokens = 0n;
    let totalCompletionTokens = 0n;
    let totalCloudTokens = 0n;
    let currentData = {};

    if (existsSync(filePath)) {
      try {
        const raw = await fsPromises.readFile(filePath, 'utf-8');
        currentData = JSON.parse(raw);
        if (currentData && typeof currentData === 'object') {
          totalPromptTokens = parseBigIntSafe(currentData.totalPromptTokens);
          totalCompletionTokens = parseBigIntSafe(currentData.totalCompletionTokens);
          totalCloudTokens = parseBigIntSafe(currentData.totalCloudTokens);
        }
      } catch (readErr) {
        if (readErr?.code !== 'ENOENT') {
          process.stderr.write(`[ai-utils] Warning reading telemetry state file for cloud metrics: ${readErr?.message ?? readErr}\n`);
        }
      }
    }

    const pTok = parseBigIntSafe(promptTokensCount);
    const cTok = parseBigIntSafe(completionTokensCount);
    const addedCloud = pTok + cTok;
    const newCloudTokens = totalCloudTokens + addedCloud;
    const totalLocalTokens = totalPromptTokens + totalCompletionTokens;
    const allTokens = totalLocalTokens + newCloudTokens;
    const edgeComputeRatioPct = allTokens > 0n
      ? Number((totalLocalTokens * 100n) / allTokens)
      : 100;

    const updated = {
      ...currentData,
      totalCloudTokens: newCloudTokens.toString(),
      lastCloudProvider: provider,
      lastCloudModel: model,
      edgeComputeRatioPct,
      lastUpdatedMs: Date.now(),
    };

    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fsPromises.writeFile(tmpPath, JSON.stringify(updated, null, 2), 'utf-8');
    await fsPromises.rename(tmpPath, filePath);
    return updated;
  });
}

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
    const body = await readErrorBody(res);
    throw new Error(`Ollama ${res.status} from ${url}: ${body}`);
  }
  const data = await res.json();
  // Decouple telemetry recording from the inference response critical path
  trackTelemetryTask(recordOllamaInferenceMetrics(data, model));
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
  if (!res.ok) {
    const body = await readErrorBody(res);
    throw new Error(`Gemini API ${res.status}: ${body}`);
  }
  const data = await res.json();
  if (data.usageMetadata) {
    trackTelemetryTask(recordCloudInferenceMetrics('google', model, data.usageMetadata.promptTokenCount, data.usageMetadata.candidatesTokenCount));
  }
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
  if (!res.ok) {
    const body = await readErrorBody(res);
    throw new Error(`Anthropic API ${res.status}: ${body}`);
  }
  const data = await res.json();
  if (data.usage) {
    trackTelemetryTask(recordCloudInferenceMetrics('anthropic', model, data.usage.input_tokens, data.usage.output_tokens));
  }
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
  if (!res.ok) {
    const body = await readErrorBody(res);
    throw new Error(`OpenAI API ${res.status}: ${body}`);
  }
  const data = await res.json();
  if (data.usage) {
    trackTelemetryTask(recordCloudInferenceMetrics('openai', model, data.usage.prompt_tokens, data.usage.completion_tokens));
  }
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

export async function runWithFallback(fallbacks, systemPrompt, userMessage, options = {}) {
  const globalTimeoutMs = options.globalTimeoutMs ?? getGlobalTimeoutMs();
  const globalTimeoutNs = toTimeoutBigInt(globalTimeoutMs, DEFAULT_GLOBAL_TIMEOUT_MS_BIGINT, 'globalTimeoutMs') * 1_000_000n;
  const startNs = process.hrtime.bigint();
  const deadlineNs = startNs + globalTimeoutNs;

  for (const item of fallbacks) {
    const nowNs = process.hrtime.bigint();
    const remainingNs = deadlineNs - nowNs;
    if (remainingNs <= 0n) {
      throw new NoAvailableModelsError(
        `Global fallback timeout exceeded (${Number(globalTimeoutNs / 1_000_000_000n)}s budget exhausted)`
      );
    }

    const { model, provider, timeoutMs: itemTimeout } = item;
    const remainingMsBigInt = remainingNs / 1_000_000n;
    const modelTimeoutMsBigInt = toTimeoutBigInt(itemTimeout, PER_MODEL_TIMEOUT_MS_BIGINT, `timeoutMs for ${model}`);
    const candidateTimeoutMsBigInt = remainingMsBigInt < modelTimeoutMsBigInt ? remainingMsBigInt : modelTimeoutMsBigInt;
    const timeoutMsBigInt = candidateTimeoutMsBigInt < MAX_TIMEOUT_MS_BIGINT ? candidateTimeoutMsBigInt : MAX_TIMEOUT_MS_BIGINT;
    const timeoutMs = Number(timeoutMsBigInt);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const label = provider === 'ollama' ? `${model} (local Ollama)` : `${model} (${provider})`;
      console.log(`  ⏳  Trying ${label} (budget: ${(timeoutMs / 1000).toFixed(0)}s)...`);
      const dispatch = PROVIDER_DISPATCH[provider];
      if (!dispatch) {
        throw new Error(`Unknown provider: ${provider}`);
      }
      const result = await dispatch(model, systemPrompt, userMessage, ac.signal, item);

      console.log(`  ✅  Success with ${model}\n`);
      return { result, model };
    } catch (e) {
      const reason = e.name === 'AbortError' ? `timed out after ${(timeoutMs / 1000).toFixed(0)}s` : e.message;
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
