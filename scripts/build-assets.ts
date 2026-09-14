import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '../public');

/**
 * Deterministic cryptographic content hash for static assets (Council Invariant 4 & 5).
 * Generates an 8-character hex digest of the asset content.
 */
export function hashFile(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 10);
}

/**
 * Automates content-addressable hashing for production web assets.
 * Guarantees atomic cache invalidation and enables immutable HTTP caching (Jeff Dean latency rule).
 */
export function buildAssets(targetDir: string = PUBLIC_DIR): { jsHashed: string; cssHashed: string } {
  const jsSourcePath = path.join(targetDir, 'zodiac-app.js');
  const cssSourcePath = path.join(targetDir, 'zodiac.css');
  const indexPath = path.join(targetDir, 'index.html');

  if (!fs.existsSync(jsSourcePath) || !fs.existsSync(cssSourcePath) || !fs.existsSync(indexPath)) {
    throw new Error(`Required asset files missing in ${targetDir}`);
  }

  const jsContent = fs.readFileSync(jsSourcePath, 'utf8');
  const cssContent = fs.readFileSync(cssSourcePath, 'utf8');
  let indexHtml = fs.readFileSync(indexPath, 'utf8');

  const jsHash = hashFile(jsContent);
  const cssHash = hashFile(cssContent);

  const jsHashedName = `zodiac-app.${jsHash}.js`;
  const cssHashedName = `zodiac.${cssHash}.css`;

  // Write content-addressed assets
  fs.writeFileSync(path.join(targetDir, jsHashedName), jsContent, 'utf8');
  fs.writeFileSync(path.join(targetDir, cssHashedName), cssContent, 'utf8');

  // Clean up any stale hashed assets in the target directory
  const files = fs.readdirSync(targetDir);
  for (const file of files) {
    if (file.startsWith('zodiac-app.') && file.endsWith('.js') && file !== 'zodiac-app.js' && file !== jsHashedName) {
      fs.unlinkSync(path.join(targetDir, file));
      console.log(`[Asset Pipeline] Removed stale hashed file: ${file}`);
    }
    if (file.startsWith('zodiac.') && file.endsWith('.css') && file !== 'zodiac.css' && file !== cssHashedName) {
      fs.unlinkSync(path.join(targetDir, file));
      console.log(`[Asset Pipeline] Removed stale hashed file: ${file}`);
    }
  }

  // Update index.html references deterministically
  // 1. CSS stylesheet link
  indexHtml = indexHtml.replace(
    /<link\s+rel=["']stylesheet["']\s+href=["']zodiac(\.[a-f0-9]+)?\.css["']/g,
    `<link rel="stylesheet" href="${cssHashedName}"`
  );

  // 2. JS script tag
  indexHtml = indexHtml.replace(
    /<script\s+defer\s+src=["']zodiac-app(\.[a-f0-9]+)?\.js(\?v=[^"']*)?["']><\/script>/g,
    `<script defer src="${jsHashedName}"></script>`
  );

  fs.writeFileSync(indexPath, indexHtml, 'utf8');

  // Emit manifest for edge/SSR routing
  const manifest = {
    'zodiac-app.js': jsHashedName,
    'zodiac.css': cssHashedName,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(targetDir, 'asset-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  console.log(`✓ [Asset Pipeline] Generated content-addressed assets:`);
  console.log(`  - ${cssHashedName} (SHA-256: ${cssHash})`);
  console.log(`  - ${jsHashedName} (SHA-256: ${jsHash})`);
  console.log(`  - Updated ${indexPath}`);

  return { jsHashed: jsHashedName, cssHashed: cssHashedName };
}

// Run directly if invoked from CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildAssets();
}
