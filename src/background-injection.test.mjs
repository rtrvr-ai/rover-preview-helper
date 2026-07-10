import test from 'node:test';
import assert from 'node:assert/strict';

function chromeEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) { listeners.push(listener); },
  };
}

const page = {};
const counters = {
  sensorEnsures: 0,
  coreEvaluations: 0,
  workers: 0,
  bridges: 0,
  listenerRegistries: 0,
  bootstrapEvaluations: 0,
};
let failNextCoreEvaluation = false;
const localStore = {};
const sessionStore = {};

function storageArea(store) {
  return {
    async get(key) {
      if (typeof key === 'string') return { [key]: store[key] };
      return { ...store };
    },
    async set(values) { Object.assign(store, values); },
    async remove(key) { delete store[key]; },
  };
}

globalThis.chrome = {
  action: {
    async setBadgeText() {},
    async setBadgeBackgroundColor() {},
  },
  runtime: {
    getURL: file => `chrome-extension://test/${file}`,
    lastError: null,
    onMessage: chromeEvent(),
  },
  storage: {
    local: storageArea(localStore),
    session: storageArea(sessionStore),
  },
  tabs: {
    async get(tabId) { return { id: tabId, url: 'https://example.com/' }; },
    async reload() {},
    onRemoved: chromeEvent(),
    onUpdated: chromeEvent(),
  },
  webNavigation: {
    onHistoryStateUpdated: chromeEvent(),
  },
  declarativeNetRequest: {
    async getSessionRules() { return []; },
    async updateSessionRules() {},
  },
  debugger: {
    async attach() {},
    async detach() {},
    async sendCommand() {},
    onDetach: chromeEvent(),
  },
  scripting: {
    async executeScript(details) {
      if (typeof details.func === 'function') {
        const previousWindow = globalThis.window;
        globalThis.window = page;
        try {
          return [{ result: details.func(...(details.args || [])) }];
        } finally {
          if (previousWindow === undefined) delete globalThis.window;
          else globalThis.window = previousWindow;
        }
      }
      const file = details.files?.[0];
      if (file === 'src/content-start.js') {
        counters.sensorEnsures += 1;
        return [];
      }
      if (file === 'src/main-world-bootstrap.js') {
        counters.bootstrapEvaluations += 1;
        page.__ROVER_PREVIEW_HELPER_BOOTSTRAP_ATTEMPTED__ = true;
        return [];
      }
      if (file === 'vendor/rover-embed.js') {
        if (failNextCoreEvaluation) {
          failNextCoreEvaluation = false;
          throw new Error('simulated partial evaluation failure');
        }
        counters.coreEvaluations += 1;
        counters.workers += 1;
        counters.bridges += 1;
        counters.listenerRegistries += 1;
        page.__ROVER_PREVIEW_HELPER_BOOTSTRAPPED__ = true;
        return [];
      }
      return [];
    },
  },
};

const {
  injectMainWorldState,
  probeAndClaimMainWorld,
} = await import(`./background.js?test=${Date.now()}`);

test('atomic MAIN-world claim admits exactly one concurrent trigger', async () => {
  delete page.__ROVER_PREVIEW_HELPER_BOOTSTRAPPED__;
  delete page.__ROVER_PREVIEW_HELPER_BOOTSTRAP_ATTEMPTED__;
  delete page.__ROVER_PREVIEW_HELPER_INJECTING__;
  delete page.__ROVER_PREVIEW_HELPER_SIGNATURE__;

  const results = await Promise.all([
    probeAndClaimMainWorld(41, 'same-document'),
    probeAndClaimMainWorld(41, 'same-document'),
    probeAndClaimMainWorld(41, 'same-document'),
    probeAndClaimMainWorld(41, 'same-document'),
  ]);
  assert.equal(results.filter(result => result?.claimed === true).length, 1);
});

test('PAGE_READY/update/history/explicit races evaluate one core and one runtime graph', async () => {
  delete page.__ROVER_PREVIEW_HELPER_BOOTSTRAPPED__;
  delete page.__ROVER_PREVIEW_HELPER_BOOTSTRAP_ATTEMPTED__;
  delete page.__ROVER_PREVIEW_HELPER_INJECTING__;
  delete page.__ROVER_PREVIEW_HELPER_SIGNATURE__;
  Object.keys(counters).forEach(key => { counters[key] = 0; });

  const state = { siteId: 'site-1', publicKey: 'pk', requestId: 'request-1' };
  const results = await Promise.all([
    injectMainWorldState(42, state, 'page_ready'),
    injectMainWorldState(42, state, 'tabs_updated_loading'),
    injectMainWorldState(42, state, 'history_state'),
    injectMainWorldState(42, state, 'popup_inject'),
  ]);

  assert.deepEqual(results, [true, true, true, true]);
  assert.deepEqual(counters, {
    sensorEnsures: 1,
    coreEvaluations: 1,
    workers: 1,
    bridges: 1,
    listenerRegistries: 1,
    bootstrapEvaluations: 1,
  });
});

test('an already-open tab gets the CSP sensor before Rover evaluates', async () => {
  delete page.__ROVER_PREVIEW_HELPER_BOOTSTRAPPED__;
  delete page.__ROVER_PREVIEW_HELPER_BOOTSTRAP_ATTEMPTED__;
  delete page.__ROVER_PREVIEW_HELPER_INJECTING__;
  delete page.__ROVER_PREVIEW_HELPER_SIGNATURE__;
  Object.keys(counters).forEach(key => { counters[key] = 0; });

  const state = { siteId: 'site-sensor', publicKey: 'pk', requestId: 'request-sensor' };
  assert.equal(await injectMainWorldState(44, state, 'popup_inject'), true);
  assert.equal(counters.sensorEnsures, 1);
  assert.equal(counters.coreEvaluations, 1);
});

test('partial injection failure releases claim and permits immediate retry', async () => {
  delete page.__ROVER_PREVIEW_HELPER_BOOTSTRAPPED__;
  delete page.__ROVER_PREVIEW_HELPER_BOOTSTRAP_ATTEMPTED__;
  delete page.__ROVER_PREVIEW_HELPER_INJECTING__;
  delete page.__ROVER_PREVIEW_HELPER_SIGNATURE__;
  failNextCoreEvaluation = true;

  const state = { siteId: 'site-2', publicKey: 'pk', requestId: 'request-2' };
  await assert.rejects(
    injectMainWorldState(43, state, 'page_ready'),
    /simulated partial evaluation failure/,
  );
  assert.equal(page.__ROVER_PREVIEW_HELPER_INJECTING__, undefined);
  assert.equal(page.__ROVER_PREVIEW_HELPER_BOOTSTRAP_ATTEMPTED__, undefined);
  assert.equal(await injectMainWorldState(43, state, 'tabs_updated_loading'), true);
  assert.equal(page.__ROVER_PREVIEW_HELPER_BOOTSTRAPPED__, true);
});
