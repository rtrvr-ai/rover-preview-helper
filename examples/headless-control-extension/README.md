# Headless Control Extension Example

This example shows the message-passing pattern for running Rover from an extension and storing the result. It is intentionally small and has no build step.

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
- `background.js`: injects Rover and starts the task.
- `content.js`: isolated-world relay.
- `page-bridge.js`: MAIN-world bridge that calls `window.rover.send(...)`.

## Notes

- `rover.send(prompt)` starts a run; it does not synchronously return the result.
- `run_completed` is the terminal event to store.
- `response_shown` is useful for capturing assistant text while the run is still active.
- For production, replace the hardcoded prompt with your popup, side panel, context menu, or background logic.
