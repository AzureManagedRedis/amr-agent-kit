import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResourceLedger } from '../../src/cache/ledger.mjs';
import { LocalRpHttpAdapter } from '../../src/cache/http-adapter.mjs';
import { reconcileOnStartup, pollUntilTerminal, ReconciliationError } from '../../src/cache/reconciliation.mjs';
import { GuardViolation } from '../../src/cache/guards.mjs';
import { buildResourceTags } from '../../src/cache/tags.mjs';
import { LeaseManager } from '../../src/cache/lease-manager.mjs';
import { createFakeRp } from './fakes/fake-rp.mjs';

async function withTempLedger(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'amr-soak-reconcile-'));
  try {
    return await fn(new ResourceLedger({ path: join(dir, 'ledger.jsonl') }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function testContext(overrides = {}) {
  const leaseManager = overrides.leaseManager ?? new LeaseManager();
  const lease = overrides.lease ?? leaseManager.acquire({ class: 'exclusive' });
  return {
    config: { resourcePrefix: 'dmon-run1-', denylist: [], acknowledgedCustomerSubscription: true, ...overrides.config },
    lease,
    leaseManager,
  };
}

// ---- Finding #2: adoption requires durable pre-create intent/operation evidence ----

test('a prefix-matching live resource with ZERO ledger evidence is unconditionally quarantined, never adopted', async () => {
  await withTempLedger(async (ledger) => {
    // Exists on the RP, matches our prefix, but this run's ledger has never
    // heard of it at all -- no intent, no created record. A name match
    // alone must never be treated as evidence.
    const fake = createFakeRp({ initialCaches: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const report = await reconcileOnStartup({ ledger, adapter, resourcePrefix: 'dmon-run1-' });
    assert.deepEqual(report.confirmedIntents, []);
    assert.deepEqual(report.quarantined, [{ resourceName: 'dmon-run1-cache1', reason: 'no-creation-intent-evidence' }]);
    assert.deepEqual(ledger.activeResources(), []); // never adopted/tracked
  });
});

test('a prefix-matching live resource with durable creation-intent evidence is safely confirmed (crash recovery)', async () => {
  await withTempLedger(async (ledger) => {
    // Simulate: the create orchestrator durably recorded intent before
    // calling the RP, the RP call succeeded, but the process crashed before
    // the confirming 'created' ledger append ran.
    ledger.append('creation-intent', 'dmon-run1-cache1', {});
    const fake = createFakeRp({ initialCaches: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const report = await reconcileOnStartup({ ledger, adapter, resourcePrefix: 'dmon-run1-' });
    assert.deepEqual(report.confirmedIntents, ['dmon-run1-cache1']);
    assert.deepEqual(report.quarantined, []);
    assert.deepEqual(ledger.activeResources(), ['dmon-run1-cache1']);
    assert.equal(ledger.isIntentOnly('dmon-run1-cache1'), false); // now confirmed 'created'
  });
});

test('a resource already fully confirmed created is left untouched (no duplicate ledger entries)', async () => {
  await withTempLedger(async (ledger) => {
    ledger.append('creation-intent', 'dmon-run1-cache1', {});
    ledger.append('created', 'dmon-run1-cache1', {});
    const fake = createFakeRp({ initialCaches: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const report = await reconcileOnStartup({ ledger, adapter, resourcePrefix: 'dmon-run1-' });
    assert.deepEqual(report.confirmedIntents, []);
    assert.deepEqual(report.quarantined, []);
    assert.equal(ledger.readAll().filter((r) => r.resourceName === 'dmon-run1-cache1').length, 2);
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
    ledger.append('creation-intent', 'dmon-run1-cache1', {});
    const fake = createFakeRp({ initialCaches: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const first = await reconcileOnStartup({ ledger, adapter, resourcePrefix: 'dmon-run1-' });
    assert.deepEqual(first.confirmedIntents, ['dmon-run1-cache1']);

    const second = await reconcileOnStartup({ ledger, adapter, resourcePrefix: 'dmon-run1-' });
    assert.deepEqual(second.confirmedIntents, []);
    assert.deepEqual(second.reconciledDeletions, []);
    assert.deepEqual(second.quarantined, []);
  });
});

test('reconciliation never adopts/touches a live resource outside our own prefix (isolation)', async () => {
  await withTempLedger(async (ledger) => {
    ledger.append('creation-intent', 'dmon-run1-cache1', {});
    const fake = createFakeRp({ initialCaches: [{ name: 'other-owner-run9-cache1' }, { name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const report = await reconcileOnStartup({ ledger, adapter, resourcePrefix: 'dmon-run1-' });
    assert.deepEqual(report.confirmedIntents, ['dmon-run1-cache1']);
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

// ---- Tag-based eligibility layered on top of durable intent evidence ----

test('tag-based eligibility: intent-evidenced resource with valid ownership tags is confirmed normally', async () => {
  await withTempLedger(async (ledger) => {
    ledger.append('creation-intent', 'dmon-run1-cache1', {});
    const tags = buildResourceTags({ ownerAlias: 'dmon', runId: 'run1', expiresInMs: 3600000 });
    const fake = createFakeRp({ initialCaches: [{ name: 'dmon-run1-cache1', tags }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const report = await reconcileOnStartup({
      ledger,
      adapter,
      resourcePrefix: 'dmon-run1-',
      ownerAlias: 'dmon',
      runId: 'run1',
    });
    assert.deepEqual(report.confirmedIntents, ['dmon-run1-cache1']);
    assert.deepEqual(report.quarantined, []);
  });
});

test('tag-based eligibility: missing CreatedOn quarantines an intent-evidenced resource too (fail-closed)', async () => {
  await withTempLedger(async (ledger) => {
    ledger.append('creation-intent', 'dmon-run1-cache1', {});
    const fake = createFakeRp({
      initialCaches: [{ name: 'dmon-run1-cache1', tags: { Owner: 'dmon', SoakRunId: 'run1' } }],
    });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const report = await reconcileOnStartup({
      ledger,
      adapter,
      resourcePrefix: 'dmon-run1-',
      ownerAlias: 'dmon',
      runId: 'run1',
    });
    assert.deepEqual(report.confirmedIntents, []);
    assert.deepEqual(report.quarantined, [{ resourceName: 'dmon-run1-cache1', reason: 'missing-createdon-fail-closed' }]);
    // Still intent-only (never confirmed 'created') -- quarantine leaves it exactly as it was.
    assert.equal(ledger.isIntentOnly('dmon-run1-cache1'), true);
  });
});

test('tag-based eligibility: an ownership-tag mismatch quarantines even with intent evidence present', async () => {
  await withTempLedger(async (ledger) => {
    ledger.append('creation-intent', 'dmon-run1-cache1', {});
    const tags = buildResourceTags({ ownerAlias: 'someone-else', runId: 'run9', expiresInMs: 3600000 });
    const fake = createFakeRp({ initialCaches: [{ name: 'dmon-run1-cache1', tags }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const report = await reconcileOnStartup({
      ledger,
      adapter,
      resourcePrefix: 'dmon-run1-',
      ownerAlias: 'dmon',
      runId: 'run1',
    });
    assert.deepEqual(report.confirmedIntents, []);
    assert.equal(report.quarantined[0].reason, 'ownership-tag-mismatch');
  });
});

test('tag-based eligibility: an explicitly persistent-tagged resource is never confirmed, regardless of intent evidence', async () => {
  await withTempLedger(async (ledger) => {
    ledger.append('creation-intent', 'dmon-run1-cache1', {});
    const tags = buildResourceTags({
      ownerAlias: 'dmon',
      runId: 'run1',
      expiresInMs: 3600000,
      extraTags: { Persistent: true },
    });
    const fake = createFakeRp({ initialCaches: [{ name: 'dmon-run1-cache1', tags }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const report = await reconcileOnStartup({
      ledger,
      adapter,
      resourcePrefix: 'dmon-run1-',
      ownerAlias: 'dmon',
      runId: 'run1',
    });
    assert.deepEqual(report.confirmedIntents, []);
    assert.equal(report.quarantined[0].reason, 'marked-persistent');
  });
});

test('tag-based eligibility is opt-in: without ownerAlias/runId, intent-evidenced resources are still confirmed', async () => {
  await withTempLedger(async (ledger) => {
    ledger.append('creation-intent', 'dmon-run1-cache1', {});
    const fake = createFakeRp({ initialCaches: [{ name: 'dmon-run1-cache1' }] }); // no tags at all
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const report = await reconcileOnStartup({ ledger, adapter, resourcePrefix: 'dmon-run1-' });
    assert.deepEqual(report.confirmedIntents, ['dmon-run1-cache1']);
    assert.deepEqual(report.quarantined, []);
  });
});

// ---- pollUntilTerminal ----

test('pollUntilTerminal polls with backoff until a terminal state is reached', async () => {
  const fake = createFakeRp({});
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  const context = testContext();
  await adapter.createCache('dmon-run1-cache1', {}, context);
  const patchResult = await adapter.patchCacheTopology('dmon-run1-cache1', { topology: 'cluster' }, context);

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

// ---- Finding #11: AbortController-bounded polling ----

test('pollUntilTerminal bounds a single hung request so it can never let the overall poll exceed its deadline', async () => {
  const hangingAdapter = {
    getOperationStatus: (id, { signal } = {}) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
        // Never resolves on its own -- only the AbortSignal can end it.
      }),
  };
  const start = Date.now();
  await assert.rejects(
    () =>
      pollUntilTerminal({
        adapter: hangingAdapter,
        operationId: 'op-x',
        timeoutMs: 100,
        perRequestTimeoutMs: 25,
        intervalMs: 5,
        sleep: async () => {},
      }),
    ReconciliationError
  );
  assert.ok(Date.now() - start < 2000, 'a hung individual request must not make the overall poll hang indefinitely');
});

test('pollUntilTerminal recovers from a single aborted request and succeeds once a later request responds', async () => {
  let callCount = 0;
  const flakyAdapter = {
    getOperationStatus: (id, { signal } = {}) => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }
      return Promise.resolve({ state: 'Succeeded' });
    },
  };
  const status = await pollUntilTerminal({
    adapter: flakyAdapter,
    operationId: 'op-y',
    timeoutMs: 5000,
    perRequestTimeoutMs: 20,
    intervalMs: 5,
    sleep: async () => {},
  });
  assert.equal(status.state, 'Succeeded');
  assert.ok(callCount >= 2);
});
