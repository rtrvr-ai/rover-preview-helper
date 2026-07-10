export const STORAGE_KEY_PREFIX = 'rover-preview-helper:tab:';
export const INJECT_DEBOUNCE_MS = 1500;
export const INJECT_STORM_WINDOW_MS = 60_000;
export const INJECT_STORM_THRESHOLD = 5;
export const SELF_REWRITE_WINDOW_MS = 5000;
export const PREVIEW_ID_PARAM = 'rover_preview_id';
export const PREVIEW_TOKEN_PARAM = 'rover_preview_token';
export const PREVIEW_API_PARAM = 'rover_preview_api';
export const HELPER_PAYLOAD_FRAGMENT_PARAM = 'rover_helper_payload';
const DEFAULT_EMBED_SCRIPT_URL = 'https://rover.rtrvr.ai/embed.js';
const DEFAULT_API_BASE = 'https://agent.rtrvr.ai';
const VOICE_AUTO_STOP_MIN_MS = 800;
const VOICE_AUTO_STOP_MAX_MS = 5000;
const DEFAULT_ACTION_SPOTLIGHT_COLOR = '#FF4C00';

export function readCurrentTabId(tabId) {
  const value = Number(tabId);
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

export function normalizeHost(urlString) {
  try {
    return new URL(urlString).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function normalizeAllowedDomains(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item || '').trim()).filter(Boolean);
  }
  const raw = String(value || '').trim();
  if (!raw) return [];
  return raw.split(',').map(item => item.trim()).filter(Boolean);
}

function normalizeVoiceConfig(value) {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value;
  const voice = {};
  if (typeof raw.enabled === 'boolean') {
    voice.enabled = raw.enabled;
  }
  const language = String(raw.language || '')
    .trim()
    .replace(/[^a-zA-Z0-9-]/g, '')
    .slice(0, 48);
  if (language) {
    voice.language = language;
  }
  const autoStopMs = Number(raw.autoStopMs);
  if (Number.isFinite(autoStopMs)) {
    voice.autoStopMs = Math.max(VOICE_AUTO_STOP_MIN_MS, Math.min(VOICE_AUTO_STOP_MAX_MS, Math.trunc(autoStopMs)));
  }
  return Object.keys(voice).length ? voice : undefined;
}

function normalizeHexColor(value) {
  const raw = String(value || '').trim();
  if (!raw) return undefined;
  const match = raw.match(/^#?([0-9a-fA-F]{6})$/);
  return match ? `#${match[1].toUpperCase()}` : undefined;
}

function normalizeUiConfig(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const ui = {};
  const voice = normalizeVoiceConfig(raw.voice);
  if (voice) {
    ui.voice = voice;
  }
  const actionSpotlight = raw.experience?.motion?.actionSpotlight;
  const actionSpotlightColor = normalizeHexColor(raw.experience?.motion?.actionSpotlightColor) || DEFAULT_ACTION_SPOTLIGHT_COLOR;
  ui.experience = {
    motion: {
      actionSpotlight: actionSpotlight !== false,
      actionSpotlightColor,
    },
  };
  return Object.keys(ui).length ? ui : undefined;
}

function normalizePageConfig(value) {
  if (!value || typeof value !== 'object') return undefined;
  const pageConfig = {};
  if (typeof value.disableAutoScroll === 'boolean') {
    pageConfig.disableAutoScroll = value.disableAutoScroll;
  }
  if (value.backgroundTabs === 'identity' || value.backgroundTabs === 'digest_unchanged' || value.backgroundTabs === 'full') {
    pageConfig.backgroundTabs = value.backgroundTabs;
  }
  return Object.keys(pageConfig).length ? pageConfig : undefined;
}

function encodeBase64Url(bytes) {
  const base64 = typeof Buffer !== 'undefined'
    ? Buffer.from(bytes).toString('base64')
    : btoa(String.fromCharCode(...bytes));

  return base64
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeBase64Url(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  if (!normalized) throw new Error('Missing helper config payload.');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  const base64 = `${normalized}${padding}`;

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(base64, 'base64').toString('utf8');
  }

  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function normalizeDomainPattern(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    try {
      return new URL(raw).hostname.toLowerCase();
    } catch {
      return '';
    }
  }
  return raw
    .replace(/^[a-z]+:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .trim();
}

export function isHostAllowed(host, allowedDomains, domainScopeMode = 'registrable_domain') {
  const normalizedHost = String(host || '').trim().toLowerCase();
  if (!normalizedHost) return false;
  const patterns = normalizeAllowedDomains(allowedDomains).map(normalizeDomainPattern).filter(Boolean);
  if (!patterns.length) return true;

  return patterns.some(pattern => {
    if (pattern === '*') return true;
    if (pattern.startsWith('=')) {
      return normalizedHost === pattern.slice(1);
    }
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2);
      return normalizedHost.length > suffix.length && normalizedHost.endsWith(`.${suffix}`);
    }
    if (domainScopeMode === 'host_only') {
      return normalizedHost === pattern;
    }
    return normalizedHost === pattern || normalizedHost.endsWith(`.${pattern}`);
  });
}

export function normalizeConfig(input = {}) {
  const previewId = String(input.previewId || '').trim();
  const previewToken = String(input.previewToken || '').trim();
  const siteId = String(input.siteId || '').trim();
  const publicKey = String(input.publicKey || '').trim();
  const sessionToken = String(input.sessionToken || '').trim();
  const sessionId = String(input.sessionId || '').trim();
  const siteKeyId = String(input.siteKeyId || input.keyId || '').trim();
  const sessionTokenExpiresAt = Number(input.sessionTokenExpiresAt);
  const embedScriptUrl = String(input.embedScriptUrl || DEFAULT_EMBED_SCRIPT_URL).trim() || DEFAULT_EMBED_SCRIPT_URL;
  const launchUrl = String(input.launchUrl || '').trim();
  const requestId = String(input.requestId || '').trim();
  const attachToken = String(input.attachToken || '').trim();
  const targetUrl = String(input.targetUrl || '').trim();
  const apiBase = String(input.apiBase || DEFAULT_API_BASE).trim() || DEFAULT_API_BASE;
  const workerUrl = String(input.workerUrl || '').trim();
  const domainScopeMode = input.domainScopeMode === 'host_only' ? 'host_only' : 'registrable_domain';
  const allowedDomains = normalizeAllowedDomains(input.allowedDomains);
  const sessionScope = ['shared_site', 'tab'].includes(String(input.sessionScope || '').trim())
    ? String(input.sessionScope).trim()
    : '';
  const openOnInit = input.openOnInit !== false;
  const mode = ['safe', 'full'].includes(String(input.mode || '').trim()) ? String(input.mode).trim() : '';
  const allowActions = typeof input.allowActions === 'boolean' ? input.allowActions : undefined;
  const cloudSandboxEnabled = typeof input.cloudSandboxEnabled === 'boolean' ? input.cloudSandboxEnabled : undefined;
  const pageConfig = normalizePageConfig(input.pageConfig) || { disableAutoScroll: true };
  const previewLabel = String(input.previewLabel || 'Rover Preview').trim();
  const configRefreshedAt = Number(input.configRefreshedAt);
  const ui = normalizeUiConfig(input.ui);

  return {
    previewId,
    previewToken,
    siteId,
    publicKey,
    sessionToken,
    sessionId,
    siteKeyId,
    sessionTokenExpiresAt: Number.isFinite(sessionTokenExpiresAt) ? sessionTokenExpiresAt : 0,
    embedScriptUrl,
    launchUrl,
    requestId,
    attachToken,
    targetUrl,
    apiBase,
    workerUrl,
    allowedDomains,
    domainScopeMode,
    sessionScope,
    openOnInit,
    mode,
    allowActions,
    cloudSandboxEnabled,
    pageConfig,
    ui,
    previewLabel,
    configRefreshedAt: Number.isFinite(configRefreshedAt) ? configRefreshedAt : 0,
  };
}

export function extractPreviewLaunchParams(urlString) {
  try {
    const url = new URL(urlString);
    const previewId = String(url.searchParams.get(PREVIEW_ID_PARAM) || '').trim();
    const previewToken = String(url.searchParams.get(PREVIEW_TOKEN_PARAM) || '').trim();
    const apiBase = String(url.searchParams.get(PREVIEW_API_PARAM) || '').trim();
    if (!previewId || !previewToken) return null;
    return {
      previewId,
      previewToken,
      apiBase,
    };
  } catch {
    return null;
  }
}

function getHelperFragmentValue(rawHash) {
  if (!rawHash || !rawHash.includes('=')) return '';
  const params = new URLSearchParams(rawHash);
  return String(
    params.get(HELPER_PAYLOAD_FRAGMENT_PARAM) || '',
  ).trim();
}

export function hasHelperConfigFragment(urlString) {
  try {
    const url = new URL(urlString);
    const rawHash = String(url.hash || '').replace(/^#/, '').trim();
    return Boolean(getHelperFragmentValue(rawHash));
  } catch {
    return false;
  }
}

export function extractHelperConfigFragment(urlString) {
  try {
    const url = new URL(urlString);
    const rawHash = String(url.hash || '').replace(/^#/, '').trim();
    const encoded = getHelperFragmentValue(rawHash);
    if (!encoded) return null;
    const decoded = decodeBase64Url(encoded);
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    const message = String(error?.message || error || 'Invalid helper handoff payload.');
    throw new Error(`Invalid Rover helper handoff: ${message}`);
  }
}

export function stripPreviewLaunchParams(urlString) {
  try {
    const url = new URL(urlString);
    url.searchParams.delete(PREVIEW_ID_PARAM);
    url.searchParams.delete(PREVIEW_TOKEN_PARAM);
    url.searchParams.delete(PREVIEW_API_PARAM);
    const rawHash = String(url.hash || '').replace(/^#/, '').trim();
    if (rawHash && rawHash.includes('=')) {
      const params = new URLSearchParams(rawHash);
      params.delete(HELPER_PAYLOAD_FRAGMENT_PARAM);
      const nextHash = params.toString();
      url.hash = nextHash ? nextHash : '';
    }
    return url.toString();
  } catch {
    return urlString;
  }
}

export function buildLaunchUrl(currentUrl, config) {
  if (config.launchUrl) return config.launchUrl;
  if (!config.requestId || !config.attachToken) return '';
  const url = new URL(currentUrl);
  url.searchParams.set('rover_launch', config.requestId);
  url.searchParams.set('rover_attach', config.attachToken);
  return url.toString();
}

export function serializeConfigForSeed(config) {
  return {
    previewId: config.previewId,
    previewToken: config.previewToken,
    siteId: config.siteId,
    publicKey: config.publicKey,
    sessionToken: config.sessionToken,
    sessionId: config.sessionId,
    siteKeyId: config.siteKeyId,
    sessionTokenExpiresAt: config.sessionTokenExpiresAt,
    embedScriptUrl: config.embedScriptUrl,
    launchUrl: config.launchUrl,
    requestId: config.requestId,
    attachToken: config.attachToken,
    targetUrl: config.targetUrl,
    apiBase: config.apiBase,
    workerUrl: config.workerUrl,
    allowedDomains: config.allowedDomains,
    domainScopeMode: config.domainScopeMode,
    sessionScope: config.sessionScope,
    openOnInit: config.openOnInit,
    mode: config.mode,
    allowActions: config.allowActions,
    cloudSandboxEnabled: config.cloudSandboxEnabled,
    pageConfig: config.pageConfig,
    ui: config.ui,
    previewLabel: config.previewLabel,
    targetHost: config.targetHost,
    bootstrapId: config.bootstrapId,
    configRefreshedAt: config.configRefreshedAt,
  };
}

export function encodeHelperConfigFragment(config) {
  const json = JSON.stringify(config || {});
  const bytes = typeof TextEncoder !== 'undefined'
    ? new TextEncoder().encode(json)
    : Uint8Array.from(Buffer.from(json, 'utf8'));
  return `${HELPER_PAYLOAD_FRAGMENT_PARAM}=${encodeBase64Url(bytes)}`;
}

// A document keeps its booted Rover instance for its whole lifetime: the
// bootstrap guard bails on a second run, so re-injecting the bundle can never
// deliver new config — it only re-evaluates ~1.26 MB on the page main thread
// and replaces window.rover, orphaning the live instance. Skip whenever the
// probe says the document already bootstrapped, regardless of signature.
//
// A bootstrap that ran but BAILED (host-allow check) leaves bootstrapped=false
// but attempted=true. The hostname can't change within a document, so retrying
// the same config would bail forever — skip it. A different signature means new
// config (e.g. corrected allowedDomains from an explicit inject) that may pass
// the host check, so it gets one fresh attempt.
export function shouldSkipInjectForProbe(probe, signature) {
  if (!probe) return false;
  if (probe.bootstrapped === true) return true;
  return probe.attempted === true && String(probe.signature || '') === String(signature || '');
}

// CSP is only relaxed *reactively* — when the page fires a real
// `securitypolicyviolation` that is attributable to Rover. content-start.js relays
// those to the background as this message.
export const CSP_BLOCKED_MESSAGE = 'ROVER_PREVIEW_HELPER_CSP_BLOCKED';

// Hosts Rover's runtime talks to / loads assets from. A CSP violation whose
// blockedURI resolves to one of these is Rover's, not the site's own traffic.
export const ROVER_HOSTS = [
  'agent.rtrvr.ai',
  'extensionrouter.rtrvr.ai',
  'roverbook.rtrvr.ai',
  'rover.rtrvr.ai',
  'www.rtrvr.ai',
];

// Rover boots a blob: module worker; a CSP block on creating it reports one of these
// directives with a blob/empty blockedURI (never a real host). Rover's own script is
// injected via executeScript, which bypasses script-src, so script-src/inline/eval
// violations are always the site's own and must NOT be attributed to Rover.
export const ROVER_WORKER_DIRECTIVES = ['worker-src', 'child-src', 'default-src'];

// Decide whether a securitypolicyviolation is caused by Rover (so we should relax the
// page CSP) rather than by the host site's own blocked traffic. Only enforced (not
// report-only) violations count.
export function isRoverCspViolation({ blockedURI, effectiveDirective, disposition } = {}, options = {}) {
  if (disposition !== 'enforce') return false;
  const raw = String(blockedURI || '').toLowerCase().trim();
  const directive = String(effectiveDirective || '').toLowerCase().trim();
  const isWorkerLike = raw === ''
    || raw === 'blob'
    || raw.startsWith('blob:')
    || raw.startsWith('chrome-extension:');
  if (isWorkerLike && ROVER_WORKER_DIRECTIVES.includes(directive)) return true;

  const host = normalizeHost(blockedURI);
  if (host) {
    const extraHosts = Array.isArray(options.extraHosts) ? options.extraHosts : [];
    const roverHosts = [...ROVER_HOSTS, ...extraHosts]
      .map(item => String(item || '').trim().toLowerCase())
      .filter(Boolean);
    return roverHosts.some(rover => host === rover || host.endsWith(`.${rover}`));
  }
  // No real host → a keyword/blob/empty source. Only Rover's blob worker qualifies.
  return false;
}

// Bounded escalation ladder for a blocked tab: strip the CSP response header (DNR),
// then also attach chrome.debugger + Page.setBypassCSP (covers <meta> CSP), then give
// up. A <meta> CSP can't be header-stripped, so meta sites jump straight to DNR+CDP.
export const CSP_LEVEL = {
  NONE: 'none',
  DNR: 'dnr',
  DNR_CDP: 'dnr_cdp',
  FAILED: 'failed',
};

export function nextEscalationLevel(current, { hasMetaCsp = false } = {}) {
  const level = current || CSP_LEVEL.NONE;
  if (level === CSP_LEVEL.NONE) {
    return hasMetaCsp
      ? { level: CSP_LEVEL.DNR_CDP, enableDnr: true, attachCdp: true, failed: false }
      : { level: CSP_LEVEL.DNR, enableDnr: true, attachCdp: false, failed: false };
  }
  if (level === CSP_LEVEL.DNR) {
    return { level: CSP_LEVEL.DNR_CDP, enableDnr: false, attachCdp: true, failed: false };
  }
  // DNR_CDP (or already FAILED) → nothing stronger is available.
  return { level: CSP_LEVEL.FAILED, enableDnr: false, attachCdp: false, failed: true };
}

export function shouldDebounceInject(record, signature, nowMs, debounceMs = INJECT_DEBOUNCE_MS) {
  if (!record || record.signature !== signature) return false;
  return Number.isFinite(record.lastInjectAt) && nowMs - record.lastInjectAt < debounceMs;
}

export function recordInjectAttempt(prev, nowMs, windowMs = INJECT_STORM_WINDOW_MS) {
  if (!prev || !Number.isFinite(prev.windowStartMs) || nowMs - prev.windowStartMs >= windowMs) {
    return { windowStartMs: nowMs, count: 1 };
  }
  return { windowStartMs: prev.windowStartMs, count: (prev.count || 0) + 1 };
}

export function isInjectStorm(stats, threshold = INJECT_STORM_THRESHOLD) {
  return Boolean(stats && stats.count > threshold);
}

// Circuit breaker on top of the storm detector: once a tab trips the storm
// threshold, stop injecting entirely until the storm window expires. The
// window is anchored at windowStartMs, so the circuit closes on its own and
// the next inject starts a fresh window. An explicit popup inject clears the
// stats and bypasses this.
export function isInjectCircuitOpen(stats, nowMs, {
  threshold = INJECT_STORM_THRESHOLD,
  windowMs = INJECT_STORM_WINDOW_MS,
} = {}) {
  if (!isInjectStorm(stats, threshold)) return false;
  return Number.isFinite(stats.windowStartMs) && nowMs - stats.windowStartMs < windowMs;
}

// Budget on CSP-escalation reloads per tab. Each escalation rung reloads the
// tab; a workflow that hops hosts re-climbs the ladder per host, and with the
// MV3 service worker torn down between hops the in-memory guard is lost — so
// the budget persists in storage.session. Same fixed-window shape as
// recordInjectAttempt.
export const CSP_RELOAD_BUDGET_WINDOW_MS = 5 * 60_000;
export const CSP_RELOAD_BUDGET_MAX = 6;

export function recordCspReload(prev, nowMs, windowMs = CSP_RELOAD_BUDGET_WINDOW_MS) {
  if (!prev || !Number.isFinite(prev.windowStartMs) || nowMs - prev.windowStartMs >= windowMs) {
    return { windowStartMs: nowMs, count: 1 };
  }
  return { windowStartMs: prev.windowStartMs, count: (prev.count || 0) + 1 };
}

export function isCspReloadBudgetExceeded(stats, nowMs, {
  max = CSP_RELOAD_BUDGET_MAX,
  windowMs = CSP_RELOAD_BUDGET_WINDOW_MS,
} = {}) {
  if (!stats || !Number.isFinite(stats.windowStartMs)) return false;
  if (nowMs - stats.windowStartMs >= windowMs) return false;
  return (stats.count || 0) >= max;
}

export function isRecentSelfRewrite(entry, url, nowMs, windowMs = SELF_REWRITE_WINDOW_MS) {
  if (!entry || !entry.url || entry.url !== String(url || '')) return false;
  return Number.isFinite(entry.ts) && nowMs - entry.ts < windowMs;
}
