import test from 'node:test';
import assert from 'node:assert/strict';

import { CSP_RULE_ID_BASE, ruleIdForTab, buildCspRemovalRule } from './csp-bypass.js';

test('ruleIdForTab offsets tab ids into a reserved range and stays unique', () => {
  assert.equal(ruleIdForTab(0), CSP_RULE_ID_BASE);
  assert.equal(ruleIdForTab(42), CSP_RULE_ID_BASE + 42);
  assert.notEqual(ruleIdForTab(1), ruleIdForTab(2));
});

test('buildCspRemovalRule removes both CSP headers scoped to the one tab', () => {
  const rule = buildCspRemovalRule(7);

  assert.equal(rule.id, ruleIdForTab(7));
  assert.equal(rule.action.type, 'modifyHeaders');

  const removed = rule.action.responseHeaders.map(h => `${h.header}:${h.operation}`).sort();
  assert.deepEqual(removed, [
    'content-security-policy-report-only:remove',
    'content-security-policy:remove',
  ]);

  assert.deepEqual(rule.condition.tabIds, [7]);
  assert.deepEqual(rule.condition.resourceTypes.sort(), ['main_frame', 'sub_frame']);
});

test('buildCspRemovalRule coerces string tab ids to numbers', () => {
  const rule = buildCspRemovalRule('9');
  assert.equal(rule.id, CSP_RULE_ID_BASE + 9);
  assert.deepEqual(rule.condition.tabIds, [9]);
});
