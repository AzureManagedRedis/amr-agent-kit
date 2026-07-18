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

// ---- Final-review finding: subscription denylist must be enforced at this
// boundary too, as a mechanism separate from the resource-name denylist ----

test('assertValidMutationContext rejects a denylisted subscription before any other resource-level check would matter', () => {
  const leaseManager = new LeaseManager();
  const lease = leaseManager.acquire({ class: 'exclusive' });
  const SUBSCRIPTION_ID = '11111111-2222-3333-4444-555555555555';
  const context = {
    config: baseConfig({ subscriptionId: SUBSCRIPTION_ID, subscriptionDenylist: [SUBSCRIPTION_ID] }),
    lease,
    leaseManager,
  };
  // Even a perfectly valid, owned, non-denylisted resource name must still
  // be refused when its subscription is denylisted.
  assert.throws(() => assertValidMutationContext(context, 'dmon-run1-cache1', 'write'), GuardViolation);
});

test('assertValidMutationContext passes when the subscription is not denylisted, unaffected by an unrelated resource-name-denylist entry', () => {
  const leaseManager = new LeaseManager();
  const lease = leaseManager.acquire({ class: 'exclusive' });
  const SUBSCRIPTION_ID = '11111111-2222-3333-4444-555555555555';
  const OTHER_SUBSCRIPTION_ID = '66666666-7777-8888-9999-aaaaaaaaaaaa';
  const context = {
    config: baseConfig({
      subscriptionId: SUBSCRIPTION_ID,
      subscriptionDenylist: [OTHER_SUBSCRIPTION_ID],
      denylist: [SUBSCRIPTION_ID], // coincidentally present in the resource-name denylist -- must not matter here
    }),
    lease,
    leaseManager,
  };
  assert.doesNotThrow(() => assertValidMutationContext(context, 'dmon-run1-cache1', 'write'));
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
