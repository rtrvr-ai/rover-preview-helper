import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  DEFAULT_ROVER_EMBED_BASE,
  looksLikeRoverRuntime,
  vendorBase,
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

test('vendorTargets maps embed + worker to the right URLs and dist paths', () => {
  const distDir = '/tmp/dist';
  const targets = vendorTargets('https://rover.rtrvr.ai', distDir);
  assert.equal(targets.length, 2);

  const embed = targets.find(t => t.name === 'embed');
  assert.equal(embed.url, 'https://rover.rtrvr.ai/embed-core.js');
  assert.deepEqual(embed.fallbackUrls, ['https://rover.rtrvr.ai/embed.js']);
  assert.equal(embed.distFile, path.join(distDir, 'vendor', 'rover-embed.js'));

  const worker = targets.find(t => t.name === 'worker');
  assert.equal(worker.url, 'https://rover.rtrvr.ai/worker/worker.js');
  assert.equal(worker.distFile, path.join(distDir, 'vendor', 'worker.js'));
});

test('looksLikeRoverRuntime accepts executable runtimes, rejects HTML, tiny bodies, and loader stubs', () => {
  const embedBody = [
    "var __ROVER_SCRIPT_URL__='';",
    `var __roverSDK=(()=>{window.rover=function(){};const a='https://agent.rtrvr.ai';const b='data-rover-methods';${'x'.repeat(2000)}})();`,
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
