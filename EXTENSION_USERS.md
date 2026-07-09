# Build a Chrome Extension with Rover

Use this when you want to test Rover from your own Chrome extension on live sites such as LinkedIn, without installing the Rover npm package.

## Pick a Rover Config First

Start in Rover, then paste the generated values into your extension.

1. Open [https://rtrvr.ai/rover/workspace](https://rtrvr.ai/rover/workspace).
2. Create or select a Rover site.
3. Add the target domain in the site policy, for example `linkedin.com`.
4. Copy the extension/test config JSON from Workspace or Live Test.

For quick demos on arbitrary sites, use the reusable test config from:

- [https://www.rtrvr.ai/rover/instant-preview?flow=workspace_config](https://www.rtrvr.ai/rover/instant-preview?flow=workspace_config)

The config should contain values like:

```json
{
  "siteId": "your_site_id",
  "publicKey": "pk_site_...",
  "siteKeyId": "key_...",
  "apiBase": "https://agent.rtrvr.ai",
  "allowedDomains": ["linkedin.com"],
  "domainScopeMode": "registrable_domain",
  "openOnInit": true,
  "allowActions": true
}
```

Use `publicKey`, not private secrets. Do not put admin tokens, API secrets, or service credentials in an extension.

## Why the Normal Script Tag Fails on Some Sites

Some sites block remote scripts with Content Security Policy. If your extension injects:

```html
<script src="https://rover.rtrvr.ai/embed.js"></script>
```

the page can reject it before Rover boots. Chrome Manifest V3 also expects extension-executed JavaScript to be packaged with the extension, not fetched as remote executable code.

The reliable extension pattern is:

- download Rover runtime files at build time;
- package them inside your extension;
- inject packaged files with `chrome.scripting.executeScript`;
- use Rover config from `rtrvr.ai/rover`.

## Minimal File Layout

```text
my-rover-extension/
  manifest.json
  background.js
  vendor/
    rover-embed.js
    worker.js
```

Download the runtime files once while building your extension:

```bash
mkdir -p vendor
curl -L https://rover.rtrvr.ai/embed-core.js -o vendor/rover-embed.js
curl -L https://rover.rtrvr.ai/worker/worker.js -o vendor/worker.js
```

Keep those files checked into your local hackathon extension or copied into your build output.

For a normal website install, keep using the public `embed.js` snippet. For a
Chrome extension that injects Rover with `chrome.scripting.executeScript`, use
`embed-core.js` as shown here so the full SDK executes without relying on a
page `<script src>` element.

## Manifest Example

This example is scoped to LinkedIn. Change `host_permissions` and `matches` for your target site.

```json
{
  "manifest_version": 3,
  "name": "Rover Hackathon Extension",
  "version": "0.1.0",
  "description": "Run Rover from a packaged Chrome extension.",
  "permissions": ["activeTab", "scripting", "storage", "tabs"],
  "host_permissions": ["https://www.linkedin.com/*"],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "action": {
    "default_title": "Open Rover"
  },
  "web_accessible_resources": [
    {
      "resources": ["vendor/worker.js"],
      "matches": ["https://www.linkedin.com/*"]
    }
  ]
}
```

## Background Script Example

Click the extension icon to inject Rover into the active tab.

```js
const roverConfig = {
  siteId: "your_site_id",
  publicKey: "pk_site_...",
  siteKeyId: "key_...",
  apiBase: "https://agent.rtrvr.ai",
  allowedDomains: ["linkedin.com"],
  domainScopeMode: "registrable_domain",
  openOnInit: true,
  allowActions: true
};

chrome.action.onClicked.addListener(async tab => {
  if (!tab.id || !tab.url) return;

  const url = new URL(tab.url);
  if (!url.hostname.endsWith("linkedin.com")) {
    console.warn("Open a LinkedIn tab first.");
    return;
  }

  const config = {
    ...roverConfig,
    workerUrl: chrome.runtime.getURL("vendor/worker.js")
  };

  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: false },
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
    target: { tabId: tab.id, allFrames: false },
    world: "MAIN",
    injectImmediately: true,
    files: ["vendor/rover-embed.js"]
  });
});
```

## Use Isolated Content Scripts for Your Own UI

If you are adding your own extension UI or custom automation logic, keep most of it in an isolated content script. Use `world: "MAIN"` only for the small Rover boot bridge above.

Good split:

- `background.js`: extension button, permissions, network calls, storage.
- `content.js`: your overlay UI, DOM reads, click/type helpers.
- `vendor/rover-embed.js`: packaged Rover SDK core.
- `vendor/worker.js`: packaged Rover worker.

This avoids page CSP problems and reduces conflicts with the website's JavaScript.

## Trigger Rover Headlessly And Store Results

If your extension needs to pass user input or a generated prompt into Rover without opening the Rover widget input, use a MAIN-world message bridge and Rover events.

The core shape is:

```js
// MAIN-world bridge, after Rover has booted.
window.rover.send("Extract the visible profile name and headline. Return JSON only.");
window.rover.on("run_completed", result => {
  window.postMessage({
    source: "my-extension-rover-bridge",
    type: "ROVER_HEADLESS_RESULT",
    result
  }, "*");
});
```

Do not expect `rover.send(...)` to return the output directly. It starts an async Rover run. Your extension should listen for `run_completed`, `response_shown`, and `error`, then store the terminal result from the background service worker.

See [HEADLESS_CONTROL.md](./HEADLESS_CONTROL.md) for the full bridge and [examples/headless-control-extension](./examples/headless-control-extension) for a copyable extension skeleton.

## Common Fixes

- **CSP blocks `https://rover.rtrvr.ai/embed.js`**  
  Package `embed-core.js` as `vendor/rover-embed.js` and inject the packaged file.

- **A strict site still blocks Rover's egress (`Refused to connect`, `connect-src`)**
  The page enforces CSP. The helper relaxes it *reactively* — a content-script sensor
  watches for a `securitypolicyviolation` caused by Rover, then strips the CSP
  *response header* for the tab with a `declarativeNetRequest` rule
  (`src/csp-bypass.js`) and, if the policy comes from a `<meta http-equiv>` tag
  (headers can't reach it), attaches `chrome.debugger` + `Page.setBypassCSP(true)`
  (`src/csp-bypass-debugger.js`). The debugger path needs the `debugger` permission
  and shows a debug banner (hide it with `--silent-debugger-extension-api`). Sites
  that don't block Rover are never reloaded and never show the banner. The bypass is
  dropped when the tab leaves the configured host/domain scope.

- **Rover says the host is outside `allowedDomains`**  
  Go back to [https://rtrvr.ai/rover/workspace](https://rtrvr.ai/rover/workspace) and add the domain. `linkedin.com` with `registrable_domain` covers `www.linkedin.com` and its subdomains.

- **Actions are disabled**  
  Make sure the Workspace key has Rover Embed enabled and your config has `allowActions: true`.

- **Worker fails to load**  
  Set `workerUrl: chrome.runtime.getURL("vendor/worker.js")` and include `vendor/worker.js` under `web_accessible_resources`.

- **You need to test many unrelated sites**  
  Use the reusable wildcard config from Live Test. For production-like behavior, use an exact site config from Workspace.

## Guardrails

- Only automate sites and accounts you are allowed to test.
- Respect target-site terms and rate limits.
- Keep public Rover keys public-only. Never ship private service credentials in an extension.
- Keep extension host permissions narrow when possible.
