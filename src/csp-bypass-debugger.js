// Some sites (e.g. app.merge.dev) ship their Content-Security-Policy in an HTML
// `<meta http-equiv="Content-Security-Policy">` tag instead of a response header.
// The declarativeNetRequest strip (src/csp-bypass.js) can only remove *response
// headers*, so it can't touch a meta-delivered policy — and Chromium applies a
// meta CSP the instant the parser inserts it and never revokes it, so a content
// script can't remove it after the fact either.
//
// For those sites we fall back to the DevTools protocol: attaching chrome.debugger
// to the tab and calling Page.setBypassCSP(true) disables ALL of the page's CSP —
// header AND meta — for that tab. That covers Rover's fetch/WebSocket/EventSource
// egress (connect-src), its blob module worker (worker-src/default-src), fonts,
// styles, and media in one shot. It is only attached reactively, when a real CSP
// violation shows Rover is blocked — never speculatively.
//
// Cost: Chrome shows a "Rover Preview Helper started debugging this browser" banner
// while attached (suppressible by launching Chrome with
// --silent-debugger-extension-api). The bypass is scoped to the one attached tab.
//
// Resilience: the attached tab/host map is mirrored to chrome.storage.session so it
// survives service-worker restarts (some Chrome builds tear the debugger session
// down with the worker, some don't — we tolerate both). On worker (re)start we
// reconcile by re-attaching only when the tab is still on the host that needed it.

const DEBUGGER_PROTOCOL_VERSION = '1.3';
const STORAGE_KEY = 'rover-preview-helper:debugger-attached';
const ALREADY_ATTACHED = /already attached/i;

// Fast in-memory cache; chrome.storage.session is the source of truth across restarts.
// tabId -> host for the document that proved it needed Page.setBypassCSP.
const attachedTabs = new Map();

function normalizeHost(value) {
  try {
    return new URL(String(value || '')).hostname.toLowerCase();
  } catch {
    return String(value || '').trim().toLowerCase();
  }
}

function normalizePersistedEntries(value) {
  const entries = new Map();
  const list = Array.isArray(value) ? value : [];
  for (const item of list) {
    if (typeof item === 'number' || typeof item === 'string') {
      const tabId = Number(item);
      if (Number.isFinite(tabId)) entries.set(tabId, '');
      continue;
    }
    const tabId = Number(item?.tabId);
    if (Number.isFinite(tabId)) {
      entries.set(tabId, normalizeHost(item.host || ''));
    }
  }
  return entries;
}

async function readPersisted() {
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEY);
    return normalizePersistedEntries(stored[STORAGE_KEY]);
  } catch {
    return new Map(attachedTabs);
  }
}

async function writePersisted(map) {
  try {
    await chrome.storage.session.set({
      [STORAGE_KEY]: [...map.entries()].map(([tabId, host]) => ({ tabId, host })),
    });
  } catch {
    // Best effort; the in-memory cache still guards this session.
  }
}

async function markAttached(id, host) {
  const normalizedHost = normalizeHost(host || '');
  attachedTabs.set(id, normalizedHost);
  const map = await readPersisted();
  map.set(id, normalizedHost);
  await writePersisted(map);
}

async function markDetached(id) {
  attachedTabs.delete(id);
  const map = await readPersisted();
  if (map.delete(id)) await writePersisted(map);
}

function cachedHostMatches(cachedHost, host) {
  const expected = normalizeHost(host || '');
  if (!cachedHost || !expected) return true;
  return cachedHost === expected;
}

// Resolves on a fresh attach OR when we're already attached to this target (which we
// treat as success — the bypass is or will be re-asserted by the caller).
function attachDebugger(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION, () => {
      const error = chrome.runtime.lastError;
      if (error && !ALREADY_ATTACHED.test(error.message || '')) {
        reject(new Error(error.message));
      } else {
        resolve();
      }
    });
  });
}

function sendDebuggerCommand(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, result => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

function detachDebugger(target) {
  return new Promise(resolve => {
    chrome.debugger.detach(target, () => {
      // Swallow "not attached" races; this is best-effort cleanup.
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

export async function hasDebuggerCspBypass(tabId, host = '') {
  const id = Number(tabId);
  if (attachedTabs.has(id)) {
    return cachedHostMatches(attachedTabs.get(id), host);
  }
  const map = await readPersisted();
  if (map.has(id) && cachedHostMatches(map.get(id), host)) {
    attachedTabs.set(id, map.get(id) || '');
    return true;
  }
  return false;
}

/**
 * Attach chrome.debugger and disable the page CSP for this tab. Idempotent and
 * restart-safe. Returns true only when the bypass was newly attached (the caller
 * reloads once so it applies to a clean load); false when it was already ours.
 */
export async function enableDebuggerCspBypass(tabId, host = '') {
  const id = Number(tabId);
  if (!Number.isFinite(id)) return false;

  const alreadyOurs = await hasDebuggerCspBypass(id, host);
  const target = { tabId: id };

  await attachDebugger(target); // tolerates "already attached"
  try {
    // Page.enable first so the Page domain is active before setBypassCSP across all
    // Chrome versions; we don't consume its events. Re-asserting is harmless if the
    // session survived a worker restart, and required if it didn't.
    await sendDebuggerCommand(target, 'Page.enable');
    await sendDebuggerCommand(target, 'Page.setBypassCSP', { enabled: true });
  } catch (error) {
    if (!alreadyOurs) {
      await markDetached(id);
      await detachDebugger(target);
    }
    throw error;
  }
  await markAttached(id, host);
  return !alreadyOurs;
}

export async function disableDebuggerCspBypass(tabId) {
  const id = Number(tabId);
  const wasAttached = await hasDebuggerCspBypass(id);
  await markDetached(id);
  if (wasAttached) await detachDebugger({ tabId: id });
}

// If the user cancels the debug banner, or DevTools attaches to the tab, Chrome
// detaches us — drop the tab so we don't believe the bypass is still active. (This
// may not fire when the detach is caused by the worker being torn down; the reactive
// escalation and the startup reconcile below cover that case.)
if (chrome.debugger?.onDetach) {
  chrome.debugger.onDetach.addListener(source => {
    if (Number.isFinite(source?.tabId)) void markDetached(source.tabId);
  });
}

// On service-worker (re)start, re-assert the CSP bypass for any same-host tab we had
// attached before, since some Chrome builds tear the debugger session down with the
// worker. Stale entries (tab since closed or navigated elsewhere) are pruned.
async function reconcileAttachedTabs() {
  const map = await readPersisted();
  for (const [id, host] of map.entries()) {
    const target = { tabId: id };
    try {
      if (!host) {
        await markDetached(id);
        continue;
      }
      const tab = await chrome.tabs.get(id);
      if (normalizeHost(tab?.url || '') !== host) {
        await markDetached(id);
        await detachDebugger(target);
        continue;
      }
      await attachDebugger(target);
      await sendDebuggerCommand(target, 'Page.enable');
      await sendDebuggerCommand(target, 'Page.setBypassCSP', { enabled: true });
      attachedTabs.set(id, host || '');
    } catch {
      await markDetached(id);
    }
  }
}

void reconcileAttachedTabs();
