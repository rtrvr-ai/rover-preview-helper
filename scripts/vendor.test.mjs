import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  DEFAULT_ROVER_EMBED_BASE,
  looksLikeRoverRuntime,
  resolveTargetArtifact,
  RUNTIME_MANIFEST_VERSION,
  sha256,
  vendorBase,
  vendorCacheDir,
  vendorTargets,
} from './vendor.mjs';

test('vendorBase defaults to prod and honors ROVER_EMBED_BASE', () => {
  assert.equal(vendorBase({}), DEFAULT_ROVER_EMBED_BASE);
  assert.equal(vendorBase({ ROVER_EMBED_BASE: 'https://staging.rtrvr.ai' }), 'https://staging.rtrvr.ai');
  // Trailing slashes are trimmed so URL joins stay clean.
  assert.equal(vendorBase({ ROVER_EMBED_BASE: 'https://staging.rtrvr.ai/' }), 'https://staging.rtrvr.ai');
  // Blank/whitespace falls back to the default.
  assert.equal(vendorBase({ ROVER_EMBED_BASE: '   ' }), DEFAULT_ROVER_EMBED_BASE);
});

test('vendor caches are isolated by normalized runtime origin', () => {
  assert.equal(vendorCacheDir('https://rover.rtrvr.ai'), vendorCacheDir('https://rover.rtrvr.ai'));
  assert.notEqual(vendorCacheDir('https://rover.rtrvr.ai'), vendorCacheDir('https://staging.rtrvr.ai'));
});

test('runtime manifest v2 uses stable SHA-256 identities', () => {
  assert.equal(RUNTIME_MANIFEST_VERSION, 2);
  assert.equal(
    sha256('rover'),
    'b0c5f417a5a9c8af7e19cfb341d9fad0869baa9d473652fcba4ae5a872db6b30',
  );
});

test('vendorTargets maps embed + worker to the right URLs and dist paths', () => {
  const distDir = '/tmp/dist';
  const targets = vendorTargets('https://rover.rtrvr.ai', distDir);
  assert.equal(targets.length, 2);

  const embed = targets.find(t => t.name === 'embed');
  assert.equal(embed.url, 'https://rover.rtrvr.ai/embed-core.js');
  assert.equal(embed.fallbackUrls, undefined);
  assert.equal(embed.distFile, path.join(distDir, 'vendor', 'rover-embed.js'));

  const worker = targets.find(t => t.name === 'worker');
  assert.equal(worker.url, 'https://rover.rtrvr.ai/worker/worker.js');
  assert.equal(worker.distFile, path.join(distDir, 'vendor', 'worker.js'));
});

test('looksLikeRoverRuntime accepts executable runtimes, rejects HTML, tiny bodies, and loader stubs', () => {
  const embedBody = [
    "var __ROVER_SCRIPT_URL__='';",
    `(()=>{const a='https://agent.rtrvr.ai/v2/rover/session/open';const b='data-rover-methods';${'x'.repeat(2000)}})();`,
  ].join('');
  assert.equal(looksLikeRoverRuntime('embed', embedBody), true);

  const workerBody = `self.onmessage=()=>{self.postMessage({type:"ok"});};${'y'.repeat(2000)}`;
  assert.equal(looksLikeRoverRuntime('worker', workerBody), true);

  // An HTML error page (404/redirect interstitial) must be rejected even if long.
  const htmlBody = `<!DOCTYPE html><html><body>${'e'.repeat(2000)}</body></html>`;
  assert.equal(looksLikeRoverRuntime('embed', htmlBody), false);
  assert.equal(looksLikeRoverRuntime('worker', htmlBody), false);

  // Too small to be the real bundle.
  assert.equal(looksLikeRoverRuntime('embed', 'var x=1;'), false);
  assert.equal(looksLikeRoverRuntime('worker', ''), false);

  // Right size, but missing the executable-runtime markers.
  assert.equal(looksLikeRoverRuntime('embed', 'z'.repeat(2000)), false);
  assert.equal(looksLikeRoverRuntime('worker', 'z'.repeat(2000)), false);

  // The public /embed.js loader is real Rover JavaScript, but this helper needs
  // the executable SDK core because it injects with chrome.scripting.executeScript.
  const loaderBody = [
    '"use strict";(()=>{',
    'const base="https://agent.rtrvr.ai";',
    'const core="embed-core.js";',
    'document.createElement("script").setAttribute("data-rover-core","api");',
    'document.createElement("link").setAttribute("data-rover-methods","GET POST");',
    `${'l'.repeat(2000)}})();`,
  ].join('');
  assert.equal(looksLikeRoverRuntime('embed', loaderBody), false);
});

test('resolveTargetArtifact prefers the content-addressed core and verifies alias parity', () => {
  const [embed, worker] = vendorTargets('https://rover.rtrvr.ai', '/tmp/dist');
  const coreSha = 'a'.repeat(64);
  const workerSha = 'b'.repeat(64);
  const manifest = {
    runtimeRevision: 'abc123def456',
    files: {
      'embed-core.js': { sha256: coreSha, bytes: 1_234_567 },
      'embed-core.abc123def456.js': { sha256: coreSha, bytes: 1_234_567 },
      'worker/worker.js': { sha256: workerSha, bytes: 234_567 },
    },
  };

  assert.deepEqual(resolveTargetArtifact(embed, manifest, 'https://rover.rtrvr.ai'), {
    key: 'embed-core.abc123def456.js',
    stableKey: 'embed-core.js',
    sha256: coreSha,
    bytes: 1_234_567,
    urls: [
      'https://rover.rtrvr.ai/embed-core.abc123def456.js',
      'https://rover.rtrvr.ai/embed-core.js',
    ],
  });
  assert.deepEqual(resolveTargetArtifact(worker, manifest, 'https://rover.rtrvr.ai'), {
    key: 'worker/worker.js',
    stableKey: 'worker/worker.js',
    sha256: workerSha,
    bytes: 234_567,
    urls: ['https://rover.rtrvr.ai/worker/worker.js'],
  });
});

test('resolveTargetArtifact rejects malformed and internally inconsistent manifests', () => {
  const [embed] = vendorTargets('https://rover.rtrvr.ai', '/tmp/dist');
  assert.throws(
    () => resolveTargetArtifact(embed, { files: {} }, 'https://rover.rtrvr.ai'),
    /manifest is missing embed-core\.js/,
  );
  assert.throws(
    () => resolveTargetArtifact(embed, {
      files: { 'embed-core.js': { sha256: 'not-a-digest', bytes: 42 } },
    }, 'https://rover.rtrvr.ai'),
    /invalid identity/,
  );
  assert.throws(
    () => resolveTargetArtifact(embed, {
      runtimeRevision: 'abc123def456',
      files: {
        'embed-core.js': { sha256: 'a'.repeat(64), bytes: 100 },
        'embed-core.abc123def456.js': { sha256: 'b'.repeat(64), bytes: 100 },
      },
    }, 'https://rover.rtrvr.ai'),
    /alias and immutable artifact disagree/,
  );
});
