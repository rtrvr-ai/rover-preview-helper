# Rover Preview Helper

Open-source Chrome extension for injecting Rover into the current tab and keeping it alive across reloads or navigation when you do not want to edit the site code directly.

Before you use this helper on arbitrary websites, get your config from Workspace.

- Workspace gives you the real test config JSON.
- Hosted Preview gives you temporary preview handoff params.
- This helper supports both.

## Path matrix

| Path | What you need | Best for | Persistence |
|---|---|---|---|
| Hosted Preview | Signed-in URL + prompt | Rover-managed demos | Temporary preview session |
| Preview Helper | Reusable test config, exact site-scoped config, or hosted handoff | Multi-page desktop demos | Re-injects after reload/navigation |
| Console | Reusable test config or exact site-scoped config + generated snippet | Fast DevTools demos | Current page only |
| Bookmarklet | Reusable test config or exact site-scoped config + generated bookmarklet | Drag-and-click demos | Current page only |
| Production install | Workspace install snippet | Real site install | Persistent |

## The two supported input modes

### 1. Generic reusable or exact config

Use this when you want to test Rover on some other website without editing that site's code first. The **reusable wildcard config** is the recommended path — it works on any domain.

Required:

- `siteId`
- either `publicKey` or `sessionToken`

Reusable wildcard config (recommended for testing):

```json
{
  "siteId": "rover-live-test-config-...",
  "publicKey": "pk_site_...",
  "siteKeyId": "...",
  "allowedDomains": ["*"],
  "domainScopeMode": "registrable_domain",
  "sessionScope": "shared_site",
  "openOnInit": true,
  "mode": "full",
  "allowActions": true,
  "capabilities": { "roverEmbed": true },
  "pageConfig": { "disableAutoScroll": true },
  "ui": {
    "voice": { "enabled": true },
    "experience": { "motion": { "actionSpotlight": true, "actionSpotlightColor": "#FF4C00" } }
  }
}
```

Exact site-scoped config (when you need policy-accurate domain validation):

```json
{
  "siteId": "site_123",
  "publicKey": "pk_site_123",
  "siteKeyId": "key_123",
  "apiBase": "https://agent.rtrvr.ai",
  "allowedDomains": ["example.com"],
  "domainScopeMode": "registrable_domain",
  "sessionScope": "shared_site",
  "openOnInit": true,
  "mode": "full",
  "allowActions": true,
  "cloudSandboxEnabled": true,
  "pageConfig": { "disableAutoScroll": true },
  "ui": {
    "voice": { "enabled": true },
    "experience": { "motion": { "actionSpotlight": true, "actionSpotlightColor": "#FF4C00" } }
  }
}
```

This works with `publicKey` directly. It is not limited to `sessionToken` anymore.

Workspace and Live Test configs rely on Rover's built-in tab behavior: outside-domain pages open in a new tab with notice, and allowed-host hops use smart tab selection.

### Wildcard configs

Setting `allowedDomains: ["*"]` means the config works on any domain. This is the default for reusable test configs created by Workspace and Live Test. You do not need to know the target domain ahead of time.

### Config persistence

The helper remembers your last-used config across browser sessions. After the first handoff via "Open target with helper" or a manual paste, subsequent sessions reuse the saved config automatically. You only need to paste or handoff once.

### 2. Hosted preview handoff

Use this when you start from the Rover website's Hosted Preview flow.

The helper can auto-hydrate from the temporary handoff payload that Rover puts on the target page URL fragment. That payload contains:

- `rover_preview_id`
- `rover_preview_token`
- `rover_preview_api`

After the helper fetches the hosted preview config, it also preserves Rover's preview session continuity fields like `sessionId` and `sessionScope`.

Rover links use the private fragment payload. You do not need to paste JSON for this path.

## Build and load

From this repo root:

```bash
pnpm install
pnpm build
```

Then load `dist` as an unpacked Chrome extension.

For local iteration:

```bash
pnpm dev
```

## How the runtime is bundled (CSP-safe)

Some sites block remote scripts with Content Security Policy, so a
`<script src="https://rover.rtrvr.ai/embed.js">` tag is rejected before Rover
boots. Manifest V3 also expects extension-executed JavaScript to ship inside the
package, not be fetched as remote code.

To avoid this, `pnpm build` packages the Rover runtime into the extension:

- it downloads the full SDK core (`embed-core.js`) and `worker/worker.js` from
  prod into `dist/vendor/` (`rover-embed.js` and `worker.js`), and writes
  `dist/vendor/VERSION.json` with the source, byte sizes, and ETags for
  traceability;
- the background worker injects `vendor/rover-embed.js` with
  `chrome.scripting.executeScript({ world: 'MAIN' })`, which bypasses the page
  CSP, and boots Rover with `workerUrl` pointing at the packaged
  `vendor/worker.js` (declared as a `web_accessible_resource`).

Build behavior:

- a plain `pnpm build` re-downloads the latest runtime from prod every run;
- if the network is unavailable it reuses the last cached copy (in
  `.rover-vendor-cache/`) with a warning, and only fails if there is neither a
  cache nor a network;
- `pnpm dev` (watch mode) reuses the cache so rebuilds stay instant and offline;
- set `ROVER_EMBED_BASE` to vendor from a staging deploy instead of prod.

Website owners should still install Rover with the public `embed.js` snippet.
This helper uses `embed-core.js` because it injects Rover directly from a Chrome
extension instead of loading it through a normal page `<script src>` tag.

### Strict sites: page CSP relaxation

Loading the runtime is only half the story. Because Rover runs in the page's main
world, the page's CSP also governs Rover's **network egress** (`fetch`, SSE, and
WebSocket to `agent.rtrvr.ai`), its mascot media (`media-src`), fonts
(`font-src`), and the module worker (`worker-src`). On hardened sites (e.g. one
with `connect-src` allow-listing only its own API) those are blocked.

To make previews work there, the helper strips the page's
`Content-Security-Policy` response header **only for the tab you inject into**,
using a session-scoped `declarativeNetRequest` rule
(`src/csp-bypass.js`). Because a CSP is locked in at page load, the first inject
into a tab reloads it once so the relaxed policy takes effect; the rule is removed
when the tab closes and never survives a browser restart.

This means the previewed tab runs without the site's CSP while you test. That is
acceptable for a developer testing tool, and is scoped as tightly as the platform
allows (one tab, session-only).

Remaining limitation: a CSP delivered via an HTML `<meta http-equiv>` tag instead
of a response header cannot be removed by `declarativeNetRequest`, so the rare
site that ships its policy that way can still block Rover's egress. The
[headless approach](./EXTENSION_USERS.md) is the alternative for those cases.

## Getting your config

- [Workspace → Test](https://www.rtrvr.ai/rover/workspace?view=test): copy the reusable wildcard test config JSON.
- [Live Test](https://www.rtrvr.ai/rover/instant-preview?flow=workspace_config): paste config and use "Open target with helper" for zero-paste handoff.

## The clean first-run flow

### Live Test helper path

1. Open [Live Test](https://www.rtrvr.ai/rover/instant-preview?flow=workspace_config).
2. Stay on the reusable test-config path unless you explicitly need the advanced exact site-scoped config.
3. Enter the target site URL in the Preview Helper section.
4. Click `Open target with helper`.
5. If Rover does not inject automatically, open the helper popup and paste the fallback helper JSON.

Use `Reconnect preview` after reloads or navigation. Generic helper sessions keep re-injecting in the same tab while later pages still match `allowedDomains`.

The website tool opens the target page with a private URL fragment:

- `#rover_helper_payload=<base64url(JSON)>`

The helper reads that fragment, strips it from the URL, and injects Rover automatically.

### Hosted preview handoff

1. Open [Rover Instant Preview](https://www.rtrvr.ai/rover/instant-preview).
2. Stay on the `Use Rover temporary demo` path and create a preview.
3. Choose `Open with helper`.
4. The helper reads the private handoff fragment automatically.
5. It fetches the preview config, strips the fragment from the page URL, injects Rover, and keeps reconnecting across navigation.

## Popup fields

The popup now says **Rover or preview config JSON** on purpose.

That means it accepts either:

- generic Workspace config with `publicKey`
- hosted preview/runtime config with `sessionToken`

The popup is not asking for the production install snippet. It wants JSON only.

## What the helper does

- injects Rover into the active tab from popup JSON config
- bundles the Rover runtime and relaxes the active tab's CSP so it works on strict sites (reloads the tab once on first inject)
- auto-hydrates from hosted preview handoff fragments
- refreshes hosted preview state when reconnecting
- re-injects on reload and history navigation
- keeps hosted handoff scoping tied to the intended target host
- lets generic reusable/exact configs keep re-injecting while later pages stay inside `allowedDomains`
- rejects tabs whose host is outside the config's `allowedDomains`

## What it does not do

- it does not create previews by itself
- it does not mint preview tokens or production site keys
- it does not replace Hosted Preview or Workspace
- it does not make Rover calls synchronous; headless runs return results through events

## Reinjection model

- a `document_start` content script signals page readiness
- the background worker decides whether to hydrate hosted preview state or reconnect saved state
- packaged main-world bootstrap code seeds Rover boot config into the page
- the packaged Rover runtime (`vendor/rover-embed.js`) is injected via `chrome.scripting.executeScript`, bypassing page CSP
- the helper re-injects after reloads and history navigation

The helper only uses packaged extension scripts injected with `chrome.scripting.executeScript(...)`. It never appends a remote `<script>` tag, so page CSP cannot block the Rover runtime from loading.

## Headless or programmatic control

Extensions can trigger Rover without using the Rover widget input, but the integration should be event-based:

- inject Rover with a Workspace config;
- inject a small MAIN-world bridge that can access `window.rover`;
- call `rover.send(prompt)` from that bridge;
- listen for `run_started`, `response_shown`, `run_completed`, and `error`;
- relay results back to the extension background script for storage or backend calls.

See [HEADLESS_CONTROL.md](./HEADLESS_CONTROL.md) and the copyable sample in [examples/headless-control-extension](./examples/headless-control-extension).

## Common mistakes

- **Pasting the install snippet instead of JSON**
  The helper wants config JSON, not HTML.
- **`This API key is missing capability: roverEmbed`**
  The selected Workspace key is not embed-ready. Rotate or create an embed-enabled key in Workspace, then copy the fresh test config JSON again.
- **`React has blocked a javascript: URL`**
  Delete any old Rover bookmarklet and recreate it from the current Rover Live Test page. The bookmarklet must be dragged from Rover's drag control, not clicked on the Rover page.
- **Testing on the wrong host with exact site-scoped config**
  If your config uses exact `allowedDomains` (not `["*"]`) and says `host_only`, open the exact host listed. Switch to the reusable wildcard config for unrestricted testing.
- **Expecting `Open hosted shell` to reopen the launcher**
  Hosted Preview should open Rover's dedicated hosted viewer page for the cloud-browser fallback.
- **Using preview tokens like production keys**
  Preview tokens are temporary. Workspace keys are persistent.
- **Expecting mobile parity**
  This helper is a desktop Chrome path. Use Hosted Preview on mobile.

## Safe extension points

You can extend this app by:

- changing popup UX and presets
- adding config templates for your own Rover environments
- changing reinjection heuristics
- adding local debug/status views

Be careful not to:

- widen host scoping unintentionally
- persist preview tokens longer than needed
- confuse short-lived preview tokens with persistent Workspace site keys

## Related docs

- Extension users: [./EXTENSION_USERS.md](./EXTENSION_USERS.md)
- Headless control: [./HEADLESS_CONTROL.md](./HEADLESS_CONTROL.md)
- Headless control sample: [./examples/headless-control-extension](./examples/headless-control-extension)
- Rover Workspace: [https://rtrvr.ai/rover/workspace](https://rtrvr.ai/rover/workspace)
- Hosted website walkthrough: [https://www.rtrvr.ai/rover/docs/try-on-other-sites](https://www.rtrvr.ai/rover/docs/try-on-other-sites)
- Hosted preview API docs: [https://www.rtrvr.ai/rover/docs/instant-preview-api](https://www.rtrvr.ai/rover/docs/instant-preview-api)
