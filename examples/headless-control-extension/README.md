# Headless Control Extension Example

This example shows the message-passing pattern for running Rover from an extension and storing the result. It is intentionally small and has no build step.

It targets the Rover SDK currently served from `https://rover.rtrvr.ai` (`embed-core` 3.x).

## Setup

1. Copy this folder into your own extension project.
2. Get a Rover config from [Rover Workspace](https://rtrvr.ai/rover/workspace) or [Live Test](https://www.rtrvr.ai/rover/instant-preview?flow=workspace_config).
3. Edit `background.js` and replace `ROVER_CONFIG` with your config.
4. Download the Rover runtime into `vendor/`:

```bash
mkdir -p vendor
curl -L https://rover.rtrvr.ai/embed-core.js -o vendor/rover-embed.js
curl -L https://rover.rtrvr.ai/worker/worker.js -o vendor/worker.js
```

5. Load this folder as an unpacked Chrome extension.
6. Open a page in your allowed domain and click the extension icon.

The extension injects Rover, sends a prompt without using the Rover widget UI, listens for Rover events, and stores the final result in `chrome.storage.local`.

## Files

- `manifest.json`: MV3 permissions and packaged runtime exposure.
- `background.js`: injects Rover once per document and starts the task.
- `content.js`: isolated-world relay.
- `page-bridge.js`: MAIN-world bridge that calls `window.rover.send(...)`.

## Result contract

`ROVER_HEADLESS_RESULT` reports one of these `status` values:

| `status` | Meaning |
|---|---|
| `completed` | Run finished with `outcome: "success"` |
| `failed` | Run finished with a failure outcome, or the prompt never dispatched |
| `needs_input` | Rover parked on a clarifying question; read `questions` and re-send a self-contained prompt |
| `auth_required` | The run is blocked until a human signs in |
| `timeout` | No terminal signal inside `timeoutMs` |
| `busy` | Another run is already active on this page |

`text` is the assistant's answer: the terminal `summary` when Rover produced one, otherwise the last `response_shown` text.

## Notes

- `rover.send(prompt)` starts a run; it does not return the result.
- `run_completed` fires for failures too — branch on `payload.outcome`, not on the event alone.
- A run that needs clarification never emits `run_completed`; it only emits `run_state_transition` with `needsUserInput: true`. The bridge handles this so the request cannot silently hang.
- `error` events carry a `scope`; background scopes like `roverbook_attach` and `run_cancel_repair` are not failures of your run, and the bridge ignores them. An unscoped error gets a grace window, because Rover can recover and still complete the run.
- Pass `startNewTask: true` for the second and later prompts on a page so Rover closes out the previous task first. That is a task boundary, not context isolation — Rover still applies a same-window follow-up heuristic, so a prompt that must stand alone should say so.
- For production, replace the hardcoded prompt with your popup, side panel, context menu, or background logic.
