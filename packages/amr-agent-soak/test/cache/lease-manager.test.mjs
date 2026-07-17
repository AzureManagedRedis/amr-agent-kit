import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LeaseManager, LeaseError, LEASE_CLASSES, MAX_ACTIVE_LEASES } from '../../src/cache/lease-manager.mjs';
import { KillSwitch, KillSwitchEngaged } from '../../src/cache/kill-switch.mjs';

function manager(opts = {}) {
  return new LeaseManager({ connectionBudget: 100, ...opts });
}

test('LEASE_CLASSES exposes exactly shared/exclusive/topology/dry-run', () => {
  assert.deepEqual([...LEASE_CLASSES].sort(), ['dry-run', 'exclusive', 'shared', 'topology']);
});

test('acquire rejects unknown lease classes', () => {
  const m = manager();
  assert.throws(() => m.acquire({ class: 'super-admin' }), LeaseError);
});

test('max six active leases: a seventh concurrent lease is rejected', () => {
  const m = manager();
  for (let i = 0; i < MAX_ACTIVE_LEASES; i += 1) {
    m.acquire({ class: 'shared', resourceName: `dmon-run1-cache${i}` });
  }
  assert.equal(m.activeCount(), 6);
  assert.throws(() => m.acquire({ class: 'shared', resourceName: 'dmon-run1-cache7' }), LeaseError);
});

test('releasing a lease frees a slot for a new one', () => {
  const m = manager();
  const leases = [];
  for (let i = 0; i < MAX_ACTIVE_LEASES; i += 1) {
    leases.push(m.acquire({ class: 'shared', resourceName: `dmon-run1-cache${i}` }));
  }
  m.release(leases[0].id);
  assert.equal(m.activeCount(), 5);
  assert.doesNotThrow(() => m.acquire({ class: 'shared', resourceName: 'dmon-run1-cache-new' }));
});

test('constructor refuses a maxActiveLeases above the hard cap of six', () => {
  assert.throws(() => new LeaseManager({ maxActiveLeases: 7 }), LeaseError);
});

test('global/destructive scenarios require an exclusive lease', () => {
  const m = manager();
  assert.throws(() => m.acquire({ class: 'shared', destructive: true }), LeaseError);
  assert.throws(() => m.acquire({ class: 'topology', destructive: true }), LeaseError);
  assert.doesNotThrow(() => m.acquire({ class: 'exclusive', destructive: true }));
});

test('dry-run and shared classes never touch the kill switch', () => {
  const ks = new KillSwitch({ path: '/tmp/engaged.killswitch', exists: () => true });
  const m = manager({ killSwitch: ks });
  assert.doesNotThrow(() => m.acquire({ class: 'shared' }));
  assert.doesNotThrow(() => m.acquire({ class: 'dry-run' }));
});

test('exclusive and topology (mutating) classes are blocked by an engaged kill switch', () => {
  const ks = new KillSwitch({ path: '/tmp/engaged.killswitch', exists: () => true });
  const m = manager({ killSwitch: ks });
  assert.throws(() => m.acquire({ class: 'exclusive' }), KillSwitchEngaged);
  assert.throws(() => m.acquire({ class: 'topology' }), KillSwitchEngaged);
});

test('connection budget rejects a lease that would exceed it', () => {
  const m = new LeaseManager({ connectionBudget: 3 });
  m.acquire({ class: 'shared', connections: 2 });
  assert.throws(() => m.acquire({ class: 'shared', connections: 2 }), LeaseError);
  assert.doesNotThrow(() => m.acquire({ class: 'shared', connections: 1 }));
});

test('leases expire after TTL and are reaped, freeing their slot', () => {
  let now = 1000;
  const m = manager({ now: () => now });
  const lease = m.acquire({ class: 'shared', ttlMs: 500 });
  assert.equal(m.isActive(lease.id), true);
  now += 600;
  assert.equal(m.isActive(lease.id), false);
  assert.equal(m.activeCount(), 0);
});

test('heartbeat renews a lease TTL before it expires', () => {
  let now = 1000;
  const m = manager({ now: () => now });
  const lease = m.acquire({ class: 'shared', ttlMs: 500 });
  now += 400;
  m.heartbeat(lease.id);
  now += 400; // 800ms after acquire, but only 400ms after the heartbeat renewal
  assert.equal(m.isActive(lease.id), true);
  now += 200; // now 600ms after the heartbeat -> expired
  assert.equal(m.isActive(lease.id), false);
});

test('heartbeat on an unknown or already-expired lease throws', () => {
  const m = manager();
  assert.throws(() => m.heartbeat('not-a-real-lease-id'), LeaseError);
});

test('listActive reflects only currently active, non-expired leases', () => {
  let now = 1000;
  const m = manager({ now: () => now });
  m.acquire({ class: 'shared', resourceName: 'a', ttlMs: 100 });
  m.acquire({ class: 'shared', resourceName: 'b', ttlMs: 100000 });
  now += 200;
  const active = m.listActive();
  assert.equal(active.length, 1);
  assert.equal(active[0].resourceName, 'b');
});
