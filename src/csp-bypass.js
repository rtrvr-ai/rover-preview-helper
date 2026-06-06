// Strict sites (e.g. agent.pioneer.ai) ship a Content-Security-Policy with a
// `connect-src` allow-list that excludes agent.rtrvr.ai, plus `default-src 'self'`
// covering media/fonts/workers. Rover's runtime runs in the page's MAIN world, so
// all of its egress (fetch, SSE, WebSocket), media, fonts, and the blob worker are
// governed by that page CSP and get blocked.
//
// To let the preview helper work on those sites we strip the page's CSP response
// header for the specific tab being previewed, using a session-scoped
// declarativeNetRequest rule. Session rules are the only kind that accept a
// `tabIds` condition, and they vanish on browser restart so the relaxation never
// outlives a preview session.

// Offset so our per-tab rule ids never collide with any other dynamic/session
// rules. Chrome tab ids are small positive integers within a session.
export const CSP_RULE_ID_BASE = 1_000_000;

export function ruleIdForTab(tabId) {
  return CSP_RULE_ID_BASE + Number(tabId);
}

/**
 * A declarativeNetRequest session rule that removes the CSP response headers for
 * one tab's top-level and framed document loads. Pure (no chrome APIs) so it can
 * be unit-tested.
 */
export function buildCspRemovalRule(tabId) {
  return {
    id: ruleIdForTab(tabId),
    priority: 1,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        { header: 'content-security-policy', operation: 'remove' },
        { header: 'content-security-policy-report-only', operation: 'remove' },
      ],
    },
    condition: {
      tabIds: [Number(tabId)],
      resourceTypes: ['main_frame', 'sub_frame'],
    },
  };
}

async function hasCspBypassRule(tabId) {
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const id = ruleIdForTab(tabId);
    return rules.some(rule => rule.id === id);
  } catch {
    return false;
  }
}

/**
 * Ensure the CSP-removal rule exists for this tab. Idempotent (remove+add).
 * Returns true only when the rule was newly created, so callers know a one-time
 * reload is needed for the relaxed CSP to take effect (CSP is locked at the load
 * that already happened).
 */
export async function enableCspBypass(tabId) {
  if (!Number.isFinite(Number(tabId))) return false;
  const alreadyEnabled = await hasCspBypassRule(tabId);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleIdForTab(tabId)],
    addRules: [buildCspRemovalRule(tabId)],
  });
  return !alreadyEnabled;
}

export async function disableCspBypass(tabId) {
  if (!Number.isFinite(Number(tabId))) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleIdForTab(tabId)],
    });
  } catch {
    // Best-effort cleanup; the session rule is dropped on browser restart anyway.
  }
}
