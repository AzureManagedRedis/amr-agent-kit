import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResourceLedger } from '../../src/cache/ledger.mjs';
import { LocalRpHttpAdapter } from '../../src/cache/http-adapter.mjs';
import { LeaseManager } from '../../src/cache/lease-manager.mjs';
import { createOwnedCache, ProvisioningError, MAX_LIVE_RESOURCES } from '../../src/cache/provisioning.mjs';
import { createFakeRp } from './fakes/fake-rp.mjs';

async function withTempLedger(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'amr-soak-provisioning-'));
  try {
    return await fn(new ResourceLedger({ path: join(dir, 'ledger.jsonl') }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function testConfig(overrides = {}) {
  return {
    resourcePrefix: 'dmon-run1-',
    denylist: [],
    ownerAlias: 'dmon',
    runId: 'run1',
    acknowledgedCustomerSubscription: true,
    ...overrides,
  };
}

function exclusiveLease() {
  const leaseManager = new LeaseManager();
  const lease = leaseManager.acquire({ class: 'exclusive' });
  return { leaseManager, lease };
}

test('createOwnedCache records durable creation-intent BEFORE calling the RP, then confirms with created', async () => {
  await withTempLedger(async (ledger) => {
    const fake = createFakeRp({});
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    const { leaseManager, lease } = exclusiveLease();

    const result = await createOwnedCache({
      ledger,
      adapter,
      resourceName: 'dmon-run1-cache1',
      spec: { sku: 'B1' },
      config: testConfig(),
      lease,
      leaseManager,
    });

    assert.equal(result.resourceName, 'dmon-run1-cache1');
    assert.equal(result.tags.Owner, 'dmon');
    assert.equal(result.tags.SoakRunId, 'run1');
    assert.ok(result.tags.CreatedOn);
    assert.ok(result.tags.ExpiresOn);

    const records = ledger.readAll().filter((r) => r.resourceName === 'dmon-run1-cache1');
    assert.deepEqual(records.map((r) => r.action), ['creation-intent', 'created']);
    assert.equal(fake._caches.has('dmon-run1-cache1'), true);
  });
});

test('createOwnedCache refuses a resourceName outside the configured prefix', async () => {
  await withTempLedger(async (ledger) => {
    const fake = createFakeRp({});
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    const { leaseManager, lease } = exclusiveLease();

    await assert.rejects(
      () =>
        createOwnedCache({
          ledger,
          adapter,
          resourceName: 'other-owner-cache1',
          config: testConfig(),
          lease,
          leaseManager,
        }),
      ProvisioningError
    );
    assert.equal(fake._caches.size, 0);
  });
});

test('createOwnedCache leaves intent recorded (but not confirmed) if the RP call fails', async () => {
  await withTempLedger(async (ledger) => {
    const fake = createFakeRp({});
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    adapter.createCache = async () => {
      throw new Error('simulated RP failure');
    };
    const { leaseManager, lease } = exclusiveLease();

    await assert.rejects(
      () =>
        createOwnedCache({
          ledger,
          adapter,
          resourceName: 'dmon-run1-cache1',
          config: testConfig(),
          lease,
          leaseManager,
        }),
      ProvisioningError
    );

    assert.equal(ledger.isIntentOnly('dmon-run1-cache1'), true);
    assert.deepEqual(ledger.activeResources(), ['dmon-run1-cache1']); // reserved, retryable/reconcilable
  });
});

// ---- Finding #8: six-cache admission is ledger-confirmed, atomic, and independent of lease count ----

test('the seventh ledger-confirmed live resource is refused even though lease capacity is available', async () => {
  await withTempLedger(async (ledger) => {
    for (let i = 0; i < MAX_LIVE_RESOURCES; i += 1) {
      ledger.append('created', `dmon-run1-cache${i}`);
    }
    const fake = createFakeRp({});
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    const { leaseManager, lease } = exclusiveLease(); // plenty of lease capacity; irrelevant to this cap

    await assert.rejects(
      () =>
        createOwnedCache({
          ledger,
          adapter,
          resourceName: 'dmon-run1-cache-seventh',
          config: testConfig(),
          lease,
          leaseManager,
        }),
      ProvisioningError
    );
    assert.equal(fake._caches.size, 0); // never attempted
  });
});

test('releasing a lease does NOT free resource capacity -- only a ledger-confirmed delete does', async () => {
  await withTempLedger(async (ledger) => {
    for (let i = 0; i < MAX_LIVE_RESOURCES; i += 1) {
      ledger.append('created', `dmon-run1-cache${i}`);
    }
    const fake = createFakeRp({});
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    const leaseManager = new LeaseManager();
    const lease = leaseManager.acquire({ class: 'exclusive' });
    leaseManager.release(lease.id); // releasing the lease changes nothing about resource capacity
    const lease2 = leaseManager.acquire({ class: 'exclusive' });

    await assert.rejects(
      () =>
        createOwnedCache({
          ledger,
          adapter,
          resourceName: 'dmon-run1-cache-seventh',
          config: testConfig(),
          lease: lease2,
          leaseManager,
        }),
      ProvisioningError
    );

    // Only after an actual ledger 'deleted' event does capacity free up.
    ledger.append('deleted', 'dmon-run1-cache0');
    await assert.doesNotReject(() =>
      createOwnedCache({
        ledger,
        adapter,
        resourceName: 'dmon-run1-cache-seventh',
        config: testConfig(),
        lease: lease2,
        leaseManager,
      })
    );
  });
});

test('createOwnedCache admission check is not fooled by acquiring/releasing many leases without any ledger-confirmed resources', async () => {
  await withTempLedger(async (ledger) => {
    const fake = createFakeRp({});
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    const leaseManager = new LeaseManager();
    // Acquire and release many leases -- none of this touches the ledger.
    for (let i = 0; i < 20; i += 1) {
      const l = leaseManager.acquire({ class: 'shared' });
      leaseManager.release(l.id);
    }
    const lease = leaseManager.acquire({ class: 'exclusive' });

    await assert.doesNotReject(() =>
      createOwnedCache({ ledger, adapter, resourceName: 'dmon-run1-cache1', config: testConfig(), lease, leaseManager })
    );
  });
});

test('createOwnedCache respects a dryRunOnly classification: no real create, no live resource, but tags/ledger still recorded', async () => {
  await withTempLedger(async (ledger) => {
    const fake = createFakeRp({});
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    const { leaseManager, lease } = exclusiveLease();

    const result = await createOwnedCache({
      ledger,
      adapter,
      resourceName: 'dmon-run1-cache1',
      config: testConfig(),
      lease,
      leaseManager,
      dryRunOnly: true,
    });

    assert.equal(result.response.simulated, true);
    assert.equal(fake._caches.size, 0); // no real resource created
    const records = ledger.readAll().filter((r) => r.resourceName === 'dmon-run1-cache1');
    assert.deepEqual(records.map((r) => r.action), ['creation-intent', 'created']);
  });
});
