import test from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeHelperConfigFragment,
  extractHelperConfigFragment,
  hasHelperConfigFragment,
  INJECT_DEBOUNCE_MS,
  INJECT_STORM_THRESHOLD,
  INJECT_STORM_WINDOW_MS,
  CSP_LEVEL,
  CSP_RELOAD_BUDGET_MAX,
  CSP_RELOAD_BUDGET_WINDOW_MS,
  isCspReloadBudgetExceeded,
  isHostAllowed,
  isInjectCircuitOpen,
  isInjectStorm,
  isRecentSelfRewrite,
  isRoverCspViolation,
  nextEscalationLevel,
  normalizeConfig,
  recordCspReload,
  recordInjectAttempt,
  SELF_REWRITE_WINDOW_MS,
  shouldDebounceInject,
  shouldSkipInjectForProbe,
  stripPreviewLaunchParams,
} from './shared.js';

test('normalizeConfig keeps Workspace publicKey config fields', () => {
  const config = normalizeConfig({
    siteId: 'site_123',
    publicKey: 'pk_site_123',
    sessionId: 'sess_123',
    siteKeyId: 'key_123',
    apiBase: 'https://agent.rtrvr.ai',
    allowedDomains: ['example.com'],
    domainScopeMode: 'host_only',
    sessionScope: 'shared_site',
    mode: 'full',
    allowActions: true,
    cloudSandboxEnabled: true,
    pageConfig: {
      disableAutoScroll: true,
    },
    ui: {
      voice: {
        enabled: true,
        language: 'en-US',
        autoStopMs: 2800,
      },
      experience: {
        motion: {
          actionSpotlight: false,
          actionSpotlightColor: '#2563eb',
        },
      },
    },
  });

  assert.equal(config.siteId, 'site_123');
  assert.equal(config.publicKey, 'pk_site_123');
  assert.equal(config.sessionId, 'sess_123');
  assert.equal(config.siteKeyId, 'key_123');
  assert.equal(config.apiBase, 'https://agent.rtrvr.ai');
  assert.deepEqual(config.allowedDomains, ['example.com']);
  assert.equal(config.domainScopeMode, 'host_only');
  assert.equal(config.sessionScope, 'shared_site');
  assert.equal(config.mode, 'full');
  assert.equal(config.allowActions, true);
  assert.equal(config.cloudSandboxEnabled, true);
  assert.deepEqual(config.pageConfig, {
    disableAutoScroll: true,
  });
  assert.deepEqual(config.ui, {
    voice: {
      enabled: true,
      language: 'en-US',
      autoStopMs: 2800,
    },
    experience: {
      motion: {
        actionSpotlight: false,
        actionSpotlightColor: '#2563EB',
      },
    },
  });
});

test('normalizeConfig exposes default action spotlight in helper configs', () => {
  const config = normalizeConfig({
    siteId: 'site_123',
    publicKey: 'pk_site_123',
  });

  assert.deepEqual(config.ui, {
    experience: {
      motion: {
        actionSpotlight: true,
        actionSpotlightColor: '#FF4C00',
      },
    },
  });
  assert.deepEqual(config.pageConfig, {
    disableAutoScroll: true,
  });
});

test('normalizeConfig preserves all supported background-tab rollback modes', () => {
  for (const backgroundTabs of ['identity', 'digest_unchanged', 'full']) {
    const config = normalizeConfig({
      siteId: 'site',
      publicKey: 'pk',
      pageConfig: { disableAutoScroll: false, backgroundTabs },
    });
    assert.deepEqual(config.pageConfig, { disableAutoScroll: false, backgroundTabs });
  }
  const invalid = normalizeConfig({
    siteId: 'site',
    publicKey: 'pk',
    pageConfig: { backgroundTabs: 'everything' },
  });
  assert.deepEqual(invalid.pageConfig, { disableAutoScroll: true });
});

test('isHostAllowed allows any host with wildcard *', () => {
  assert.ok(isHostAllowed('www.rtrvr.ai', ['*'], 'registrable_domain'));
  assert.ok(isHostAllowed('anything.example.com', ['*'], 'host_only'));
  assert.ok(isHostAllowed('localhost', ['*'], 'host_only'));
  assert.ok(isHostAllowed('some-random-site.org', ['*', 'example.com'], 'registrable_domain'));
});

test('isHostAllowed respects host_only and registrable domain rules', () => {
  assert.equal(isHostAllowed('example.com', ['example.com'], 'host_only'), true);
  assert.equal(isHostAllowed('shop.example.com', ['example.com'], 'host_only'), false);
  assert.equal(isHostAllowed('shop.example.com', ['example.com'], 'registrable_domain'), true);
  assert.equal(isHostAllowed('example.com', ['*.example.com'], 'registrable_domain'), false);
  assert.equal(isHostAllowed('shop.example.com', ['*.example.com'], 'registrable_domain'), true);
  assert.equal(isHostAllowed('app.example.com', ['=app.example.com'], 'registrable_domain'), true);
  assert.equal(isHostAllowed('shop.example.com', ['=app.example.com'], 'registrable_domain'), false);
});

test('helper fragment handoff round-trips generic publicKey config and strips itself from the URL', () => {
  const fragment = encodeHelperConfigFragment({
    siteId: 'site_123',
    publicKey: 'pk_site_123',
    sessionId: 'sess_123',
    allowedDomains: ['example.com'],
    domainScopeMode: 'registrable_domain',
    sessionScope: 'shared_site',
  });
  const url = `https://www.example.com/products#${fragment}`;

  assert.equal(hasHelperConfigFragment(url), true);
  assert.deepEqual(extractHelperConfigFragment(url), {
    siteId: 'site_123',
    publicKey: 'pk_site_123',
    sessionId: 'sess_123',
    allowedDomains: ['example.com'],
    domainScopeMode: 'registrable_domain',
    sessionScope: 'shared_site',
  });
  assert.equal(stripPreviewLaunchParams(url), 'https://www.example.com/products');
});

test('helper fragment handoff also round-trips hosted preview payloads', () => {
  const fragment = encodeHelperConfigFragment({
    previewId: 'rpv_123',
    previewToken: 'rvprv_123',
    apiBase: 'https://agent.rtrvr.ai',
    sessionId: 'rpv_123',
    sessionScope: 'shared_site',
    targetUrl: 'https://www.example.com/products',
  });
  const url = `https://www.example.com/products#${fragment}`;

  assert.deepEqual(extractHelperConfigFragment(url), {
    previewId: 'rpv_123',
    previewToken: 'rvprv_123',
    apiBase: 'https://agent.rtrvr.ai',
    sessionId: 'rpv_123',
    sessionScope: 'shared_site',
    targetUrl: 'https://www.example.com/products',
  });
});

test('old helper fragment param is ignored after the cutover', () => {
  const payload = encodeURIComponent(Buffer.from(JSON.stringify({
    siteId: 'old_site',
    publicKey: 'pk_site_old',
  })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''));
  const oldParam = `rover_helper_${'config'}`;
  const url = `https://www.example.com/#${oldParam}=${payload}`;

  assert.equal(hasHelperConfigFragment(url), false);
  assert.equal(extractHelperConfigFragment(url), null);
});

test('invalid helper fragments throw a clear error', () => {
  assert.throws(
    () => extractHelperConfigFragment('https://www.example.com/#rover_helper_payload=not-valid-base64'),
    /Invalid Rover helper handoff:/,
  );
});

test('shouldSkipInjectForProbe skips booted documents regardless of signature', () => {
  assert.equal(shouldSkipInjectForProbe({ bootstrapped: true, signature: 'a', embedVersion: '1.0.0' }, 'b'), true);
  assert.equal(shouldSkipInjectForProbe({ bootstrapped: true, signature: '', embedVersion: '' }, ''), true);
  assert.equal(shouldSkipInjectForProbe(null, 'a'), false);
  assert.equal(shouldSkipInjectForProbe(undefined, 'a'), false);
});

test('shouldSkipInjectForProbe skips a bailed bootstrap only for the same config signature', () => {
  // Same signature: the host check would bail again on this document — skip.
  assert.equal(shouldSkipInjectForProbe({ bootstrapped: false, attempted: true, signature: 'a' }, 'a'), true);
  // New signature (e.g. corrected allowedDomains): give it a fresh attempt.
  assert.equal(shouldSkipInjectForProbe({ bootstrapped: false, attempted: true, signature: 'a' }, 'b'), false);
  // Never attempted on this document: inject.
  assert.equal(shouldSkipInjectForProbe({ bootstrapped: false, attempted: false, signature: 'a' }, 'a'), false);
  assert.equal(shouldSkipInjectForProbe({ bootstrapped: false, signature: 'a', embedVersion: '1.0.0' }, 'a'), false);
});

test('isRoverCspViolation attributes only enforced, Rover-caused violations', () => {
  // Rover backend hosts (connect-src blockedURIs are often origin-truncated).
  assert.equal(isRoverCspViolation({ blockedURI: 'https://agent.rtrvr.ai', effectiveDirective: 'connect-src', disposition: 'enforce' }), true);
  assert.equal(isRoverCspViolation({ blockedURI: 'https://extensionrouter.rtrvr.ai/v2/rover', effectiveDirective: 'connect-src', disposition: 'enforce' }), true);
  assert.equal(isRoverCspViolation({ blockedURI: 'https://rover.rtrvr.ai/rover/fonts/x.woff2', effectiveDirective: 'font-src', disposition: 'enforce' }), true);
  // Rover's blob module worker: keyword/blob source under a worker directive.
  assert.equal(isRoverCspViolation({ blockedURI: 'blob', effectiveDirective: 'worker-src', disposition: 'enforce' }), true);
  assert.equal(isRoverCspViolation({ blockedURI: '', effectiveDirective: 'default-src', disposition: 'enforce' }), true);
  assert.equal(isRoverCspViolation({ blockedURI: 'chrome-extension://abc123/vendor/worker.js', effectiveDirective: 'worker-src', disposition: 'enforce' }), true);
  assert.equal(isRoverCspViolation(
    { blockedURI: 'https://staging-agent.rtrvr.ai/v2/rover', effectiveDirective: 'connect-src', disposition: 'enforce' },
    { extraHosts: ['staging-agent.rtrvr.ai'] },
  ), true);
  // Report-only never counts.
  assert.equal(isRoverCspViolation({ blockedURI: 'https://agent.rtrvr.ai', effectiveDirective: 'connect-src', disposition: 'report' }), false);
  // The site's own blocked traffic must NOT be attributed to Rover.
  assert.equal(isRoverCspViolation({ blockedURI: 'https://api.merge.dev', effectiveDirective: 'connect-src', disposition: 'enforce' }), false);
  assert.equal(isRoverCspViolation({ blockedURI: 'https://fonts.googleapis.com/x', effectiveDirective: 'style-src', disposition: 'enforce' }), false);
  assert.equal(isRoverCspViolation({ blockedURI: 'chrome-extension://abc123/src/content-start.js', effectiveDirective: 'script-src', disposition: 'enforce' }), false);
  assert.equal(isRoverCspViolation({ blockedURI: 'inline', effectiveDirective: 'script-src', disposition: 'enforce' }), false);
  assert.equal(isRoverCspViolation({ blockedURI: 'eval', effectiveDirective: 'script-src', disposition: 'enforce' }), false);
  assert.equal(isRoverCspViolation({}), false);
});

test('nextEscalationLevel climbs a bounded ladder, jumping to DNR+CDP for meta CSP', () => {
  const fromNone = nextEscalationLevel(CSP_LEVEL.NONE, { hasMetaCsp: false });
  assert.deepEqual(fromNone, { level: CSP_LEVEL.DNR, enableDnr: true, attachCdp: false, failed: false });

  const fromNoneMeta = nextEscalationLevel(CSP_LEVEL.NONE, { hasMetaCsp: true });
  assert.deepEqual(fromNoneMeta, { level: CSP_LEVEL.DNR_CDP, enableDnr: true, attachCdp: true, failed: false });

  const fromDnr = nextEscalationLevel(CSP_LEVEL.DNR, { hasMetaCsp: false });
  assert.deepEqual(fromDnr, { level: CSP_LEVEL.DNR_CDP, enableDnr: false, attachCdp: true, failed: false });

  const fromDnrCdp = nextEscalationLevel(CSP_LEVEL.DNR_CDP, {});
  assert.deepEqual(fromDnrCdp, { level: CSP_LEVEL.FAILED, enableDnr: false, attachCdp: false, failed: true });

  const fromFailed = nextEscalationLevel(CSP_LEVEL.FAILED, {});
  assert.equal(fromFailed.failed, true);

  // Undefined/absent current level starts at NONE.
  assert.equal(nextEscalationLevel(undefined, {}).level, CSP_LEVEL.DNR);
});

test('shouldDebounceInject drops identical-signature triggers inside the window', () => {
  const record = { signature: 'sig-1', inFlight: null, lastInjectAt: 10_000 };
  assert.equal(shouldDebounceInject(record, 'sig-1', 10_000 + INJECT_DEBOUNCE_MS - 1), true);
  assert.equal(shouldDebounceInject(record, 'sig-1', 10_000 + INJECT_DEBOUNCE_MS), false);
  assert.equal(shouldDebounceInject(record, 'sig-2', 10_100), false);
  assert.equal(shouldDebounceInject(null, 'sig-1', 10_100), false);
  assert.equal(shouldDebounceInject({ signature: 'sig-1' }, 'sig-1', 10_100), false);
});

test('recordInjectAttempt counts within a window and resets after it', () => {
  const first = recordInjectAttempt(undefined, 1_000);
  assert.deepEqual(first, { windowStartMs: 1_000, count: 1 });
  const second = recordInjectAttempt(first, 2_000);
  assert.deepEqual(second, { windowStartMs: 1_000, count: 2 });
  const reset = recordInjectAttempt(second, 1_000 + INJECT_STORM_WINDOW_MS);
  assert.deepEqual(reset, { windowStartMs: 1_000 + INJECT_STORM_WINDOW_MS, count: 1 });
});

test('isInjectStorm fires strictly above the threshold', () => {
  assert.equal(isInjectStorm({ windowStartMs: 0, count: INJECT_STORM_THRESHOLD }), false);
  assert.equal(isInjectStorm({ windowStartMs: 0, count: INJECT_STORM_THRESHOLD + 1 }), true);
  assert.equal(isInjectStorm(null), false);
});

test('isInjectCircuitOpen blocks a storming tab until its window expires', () => {
  const storming = { windowStartMs: 100_000, count: INJECT_STORM_THRESHOLD + 1 };
  assert.equal(isInjectCircuitOpen(storming, 100_000 + INJECT_STORM_WINDOW_MS - 1), true);
  // Window elapsed: circuit closes on its own, next inject starts a fresh window.
  assert.equal(isInjectCircuitOpen(storming, 100_000 + INJECT_STORM_WINDOW_MS), false);
  // Below the threshold there is no circuit to open.
  assert.equal(isInjectCircuitOpen({ windowStartMs: 100_000, count: INJECT_STORM_THRESHOLD }, 100_001), false);
  assert.equal(isInjectCircuitOpen(null, 100_001), false);
});

test('recordCspReload counts within a window and resets after it', () => {
  const first = recordCspReload(undefined, 1_000);
  assert.deepEqual(first, { windowStartMs: 1_000, count: 1 });
  const second = recordCspReload(first, 2_000);
  assert.deepEqual(second, { windowStartMs: 1_000, count: 2 });
  const reset = recordCspReload(second, 1_000 + CSP_RELOAD_BUDGET_WINDOW_MS);
  assert.deepEqual(reset, { windowStartMs: 1_000 + CSP_RELOAD_BUDGET_WINDOW_MS, count: 1 });
});

test('isCspReloadBudgetExceeded caps reloads inside the window and refills after it', () => {
  const atCap = { windowStartMs: 1_000, count: CSP_RELOAD_BUDGET_MAX };
  assert.equal(isCspReloadBudgetExceeded(atCap, 2_000), true);
  assert.equal(isCspReloadBudgetExceeded({ windowStartMs: 1_000, count: CSP_RELOAD_BUDGET_MAX - 1 }, 2_000), false);
  // Window elapsed: the budget refills.
  assert.equal(isCspReloadBudgetExceeded(atCap, 1_000 + CSP_RELOAD_BUDGET_WINDOW_MS), false);
  assert.equal(isCspReloadBudgetExceeded(null, 2_000), false);
  assert.equal(isCspReloadBudgetExceeded({}, 2_000), false);
});

test('isRecentSelfRewrite matches only the same URL inside the window', () => {
  const entry = { url: 'https://example.com/page', ts: 50_000 };
  assert.equal(isRecentSelfRewrite(entry, 'https://example.com/page', 50_000 + SELF_REWRITE_WINDOW_MS - 1), true);
  assert.equal(isRecentSelfRewrite(entry, 'https://example.com/page', 50_000 + SELF_REWRITE_WINDOW_MS), false);
  assert.equal(isRecentSelfRewrite(entry, 'https://example.com/other', 50_100), false);
  assert.equal(isRecentSelfRewrite(null, 'https://example.com/page', 50_100), false);
});
