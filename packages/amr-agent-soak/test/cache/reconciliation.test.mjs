import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResourceLedger } from '../../src/cache/ledger.mjs';
import { LocalRpHttpAdapter } from '../../src/cache/http-adapter.mjs';
import { reconcileOnStartup, pollUntilTerminal, ReconciliationError } from '../../src/cache/reconciliation.mjs';
import { GuardViolation } from '../../src/cache/guards.mjs';
import { createFakeRp } from './fakes/fake-rp.mjs';

async function withTempLedger(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'amr-soak-reconcile-'));
  try {
    return await fn(new ResourceLedger({ path: join(dir, 'ledger.jsonl') }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('crash reconciliation: RP has a resource under our prefix that the ledger never recorded (adopted as orphan)', async () => {
  await withTempLedger(async (ledger) => {
    // Simulate: adapter.createCache() succeeded against the RP, but the
    // process crashed before ledger.append('created', ...) ran.
    const fake = createFakeRp({ initialCaches: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const report = await reconcileOnStartup({ ledger, adapter, resourcePrefix: 'dmon-run1-' });
    assert.deepEqual(report.adoptedOrphans, ['dmon-run1-cache1']);
    assert.deepEqual(ledger.activeResources(), ['dmon-run1-cache1']);
  });
});

test('crash reconciliation: ledger believes a resource is active but the RP no longer has it', async () => {
  await withTempLedger(async (ledger) => {
    ledger.append('created', 'dmon-run1-cache1');
    const fake = createFakeRp({}); // RP has nothing.
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const report = await reconcileOnStartup({ ledger, adapter, resourcePrefix: 'dmon-run1-' });
    assert.deepEqual(report.reconciledDeletions, ['dmon-run1-cache1']);
    assert.deepEqual(ledger.activeResources(), []);
  });
});

test('reconciliation is idempotent: running it twice in a row produces no further changes', async () => {
  await withTempLedger(async (ledger) => {
    const fake = createFakeRp({ initialCaches: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    await reconcileOnStartup({ ledger, adapter, resourcePrefix: 'dmon-run1-' });
    const second = await reconcileOnStartup({ ledger, adapter, resourcePrefix: 'dmon-run1-' });
    assert.deepEqual(second.adoptedOrphans, []);
    assert.deepEqual(second.reconciledDeletions, []);
  });
});

test('reconciliation never adopts/touches a live resource outside our own prefix (isolation)', async () => {
  await withTempLedger(async (ledger) => {
    const fake = createFakeRp({ initialCaches: [{ name: 'other-owner-run9-cache1' }, { name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const report = await reconcileOnStartup({ ledger, adapter, resourcePrefix: 'dmon-run1-' });
    assert.deepEqual(report.adoptedOrphans, ['dmon-run1-cache1']);
    assert.ok(!ledger.activeResources().includes('other-owner-run9-cache1'));
  });
});

test('reconciliation refuses (defense in depth) if it is ever asked to reconcile a ledger entry outside the prefix', async () => {
  await withTempLedger(async (ledger) => {
    ledger.append('created', 'someone-elses-cache');
    const fake = createFakeRp({ initialCaches: [{ name: 'someone-elses-cache' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    await assert.rejects(() => reconcileOnStartup({ ledger, adapter, resourcePrefix: 'dmon-run1-' }), GuardViolation);
  });
});

test('pollUntilTerminal polls with backoff until a terminal state is reached', async () => {
  const fake = createFakeRp({});
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  await adapter.createCache('dmon-run1-cache1', {});
  const patchResult = await adapter.patchCacheTopology('dmon-run1-cache1', { topology: 'cluster' });

  const sleeps = [];
  const status = await pollUntilTerminal({
    adapter,
    operationId: patchResult.operationId,
    intervalMs: 10,
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.equal(status.state, 'Succeeded');
  assert.ok(sleeps.length >= 1);
});

test('pollUntilTerminal throws ReconciliationError on timeout', async () => {
  const adapter = {
    getOperationStatus: async () => ({ state: 'Running' }),
  };
  await assert.rejects(
    () =>
      pollUntilTerminal({
        adapter,
        operationId: 'op-forever',
        intervalMs: 5,
        timeoutMs: 15,
        sleep: async () => {},
      }),
    ReconciliationError
  );
});
