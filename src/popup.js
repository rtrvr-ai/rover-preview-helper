import { normalizeConfig } from './shared.js';

const configEl = document.getElementById('config');
const statusEl = document.getElementById('status');
const injectBtn = document.getElementById('inject');
const reconnectBtn = document.getElementById('reconnect');
const helpEl = document.getElementById('config-help');
const tabBadgeEl = document.getElementById('tab-badge');
const tabCardEl = document.getElementById('tab-card');
const tabSummaryEl = document.getElementById('tab-summary');

function buildStorageKey(prefix, tabId) {
  return `${prefix}${tabId}`;
}

function cleanEditorConfig(value) {
  if (!value || typeof value !== 'object') return null;
  const next = { ...value };
  delete next.bootstrapId;
  delete next.targetHost;
  delete next.configRefreshedAt;
  return normalizeConfig(next);
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? '#ff9a76' : '';
}

function setEditorConfig(config) {
  configEl.value = config ? JSON.stringify(config, null, 2) : '';
  if (helpEl) helpEl.style.display = config ? 'none' : 'block';
}

function renderTabState(tab, state) {
  if (!tabBadgeEl || !tabCardEl || !tabSummaryEl) return;
  if (!tab?.id || !state) {
    tabBadgeEl.style.display = 'none';
    tabCardEl.style.display = 'none';
    tabSummaryEl.textContent = '';
    return;
  }

  let host = String(state.targetHost || '').trim();
  if (!host) {
    try {
      host = tab.url ? new URL(tab.url).host : '';
    } catch {
      host = '';
    }
  }
  const mode = String(state.mode || 'full').trim() || 'full';
  const siteId = String(state.siteId || '').trim();
  const source = state.previewId && state.previewToken ? 'Hosted preview session' : 'Saved reusable config';

  tabBadgeEl.style.display = 'inline-flex';
  tabCardEl.style.display = 'block';
  tabSummaryEl.textContent = [
    host ? `Host: ${host}` : '', siteId ? `Site: ${siteId}` : '',
    `Mode: ${mode}`, `Source: ${source}`,
  ].filter(Boolean).join('\n');
}

async function loadTabState(tabId) {
  const key = buildStorageKey('rover-preview-helper:tab:', tabId);
  const stored = await chrome.storage.session.get(key);
  return stored[key] || null;
}

async function loadSavedStatus(tabId) {
  const key = buildStorageKey('rover-preview-helper:status:', tabId);
  const stored = await chrome.storage.session.get(key);
  const value = String(stored[key] || '').trim();
  if (value) {
    setStatus(value, value.toLowerCase().includes('invalid') || value.toLowerCase().includes('failed'));
  } else {
    setStatus('Ready. Use Workspace -> Live Test -> Use Workspace config -> Open target with helper, or paste config JSON below.');
  }
}

async function loadPersistedConfig() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'ROVER_PREVIEW_HELPER_GET_PERSISTED_CONFIG',
    });
    if (response?.ok && response.config) {
      setEditorConfig(cleanEditorConfig(response.config));
      setStatus('Loaded your last-used config. Click "Inject Rover into this tab" to use it here.');
      return true;
    }
  } catch {
    // Ignore extension messaging failures during initial paint.
  }
  return false;
}

injectBtn.addEventListener('click', async () => {
  try {
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error('No active tab found.');
    const raw = JSON.parse(String(configEl.value || '{}'));
    const config = normalizeConfig(raw);
    const response = await chrome.runtime.sendMessage({
      type: 'ROVER_PREVIEW_HELPER_INJECT',
      tabId: tab.id,
      config,
    });
    if (!response?.ok) throw new Error(response?.error || 'Injection failed.');
    setEditorConfig(cleanEditorConfig(response.state) || config);
    renderTabState(tab, response.state || null);
    setStatus('Rover injected into this tab and your config was saved.');
  } catch (error) {
    setStatus(String(error?.message || error), true);
  }
});

reconnectBtn.addEventListener('click', async () => {
  try {
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error('No active tab found.');
    const response = await chrome.runtime.sendMessage({
      type: 'ROVER_PREVIEW_HELPER_RECONNECT',
      tabId: tab.id,
    });
    if (!response?.ok) throw new Error(response?.error || 'Reconnect failed.');
    const tabState = await loadTabState(tab.id);
    renderTabState(tab, tabState);
    setStatus('Rover reconnect requested for this tab.');
  } catch (error) {
    setStatus(String(error?.message || error), true);
  }
});

configEl.addEventListener('input', () => {
  if (helpEl && configEl.value.trim()) helpEl.style.display = 'none';
});

(async () => {
  try {
    const tab = await getActiveTab();
    let tabState = null;
    if (tab?.id) {
      tabState = await loadTabState(tab.id);
      await loadSavedStatus(tab.id);
      renderTabState(tab, tabState);
    }

    const loadedPersisted = await loadPersistedConfig();
    if (!loadedPersisted && tabState) {
      setEditorConfig(cleanEditorConfig(tabState));
      setStatus('Loaded this tab\'s Rover config. Click "Inject Rover into this tab" to refresh it here.');
    } else if (!loadedPersisted && helpEl) {
      helpEl.style.display = 'block';
    }
  } catch {
    // Ignore initial load failures.
  }
})();


document.getElementById('check-tools')?.addEventListener('click', async () => {
  const output = document.getElementById('tool-status');
  if (!output) return;
  output.textContent = 'Checking configured actions…';
  try {
    const tab = await getActiveTab();
    const response = await chrome.runtime.sendMessage({ type: 'ROVER_PREVIEW_HELPER_TOOL_STATUS', tabId: tab?.id });
    if (!response?.ok) throw new Error(response?.error || 'Could not read actions.');
    const status = response.status;
    output.textContent = !status ? 'This runtime cannot report action readiness. Rebuild and reload Preview Helper, then reconnect.'
      : !status.actions?.length ? 'No browser actions were returned for this site. Use the same site config where you saved the action. Temporary previews have a separate site.'
      : status.actions.slice(0, 20).map(action => `${String(action.name).slice(0, 64)}: ${action.status === 'ready' ? 'ready' : action.status === 'loading' ? 'loading' : 'unavailable; reconnect and check the site security policy'}`).join(' · ');
  } catch (error) { output.textContent = String(error?.message || 'Could not read actions.'); }
});
