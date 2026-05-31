(() => {
  if (window.__MY_ROVER_HEADLESS_BRIDGE__) return;
  window.__MY_ROVER_HEADLESS_BRIDGE__ = true;

  const REQUEST_SOURCE = "my-rover-extension";
  const RESPONSE_SOURCE = "my-rover-extension-rover-bridge";

  function post(type, requestId, payload = {}) {
    window.postMessage({ source: RESPONSE_SOURCE, type, requestId, payload }, "*");
  }

  function waitForRover(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const tick = () => {
        const rover = window.rover;
        if (rover && typeof rover.send === "function" && typeof rover.on === "function") {
          resolve(rover);
          return;
        }
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error("Rover did not become ready."));
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  window.addEventListener("message", async event => {
    if (event.source !== window) return;
    const message = event.data || {};
    if (message.source !== REQUEST_SOURCE || message.type !== "ROVER_HEADLESS_RUN") return;

    const requestId = String(message.requestId || crypto.randomUUID());
    const prompt = String(message.prompt || "").trim();
    const timeoutMs = Number(message.timeoutMs || 120000);
    if (!prompt) {
      post("ROVER_HEADLESS_RESULT", requestId, { status: "failed", error: "Missing prompt." });
      return;
    }

    const unsubscribers = [];
    let finished = false;
    let timeoutId = 0;

    const cleanup = () => {
      while (unsubscribers.length) {
        try {
          unsubscribers.pop()();
        } catch {
          // Ignore event cleanup failures.
        }
      }
    };

    const finish = (status, payload = {}) => {
      if (finished) return;
      finished = true;
      if (timeoutId) clearTimeout(timeoutId);
      cleanup();
      post("ROVER_HEADLESS_RESULT", requestId, { status, ...payload });
    };

    try {
      const rover = await waitForRover();

      unsubscribers.push(rover.on("run_started", payload => {
        post("ROVER_HEADLESS_EVENT", requestId, { event: "run_started", payload });
      }));

      unsubscribers.push(rover.on("response_shown", payload => {
        post("ROVER_HEADLESS_EVENT", requestId, { event: "response_shown", payload });
      }));

      unsubscribers.push(rover.on("run_completed", payload => {
        finish("completed", { result: payload });
      }));

      unsubscribers.push(rover.on("error", payload => {
        finish("failed", { error: payload });
      }));

      timeoutId = setTimeout(() => {
        finish("timeout", { error: "Timed out waiting for Rover to complete." });
      }, timeoutMs);

      rover.send(prompt);
    } catch (error) {
      finish("failed", { error: String(error?.message || error) });
    }
  });
})();
