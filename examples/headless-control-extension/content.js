const REQUEST_SOURCE = "my-rover-extension";
const RESPONSE_SOURCE = "my-rover-extension-rover-bridge";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "RUN_ROVER_TASK") return false;

  const requestId = String(message.requestId || crypto.randomUUID());

  const onPageMessage = event => {
    if (event.source !== window) return;
    const data = event.data || {};
    if (data.source !== RESPONSE_SOURCE || data.requestId !== requestId) return;

    chrome.runtime.sendMessage({
      type: data.type,
      requestId,
      payload: data.payload
    });

    if (data.type === "ROVER_HEADLESS_RESULT") {
      window.removeEventListener("message", onPageMessage);
    }
  };

  window.addEventListener("message", onPageMessage);
  window.postMessage({
    source: REQUEST_SOURCE,
    type: "ROVER_HEADLESS_RUN",
    requestId,
    prompt: String(message.prompt || ""),
    timeoutMs: Number(message.timeoutMs || 180000),
    readyTimeoutMs: Number(message.readyTimeoutMs || 20000),
    // Set for the second and later prompts on a page so Rover closes out the
    // previous task before this one starts.
    startNewTask: message.startNewTask === true,
    // Optional passthrough to rover.send(prompt, options): { playbookId, engagementKind }.
    sendOptions: message.sendOptions && typeof message.sendOptions === "object"
      ? message.sendOptions
      : undefined
  }, "*");

  sendResponse({ ok: true, requestId });
  return true;
});
