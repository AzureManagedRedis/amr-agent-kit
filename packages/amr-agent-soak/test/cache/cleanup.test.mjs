import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResourceLedger } from '../../src/cache/ledger.mjs';
import { LocalRpHttpAdapter } from '../../src/cache/http-adapter.mjs';
import { KillSwitch, KillSwitchEngaged } from '../../src/cache/kill-switch.mjs';
import { reverseCleanup } from '../../src/cache/cleanup.mjs';
import { GuardViolation } from '../../src/cache/guards.mjs';
import { createFakeRp } from './fakes/fake-rp.mjs';

async function withTempLedger(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'amr-soak-cleanup-'));
  try {
    return await fn(new ResourceLedger({ path: join(dir, 'ledger.jsonl') }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('reverseCleanup tears down resources in reverse (LIFO) creation order', async () => {
  await withTempLedger(async (ledger) => {
    const fake = createFakeRp({
      initialCaches: [{ name: 'dmon-run1-cache1' }, { name: 'dmon-run1-cache2' }, { name: 'dmon-run1-cache3' }],
    });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    ledger.append('created', 'dmon-run1-cache1');
    ledger.append('created', 'dmon-run1-cache2');
    ledger.append('created', 'dmon-run1-cache3');

    const results = await reverseCleanup({ ledger, adapter, resourcePrefix: 'dmon-run1-' });
    assert.deepEqual(
      results.map((r) => r.resourceName),
      ['dmon-run1-cache3', 'dmon-run1-cache2', 'dmon-run1-cache1']
    );
    assert.ok(results.every((r) => r.status === 'deleted'));
    assert.equal(fake._caches.size, 0);
  });
});

test('reverseCleanup is idempotent: a second run finds nothing left to delete', async () => {
  await withTempLedger(async (ledger) => {
    const fake = createFakeRp({ initialCaches: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    ledger.append('created', 'dmon-run1-cache1');

    const first = await reverseCleanup({ ledger, adapter, resourcePrefix: 'dmon-run1-' });
    assert.deepEqual(first.map((r) => r.status), ['deleted']);

    const second = await reverseCleanup({ ledger, adapter, resourcePrefix: 'dmon-run1-' });
    assert.deepEqual(second, []); // nothing active left in the ledger to clean up
  });
});

test('reverseCleanup treats an already-absent resource as idempotent success, not a failure', async () => {
  await withTempLedger(async (ledger) => {
    const fake = createFakeRp({}); // RP already empty, but the ledger still thinks it's active.
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    ledger.append('created', 'dmon-run1-cache1');

    const results = await reverseCleanup({ ledger, adapter, resourcePrefix: 'dmon-run1-' });
    assert.deepEqual(results, [{ resourceName: 'dmon-run1-cache1', status: 'already-absent' }]);
    assert.deepEqual(ledger.activeResources(), []);
  });
});

test('reverseCleanup refuses to delete anything once the kill switch is engaged', async () => {
  await withTempLedger(async (ledger) => {
    const fake = createFakeRp({ initialCaches: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    ledger.append('created', 'dmon-run1-cache1');
    const killSwitch = new KillSwitch({ path: '/tmp/engaged.killswitch', exists: () => true });

    await assert.rejects(
      () => reverseCleanup({ ledger, adapter, resourcePrefix: 'dmon-run1-', killSwitch }),
      KillSwitchEngaged
    );
    // Nothing was deleted.
    assert.equal(fake._caches.size, 1);
  });
});

test('reverseCleanup never touches a resource outside the owner/run prefix, even if present in the ledger (isolation)', async () => {
  await withTempLedger(async (ledger) => {
    const fake = createFakeRp({ initialCaches: [{ name: 'other-owner-run9-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    ledger.append('created', 'other-owner-run9-cache1');

    await assert.rejects(
      () => reverseCleanup({ ledger, adapter, resourcePrefix: 'dmon-run1-' }),
      GuardViolation
    );
    assert.equal(fake._caches.size, 1); // untouched
  });
});

test('reverseCleanup honors the runtime denylist even for owned resources', async () => {
  await withTempLedger(async (ledger) => {
    const fake = createFakeRp({ initialCaches: [{ name: 'dmon-run1-locked-cache' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    ledger.append('created', 'dmon-run1-locked-cache');

    await assert.rejects(
      () => reverseCleanup({ ledger, adapter, resourcePrefix: 'dmon-run1-', denylist: ['dmon-run1-locked*'] }),
      GuardViolation
    );
  });
});
