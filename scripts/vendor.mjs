import { mkdir, copyFile, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = new URL('..', import.meta.url);
const rootDir = path.resolve(root.pathname);

export const DEFAULT_ROVER_EMBED_BASE = 'https://rover.rtrvr.ai';
export const CACHE_DIR = path.join(rootDir, '.rover-vendor-cache');
export const RUNTIME_MANIFEST_VERSION = 2;

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

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
      // The extension injects this file with chrome.scripting.executeScript.
      // Use the full SDK core, not the lightweight /embed.js loader that expects
      // to derive embed-core.js from a real <script src> element.
      name: 'embed',
      url: `${base}/embed-core.js`,
      fallbackUrls: [`${base}/embed.js`],
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
 * Guard against caching/bundling an HTML error page, loader stub, or empty body
 * in place of the executable runtime. rover-embed.js must be the full SDK core
 * because the helper injects it with chrome.scripting.executeScript, where
 * document.currentScript is not reliable enough for the lightweight loader to
 * find embed-core.js. worker.js must be a sizable worker bundle.
 */
export function looksLikeRoverRuntime(name, text) {
  const body = String(text || '');
  if (body.length < 1024) return false;
  const head = body.slice(0, 512).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<')) {
    return false;
  }

  const hasAll = markers => markers.every(marker => body.includes(marker));
  const hasAny = markers => markers.some(marker => body.includes(marker));

  if (name === 'embed') {
    return hasAll(['__roverSDK', '__ROVER_SCRIPT_URL__'])
      && hasAny(['window.rover', 'installGlobal', 'createRoverScriptTagSnippet'])
      && hasAll(['agent.rtrvr.ai', 'data-rover-methods']);
  }
  if (name === 'worker') {
    return hasAny(['self.onmessage', 'addEventListener("message"', "addEventListener('message'"])
      && hasAny(['self.postMessage', 'postMessage({']);
  }
  return false;
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function downloadUrl(target, url) {
  const response = await fetch(url, { cache: 'no-store', redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  const text = await response.text();
  if (!looksLikeRoverRuntime(target.name, text)) {
    throw new Error(`downloaded body from ${url} did not look like the Rover runtime`);
  }
  return {
    text,
    url,
    etag: response.headers.get('etag') || '',
    lastModified: response.headers.get('last-modified') || '',
  };
}

async function downloadTarget(target) {
  const urls = [target.url, ...(target.fallbackUrls || [])];
  const errors = [];

  for (const url of urls) {
    try {
      return await downloadUrl(target, url);
    } catch (error) {
      errors.push(`${url}: ${error?.message || error}`);
    }
  }

  throw new Error(errors.join('; '));
}

async function downloadRuntimeManifest(base) {
  const url = `${base}/rover-artifacts-manifest.json`;
  const response = await fetch(url, { cache: 'no-store', redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const payload = await response.json();
  if (!payload || typeof payload !== 'object' || !payload.files || typeof payload.files !== 'object') {
    throw new Error(`invalid Rover artifact manifest from ${url}`);
  }
  return { payload, url };
}

function targetManifestKey(target) {
  return target.name === 'embed' ? 'embed-core.js' : 'worker/worker.js';
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
  let upstreamManifest = null;
  let upstreamManifestUrl = '';
  if (refresh) {
    const downloadedManifest = await downloadRuntimeManifest(base);
    upstreamManifest = downloadedManifest.payload;
    upstreamManifestUrl = downloadedManifest.url;
  }
  await mkdir(CACHE_DIR, { recursive: true });
  await mkdir(path.join(distDir, 'vendor'), { recursive: true });

  const manifestFiles = [];

  for (const target of targets) {
    const hasCache = await fileExists(target.cacheFile);
    let etag = '';
    let lastModified = '';
    let source = 'cache';
    let sourceUrl = '';

    if (refresh || !hasCache) {
      try {
        const downloaded = await downloadTarget(target);
        await writeFile(target.cacheFile, downloaded.text);
        etag = downloaded.etag;
        lastModified = downloaded.lastModified;
        sourceUrl = downloaded.url;
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
    const body = await readFile(target.distFile);
    const digest = sha256(body);
    const manifestEntry = upstreamManifest?.files?.[targetManifestKey(target)];
    if (refresh && !manifestEntry) {
      throw new Error(`Website Rover manifest is missing ${targetManifestKey(target)}.`);
    }
    if (manifestEntry) {
      const expectedSha = String(manifestEntry.sha256 || '').trim().toLowerCase();
      const expectedBytes = Number(manifestEntry.bytes);
      if (expectedSha !== digest || expectedBytes !== bytes) {
        throw new Error(
          `Website Rover parity mismatch for ${target.name}: expected ${expectedSha}/${expectedBytes}, got ${digest}/${bytes}.`,
        );
      }
    }
    manifestFiles.push({
      name: target.name,
      file: path.basename(target.distFile),
      sourceUrl: sourceUrl || target.url,
      sha256: digest,
      bytes,
      etag,
      lastModified,
    });
    log(`  - ${path.basename(target.distFile)}: ${bytes.toLocaleString()} bytes (${source})`);
  }

  const versionPath = path.join(distDir, 'vendor', 'VERSION.json');
  const extensionManifest = JSON.parse(await readFile(path.join(rootDir, 'manifest.json'), 'utf8'));
  const versionManifest = {
    version: RUNTIME_MANIFEST_VERSION,
    extensionManifestVersion: String(extensionManifest.version || ''),
    roverSourceCommit: String(upstreamManifest?.sourceCommit || process.env.ROVER_SOURCE_COMMIT || '').trim(),
    source: base,
    sourceManifestUrl: upstreamManifestUrl || undefined,
    fetchedAt: now,
    files: manifestFiles,
  };
  await writeFile(
    versionPath,
    `${JSON.stringify(versionManifest, null, 2)}\n`,
  );

  return { base, files: manifestFiles, manifest: versionManifest };
}
