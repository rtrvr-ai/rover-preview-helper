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

async function injectRover(tabId) {
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

  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    world: "MAIN",
    injectImmediately: true,
    files: ["page-bridge.js"]
  });
}

chrome.action.onClicked.addListener(async tab => {
  if (!tab.id || !tab.url) return;

  const url = new URL(tab.url);
  if (!url.hostname.endsWith("linkedin.com")) {
    console.warn("Open an allowed LinkedIn page first.");
    return;
  }

  await injectRover(tab.id);

  const requestId = crypto.randomUUID();
  await chrome.tabs.sendMessage(tab.id, {
    type: "RUN_ROVER_TASK",
    requestId,
    prompt: DEFAULT_PROMPT,
    timeoutMs: 120000
  });
});

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === "ROVER_HEADLESS_EVENT") {
    console.debug("[Rover event]", message.requestId, message.payload);
    return;
  }

  if (message?.type !== "ROVER_HEADLESS_RESULT") return;

  const key = `rover-result:${message.requestId}`;
  chrome.storage.local.set({
    [key]: {
      savedAt: new Date().toISOString(),
      status: message.payload?.status || "unknown",
      result: message.payload?.result || null,
      error: message.payload?.error || null
    }
  });
});

