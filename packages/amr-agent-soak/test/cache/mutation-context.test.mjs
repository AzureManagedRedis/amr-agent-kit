import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertValidMutationContext, MutationContextError } from '../../src/cache/mutation-context.mjs';
import { GuardViolation } from '../../src/cache/guards.mjs';
import { LeaseManager, LeaseNotAuthorized, FencingTokenStale } from '../../src/cache/lease-manager.mjs';
import { KillSwitch, KillSwitchEngaged } from '../../src/cache/kill-switch.mjs';

function baseConfig(overrides = {}) {
  return { resourcePrefix: 'dmon-run1-', denylist: [], acknowledgedCustomerSubscription: true, ...overrides };
}

test('assertValidMutationContext requires a context object at all', () => {
  assert.throws(() => assertValidMutationContext(undefined, 'dmon-run1-cache1', 'write'), MutationContextError);
  assert.throws(() => assertValidMutationContext(null, 'dmon-run1-cache1', 'write'), MutationContextError);
  assert.throws(() => assertValidMutationContext('not-an-object', 'dmon-run1-cache1', 'write'), MutationContextError);
});

test('assertValidMutationContext requires config, lease, and leaseManager fields', () => {
  const leaseManager = new LeaseManager();
  const lease = leaseManager.acquire({ class: 'exclusive' });
  assert.throws(() => assertValidMutationContext({ lease, leaseManager }, 'dmon-run1-cache1', 'write'), MutationContextError);
  assert.throws(() => assertValidMutationContext({ config: baseConfig(), leaseManager }, 'dmon-run1-cache1', 'write'), MutationContextError);
  assert.throws(() => assertValidMutationContext({ config: baseConfig(), lease }, 'dmon-run1-cache1', 'write'), MutationContextError);
});

test('assertValidMutationContext passes for a fully valid context', () => {
  const leaseManager = new LeaseManager();
  const lease = leaseManager.acquire({ class: 'exclusive' });
  assert.doesNotThrow(() =>
    assertValidMutationContext({ config: baseConfig(), lease, leaseManager }, 'dmon-run1-cache1', 'write')
  );
});

test('assertValidMutationContext enforces customer-subscription acknowledgement', () => {
  const leaseManager = new LeaseManager();
  const lease = leaseManager.acquire({ class: 'exclusive' });
  const context = { config: baseConfig({ acknowledgedCustomerSubscription: false }), lease, leaseManager };
  assert.throws(() => assertValidMutationContext(context, 'dmon-run1-cache1', 'write'), GuardViolation);
});

test('assertValidMutationContext enforces the kill switch immediately', () => {
  const leaseManager = new LeaseManager();
  const lease = leaseManager.acquire({ class: 'exclusive' });
  const killSwitch = new KillSwitch({ path: '/tmp/engaged.killswitch', exists: () => true });
  const context = { config: baseConfig(), lease, leaseManager, killSwitch };
  assert.throws(() => assertValidMutationContext(context, 'dmon-run1-cache1', 'write'), KillSwitchEngaged);
});

test('assertValidMutationContext enforces ownership + denylist', () => {
  const leaseManager = new LeaseManager();
  const lease = leaseManager.acquire({ class: 'exclusive' });
  assert.throws(
    () => assertValidMutationContext({ config: baseConfig(), lease, leaseManager }, 'other-owner-cache1', 'write'),
    GuardViolation
  );
  const denylistContext = { config: baseConfig({ denylist: ['dmon-run1-locked*'] }), lease, leaseManager };
  assert.throws(
    () => assertValidMutationContext(denylistContext, 'dmon-run1-locked-cache', 'write'),
    GuardViolation
  );
});

test('assertValidMutationContext enforces lease-class operation authorization', () => {
  const leaseManager = new LeaseManager();
  const lease = leaseManager.acquire({ class: 'shared' });
  const context = { config: baseConfig(), lease, leaseManager };
  assert.throws(() => assertValidMutationContext(context, 'dmon-run1-cache1', 'write'), LeaseNotAuthorized);
  assert.doesNotThrow(() => assertValidMutationContext(context, 'dmon-run1-cache1', 'read'));
});

test('assertValidMutationContext enforces fencing-token liveness', () => {
  let now = 1000;
  const leaseManager = new LeaseManager({ now: () => now });
  const lease = leaseManager.acquire({ class: 'exclusive', ttlMs: 100 });
  now += 200; // expired
  const context = { config: baseConfig(), lease, leaseManager };
  assert.throws(() => assertValidMutationContext(context, 'dmon-run1-cache1', 'write'), FencingTokenStale);
});

test('checks run in a deterministic order: ack before kill switch before ownership before lease authz before fencing', () => {
  // Missing ack should surface even when everything else would also fail,
  // proving ack is checked first (the strongest, cheapest gate).
  const leaseManager = new LeaseManager();
  const lease = leaseManager.acquire({ class: 'shared' }); // wrong class too
  const context = { config: baseConfig({ acknowledgedCustomerSubscription: false }), lease, leaseManager };
  assert.throws(
    () => assertValidMutationContext(context, 'other-owner-cache1', 'write'),
    (err) => {
      assert.ok(err instanceof GuardViolation);
      assert.match(err.message, /acknowledgement/i);
      return true;
    }
  );
});
