const ROVER_CONFIG = {
  siteId: "your_site_id",
  publicKey: "pk_site_...",
  siteKeyId: "key_...",
  apiBase: "https://agent.rtrvr.ai",
  allowedDomains: ["linkedin.com"],
  domainScopeMode: "registrable_domain",
  openOnInit: false,
  allowActions: true
};

const DEFAULT_PROMPT = [
  "Extract the visible name, headline, company, and location from this page.",
  "Return compact JSON only with keys: name, headline, company, location, confidence."
].join(" ");

// Tabs this service worker has already booted Rover into. The runtime bundle is
// ~1.5 MB; re-evaluating it on every click makes Rover hand the page over to a
// fresh instance and wastes main-thread time, so inject once per document.
const bootedTabs = new Map();

async function isRoverBooted(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: "MAIN",
      injectImmediately: true,
      func: () => ({
        // The pre-boot queue shim is a bare function with `.q`; the booted
        // runtime replaces it with the real API object.
        booted: typeof window.rover?.send === "function" && !Array.isArray(window.rover?.q),
        bridged: window.__MY_ROVER_HEADLESS_BRIDGE__ === true,
        version: String(window.__ROVER_EMBED_VERSION__ || "")
      })
    });
    return result?.result || null;
  } catch {
    return null;
  }
}

async function injectRover(tabId) {
  const state = await isRoverBooted(tabId);
  if (state?.booted && state?.bridged) return;

  if (!state?.booted) {
    const config = {
      ...ROVER_CONFIG,
      workerUrl: chrome.runtime.getURL("vendor/worker.js")
    };

    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: "MAIN",
      injectImmediately: true,
      func: cfg => {
        const rover = window.rover = window.rover || function () {
          (rover.q = rover.q || []).push(arguments);
        };
        rover("boot", cfg);
      },
      args: [config]
    });

    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: "MAIN",
      injectImmediately: true,
      files: ["vendor/rover-embed.js"]
    });
  }

  if (!state?.bridged) {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: "MAIN",
      injectImmediately: true,
      files: ["page-bridge.js"]
    });
  }
}

chrome.action.onClicked.addListener(async tab => {
  if (!tab.id || !tab.url) return;

  const url = new URL(tab.url);
  if (!url.hostname.endsWith("linkedin.com")) {
    console.warn("Open an allowed LinkedIn page first.");
    return;
  }

  await injectRover(tab.id);

  // The first prompt on a page starts its own task; later prompts close out the
  // previous task first so they do not land on a task that is still open.
  const startNewTask = bootedTabs.get(tab.id) === true;
  bootedTabs.set(tab.id, true);

  const requestId = crypto.randomUUID();
  await chrome.tabs.sendMessage(tab.id, {
    type: "RUN_ROVER_TASK",
    requestId,
    prompt: DEFAULT_PROMPT,
    timeoutMs: 180000,
    startNewTask
  });
});

chrome.tabs.onRemoved.addListener(tabId => {
  bootedTabs.delete(tabId);
});

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === "ROVER_HEADLESS_EVENT") {
    console.debug("[Rover event]", message.requestId, message.payload?.event, message.payload?.payload);
    return;
  }

  if (message?.type !== "ROVER_HEADLESS_RESULT") return;

  const payload = message.payload || {};
  // status: completed | failed | needs_input | auth_required | timeout | busy
  if (payload.status === "needs_input") {
    console.warn(
      "[Rover] run parked on a clarifying question. Re-send a self-contained prompt that answers:",
      payload.questions
    );
  }

  const key = `rover-result:${message.requestId}`;
  chrome.storage.local.set({
    [key]: {
      savedAt: new Date().toISOString(),
      status: payload.status || "unknown",
      outcome: payload.outcome || null,
      // `text` is the assistant's answer: the terminal summary when Rover sends
      // one, otherwise the last response_shown text.
      text: payload.text || "",
      questions: payload.questions || null,
      error: payload.error || null,
      runId: payload.runId || null
    }
  });
});
