/**
 * Vitest Global Setup
 */

import { beforeAll } from 'vitest';

beforeAll(() => {
  // Ensure monotonic clock and hrtime are functional
  if (typeof process.hrtime.bigint !== 'function') {
    throw new Error('Process environment does not support process.hrtime.bigint');
  }
});
