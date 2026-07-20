import { mkdir, copyFile, readFile, rename, writeFile, stat } from 'node:fs/promises';
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

export function vendorCacheDir(base = vendorBase()) {
  return path.join(CACHE_DIR, sha256(base).slice(0, 16));
}

/**
 * The exact runtime files we package, with download URL, on-disk cache path, and
 * the destination inside dist/. Pure: no IO, easy to unit-test.
 */
export function vendorTargets(base = vendorBase(), distDir = path.join(rootDir, 'dist')) {
  const cacheDir = vendorCacheDir(base);
  return [
    {
      // The extension injects this file with chrome.scripting.executeScript.
      // Use the full SDK core, not the lightweight /embed.js loader that expects
      // to derive embed-core.js from a real <script src> element.
      name: 'embed',
      url: `${base}/embed-core.js`,
      cacheFile: path.join(cacheDir, 'rover-embed.js'),
      distFile: path.join(distDir, 'vendor', 'rover-embed.js'),
    },
    {
      name: 'worker',
      url: `${base}/worker/worker.js`,
      cacheFile: path.join(cacheDir, 'worker.js'),
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
    return hasAll(['__ROVER_SCRIPT_URL__', 'agent.rtrvr.ai', 'data-rover-methods'])
      && hasAny(['/v2/rover', 'session/open'])
      && !hasAny(['data-rover-core-loader', 'embed-manifest.json']);
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

function normalizeManifestEntry(manifest, key) {
  const entry = manifest?.files?.[key];
  if (!entry || typeof entry !== 'object') return null;
  const digest = String(entry.sha256 || '').trim().toLowerCase();
  const bytes = Number(entry.bytes);
  if (!/^[a-f0-9]{64}$/.test(digest) || !Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(`Website Rover manifest has an invalid identity for ${key}.`);
  }
  return { key, sha256: digest, bytes };
}

/**
 * Resolve the immutable runtime object and its deployment-manifest identity.
 * The manifest identity is stronger and more future-proof than minifier-sensitive
 * source markers. The stable alias remains a retry only for older deployments.
 */
export function resolveTargetArtifact(target, manifest, base = vendorBase()) {
  const stableKey = targetManifestKey(target);
  const stable = normalizeManifestEntry(manifest, stableKey);
  if (!stable) throw new Error(`Website Rover manifest is missing ${stableKey}.`);

  let immutable = null;
  if (target.name === 'embed') {
    const revision = String(manifest?.runtimeRevision || '').trim();
    if (/^[a-f0-9]{12}$/i.test(revision)) {
      const candidate = normalizeManifestEntry(manifest, `embed-core.${revision}.js`);
      if (candidate) {
        if (candidate.sha256 !== stable.sha256 || candidate.bytes !== stable.bytes) {
          throw new Error('Website Rover manifest core alias and immutable artifact disagree.');
        }
        immutable = candidate;
      }
    }
  }

  const selected = immutable || stable;
  const urls = [...new Set([
    `${base}/${selected.key}`,
    `${base}/${stable.key}`,
  ])];
  return { ...selected, stableKey, urls };
}

async function downloadUrl(target, url, expected) {
  const response = await fetch(url, { cache: 'no-store', redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  const digest = sha256(body);
  if (expected) {
    if (body.byteLength !== expected.bytes || digest !== expected.sha256) {
      throw new Error(
        `downloaded body from ${url} failed manifest verification: expected `
        + `${expected.sha256}/${expected.bytes}, got ${digest}/${body.byteLength}`,
      );
    }
  } else if (!looksLikeRoverRuntime(target.name, body.toString('utf8'))) {
    throw new Error(`downloaded body from ${url} did not look like the Rover runtime`);
  }
  return {
    body,
    url,
    etag: response.headers.get('etag') || '',
    lastModified: response.headers.get('last-modified') || '',
  };
}

async function downloadTarget(target, artifact) {
  const urls = artifact?.urls || [target.url];
  const errors = [];

  for (const url of urls) {
    try {
      return await downloadUrl(target, url, artifact);
    } catch (error) {
      errors.push(`${url}: ${error?.message || error}`);
    }
  }

  throw new Error(errors.join('; '));
}

async function readFileIdentity(filePath) {
  const body = await readFile(filePath);
  return { sha256: sha256(body), bytes: body.byteLength };
}

async function writeFileAtomically(filePath, body) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, body);
  await rename(tempPath, filePath);
}

async function downloadRuntimeManifest(base) {
  const url = `${base}/rover-artifacts-manifest.json`;
  const response = await fetch(url, { cache: 'no-store', redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const payload = await response.json();
  validateRuntimeManifestPayload(payload, url);
  return { payload, url };
}

function validateRuntimeManifestPayload(payload, source) {
  if (!payload || typeof payload !== 'object' || !payload.files || typeof payload.files !== 'object') {
    throw new Error(`invalid Rover artifact manifest from ${source}`);
  }
}

async function readCachedRuntimeManifest(base, manifestCacheFile) {
  const payload = JSON.parse(await readFile(manifestCacheFile, 'utf8'));
  validateRuntimeManifestPayload(payload, manifestCacheFile);
  return { payload, url: `${base}/rover-artifacts-manifest.json` };
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
  const cacheDir = vendorCacheDir(base);
  const manifestCacheFile = path.join(cacheDir, 'rover-artifacts-manifest.json');
  const targets = vendorTargets(base, distDir);
  let upstreamManifest = null;
  let upstreamManifestUrl = '';
  await mkdir(cacheDir, { recursive: true });
  if (refresh) {
    try {
      const downloadedManifest = await downloadRuntimeManifest(base);
      upstreamManifest = downloadedManifest.payload;
      upstreamManifestUrl = downloadedManifest.url;
      await writeFileAtomically(
        manifestCacheFile,
        `${JSON.stringify(upstreamManifest, null, 2)}\n`,
      );
    } catch (error) {
      if (!(await fileExists(manifestCacheFile))) {
        throw new Error(
          `Failed to download the Rover artifact manifest: ${error?.message || error}. `
          + 'No cached manifest exists. Connect to the network (or set ROVER_EMBED_BASE) and rebuild.',
        );
      }
      const cachedManifest = await readCachedRuntimeManifest(base, manifestCacheFile);
      upstreamManifest = cachedManifest.payload;
      upstreamManifestUrl = cachedManifest.url;
      log(`  ! manifest: ${error?.message || error} — reusing cached manifest.`);
    }
  }
  await mkdir(path.join(distDir, 'vendor'), { recursive: true });

  const manifestFiles = [];

  for (const target of targets) {
    const hasCache = await fileExists(target.cacheFile);
    const artifact = upstreamManifest
      ? resolveTargetArtifact(target, upstreamManifest, base)
      : null;
    let etag = '';
    let lastModified = '';
    let source = 'cache';
    let sourceUrl = '';

    if (refresh || !hasCache) {
      try {
        const downloaded = await downloadTarget(target, artifact);
        await writeFileAtomically(target.cacheFile, downloaded.body);
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
        if (artifact) {
          const cached = await readFileIdentity(target.cacheFile);
          if (cached.sha256 !== artifact.sha256 || cached.bytes !== artifact.bytes) {
            throw new Error(
              `Failed to vendor ${target.name}: ${error?.message || error}. Cached artifact is stale: `
              + `expected ${artifact.sha256}/${artifact.bytes}, got ${cached.sha256}/${cached.bytes}.`,
            );
          }
        }
        log(`  ! ${target.name}: ${error?.message || error} — reusing cached copy.`);
        source = 'cache (stale)';
      }
    }

    await copyFile(target.cacheFile, target.distFile);
    const bytes = (await stat(target.distFile)).size;
    const body = await readFile(target.distFile);
    const digest = sha256(body);
    if (artifact) {
      if (artifact.sha256 !== digest || artifact.bytes !== bytes) {
        throw new Error(
          `Website Rover parity mismatch for ${target.name}: expected ${artifact.sha256}/${artifact.bytes}, got ${digest}/${bytes}.`,
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
