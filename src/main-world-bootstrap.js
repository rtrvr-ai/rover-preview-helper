(() => {
  const state = window.__ROVER_PREVIEW_HELPER_STATE__;
  if (!state || window.__ROVER_PREVIEW_HELPER_BOOTSTRAPPED__) return;
  // "This config was tried on this document" — set before the host-allow check
  // so a bail doesn't leave the background re-injecting the 1.26 MB bundle on
  // every navigation event. BOOTSTRAPPED below keeps meaning "a live Rover
  // instance owns this document"; the probe treats attempted+same-signature as
  // skip, while a changed config (new signature) still gets a fresh attempt.
  window.__ROVER_PREVIEW_HELPER_BOOTSTRAP_ATTEMPTED__ = true;

  const normalizeDomainPattern = value => {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';
    if (raw === '*') return '*';
    const exact = raw.startsWith('=');
    const wildcard = !exact && raw.startsWith('*.');
    const core = exact ? raw.slice(1) : (wildcard ? raw.slice(2) : raw);
    try {
      const host = new URL(core.startsWith('http://') || core.startsWith('https://') ? core : `https://${core}`)
        .hostname
        .toLowerCase();
      if (!host) return '';
      if (exact) return `=${host}`;
      if (wildcard) return `*.${host}`;
      return host;
    } catch {
      return core
        .replace(/^[a-z]+:\/\//, '')
        .replace(/\/.*$/, '')
        .replace(/:\d+$/, '')
        .trim();
    }
  };
  const isHostAllowed = (host, patterns, domainScopeMode) => {
    const normalizedHost = String(host || '').trim().toLowerCase();
    if (!normalizedHost) return false;
    const rules = Array.isArray(patterns) ? patterns.map(normalizeDomainPattern).filter(Boolean) : [];
    if (!rules.length) return true;
    return rules.some(pattern => {
      if (pattern === '*') return true;
      if (pattern.startsWith('=')) return normalizedHost === pattern.slice(1);
      if (pattern.startsWith('*.')) {
        const suffix = pattern.slice(2);
        return normalizedHost.length > suffix.length && normalizedHost.endsWith(`.${suffix}`);
      }
      if (domainScopeMode === 'host_only') return normalizedHost === pattern;
      return normalizedHost === pattern || normalizedHost.endsWith(`.${pattern}`);
    });
  };

  const currentHost = String(location.hostname || '').toLowerCase();
  const allowed = Array.isArray(state.allowedDomains) ? state.allowedDomains : [];
  const explicitHost = String(state.targetHost || '').toLowerCase();
  if (allowed.length) {
    if (!isHostAllowed(currentHost, allowed, state.domainScopeMode)) return;
  } else if (explicitHost && !isHostAllowed(currentHost, [explicitHost], 'host_only')) {
    return;
  }
  window.__ROVER_PREVIEW_HELPER_BOOTSTRAPPED__ = true;

  const launchUrl = String(state.launchUrl || '').trim();
  if (launchUrl) {
    try {
      const next = new URL(launchUrl, location.href);
      history.replaceState(history.state, '', next.toString());
    } catch {
      // Ignore URL normalization failures and keep current location.
    }
  } else if (state.requestId && state.attachToken) {
    const next = new URL(location.href);
    next.searchParams.set('rover_launch', state.requestId);
    next.searchParams.set('rover_attach', state.attachToken);
    history.replaceState(history.state, '', next.toString());
  }

  const apiBase = String(state.apiBase || 'https://agent.rtrvr.ai').trim() || 'https://agent.rtrvr.ai';
  const siteId = String(state.siteId || '').trim();
  const publicKey = String(state.publicKey || '').trim();
  const sessionToken = String(state.sessionToken || '').trim();
  const sessionId = String(state.sessionId || '').trim();
  const siteKeyId = String(state.siteKeyId || '').trim();
  const workerUrl = String(state.workerUrl || '').trim();
  const domainScopeMode = state.domainScopeMode === 'host_only' ? 'host_only' : 'registrable_domain';
  const sessionScope = state.sessionScope === 'shared_site' || state.sessionScope === 'tab'
    ? state.sessionScope
    : '';
  const allowedDomains = allowed.length ? allowed : [location.hostname];
  const normalizeSpotlightColor = (value) => {
    const raw = String(value || '').trim();
    const match = raw.match(/^#?([0-9a-fA-F]{6})$/);
    return match ? `#${match[1].toUpperCase()}` : undefined;
  };

  const rover = window.rover = window.rover || function () {
    (rover.q = rover.q || []).push(arguments);
  };
  rover.l = +new Date();

  const bootConfig = {
    siteId,
    apiBase,
    allowedDomains,
    domainScopeMode,
    openOnInit: state.openOnInit !== false,
    ui: {
      muted: true,
    },
  };
  if (typeof state.cloudSandboxEnabled === 'boolean') {
    bootConfig.cloudSandboxEnabled = state.cloudSandboxEnabled;
  }
  if (state.pageConfig && typeof state.pageConfig === 'object') {
    const pageConfig = {};
    if (typeof state.pageConfig.disableAutoScroll === 'boolean') {
      pageConfig.disableAutoScroll = state.pageConfig.disableAutoScroll;
    }
    if (['identity', 'digest_unchanged', 'full'].includes(state.pageConfig.backgroundTabs)) {
      pageConfig.backgroundTabs = state.pageConfig.backgroundTabs;
    }
    if (Object.keys(pageConfig).length) bootConfig.pageConfig = pageConfig;
  }
  if (state.ui && typeof state.ui === 'object') {
    const voice = state.ui.voice;
    if (voice && typeof voice === 'object') {
      const nextVoice = {};
      if (typeof voice.enabled === 'boolean') nextVoice.enabled = voice.enabled;
      const language = String(voice.language || '').trim();
      if (language) nextVoice.language = language;
      const autoStopMs = Number(voice.autoStopMs);
      if (Number.isFinite(autoStopMs)) nextVoice.autoStopMs = autoStopMs;
      if (Object.keys(nextVoice).length > 0) {
        bootConfig.ui.voice = nextVoice;
      }
    }
    const actionSpotlight = state.ui.experience?.motion?.actionSpotlight;
    const actionSpotlightColor = normalizeSpotlightColor(state.ui.experience?.motion?.actionSpotlightColor) || '#FF4C00';
    bootConfig.ui.experience = {
      motion: {
        actionSpotlight: actionSpotlight !== false,
        actionSpotlightColor,
      },
    };
  } else {
    bootConfig.ui.experience = {
      motion: {
        actionSpotlight: true,
        actionSpotlightColor: '#FF4C00',
      },
    };
  }
  if (publicKey) bootConfig.publicKey = publicKey;
  if (sessionToken) bootConfig.sessionToken = sessionToken;
  if (sessionId) bootConfig.sessionId = sessionId;
  if (siteKeyId) bootConfig.siteKeyId = siteKeyId;
  if (workerUrl) bootConfig.workerUrl = workerUrl;
  if (sessionScope) bootConfig.sessionScope = sessionScope;
  if (state.mode) bootConfig.mode = state.mode;
  if (typeof state.allowActions === 'boolean') bootConfig.allowActions = state.allowActions;

  rover('boot', bootConfig);

  // The packaged Rover runtime (vendor/rover-embed.js) is injected by the
  // background service worker via chrome.scripting.executeScript right after this
  // bootstrap, so it bypasses the page CSP and drains this rover('boot', ...) call
  // from the queue. We intentionally do not append a remote <script> tag here.

  delete window.__ROVER_PREVIEW_HELPER_STATE__;
})();
