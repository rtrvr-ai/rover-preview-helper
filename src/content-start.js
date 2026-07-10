(() => {
  // Manifest content scripts are not retroactively installed into tabs that were
  // already open when an unpacked extension was installed or reloaded. The
  // background therefore also executes this file immediately before injecting
  // Rover. Keep the whole setup idempotent so the manifest and dynamic paths can
  // safely race without registering duplicate CSP/message listeners.
  const INSTALL_KEY = '__ROVER_PREVIEW_HELPER_CONTENT_START_INSTALLED__';
  if (globalThis[INSTALL_KEY] === true) return;
  globalThis[INSTALL_KEY] = true;

  const availabilityMessage = {
    type: 'ROVER_PREVIEW_HELPER_AVAILABLE',
    source: 'rover-preview-helper',
    version: chrome.runtime.getManifest?.().version || '',
  };

  const announceAvailability = () => {
    try {
      window.postMessage(availabilityMessage, '*');
    } catch {
      // Ignore page messaging failures on locked-down pages.
    }
  };

  const payload = {
    type: 'ROVER_PREVIEW_HELPER_PAGE_READY',
    url: location.href,
    host: location.hostname,
  };

  announceAvailability();

  window.addEventListener('message', event => {
    if (event.source !== window) return;
    if (String(event.data?.type || '') !== 'ROVER_PREVIEW_HELPER_PING') return;
    announceAvailability();
  });

  // Reactive CSP sensor. Rover runs in the page's world, so a strict page CSP can
  // block its egress/worker/assets. We do NOT relax CSP up front — we watch for a
  // real securitypolicyviolation and let the background decide whether it's Rover's
  // and escalate the bypass only then. The manifest installs this at document_start,
  // and the background also ensures it is present before Rover is injected.
  const hasMetaCsp = () => {
    try {
      return Array.prototype.some.call(
        document.querySelectorAll('meta[http-equiv]'),
        meta => String(meta.httpEquiv || '').toLowerCase() === 'content-security-policy',
      );
    } catch {
      return false;
    }
  };

  // Dedupe by (directive, origin+path of blockedURI) rather than time-throttling,
  // so a site's own noisy violations can never crowd out Rover's distinct one. The
  // query string is stripped from the key: cache-busted URLs (retrying SSE/fetch
  // with varying params) would otherwise defeat the dedup and flood the service
  // worker with one message per retry. The background is the authority on
  // attribution and escalation, and it only needs the host anyway.
  const dedupeUri = uri => {
    const raw = String(uri || '');
    try {
      const url = new URL(raw);
      return `${url.origin}${url.pathname}`;
    } catch {
      return raw.split(/[?#]/, 1)[0];
    }
  };
  // Hard backstop on message rate per document: whatever slips past the dedup
  // (e.g. many distinct blocked paths) may not wake the service worker more than
  // CSP_RELAY_MAX times per window. One relayed violation per rung is enough for
  // the background to escalate; the rest is noise.
  const CSP_RELAY_WINDOW_MS = 10_000;
  const CSP_RELAY_MAX = 10;
  let relayWindowStart = 0;
  let relayCount = 0;
  const MAX_CSP_KEYS = 80;
  const seenCspKeys = new Set();
  document.addEventListener('securitypolicyviolation', event => {
    if (event.disposition !== 'enforce') return;
    const effectiveDirective = String(event.effectiveDirective || event.violatedDirective || '');
    const blockedURI = String(event.blockedURI || '');
    const key = `${effectiveDirective}|${dedupeUri(blockedURI)}`;
    if (seenCspKeys.has(key)) return;
    if (seenCspKeys.size >= MAX_CSP_KEYS) {
      const oldest = seenCspKeys.values().next().value;
      if (oldest !== undefined) seenCspKeys.delete(oldest);
    }
    seenCspKeys.add(key);
    const now = Date.now();
    if (now - relayWindowStart >= CSP_RELAY_WINDOW_MS) {
      relayWindowStart = now;
      relayCount = 0;
    }
    if (relayCount >= CSP_RELAY_MAX) return;
    relayCount += 1;
    try {
      chrome.runtime.sendMessage({
        type: 'ROVER_PREVIEW_HELPER_CSP_BLOCKED',
        blockedURI,
        effectiveDirective,
        disposition: 'enforce',
        hasMetaCsp: hasMetaCsp(),
        url: location.href,
      });
    } catch {
      // Background may be asleep; a distinct later violation will retry.
    }
  });

  try {
    chrome.runtime.sendMessage(payload);
  } catch {
    // Background may not be ready yet. The navigation hooks will catch up.
  }
})();
