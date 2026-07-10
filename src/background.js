import {
  CSP_BLOCKED_MESSAGE,
  CSP_LEVEL,
  extractPreviewLaunchParams,
  extractHelperConfigFragment,
  hasHelperConfigFragment,
  isCspReloadBudgetExceeded,
  isHostAllowed,
  isInjectCircuitOpen,
  isInjectStorm,
  isRecentSelfRewrite,
  isRoverCspViolation,
  nextEscalationLevel,
  recordCspReload,
  normalizeConfig,
  normalizeHost,
  recordInjectAttempt,
  serializeConfigForSeed,
  shouldDebounceInject,
  shouldSkipInjectForProbe,
  STORAGE_KEY_PREFIX,
  stripPreviewLaunchParams,
} from './shared.js';
import { enableCspBypass, disableCspBypass } from './csp-bypass.js';
import {
  enableDebuggerCspBypass,
  disableDebuggerCspBypass,
} from './csp-bypass-debugger.js';

const inMemoryState = new Map();
// tabId -> { signature, inFlight: Promise|null, lastInjectAt }
const injectControl = new Map();
// tabId -> { windowStartMs, count } of full bundle injects
const injectStats = new Map();
// tabId -> { url, ts } of the last URL this extension itself rewrote
const lastSelfRewrites = new Map();
// tabId while a CSP escalation is being decided — a synchronous guard so a burst of
// securitypolicyviolation events can't trigger more than one reload per level.
const escalationInFlight = new Set();
const STATUS_KEY_PREFIX = 'rover-preview-helper:status:';
const CSP_LEVEL_KEY_PREFIX = 'rover-preview-helper:csp-level:';
const RELOAD_BUDGET_KEY_PREFIX = 'rover-preview-helper:reload-budget:';
const PERSISTED_CONFIG_KEY = 'rover-preview-helper:last-config';

async function persistConfig(config) {
  const toStore = { ...config };
  delete toStore.bootstrapId;
  delete toStore.targetHost;
  delete toStore.configRefreshedAt;
  await chrome.storage.local.set({ [PERSISTED_CONFIG_KEY]: toStore });
}

async function getPersistedConfig() {
  const stored = await chrome.storage.local.get(PERSISTED_CONFIG_KEY);
  return stored[PERSISTED_CONFIG_KEY] || null;
}

function storageKey(tabId) {
  return `${STORAGE_KEY_PREFIX}${tabId}`;
}

function statusKey(tabId) {
  return `${STATUS_KEY_PREFIX}${tabId}`;
}

function cspLevelKey(tabId) {
  return `${CSP_LEVEL_KEY_PREFIX}${tabId}`;
}

function reloadBudgetKey(tabId) {
  return `${RELOAD_BUDGET_KEY_PREFIX}${tabId}`;
}

async function getSessionValue(key) {
  return await chrome.storage.session.get(key);
}

async function setSessionValue(key, value) {
  await chrome.storage.session.set({ [key]: value });
}

async function removeSessionValue(key) {
  await chrome.storage.session.remove(key);
}

async function readState(tabId) {
  const memory = inMemoryState.get(tabId);
  if (memory) return memory;
  const stored = await getSessionValue(storageKey(tabId));
  const value = stored[storageKey(tabId)];
  if (value) {
    inMemoryState.set(tabId, value);
    return value;
  }
  return null;
}

async function writeState(tabId, state) {
  inMemoryState.set(tabId, state);
  await setSessionValue(storageKey(tabId), state);
}

async function clearState(tabId) {
  inMemoryState.delete(tabId);
  await removeSessionValue(storageKey(tabId));
}

async function writeStatus(tabId, message) {
  await setSessionValue(statusKey(tabId), String(message || '').trim());
}

async function readCspLevel(tabId) {
  const stored = await getSessionValue(cspLevelKey(tabId));
  const value = stored[cspLevelKey(tabId)];
  return value && typeof value === 'object' ? value : { level: CSP_LEVEL.NONE, host: '' };
}

async function writeCspLevel(tabId, level, host) {
  await setSessionValue(cspLevelKey(tabId), { level, host: String(host || '') });
}

async function clearCspLevel(tabId) {
  await removeSessionValue(cspLevelKey(tabId));
}

async function readReloadBudget(tabId) {
  const stored = await getSessionValue(reloadBudgetKey(tabId));
  const value = stored[reloadBudgetKey(tabId)];
  return value && typeof value === 'object' ? value : null;
}

async function noteCspReload(tabId) {
  const stats = recordCspReload(await readReloadBudget(tabId), Date.now());
  await setSessionValue(reloadBudgetKey(tabId), stats);
  return stats;
}

async function clearReloadBudget(tabId) {
  await removeSessionValue(reloadBudgetKey(tabId));
}

async function sanitizeTabUrl(tabId, url) {
  const cleanUrl = stripPreviewLaunchParams(url);
  if (!cleanUrl || cleanUrl === url) return;
  lastSelfRewrites.set(tabId, { url: cleanUrl, ts: Date.now() });
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'MAIN',
      injectImmediately: true,
      func: nextUrl => {
        try {
          if (window.location.href !== nextUrl) {
            window.history.replaceState(window.history.state, '', nextUrl);
          }
        } catch {
          // Ignore URL rewrite failures on locked-down pages.
        }
      },
      args: [cleanUrl],
    });
  } catch {
    // If this fails, the preview still works; the params just remain visible.
  }
}

async function fetchPreviewConfig(params, tabUrl) {
  const apiBase = String(params.apiBase || 'https://agent.rtrvr.ai').replace(/\/+$/, '');
  const response = await fetch(
    `${apiBase}/v2/rover/previews/${encodeURIComponent(params.previewId)}?previewToken=${encodeURIComponent(params.previewToken)}`,
    {
      credentials: 'omit',
      cache: 'no-store',
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `Preview fetch failed (${response.status}).`);
  }

  const payload = await response.json().catch(() => ({}));
  const data = payload?.data || payload || {};
  const fetchedAt = Date.now();
  const helperConfig = normalizeConfig({
    previewId: params.previewId,
    previewToken: params.previewToken,
    ...(data.helperConfig || {}),
    siteId: data.helperConfig?.siteId || data.siteId,
    sessionToken: data.helperConfig?.sessionToken || data.runtimeSessionToken,
    sessionId: data.helperConfig?.sessionId || data.sessionId,
    sessionTokenExpiresAt: data.runtimeSessionTokenExpiresAt || data.helperConfig?.sessionTokenExpiresAt,
    targetUrl: data.helperConfig?.targetUrl || data.targetUrl || tabUrl,
    apiBase,
    requestId: data.helperConfig?.requestId || data.activeLaunch?.requestId,
    attachToken: data.helperConfig?.attachToken || data.activeLaunch?.attachToken,
    launchUrl: data.helperConfig?.launchUrl || '',
    previewLabel: data.helperConfig?.previewLabel || `Rover Preview · ${data.host || normalizeHost(tabUrl) || 'site'}`,
    allowedDomains:
      data.helperConfig?.allowedDomains
      || (data.host ? [data.host] : []),
    domainScopeMode: data.helperConfig?.domainScopeMode || 'host_only',
    sessionScope: data.helperConfig?.sessionScope || 'shared_site',
    openOnInit: data.helperConfig?.openOnInit !== false,
    configRefreshedAt: fetchedAt,
  });

  if (!helperConfig.siteId || !helperConfig.sessionToken) {
    throw new Error('Preview response is missing siteId or runtime session token.');
  }

  return helperConfig;
}

function shouldRefreshState(state, nowMs = Date.now()) {
  if (!state?.previewId || !state?.previewToken) return false;
  const refreshedAt = Number(state.configRefreshedAt || 0);
  const sessionTokenExpiresAt = Number(state.sessionTokenExpiresAt || 0);
  if (!refreshedAt) return true;
  if (!sessionTokenExpiresAt) return nowMs - refreshedAt > 15_000;
  if (sessionTokenExpiresAt - nowMs < 60_000) return true;
  return nowMs - refreshedAt > 15_000;
}

async function refreshStateFromBackend(tabId, state, tabUrl, options = {}) {
  if (!state) return null;
  if (!state.previewId || !state.previewToken) return state;
  if (!options.force && !shouldRefreshState(state)) {
    return state;
  }

  const refreshed = await fetchPreviewConfig({
    previewId: state.previewId,
    previewToken: state.previewToken,
    apiBase: state.apiBase,
  }, tabUrl || state.targetUrl || '');
  const targetHost = buildTargetHost(tabUrl || refreshed.targetUrl || state.targetUrl, refreshed) || state.targetHost;
  const shouldRememberTargetHost = Boolean(refreshed.previewId && refreshed.previewToken);
  const nextState = normalizeConfig({
    ...state,
    ...refreshed,
    targetHost: shouldRememberTargetHost ? targetHost : '',
    configRefreshedAt: Date.now(),
  });
  const persistedState = {
    ...nextState,
    targetHost: shouldRememberTargetHost ? targetHost : '',
  };
  await writeState(tabId, persistedState);
  return persistedState;
}

async function maybeHydratePreviewFromUrl(tabId, tabUrl, reason = 'hydrate_url') {
  const params = extractPreviewLaunchParams(tabUrl);
  if (!params) return null;
  const config = await fetchPreviewConfig(params, tabUrl);
  await sanitizeTabUrl(tabId, tabUrl);
  return await injectFromTab(tabId, config, reason);
}

async function maybeHydrateGenericConfigFromUrl(tabId, tabUrl, reason = 'hydrate_url') {
  if (!hasHelperConfigFragment(tabUrl)) return null;
  const rawConfig = extractHelperConfigFragment(tabUrl);
  if (!rawConfig) return null;
  const config = normalizeConfig(rawConfig);
  await sanitizeTabUrl(tabId, tabUrl);
  if (config.previewId && config.previewToken) {
    const previewConfig = await fetchPreviewConfig({
      previewId: config.previewId,
      previewToken: config.previewToken,
      apiBase: config.apiBase,
    }, tabUrl);
    return await injectFromTab(tabId, {
      ...config,
      ...previewConfig,
    }, reason);
  }
  return await injectFromTab(tabId, config, reason);
}

function buildTargetHost(tabUrl, fallbackState) {
  const fromTab = normalizeHost(tabUrl);
  if (fromTab) return fromTab;
  return String(fallbackState?.targetHost || '').toLowerCase();
}

function canReinjectStateOnUrl(state, url) {
  const host = normalizeHost(url);
  if (!host) return false;
  const allowedDomains = Array.isArray(state?.allowedDomains)
    ? state.allowedDomains.map(item => String(item || '').trim()).filter(Boolean)
    : [];
  if (allowedDomains.length) {
    return isHostAllowed(host, allowedDomains, state.domainScopeMode);
  }
  const targetHost = String(state?.targetHost || '').trim().toLowerCase();
  if (targetHost) {
    return isHostAllowed(host, [`=${targetHost}`], 'host_only');
  }
  return true;
}

function collectRoverCspHostsForState(state) {
  const hosts = new Set();
  for (const value of [
    state?.apiBase,
    state?.embedScriptUrl,
    state?.workerUrl,
    state?.bootstrapUrl,
  ]) {
    let host = '';
    try {
      const parsed = new URL(String(value || ''));
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      host = parsed.hostname.toLowerCase();
    } catch {
      host = normalizeHost(value);
    }
    if (host) hosts.add(host);
  }
  return [...hosts];
}

async function resetCspBypass(tabId) {
  await Promise.allSettled([
    disableCspBypass(tabId),
    disableDebuggerCspBypass(tabId),
    clearCspLevel(tabId),
  ]);
  escalationInFlight.delete(tabId);
}

async function reconcileCspBypassForNavigation(tabId, state, url) {
  if (!state || !url) return false;
  if (!canReinjectStateOnUrl(state, url)) {
    await resetCspBypass(tabId);
    return false;
  }
  const host = normalizeHost(url);
  if (!host) return false;
  const current = await readCspLevel(tabId);
  if (current.host && current.host !== host) {
    await resetCspBypass(tabId);
  }
  return true;
}

async function prepareCspBypassForExplicitInject(tabId, state, url) {
  const current = await readCspLevel(tabId);
  if (current.level === CSP_LEVEL.FAILED) {
    await resetCspBypass(tabId);
    return true;
  }
  return await reconcileCspBypassForNavigation(tabId, state, url);
}

// Probe AND claim in one MAIN-world execution. Page JS is single-threaded, so
// the test-and-set below is atomic: when two triggers race past the service
// worker's own guards (the probe used to be a separate async round-trip),
// exactly ONE gets `claimed: true` — the other observes the live claim and
// skips, instead of both evaluating the 1.26 MB bundle (the inject-storm /
// double-eval vector the badge counters keep catching).
async function probeAndClaimMainWorld(tabId, signature) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'MAIN',
      injectImmediately: true,
      func: sig => {
        const out = {
          bootstrapped: window.__ROVER_PREVIEW_HELPER_BOOTSTRAPPED__ === true,
          attempted: window.__ROVER_PREVIEW_HELPER_BOOTSTRAP_ATTEMPTED__ === true,
          signature: String(window.__ROVER_PREVIEW_HELPER_SIGNATURE__ || ''),
          embedVersion: String(window.__ROVER_EMBED_VERSION__ || ''),
          claimed: false,
        };
        if (out.bootstrapped || out.attempted) return out;
        const claim = window.__ROVER_PREVIEW_HELPER_INJECTING__;
        const nowTs = Date.now();
        const claimLive =
          claim
          && typeof claim === 'object'
          && nowTs - Number(claim.at || 0) < 15_000;
        if (claimLive) return out; // someone else is mid-inject on this document
        window.__ROVER_PREVIEW_HELPER_INJECTING__ = { signature: String(sig || ''), at: nowTs };
        out.claimed = true;
        return out;
      },
      args: [String(signature || '')],
    });
    return results?.[0]?.result || null;
  } catch {
    return null;
  }
}

async function releaseFailedMainWorldClaim(tabId, signature) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'MAIN',
      injectImmediately: true,
      func: sig => {
        if (window.__ROVER_PREVIEW_HELPER_BOOTSTRAPPED__ === true) return false;
        const expected = String(sig || '');
        const activeSignature = String(window.__ROVER_PREVIEW_HELPER_SIGNATURE__ || '');
        const claimSignature = String(window.__ROVER_PREVIEW_HELPER_INJECTING__?.signature || '');
        if (activeSignature && activeSignature !== expected) return false;
        if (claimSignature && claimSignature !== expected) return false;
        delete window.__ROVER_PREVIEW_HELPER_INJECTING__;
        // The bootstrap sets ATTEMPTED before the large runtime evaluates. If
        // that file evaluation fails, retaining ATTEMPTED would permanently
        // suppress a same-signature retry even though no Rover instance exists.
        delete window.__ROVER_PREVIEW_HELPER_BOOTSTRAP_ATTEMPTED__;
        return true;
      },
      args: [String(signature || '')],
    });
  } catch {
    // The document may have navigated away; its claim disappears with it.
  }
}

async function noteFullInject(tabId, reason) {
  const stats = recordInjectAttempt(injectStats.get(tabId), Date.now());
  injectStats.set(tabId, stats);
  console.warn('[rover-helper] inject', { tabId, reason, countInWindow: stats.count });
  if (isInjectStorm(stats)) {
    try {
      await chrome.action.setBadgeText({ tabId, text: String(stats.count) });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#FF4C00' });
    } catch {
      // Badge is best-effort diagnostics only.
    }
    await writeStatus(tabId, `Re-inject storm: ${stats.count} injects/min (last: ${reason}).`).catch(() => {});
  }
}

// A manifest document_start content script is only installed on documents loaded
// after the extension was installed/reloaded. Users commonly reload an unpacked
// helper and then inject into an already-open target tab; without this explicit
// ensure, Rover runs but no listener exists to relay its first connect-src CSP
// violation, so the reactive DNR/CDP ladder never starts. content-start.js guards
// its setup in the isolated world, making this safe when the manifest path already
// ran or races with us during navigation.
async function ensureContentStartSensor(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    world: 'ISOLATED',
    injectImmediately: true,
    files: ['src/content-start.js'],
  });
}

async function injectMainWorldState(tabId, state, reason = 'unknown') {
  if (!state) return false;
  const signature = `${state.siteId}:${state.publicKey || ''}:${state.sessionToken || ''}:${state.launchUrl || state.requestId || ''}:${state.attachToken || ''}`;
  const control = injectControl.get(tabId);
  if (control?.inFlight && control.signature === signature) return control.inFlight;
  if (shouldDebounceInject(control, signature, Date.now())) return true;

  // Storm circuit breaker: once a tab tripped the storm threshold, stop
  // injecting until the window expires instead of only badging. An explicit
  // popup inject clears injectStats and so bypasses this.
  if (isInjectCircuitOpen(injectStats.get(tabId), Date.now())) {
    console.warn('[rover-helper] inject blocked: storm circuit open', { tabId, reason });
    return false;
  }

  // Load the Rover worker from the packaged file (resolved relative to the
  // extension, not the page) unless the caller pinned an explicit workerUrl.
  // embed.js is injected via executeScript below, so its document.currentScript
  // is null and it can't derive the worker path on its own.
  const seedState = {
    ...state,
    workerUrl: state.workerUrl || chrome.runtime.getURL('vendor/worker.js'),
    bootstrapId: signature,
  };

  const inFlight = (async () => {
    let claimed = false;
    try {
      // Install the reactive CSP relay before Rover can make its first request.
      // This also repairs already-open tabs that missed manifest content-script
      // registration after an extension update/reload.
      await ensureContentStartSensor(tabId);

    // A booted document can't accept new config anyway (the bootstrap guard
    // bails), and re-evaluating the bundle would replace window.rover and orphan
    // the live instance — so one tiny probe decides instead of a 1.26 MB eval.
    // A bailed bootstrap (attempted, not booted) is only retried with a NEW
    // signature; same config would bail again on the same document forever.
    // The probe also atomically CLAIMS the document (single-threaded page JS),
    // closing the async-probe race where two triggers both passed the check.
    const probe = await probeAndClaimMainWorld(tabId, signature);
    if (shouldSkipInjectForProbe(probe, signature) || probe?.claimed !== true) {
      console.debug('[rover-helper] inject skipped: bootstrapped, attempted, or claimed elsewhere', {
        tabId,
        reason,
        bootstrapped: probe?.bootstrapped === true,
        signatureMatch: probe?.signature === signature,
        claimed: probe?.claimed === true,
        embedVersion: probe?.embedVersion || undefined,
      });
      return true;
    }
    claimed = true;

    await noteFullInject(tabId, reason);

    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'MAIN',
      injectImmediately: true,
      func: previewState => {
        window.__ROVER_PREVIEW_HELPER_STATE__ = previewState;
        window.__ROVER_PREVIEW_HELPER_SIGNATURE__ = previewState.bootstrapId;
      },
      args: [serializeConfigForSeed(seedState)],
    });

    // Sets up the rover() queue and calls rover('boot', config) with workerUrl.
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'MAIN',
      injectImmediately: true,
      files: ['src/main-world-bootstrap.js'],
    });

    // Inject the packaged Rover runtime directly. Scripts injected via
    // executeScript bypass the page's CSP, so this works on hardened sites where
    // a remote <script src="https://rover.rtrvr.ai/embed.js"> tag is blocked.
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'MAIN',
      injectImmediately: true,
      files: ['vendor/rover-embed.js'],
    });

    return true;
    } catch (error) {
      if (claimed) await releaseFailedMainWorldClaim(tabId, signature);
      throw error;
    }
  })();

  injectControl.set(tabId, { signature, inFlight, lastInjectAt: Date.now() });
  let succeeded = false;
  try {
    const result = await inFlight;
    succeeded = result === true;
    return result;
  } finally {
    const current = injectControl.get(tabId);
    if (current && current.inFlight === inFlight) {
      injectControl.set(tabId, { signature, inFlight: null, lastInjectAt: succeeded ? Date.now() : 0 });
    }
  }
}

export {
  ensureContentStartSensor,
  injectMainWorldState,
  probeAndClaimMainWorld,
  releaseFailedMainWorldClaim,
};

// Inject Rover into a tab, first ensuring the page CSP won't block its egress.
// The CSP relaxation only takes effect on the next document load, so the first
// time we enable it for a tab we reload and let the readiness/navigation hooks
// re-run injection on the clean page. Subsequent calls inject directly.
//
// The declarativeNetRequest strip only removes CSP *response headers*. A site that
// ships its policy in a <meta http-equiv> tag (e.g. app.merge.dev) still blocks
// Rover's egress, so when the main-world probe reports one we escalate to the
// debugger-based Page.setBypassCSP, which disables header AND meta CSP for the tab.
async function applyStateToTab(tabId, state, reason = 'unknown') {
  if (!state) return false;
  return await injectMainWorldState(tabId, state, reason);
}

// Relax the page CSP one rung further for a tab that just reported a Rover-caused
// CSP violation, then reload so it takes effect on a clean load. Bounded ladder
// (none -> DNR header strip -> DNR + chrome.debugger -> failed), guarded so a burst
// of violations only reloads once per level.
async function escalateCspBypass(tabId, hasMetaCsp, host) {
  if (!host) return;
  if (escalationInFlight.has(tabId)) return;
  escalationInFlight.add(tabId);
  try {
    // Escalation reloads are budgeted per tab (persisted in storage.session so
    // MV3 service-worker teardown between host hops can't reset it). A workflow
    // that hops hosts re-climbs the ladder per host; without a budget that's an
    // unbounded reload loop on a tab the user may not even be looking at.
    if (isCspReloadBudgetExceeded(await readReloadBudget(tabId), Date.now())) {
      await writeStatus(tabId, `CSP bypass reload budget reached for this tab — re-inject from the popup to continue on ${host || 'this site'}.`);
      return;
    }
    let current = await readCspLevel(tabId);
    // A genuinely different host starts the ladder over and drops any tab-wide
    // bypass inherited from the previous host.
    if (current.host && current.host !== host) {
      await resetCspBypass(tabId);
      current = { level: CSP_LEVEL.NONE, host: '' };
    }
    const level = current.level;
    const step = nextEscalationLevel(level, { hasMetaCsp });

    if (step.failed) {
      await writeCspLevel(tabId, CSP_LEVEL.FAILED, host);
      await writeStatus(tabId, `${host || 'This site'} still blocks Rover after the strongest CSP bypass. Try reloading or re-injecting.`);
      return;
    }

    if (step.enableDnr) await enableCspBypass(tabId);
    if (step.attachCdp) {
      try {
        await enableDebuggerCspBypass(tabId, host);
      } catch (error) {
        await writeStatus(tabId, `Couldn't attach the stronger CSP bypass for ${host || 'this tab'}: ${error?.message || error}.`);
        return;
      }
    }

    // Persist the advanced level BEFORE reloading so a still-blocked reload reads the
    // higher level and climbs, rather than repeating this one.
    await writeCspLevel(tabId, step.level, host);
    await writeStatus(tabId, step.attachCdp
      ? `${host || 'This site'} enforces CSP via a <meta> tag — using a stronger bypass (a debug banner will appear), then reloading…`
      : `Relaxing ${host || 'this site'}'s CSP so Rover can connect, then reloading…`);
    await noteCspReload(tabId);
    await chrome.tabs.reload(tabId);
  } finally {
    escalationInFlight.delete(tabId);
  }
}

async function injectFromTab(tabId, config, reason = 'popup_inject') {
  const tab = await chrome.tabs.get(tabId);
  const currentUrl = String(tab.url || '');
  const targetHost = buildTargetHost(currentUrl, config);
  const shouldRememberTargetHost = Boolean(config?.previewId && config?.previewToken);

  if (!targetHost) {
    throw new Error('Target host is required to inject Rover.');
  }
  const normalized = normalizeConfig({
    ...config,
  });
  if (!normalized.siteId || (!normalized.publicKey && !normalized.sessionToken)) {
    throw new Error('siteId and either publicKey or sessionToken are required.');
  }
  if (!isHostAllowed(targetHost, normalized.allowedDomains, normalized.domainScopeMode)) {
    throw new Error(`This tab host (${targetHost}) is outside allowedDomains. Update your Workspace config or open a matching host.`);
  }
  const launchUrl = normalized.launchUrl || '';
  const state = {
    ...normalized,
    targetHost: shouldRememberTargetHost ? targetHost : '',
    launchUrl,
    bootstrapId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  };

  await writeState(tabId, state);
  await persistConfig(state);
  // An explicit inject is a deliberate user action: reopen the storm circuit
  // and refill the reload budget so recovery is always possible by hand.
  injectStats.delete(tabId);
  await clearReloadBudget(tabId).catch(() => {});
  // An explicit inject recovers a tab that hit the CSP ceiling and drops any
  // tab-wide bypass inherited from another host, while preserving a same-host
  // bypass that is already keeping a strict page working.
  await prepareCspBypassForExplicitInject(tabId, state, currentUrl);
  const injected = await applyStateToTab(tabId, state, reason);
  if (injected) {
    await writeStatus(tabId, `Rover injected for ${targetHost}.`);
  }

  return state;
}

async function reconnectTab(tabId) {
  const state = await readState(tabId);
  if (!state) throw new Error('No saved preview state for this tab.');
  let refreshed = state;
  try {
    refreshed = await refreshStateFromBackend(tabId, state, state.targetUrl || '', { force: true }) || state;
  } catch {
    refreshed = state;
  }
  return await applyStateToTab(tabId, refreshed, 'popup_reconnect');
}

function getTabIdFromSender(sender) {
  return Number.isFinite(sender?.tab?.id) ? sender.tab.id : null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;

  if (message.type === CSP_BLOCKED_MESSAGE) {
    const tabId = getTabIdFromSender(sender);
    if (tabId === null) return;
    void (async () => {
      // Only escalate when Rover is actually meant to be in this tab.
      const state = await readState(tabId);
      if (!state) return;
      const pageUrl = String(message.url || sender?.tab?.url || '');
      if (!canReinjectStateOnUrl(state, pageUrl)) {
        await resetCspBypass(tabId);
        return;
      }
      // Ignore the host site's own CSP violations and report-only policies.
      if (!isRoverCspViolation(message, { extraHosts: collectRoverCspHostsForState(state) })) return;
      const host = normalizeHost(pageUrl);
      await escalateCspBypass(tabId, message.hasMetaCsp === true, host);
    })();
    return;
  }

  if (message.type === 'ROVER_PREVIEW_HELPER_PAGE_READY') {
    const tabId = getTabIdFromSender(sender);
    if (tabId === null) return;
    void (async () => {
      const pageUrl = String(message.url || sender?.tab?.url || '');
      if (pageUrl) {
        try {
          const hydrated = await maybeHydratePreviewFromUrl(tabId, pageUrl, 'page_ready');
          if (hydrated) return;
        } catch {
          // Fall through to stored-state reconnect.
        }
        try {
          const hydrated = await maybeHydrateGenericConfigFromUrl(tabId, pageUrl, 'page_ready');
          if (hydrated) return;
        } catch (error) {
          await sanitizeTabUrl(tabId, pageUrl).catch(() => {});
          await writeStatus(tabId, String(error?.message || error || 'Invalid Rover helper handoff.'));
        }
      }
      const state = await readState(tabId);
      if (!state) return;
      if (pageUrl && !(await reconcileCspBypassForNavigation(tabId, state, pageUrl))) return;
      try {
        const refreshed = await refreshStateFromBackend(tabId, state, pageUrl).catch(() => state);
        const injected = await applyStateToTab(tabId, refreshed || state, 'page_ready');
        if (injected) {
          await writeStatus(tabId, `Rover reconnected for ${buildTargetHost(pageUrl, refreshed || state) || 'this tab'}.`);
        }
      } catch {
        // Ignore readiness races; tab navigation hooks will retry.
      }
    })();
    return;
  }

  if (message.type === 'ROVER_PREVIEW_HELPER_GET_PERSISTED_CONFIG') {
    void (async () => {
      const config = await getPersistedConfig();
      sendResponse({ ok: true, config });
    })().catch(error => {
      sendResponse({ ok: false, error: String(error?.message || error) });
    });
    return true;
  }

  if (message.type === 'ROVER_PREVIEW_HELPER_SET_CONFIG') {
    const tabId = Number(message.tabId);
    const config = normalizeConfig(message.config || {});
    void (async () => {
      const state = await injectFromTab(tabId, config, 'popup_set_config');
      sendResponse({ ok: true, state });
    })().catch(error => {
      sendResponse({ ok: false, error: String(error?.message || error) });
    });
    return true;
  }

  if (message.type === 'ROVER_PREVIEW_HELPER_INJECT') {
    const tabId = Number(message.tabId);
    const config = normalizeConfig(message.config || {});
    void (async () => {
      const state = await injectFromTab(tabId, config, 'popup_inject');
      sendResponse({ ok: true, state });
    })().catch(error => {
      sendResponse({ ok: false, error: String(error?.message || error) });
    });
    return true;
  }

  if (message.type === 'ROVER_PREVIEW_HELPER_RECONNECT') {
    const tabId = Number(message.tabId);
    void (async () => {
      await reconnectTab(tabId);
      sendResponse({ ok: true });
    })().catch(error => {
      sendResponse({ ok: false, error: String(error?.message || error) });
    });
    return true;
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  void clearState(tabId);
  void resetCspBypass(tabId);
  void clearReloadBudget(tabId);
  injectControl.delete(tabId);
  injectStats.delete(tabId);
  lastSelfRewrites.delete(tabId);
  escalationInFlight.delete(tabId);
});

// Re-inject only on 'loading' (earliest hook after a hard navigation); the
// PAGE_READY content-script message covers every new document, and the
// bootstrapped-probe makes duplicate triggers a micro no-op. onUpdated
// 'complete' and webNavigation.onCompleted were fully redundant sources that
// each re-evaluated the 1.26 MB bundle on the page main thread.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = String(changeInfo.url || tab.url || '');
  if (!url) return;

  void (async () => {
    try {
      const hydrated = await maybeHydratePreviewFromUrl(tabId, url, 'tabs_updated_loading');
      if (hydrated) return;
    } catch {
      // If hydration fails, fall back to any saved preview state.
    }
    const state = await readState(tabId);
    if (!state) return;
    if (!(await reconcileCspBypassForNavigation(tabId, state, url))) return;
    if (changeInfo.status === 'loading') {
      const refreshed = await refreshStateFromBackend(tabId, state, url).catch(() => state);
      await applyStateToTab(tabId, refreshed || state, 'tabs_updated_loading');
    }
  })();
});

chrome.webNavigation.onHistoryStateUpdated.addListener(details => {
  if (details.frameId !== 0) return;
  // Our own history.replaceState rewrites (sanitizeTabUrl, the bootstrap's
  // launch-param handling) fire this event too — don't feed back into inject.
  if (isRecentSelfRewrite(lastSelfRewrites.get(details.tabId), details.url || '', Date.now())) return;
  void (async () => {
    try {
      const hydrated = await maybeHydratePreviewFromUrl(details.tabId, details.url || '', 'history_state');
      if (hydrated) return;
    } catch {
      // Ignore and keep reconnect behavior.
    }
    const state = await readState(details.tabId);
    if (!state) return;
    if (!(await reconcileCspBypassForNavigation(details.tabId, state, details.url || ''))) return;
    const refreshed = await refreshStateFromBackend(details.tabId, state, details.url || '').catch(() => state);
    await applyStateToTab(details.tabId, refreshed || state, 'history_state');
  })();
});
