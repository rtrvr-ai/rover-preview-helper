import test from 'node:test';
import assert from 'node:assert/strict';

test('content-start setup is idempotent across manifest and dynamic injection', async () => {
  const previous = {
    chrome: globalThis.chrome,
    document: globalThis.document,
    location: globalThis.location,
    window: globalThis.window,
  };
  const documentListeners = [];
  const windowListeners = [];
  const sentMessages = [];

  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: 'test' }),
      sendMessage: message => { sentMessages.push(message); },
    },
  };
  globalThis.document = {
    addEventListener(type, listener) { documentListeners.push({ type, listener }); },
    querySelectorAll() { return []; },
  };
  globalThis.location = { href: 'https://example.com/', hostname: 'example.com' };
  globalThis.window = {
    addEventListener(type, listener) { windowListeners.push({ type, listener }); },
    postMessage() {},
  };

  try {
    await import(`./content-start.js?manifest=${Date.now()}`);
    await import(`./content-start.js?dynamic=${Date.now()}`);

    assert.deepEqual(documentListeners.map(item => item.type), ['securitypolicyviolation']);
    assert.deepEqual(windowListeners.map(item => item.type), ['message']);
    assert.equal(sentMessages.filter(message => message.type === 'ROVER_PREVIEW_HELPER_PAGE_READY').length, 1);
  } finally {
    delete globalThis.__ROVER_PREVIEW_HELPER_CONTENT_START_INSTALLED__;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
