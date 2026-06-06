import { mkdir, copyFile, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = new URL('..', import.meta.url);
const rootDir = path.resolve(root.pathname);

export const DEFAULT_ROVER_EMBED_BASE = 'https://rover.rtrvr.ai';
export const CACHE_DIR = path.join(rootDir, '.rover-vendor-cache');

/**
 * Source origin for the Rover runtime files. Override with ROVER_EMBED_BASE to
 * vendor from a staging deploy instead of prod.
 */
export function vendorBase(env = process.env) {
  const raw = String(env?.ROVER_EMBED_BASE || '').trim();
  return (raw || DEFAULT_ROVER_EMBED_BASE).replace(/\/+$/, '');
}

/**
 * The exact runtime files we package, with download URL, on-disk cache path, and
 * the destination inside dist/. Pure: no IO, easy to unit-test.
 */
export function vendorTargets(base = vendorBase(), distDir = path.join(rootDir, 'dist')) {
  return [
    {
      name: 'embed',
      url: `${base}/embed.js`,
      cacheFile: path.join(CACHE_DIR, 'rover-embed.js'),
      distFile: path.join(distDir, 'vendor', 'rover-embed.js'),
    },
    {
      name: 'worker',
      url: `${base}/worker/worker.js`,
      cacheFile: path.join(CACHE_DIR, 'worker.js'),
      distFile: path.join(distDir, 'vendor', 'worker.js'),
    },
  ];
}

/**
 * Guard against caching/bundling an HTML error page or empty body in place of
 * the real runtime. embed.js is a self-executing SDK bundle; worker.js is a
 * plain module. Both must be sizable JS, never start with an HTML tag.
 */
export function looksLikeRoverRuntime(name, text) {
  const body = String(text || '');
  if (body.length < 1024) return false;
  const head = body.slice(0, 512).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<')) {
    return false;
  }
  if (name === 'embed') {
    return body.includes('__roverSDK') || body.includes('__ROVER_SCRIPT_URL__');
  }
  // worker.js has no stable public token; rely on size + not-HTML above.
  return true;
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function downloadTarget(target) {
  const response = await fetch(target.url, { cache: 'no-store', redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  const text = await response.text();
  if (!looksLikeRoverRuntime(target.name, text)) {
    throw new Error('downloaded body did not look like the Rover runtime');
  }
  return {
    text,
    etag: response.headers.get('etag') || '',
    lastModified: response.headers.get('last-modified') || '',
  };
}

/**
 * Ensure each runtime file is present in the local cache, then copy it into
 * dist/vendor. With `refresh`, re-download the latest from prod (falling back to
 * the cached copy on any network/validation error). Without `refresh`, reuse the
 * cache when present so watch-mode rebuilds stay instant and offline.
 *
 * @param {{ refresh?: boolean, distDir?: string, now?: string, log?: (msg: string) => void }} options
 */
export async function vendorRoverRuntime(options = {}) {
  const {
    refresh = true,
    distDir = path.join(rootDir, 'dist'),
    now = new Date().toISOString(),
    log = console.log,
  } = options;

  const base = vendorBase();
  const targets = vendorTargets(base, distDir);
  await mkdir(CACHE_DIR, { recursive: true });
  await mkdir(path.join(distDir, 'vendor'), { recursive: true });

  const manifestFiles = [];

  for (const target of targets) {
    const hasCache = await fileExists(target.cacheFile);
    let etag = '';
    let lastModified = '';
    let source = 'cache';

    if (refresh || !hasCache) {
      try {
        const downloaded = await downloadTarget(target);
        await writeFile(target.cacheFile, downloaded.text);
        etag = downloaded.etag;
        lastModified = downloaded.lastModified;
        source = 'network';
      } catch (error) {
        if (!hasCache) {
          throw new Error(
            `Failed to vendor ${target.name} from ${target.url}: ${error?.message || error}. `
            + 'No cached copy exists. Connect to the network (or set ROVER_EMBED_BASE) and rebuild.',
          );
        }
        log(`  ! ${target.name}: ${error?.message || error} — reusing cached copy.`);
        source = 'cache (stale)';
      }
    }

    await copyFile(target.cacheFile, target.distFile);
    const bytes = (await stat(target.distFile)).size;
    manifestFiles.push({ name: target.name, file: path.basename(target.distFile), bytes, etag, lastModified });
    log(`  - ${path.basename(target.distFile)}: ${bytes.toLocaleString()} bytes (${source})`);
  }

  const versionPath = path.join(distDir, 'vendor', 'VERSION.json');
  await writeFile(
    versionPath,
    `${JSON.stringify({ source: base, fetchedAt: now, files: manifestFiles }, null, 2)}\n`,
  );

  return { base, files: manifestFiles };
}
