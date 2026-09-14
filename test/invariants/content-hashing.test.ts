import { describe, it, expect } from 'vitest';
import { hashFile } from '../../scripts/build-assets.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '../../public');

describe('Content-Addressable Asset Pipeline (Council Invariant 4 & Dean Latency)', () => {
  it('deterministically computes sha256 10-char hex digest', () => {
    const hash1 = hashFile('console.log("hello");');
    const hash2 = hashFile('console.log("hello");');
    const hashDiff = hashFile('console.log("world");');

    expect(hash1).toHaveLength(10);
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hashDiff);
  });

  it('verifies index.html references active content-hashed assets', () => {
    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    const manifestPath = path.join(PUBLIC_DIR, 'asset-manifest.json');

    expect(fs.existsSync(indexPath)).toBe(true);
    expect(fs.existsSync(manifestPath)).toBe(true);

    const indexHtml = fs.readFileSync(indexPath, 'utf8');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    expect(manifest['zodiac-app.js']).toMatch(/^zodiac-app\.[a-f0-9]{10}\.js$/);
    expect(manifest['zodiac.css']).toMatch(/^zodiac\.[a-f0-9]{10}\.css$/);

    // index.html must reference the exact hashed assets from manifest
    expect(indexHtml).toContain(manifest['zodiac-app.js']);
    expect(indexHtml).toContain(manifest['zodiac.css']);

    // Ensure physical files exist in public/
    expect(fs.existsSync(path.join(PUBLIC_DIR, manifest['zodiac-app.js']))).toBe(true);
    expect(fs.existsSync(path.join(PUBLIC_DIR, manifest['zodiac.css']))).toBe(true);
  });
});
