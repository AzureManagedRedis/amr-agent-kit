import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LeaseManager,
  LeaseError,
  LEASE_CLASSES,
  MAX_ACTIVE_LEASES,
  assertLeaseAuthorizes,
  OPERATION_KINDS,
  LeaseNotAuthorized,
  FencingTokenStale,
} from '../../src/cache/lease-manager.mjs';
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

test('every acquired lease carries a monotonically increasing fencing token', () => {
  const m = manager();
  const a = m.acquire({ class: 'shared' });
  const b = m.acquire({ class: 'shared' });
  const c = m.acquire({ class: 'shared' });
  assert.ok(a.fencingToken < b.fencingToken);
  assert.ok(b.fencingToken < c.fencingToken);
});

test('assertFencingTokenValid passes for a live lease presenting its own token', () => {
  const m = manager();
  const lease = m.acquire({ class: 'exclusive' });
  assert.doesNotThrow(() => m.assertFencingTokenValid(lease.id, lease.fencingToken));
  assert.equal(m.isFencingTokenValid(lease.id, lease.fencingToken), true);
});

test('assertFencingTokenValid rejects a mismatched token for a still-live lease', () => {
  const m = manager();
  const lease = m.acquire({ class: 'exclusive' });
  assert.throws(() => m.assertFencingTokenValid(lease.id, lease.fencingToken + 999), FencingTokenStale);
  assert.equal(m.isFencingTokenValid(lease.id, lease.fencingToken + 999), false);
});

test('assertFencingTokenValid rejects an unknown lease id', () => {
  const m = manager();
  assert.throws(() => m.assertFencingTokenValid('not-a-real-lease-id', 1), FencingTokenStale);
});

test('an expired (reaped) lease can no longer authorize mutations via its old fencing token', () => {
  let now = 1000;
  const m = manager({ now: () => now });
  const lease = m.acquire({ class: 'exclusive', ttlMs: 500 });
  assert.doesNotThrow(() => m.assertFencingTokenValid(lease.id, lease.fencingToken));

  now += 600; // past TTL -- the lease is reaped on next access
  assert.throws(() => m.assertFencingTokenValid(lease.id, lease.fencingToken), FencingTokenStale);
});

test('re-acquiring after expiry issues a strictly newer fencing token, superseding the old one', () => {
  let now = 1000;
  const m = manager({ now: () => now });
  const first = m.acquire({ class: 'exclusive', resourceName: 'dmon-run1-cache1', ttlMs: 100 });
  now += 200; // first lease expires
  const second = m.acquire({ class: 'exclusive', resourceName: 'dmon-run1-cache1', ttlMs: 100 });

  assert.ok(second.fencingToken > first.fencingToken);
  // The old (expired) owner's token/lease is no longer valid at all.
  assert.throws(() => m.assertFencingTokenValid(first.id, first.fencingToken), FencingTokenStale);
  // The new owner's token is valid.
  assert.doesNotThrow(() => m.assertFencingTokenValid(second.id, second.fencingToken));
});

test('heartbeat renewal keeps the same fencing token (it is a renewal, not a new grant)', () => {
  let now = 1000;
  const m = manager({ now: () => now });
  const lease = m.acquire({ class: 'exclusive', ttlMs: 500 });
  now += 400;
  const renewed = m.heartbeat(lease.id);
  assert.equal(renewed.fencingToken, lease.fencingToken);
});

test('OPERATION_KINDS exposes exactly read/write/topology', () => {
  assert.deepEqual([...OPERATION_KINDS].sort(), ['read', 'topology', 'write']);
});

test('assertLeaseAuthorizes: shared leases are read-only (connectivity), never write or topology', () => {
  const m = manager();
  const lease = m.acquire({ class: 'shared' });
  assert.doesNotThrow(() => assertLeaseAuthorizes(lease, 'read'));
  assert.throws(() => assertLeaseAuthorizes(lease, 'write'), LeaseNotAuthorized);
  assert.throws(() => assertLeaseAuthorizes(lease, 'topology'), LeaseNotAuthorized);
});

test('assertLeaseAuthorizes: exclusive leases authorize read/write/topology (control-plane mutations)', () => {
  const m = manager();
  const lease = m.acquire({ class: 'exclusive' });
  assert.doesNotThrow(() => assertLeaseAuthorizes(lease, 'read'));
  assert.doesNotThrow(() => assertLeaseAuthorizes(lease, 'write'));
  assert.doesNotThrow(() => assertLeaseAuthorizes(lease, 'topology'));
});

test('assertLeaseAuthorizes: topology leases authorize topology-shape changes but not generic write', () => {
  const m = manager();
  const lease = m.acquire({ class: 'topology' });
  assert.doesNotThrow(() => assertLeaseAuthorizes(lease, 'read'));
  assert.doesNotThrow(() => assertLeaseAuthorizes(lease, 'topology'));
  assert.throws(() => assertLeaseAuthorizes(lease, 'write'), LeaseNotAuthorized);
});

test('assertLeaseAuthorizes rejects an unknown operation kind', () => {
  const m = manager();
  const lease = m.acquire({ class: 'exclusive' });
  assert.throws(() => assertLeaseAuthorizes(lease, 'teleport'), LeaseError);
});

// ---- Finding #6: exclusive mutual exclusion + explicit topology semantics ----

test('acquiring an exclusive lease requires that no other lease is currently active', () => {
  const m = manager();
  m.acquire({ class: 'shared' });
  assert.throws(() => m.acquire({ class: 'exclusive' }), LeaseError);
});

test('no lease of any class may be acquired while an exclusive lease is active', () => {
  const m = manager();
  m.acquire({ class: 'exclusive' });
  assert.throws(() => m.acquire({ class: 'shared' }), LeaseError);
  assert.throws(() => m.acquire({ class: 'topology' }), LeaseError);
  assert.throws(() => m.acquire({ class: 'dry-run' }), LeaseError);
  assert.throws(() => m.acquire({ class: 'exclusive' }), LeaseError);
});

test('an exclusive lease can be acquired on a fresh manager with no other leases', () => {
  const m = manager();
  assert.doesNotThrow(() => m.acquire({ class: 'exclusive' }));
});

test('once the sole exclusive lease is released, new leases may be acquired again', () => {
  const m = manager();
  const lease = m.acquire({ class: 'exclusive' });
  assert.throws(() => m.acquire({ class: 'shared' }), LeaseError);
  m.release(lease.id);
  assert.doesNotThrow(() => m.acquire({ class: 'shared' }));
});

test('once the sole exclusive lease expires (is reaped), new leases may be acquired again', () => {
  let now = 1000;
  const m = manager({ now: () => now });
  m.acquire({ class: 'exclusive', ttlMs: 100 });
  now += 200;
  assert.doesNotThrow(() => m.acquire({ class: 'shared' }));
});

test('shared leases may coexist with each other and with dry-run/topology leases on different resources', () => {
  const m = manager();
  assert.doesNotThrow(() => m.acquire({ class: 'shared' }));
  assert.doesNotThrow(() => m.acquire({ class: 'shared' }));
  assert.doesNotThrow(() => m.acquire({ class: 'dry-run' }));
  assert.doesNotThrow(() => m.acquire({ class: 'topology', resourceName: 'dmon-run1-cache1' }));
  assert.doesNotThrow(() => m.acquire({ class: 'topology', resourceName: 'dmon-run1-cache2' }));
});

test('topology leases are explicitly exclusive per-resourceName: a second topology lease on the same resource is refused', () => {
  const m = manager();
  m.acquire({ class: 'topology', resourceName: 'dmon-run1-cache1' });
  assert.throws(() => m.acquire({ class: 'topology', resourceName: 'dmon-run1-cache1' }), LeaseError);
});

test('topology leases on different resourceNames do not conflict with each other', () => {
  const m = manager();
  m.acquire({ class: 'topology', resourceName: 'dmon-run1-cache1' });
  assert.doesNotThrow(() => m.acquire({ class: 'topology', resourceName: 'dmon-run1-cache2' }));
});

test('a topology lease without a resourceName does not participate in per-resource exclusivity', () => {
  const m = manager();
  m.acquire({ class: 'topology' });
  assert.doesNotThrow(() => m.acquire({ class: 'topology' }));
});

// ---- Finding #7: persisted monotonic fencing token ----

test('without a fencingStatePath, the fencing counter starts at 1 (in-memory only)', () => {
  const m = manager();
  const lease = m.acquire({ class: 'shared' });
  assert.equal(lease.fencingToken, 1);
});

test('with a fencingStatePath, the fencing counter survives across LeaseManager instances (process restarts)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'amr-soak-fencing-'));
  try {
    const fencingStatePath = join(dir, 'fencing.json');
    const m1 = new LeaseManager({ connectionBudget: 100, fencingStatePath });
    const leaseA = m1.acquire({ class: 'shared' });
    m1.release(leaseA.id);

    // Simulate a process restart: a brand new LeaseManager instance pointed
    // at the same durable state file must never reissue/reuse leaseA's token.
    const m2 = new LeaseManager({ connectionBudget: 100, fencingStatePath });
    const leaseB = m2.acquire({ class: 'shared' });
    assert.ok(leaseB.fencingToken > leaseA.fencingToken);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the persisted fencing counter monotonically increases across many acquisitions and restarts (Windows regression: unlink-before-rename)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'amr-soak-fencing-'));
  try {
    const fencingStatePath = join(dir, 'fencing.json');
    let lastToken = 0;
    for (let i = 0; i < 25; i += 1) {
      const m = new LeaseManager({ connectionBudget: 100, fencingStatePath });
      const lease = m.acquire({ class: 'shared' });
      assert.ok(lease.fencingToken > lastToken);
      lastToken = lease.fencingToken;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
