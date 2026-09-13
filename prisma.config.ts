import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load local environment files if present
for (const envFile of ['.env.local', '.env']) {
  const p = join(__dirname, envFile);
  if (existsSync(p)) {
    try {
      process.loadEnvFile(p);
    } catch {
      // Non-fatal
    }
  }
}

const rawUrl = process.env.DATABASE_URL || '';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  // advisory_lock=false prevents timeouts on Neon pooled connections
  datasource: {
    url: rawUrl
      ? (rawUrl.includes('?') ? `${rawUrl}&advisory_lock=false` : `${rawUrl}?advisory_lock=false`)
      : '',
  },
});
