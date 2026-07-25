// MAIN-world bridge for driving Rover headlessly.
//
// Targets the current Rover SDK (embed-core 3.x). The public surface it relies on:
//   rover.send(prompt, options?)  starts a run; returns nothing.
//   rover.on(event, handler)      returns an unsubscribe function.
//   rover.newTask(options?)       starts a fresh task boundary.
//
// Terminal signals a headless caller must handle:
//   run_completed          -> payload.outcome tells you success vs failure.
//   run_state_transition   -> payload.needsUserInput means the run parked on a
//                             clarifying question and run_completed will NOT fire.
//   auth_required          -> the run is parked until a human signs in.
//   error                  -> only some scopes are fatal; see isFatalError below.
(() => {
  if (window.__MY_ROVER_HEADLESS_BRIDGE__) return;
  window.__MY_ROVER_HEADLESS_BRIDGE__ = true;

  const REQUEST_SOURCE = "my-rover-extension";
  const RESPONSE_SOURCE = "my-rover-extension-rover-bridge";

  const DEFAULT_RUN_TIMEOUT_MS = 180000;
  const DEFAULT_READY_TIMEOUT_MS = 20000;
  // An execution error does not always end the run: Rover may recover and still
  // report a terminal state. Wait this long for that terminal signal before
  // reporting the error as the outcome.
  const ERROR_GRACE_MS = 15000;

  // Rover emits `error` for background subsystems too (analytics attach, stale-run
  // cleanup, session rebinding). Failing the run on those aborts healthy runs, so
  // only a failed prompt dispatch and unscoped execution errors count.
  const FATAL_ERROR_SCOPES = new Set(["run_input"]);
  const IGNORED_ERROR_SCOPES = new Set([
    "roverbook_attach",
    "run_cancel_repair",
    "session_binding",
    "attachment_upload",
    "resume"
  ]);

  // One run at a time per document: the runtime silently suppresses a second
  // prompt dispatch while one is in flight, which would otherwise look like a
  // request that hangs until its timeout.
  let activeRequestId = "";

  function post(type, requestId, payload = {}) {
    window.postMessage({ source: RESPONSE_SOURCE, type, requestId, payload }, "*");
  }

  function waitForRover(timeoutMs) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const tick = () => {
        // Before the runtime evaluates, window.rover is the queue shim: a bare
        // function with `.q` and no methods. Waiting for send+on waits for boot.
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

  function isFatalError(payload) {
    const scope = String(payload?.scope || "").trim();
    if (!scope) return true; // unscoped == worker execution error for this run
    if (IGNORED_ERROR_SCOPES.has(scope)) return false;
    return FATAL_ERROR_SCOPES.has(scope);
  }

  function errorText(payload) {
    if (!payload) return "Rover reported an error.";
    if (typeof payload === "string") return payload;
    return String(payload.message || payload.error || "Rover reported an error.");
  }

  window.addEventListener("message", async event => {
    if (event.source !== window) return;
    const message = event.data || {};
    if (message.source !== REQUEST_SOURCE || message.type !== "ROVER_HEADLESS_RUN") return;

    const requestId = String(message.requestId || crypto.randomUUID());
    const prompt = String(message.prompt || "").trim();
    const timeoutMs = Number(message.timeoutMs) || DEFAULT_RUN_TIMEOUT_MS;
    const readyTimeoutMs = Number(message.readyTimeoutMs) || DEFAULT_READY_TIMEOUT_MS;
    const sendOptions = message.sendOptions && typeof message.sendOptions === "object"
      ? message.sendOptions
      : undefined;

    if (!prompt) {
      post("ROVER_HEADLESS_RESULT", requestId, { status: "failed", error: "Missing prompt." });
      return;
    }
    if (activeRequestId) {
      post("ROVER_HEADLESS_RESULT", requestId, {
        status: "busy",
        error: `Rover is already running request ${activeRequestId} on this page.`
      });
      return;
    }
    activeRequestId = requestId;

    const unsubscribers = [];
    let finished = false;
    let timeoutId = 0;
    let errorGraceId = 0;
    // Best assistant text seen so far, used when the terminal payload has no summary.
    let latestText = "";
    let finalText = "";

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
      if (errorGraceId) clearTimeout(errorGraceId);
      cleanup();
      activeRequestId = "";
      post("ROVER_HEADLESS_RESULT", requestId, {
        status,
        text: finalText || latestText || "",
        ...payload
      });
    };

    const relay = (name, payload) => {
      post("ROVER_HEADLESS_EVENT", requestId, { event: name, payload });
    };

    // run_completed and run_state_transition carry the same payload shape, and a
    // parked run only ever reports through the latter.
    const handleRunState = (payload, viaCompleted) => {
      if (payload?.needsUserInput === true || payload?.terminalState === "waiting_input") {
        finish("needs_input", {
          runId: payload?.runId,
          terminalState: payload?.terminalState,
          questions: payload?.questions || [],
          summary: payload?.summary || "",
          pageUrl: payload?.pageUrl,
          raw: payload
        });
        return;
      }
      if (!viaCompleted) return;

      const outcome = String(payload?.outcome || "");
      const status = outcome === "success" ? "completed" : "failed";
      finish(status, {
        runId: payload?.runId,
        outcome,
        terminalState: payload?.terminalState,
        summary: payload?.summary || "",
        error: payload?.error || null,
        endedAt: payload?.endedAt,
        pageUrl: payload?.pageUrl,
        raw: payload
      });
    };

    try {
      const rover = await waitForRover(readyTimeoutMs);

      unsubscribers.push(rover.on("run_started", payload => relay("run_started", payload)));

      unsubscribers.push(rover.on("response_shown", payload => {
        relay("response_shown", payload);
        const text = String(payload?.text || "").trim();
        if (!text) return;
        latestText = text;
        if (payload?.responseKind === "final") finalText = text;
      }));

      unsubscribers.push(rover.on("run_state_transition", payload => {
        relay("run_state_transition", payload);
        handleRunState(payload, false);
      }));

      unsubscribers.push(rover.on("run_completed", payload => {
        relay("run_completed", payload);
        handleRunState(payload, true);
      }));

      unsubscribers.push(rover.on("auth_required", payload => {
        relay("auth_required", payload);
        finish("auth_required", { error: errorText(payload), raw: payload });
      }));

      unsubscribers.push(rover.on("error", payload => {
        relay("error", payload);
        if (!isFatalError(payload)) return;
        if (String(payload?.scope || "") === "run_input") {
          finish("failed", { error: errorText(payload), raw: payload });
          return;
        }
        // Execution error: give the run a bounded chance to report a terminal
        // state of its own before calling it failed.
        if (errorGraceId) return;
        errorGraceId = setTimeout(() => {
          finish("failed", { error: errorText(payload), raw: payload });
        }, ERROR_GRACE_MS);
      }));

      timeoutId = setTimeout(() => {
        finish("timeout", { error: "Timed out waiting for Rover to complete." });
      }, timeoutMs);

      // Close out the previous task when this page has already run one, so the
      // prompt starts from a clean task instead of landing on the current one.
      // Rover still applies its same-window follow-up heuristic, so this is a
      // boundary, not an isolation guarantee.
      if (message.startNewTask === true && typeof rover.newTask === "function") {
        try {
          rover.newTask({ reason: "headless_run", source: "public_sdk" });
        } catch {
          // A missing runtime here is not fatal; send() below still starts a run.
        }
      }

      rover.send(prompt, sendOptions);
    } catch (error) {
      finish("failed", { error: String(error?.message || error) });
    }
  });
})();
