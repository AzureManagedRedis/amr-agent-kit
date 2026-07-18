import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCustomerSubscriptionAcknowledged,
  assertNotDenylisted,
  assertSubscriptionNotDenylisted,
  assertOwnedResource,
  assertNotPreExisting,
  assertSafeToMutate,
  GuardViolation,
} from '../../src/cache/guards.mjs';

test('assertCustomerSubscriptionAcknowledged passes only when the flag is explicitly true', () => {
  assert.doesNotThrow(() => assertCustomerSubscriptionAcknowledged({ acknowledgedCustomerSubscription: true }));
  assert.throws(() => assertCustomerSubscriptionAcknowledged({}), GuardViolation);
  assert.throws(() => assertCustomerSubscriptionAcknowledged({ acknowledgedCustomerSubscription: 'true' }), GuardViolation);
  assert.throws(() => assertCustomerSubscriptionAcknowledged(undefined), GuardViolation);
});

test('assertNotDenylisted throws on an exact denylist match', () => {
  assert.throws(() => assertNotDenylisted('prod-cache', ['prod-cache']), GuardViolation);
});

test('assertNotDenylisted throws on a wildcard denylist match', () => {
  assert.throws(() => assertNotDenylisted('shared-infra-db', ['shared-infra*']), GuardViolation);
});

test('assertNotDenylisted passes for unrelated names', () => {
  assert.doesNotThrow(() => assertNotDenylisted('dmon-run1-cache1', ['prod-cache', 'shared-infra*']));
});

test('assertOwnedResource enforces the owner/run prefix (no unowned/pre-existing mutation)', () => {
  assert.doesNotThrow(() => assertOwnedResource('dmon-run1-cache1', 'dmon-run1-'));
  assert.throws(() => assertOwnedResource('someone-else-run9-cache1', 'dmon-run1-'), GuardViolation);
  assert.throws(() => assertOwnedResource('prexisting-shared-cache', 'dmon-run1-'), GuardViolation);
});

test('assertNotPreExisting requires the resource to be tracked in a known-created set', () => {
  const known = new Set(['dmon-run1-cache1']);
  assert.doesNotThrow(() => assertNotPreExisting('dmon-run1-cache1', known));
  assert.throws(() => assertNotPreExisting('dmon-run1-cache2', known), GuardViolation);
});

test('assertNotPreExisting requires a Set, not an array or plain object', () => {
  assert.throws(() => assertNotPreExisting('dmon-run1-cache1', ['dmon-run1-cache1']), TypeError);
});

test('assertSafeToMutate combines ownership + denylist checks', () => {
  const opts = { resourcePrefix: 'dmon-run1-', denylist: ['dmon-run1-locked*'] };
  assert.doesNotThrow(() => assertSafeToMutate('dmon-run1-cache1', opts));
  assert.throws(() => assertSafeToMutate('other-owner-cache1', opts), GuardViolation);
  assert.throws(() => assertSafeToMutate('dmon-run1-locked-cache', opts), GuardViolation);
});

// ---- Final-review finding: subscription denylist is a distinct mechanism
// from the resource-name denylist ----

const SUB_A = '11111111-2222-3333-4444-555555555555';
const SUB_B = '66666666-7777-8888-9999-aaaaaaaaaaaa';

test('assertSubscriptionNotDenylisted throws on an exact (normalized) subscription match', () => {
  assert.throws(() => assertSubscriptionNotDenylisted(SUB_A, [SUB_A]), GuardViolation);
});

test('assertSubscriptionNotDenylisted is case-insensitive and trims whitespace', () => {
  assert.throws(() => assertSubscriptionNotDenylisted(SUB_A.toUpperCase(), [SUB_A]), GuardViolation);
  assert.throws(() => assertSubscriptionNotDenylisted(SUB_A, [`  ${SUB_A.toUpperCase()}  `]), GuardViolation);
});

test('assertSubscriptionNotDenylisted passes for an unrelated subscription', () => {
  assert.doesNotThrow(() => assertSubscriptionNotDenylisted(SUB_A, [SUB_B]));
});

test('assertSubscriptionNotDenylisted does not support wildcard matching -- only exact subscription IDs', () => {
  // Deliberately different from assertNotDenylisted: a subscription ID
  // either is, or is not, denylisted -- a trailing "*" is a literal
  // character, not a wildcard.
  assert.doesNotThrow(() => assertSubscriptionNotDenylisted(SUB_A, [`${SUB_A.slice(0, 8)}*`]));
});

test('assertSubscriptionNotDenylisted passes through harmlessly for a falsy subscriptionId', () => {
  assert.doesNotThrow(() => assertSubscriptionNotDenylisted(undefined, [SUB_A]));
  assert.doesNotThrow(() => assertSubscriptionNotDenylisted(null, [SUB_A]));
  assert.doesNotThrow(() => assertSubscriptionNotDenylisted('', [SUB_A]));
});

test('assertSubscriptionNotDenylisted is a SEPARATE mechanism from assertNotDenylisted: neither check is fooled by the other list', () => {
  // A subscription-denylist entry that happens to look like a resource
  // name must never trip the resource-name denylist check.
  assert.doesNotThrow(() => assertNotDenylisted('dmon-run1-cache1', [SUB_A]));
  // A resource-name-denylist entry that happens to look like a
  // subscription ID must never trip the subscription-denylist check.
  assert.doesNotThrow(() => assertSubscriptionNotDenylisted(SUB_A, ['dmon-run1-cache1']));
});

test('assertSafeToMutate rejects a denylisted subscription even when the resource name itself is perfectly fine', () => {
  const opts = { resourcePrefix: 'dmon-run1-', denylist: [], subscriptionId: SUB_A, subscriptionDenylist: [SUB_A] };
  assert.throws(() => assertSafeToMutate('dmon-run1-cache1', opts), GuardViolation);
});

test('assertSafeToMutate passes when the subscription is not denylisted, independent of an unrelated resource-name denylist entry', () => {
  const opts = { resourcePrefix: 'dmon-run1-', denylist: [SUB_A], subscriptionId: SUB_B, subscriptionDenylist: [SUB_A] };
  // SUB_A appears in the resource-name denylist by coincidence, and SUB_B
  // (our actual subscription) is not in subscriptionDenylist -- this must
  // still pass; the two lists must never be confused for one another.
  assert.doesNotThrow(() => assertSafeToMutate('dmon-run1-cache1', opts));
});

test('assertSafeToMutate omitting subscriptionId/subscriptionDenylist entirely still enforces resource-level checks (backward compatible)', () => {
  const opts = { resourcePrefix: 'dmon-run1-', denylist: ['dmon-run1-locked*'] };
  assert.doesNotThrow(() => assertSafeToMutate('dmon-run1-cache1', opts));
  assert.throws(() => assertSafeToMutate('dmon-run1-locked-cache', opts), GuardViolation);
});
