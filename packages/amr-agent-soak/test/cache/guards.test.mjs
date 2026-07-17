import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCustomerSubscriptionAcknowledged,
  assertNotDenylisted,
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
