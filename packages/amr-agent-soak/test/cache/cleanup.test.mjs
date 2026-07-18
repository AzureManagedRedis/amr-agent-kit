import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResourceLedger } from '../../src/cache/ledger.mjs';
import { LocalRpHttpAdapter } from '../../src/cache/http-adapter.mjs';
import { KillSwitch, KillSwitchEngaged } from '../../src/cache/kill-switch.mjs';
import {
  reverseCleanup,
  deleteOwnedResource,
  CleanupError,
  CircuitBreakerTripped,
  DEFAULT_MAX_DELETES_PER_RUN,
} from '../../src/cache/cleanup.mjs';
import { GuardViolation } from '../../src/cache/guards.mjs';
import { LeaseManager, LeaseNotAuthorized, FencingTokenStale } from '../../src/cache/lease-manager.mjs';
import { createFakeRp } from './fakes/fake-rp.mjs';

const SUBSCRIPTION_ID = '11111111-2222-3333-4444-555555555555';

async function withTempLedger(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'amr-soak-cleanup-'));
  try {
    return await fn(new ResourceLedger({ path: join(dir, 'ledger.jsonl') }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function testConfig(overrides = {}) {
  return {
    subscriptionId: SUBSCRIPTION_ID,
    resourceGroup: 'rg1',
    resourcePrefix: 'dmon-run1-',
    denylist: [],
    acknowledgedCustomerSubscription: true,
    ...overrides,
  };
}

function exclusiveLeaseFor(resourceName) {
  const leaseManager = new LeaseManager();
  const lease = leaseManager.acquire({ class: 'exclusive', resourceName });
  return { leaseManager, lease };
}

test('reverseCleanup tears down resources in reverse (LIFO) creation order', async () => {
  await withTempLedger(async (ledger) => {
    const fake = createFakeRp({
      initialClusters: [{ name: 'dmon-run1-cache1' }, { name: 'dmon-run1-cache2' }, { name: 'dmon-run1-cache3' }],
    });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    ledger.append('created', 'dmon-run1-cache1');
    ledger.append('created', 'dmon-run1-cache2');
    ledger.append('created', 'dmon-run1-cache3');
    const { leaseManager, lease } = exclusiveLeaseFor('cleanup');

    const results = await reverseCleanup({ ledger, adapter, config: testConfig(), lease, leaseManager });
    assert.deepEqual(
      results.map((r) => r.resourceName),
      ['dmon-run1-cache3', 'dmon-run1-cache2', 'dmon-run1-cache1']
    );
    assert.ok(results.every((r) => r.status === 'deleted'));
    assert.equal(fake._clusters.size, 0);
  });
});

test('reverseCleanup is idempotent: a second run finds nothing left to delete', async () => {
  await withTempLedger(async (ledger) => {
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    ledger.append('created', 'dmon-run1-cache1');
    const { leaseManager, lease } = exclusiveLeaseFor('cleanup');

    const first = await reverseCleanup({ ledger, adapter, config: testConfig(), lease, leaseManager });
    assert.deepEqual(first.map((r) => r.status), ['deleted']);

    const second = await reverseCleanup({ ledger, adapter, config: testConfig(), lease, leaseManager });
    assert.deepEqual(second, []); // nothing active left in the ledger to clean up
  });
});

test('reverseCleanup treats an already-absent resource as idempotent success, not a failure', async () => {
  await withTempLedger(async (ledger) => {
    const fake = createFakeRp({}); // RP already empty, but the ledger still thinks it's active.
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    ledger.append('created', 'dmon-run1-cache1');
    const { leaseManager, lease } = exclusiveLeaseFor('cleanup');

    const results = await reverseCleanup({ ledger, adapter, config: testConfig(), lease, leaseManager });
    assert.deepEqual(results, [{ resourceName: 'dmon-run1-cache1', status: 'already-absent' }]);
    assert.deepEqual(ledger.activeResources(), []);
  });
});

test('reverseCleanup refuses to delete anything once the kill switch is engaged', async () => {
  await withTempLedger(async (ledger) => {
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    ledger.append('created', 'dmon-run1-cache1');
    const killSwitch = new KillSwitch({ path: '/tmp/engaged.killswitch', exists: () => true });
    const { leaseManager, lease } = exclusiveLeaseFor('cleanup');

    await assert.rejects(
      () => reverseCleanup({ ledger, adapter, config: testConfig(), killSwitch, lease, leaseManager }),
      KillSwitchEngaged
    );
    assert.equal(fake._clusters.size, 1);
  });
});

test('reverseCleanup never touches a resource outside the owner/run prefix, even if present in the ledger (isolation)', async () => {
  await withTempLedger(async (ledger) => {
    const fake = createFakeRp({ initialClusters: [{ name: 'other-owner-run9-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    ledger.append('created', 'other-owner-run9-cache1');
    const { leaseManager, lease } = exclusiveLeaseFor('cleanup');

    await assert.rejects(
      () => reverseCleanup({ ledger, adapter, config: testConfig(), lease, leaseManager }),
      GuardViolation
    );
    assert.equal(fake._clusters.size, 1); // untouched
  });
});

test('reverseCleanup honors the runtime denylist even for owned resources', async () => {
  await withTempLedger(async (ledger) => {
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-locked-cache' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    ledger.append('created', 'dmon-run1-locked-cache');
    const { leaseManager, lease } = exclusiveLeaseFor('cleanup');

    await assert.rejects(
      () =>
        reverseCleanup({
          ledger,
          adapter,
          config: testConfig({ denylist: ['dmon-run1-locked*'] }),
          lease,
          leaseManager,
        }),
      GuardViolation
    );
  });
});

test('reverseCleanup requires config + a lease and leaseManager for real (non-dry-run) mutations', async () => {
  await withTempLedger(async (ledger) => {
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    ledger.append('created', 'dmon-run1-cache1');

    await assert.rejects(() => reverseCleanup({ ledger, adapter, config: testConfig() }), CleanupError);
  });
});

test('reverseCleanup rejects a shared (read-only) lease -- write mutations require exclusive', async () => {
  await withTempLedger(async (ledger) => {
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    ledger.append('created', 'dmon-run1-cache1');
    const leaseManager = new LeaseManager();
    const lease = leaseManager.acquire({ class: 'shared' });

    await assert.rejects(
      () => reverseCleanup({ ledger, adapter, config: testConfig(), lease, leaseManager }),
      LeaseNotAuthorized
    );
    assert.equal(fake._clusters.size, 1); // untouched
  });
});

test('reverseCleanup rejects a stale fencing token: an owner that lost its lease cannot keep deleting', async () => {
  await withTempLedger(async (ledger) => {
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    ledger.append('created', 'dmon-run1-cache1');

    let now = 1000;
    const leaseManager = new LeaseManager({ now: () => now });
    const lease = leaseManager.acquire({ class: 'exclusive', ttlMs: 100 });
    now += 200; // lease has now expired and will be reaped on next access

    await assert.rejects(
      () => reverseCleanup({ ledger, adapter, config: testConfig(), lease, leaseManager }),
      FencingTokenStale
    );
    assert.equal(fake._clusters.size, 1); // untouched
  });
});

test('reverseCleanup dry-run mode reports intended deletions without mutating anything or requiring a lease', async () => {
  await withTempLedger(async (ledger) => {
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }, { name: 'dmon-run1-cache2' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    ledger.append('created', 'dmon-run1-cache1');
    ledger.append('created', 'dmon-run1-cache2');

    const results = await reverseCleanup({ ledger, adapter, config: testConfig(), dryRun: true });
    assert.deepEqual(
      results.map((r) => r.status),
      ['dry-run', 'dry-run']
    );
    assert.equal(fake._clusters.size, 2); // nothing actually deleted
    assert.deepEqual(ledger.activeResources(), ['dmon-run1-cache1', 'dmon-run1-cache2']); // ledger unchanged
  });
});

test('reverseCleanup circuit breaker trips (fail closed) when a run would exceed the max-delete cap', async () => {
  await withTempLedger(async (ledger) => {
    const names = Array.from({ length: DEFAULT_MAX_DELETES_PER_RUN + 1 }, (_, i) => `dmon-run1-cache${i}`);
    const fake = createFakeRp({ initialClusters: names.map((name) => ({ name })) });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    for (const name of names) ledger.append('created', name);
    const { leaseManager, lease } = exclusiveLeaseFor('cleanup');

    await assert.rejects(
      () => reverseCleanup({ ledger, adapter, config: testConfig(), lease, leaseManager }),
      CircuitBreakerTripped
    );
    assert.equal(fake._clusters.size, names.length); // nothing deleted -- tripped before any mutation
  });
});

test('reverseCleanup circuit breaker can be explicitly overridden after manual review', async () => {
  await withTempLedger(async (ledger) => {
    const names = Array.from({ length: DEFAULT_MAX_DELETES_PER_RUN + 1 }, (_, i) => `dmon-run1-cache${i}`);
    const fake = createFakeRp({ initialClusters: names.map((name) => ({ name })) });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    for (const name of names) ledger.append('created', name);
    const { leaseManager, lease } = exclusiveLeaseFor('cleanup');

    const results = await reverseCleanup({
      ledger,
      adapter,
      config: testConfig(),
      lease,
      leaseManager,
      allowExceedCircuitBreaker: true,
    });
    assert.equal(results.length, names.length);
    assert.equal(fake._clusters.size, 0);
  });
});

test('reverseCleanup polls the real DELETE contract (no fake "/operations" API) to terminal absence', async () => {
  await withTempLedger(async (ledger) => {
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }], pollsUntilDeleteComplete: 2 });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    ledger.append('created', 'dmon-run1-cache1');
    const { leaseManager, lease } = exclusiveLeaseFor('cleanup');

    const results = await reverseCleanup({
      ledger,
      adapter,
      config: testConfig(),
      lease,
      leaseManager,
      pollTerminal: (opts) => import('../../src/cache/reconciliation.mjs').then((m) => m.pollUntilTerminal({ ...opts, intervalMs: 1, sleep: async () => {} })),
    });
    assert.deepEqual(results, [{ resourceName: 'dmon-run1-cache1', status: 'deleted' }]);
    assert.equal(fake._clusters.has('dmon-run1-cache1'), false);
  });
});

test('reverseCleanup preserves a delete that reaches a terminal Failed state for future reconciliation', async () => {
  await withTempLedger(async (ledger) => {
    // A large pollsUntilDeleteComplete keeps the fake's cluster present (in
    // "Deleting") rather than actually removing it, so the override below
    // can substitute a terminal "Failed" state instead.
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }], pollsUntilDeleteComplete: 100 });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    ledger.append('created', 'dmon-run1-cache1');
    const { leaseManager, lease } = exclusiveLeaseFor('cleanup');

    // Simulate the RP reporting the delete ultimately failed rather than
    // completing -- the resource stays present.
    const originalGetCluster = adapter.getCluster.bind(adapter);
    adapter.getCluster = async (...args) => ({ ...(await originalGetCluster(...args)), properties: { provisioningState: 'Failed' } });

    const results = await reverseCleanup({ ledger, adapter, config: testConfig(), lease, leaseManager });
    assert.deepEqual(results, [{ resourceName: 'dmon-run1-cache1', status: 'failed-pending-retry', state: 'Failed' }]);
    // The ledger must still consider this resource active for a future retry.
    assert.deepEqual(ledger.activeResources(), ['dmon-run1-cache1']);
  });
});

test('deleteOwnedResource can be used standalone (e.g. by the janitor) with the same verified-delete guarantees', async () => {
  await withTempLedger(async (ledger) => {
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    ledger.append('created', 'dmon-run1-cache1');
    const { leaseManager, lease } = exclusiveLeaseFor('dmon-run1-cache1');

    const result = await deleteOwnedResource({
      ledger,
      adapter,
      resourceName: 'dmon-run1-cache1',
      context: { config: testConfig(), lease, leaseManager },
    });
    assert.deepEqual(result, { resourceName: 'dmon-run1-cache1', status: 'deleted' });
    assert.deepEqual(ledger.activeResources(), []);
  });
});
