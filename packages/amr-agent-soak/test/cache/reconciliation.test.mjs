import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResourceLedger } from '../../src/cache/ledger.mjs';
import { LocalRpHttpAdapter } from '../../src/cache/http-adapter.mjs';
import {
  reconcileOnStartup,
  pollUntilTerminal,
  buildResourceProvisioningStateCheck,
  buildDeletionCheck,
  buildAsyncOperationCheck,
  confirmCandidateLiveness,
  ReconciliationError,
} from '../../src/cache/reconciliation.mjs';
import { GuardViolation } from '../../src/cache/guards.mjs';
import { buildResourceTags } from '../../src/cache/tags.mjs';
import { LeaseManager } from '../../src/cache/lease-manager.mjs';
import { createFakeRp } from './fakes/fake-rp.mjs';

const SUBSCRIPTION_ID = '11111111-2222-3333-4444-555555555555';

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
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const report = await reconcileOnStartup({ ledger, adapter, subscriptionId: SUBSCRIPTION_ID, resourcePrefix: 'dmon-run1-' });
    assert.deepEqual(report.confirmedIntents, []);
    assert.deepEqual(report.quarantined, [{ resourceName: 'dmon-run1-cache1', reason: 'no-creation-intent-evidence' }]);
    assert.deepEqual(ledger.activeResources(), []); // never adopted/tracked
  });
});

// ---- Final launch-blocking finding: a stale list "ghost" (already 404 on
// direct GET) must never be quarantined as an unrecognized live resource ----

test('confirmCandidateLiveness classifies a 404 GET as absent', async () => {
  const getResource = async () => {
    const err = new Error('not found');
    err.status = 404;
    throw err;
  };
  assert.equal(await confirmCandidateLiveness(getResource), 'absent');
});

test('confirmCandidateLiveness classifies a terminal "Deleted" provisioningState as absent', async () => {
  const getResource = async () => ({ properties: { provisioningState: 'Deleted' } });
  assert.equal(await confirmCandidateLiveness(getResource), 'absent');
});

test('confirmCandidateLiveness classifies any other successful response as live', async () => {
  const getResource = async () => ({ properties: { provisioningState: 'Deleting' } });
  assert.equal(await confirmCandidateLiveness(getResource), 'live');
  const getResourceSucceeded = async () => ({ properties: { provisioningState: 'Succeeded' } });
  assert.equal(await confirmCandidateLiveness(getResourceSucceeded), 'live');
});

test('confirmCandidateLiveness classifies a non-404 error (network/timeout) as ambiguous, not absent', async () => {
  const getResource = async () => {
    throw new Error('simulated network failure');
  };
  assert.equal(await confirmCandidateLiveness(getResource), 'ambiguous');

  const getResourceTimeout = async () => {
    const err = new Error('timed out');
    err.name = 'AbortError';
    throw err;
  };
  assert.equal(await confirmCandidateLiveness(getResourceTimeout), 'ambiguous');
});

test('reconcileOnStartup does NOT quarantine a stale list "ghost" that direct GET confirms is already gone (404)', async () => {
  await withTempLedger(async (ledger) => {
    // No creation-intent evidence at all for this name (a real orphan
    // candidate), but the list response is stale: it still reports the
    // resource in "Deleting" even though it does not really exist any
    // more (the fake's `clusters` map has no such entry -- a direct GET
    // 404s, exactly like the real observed local-RP bug).
    const fake = createFakeRp({ staleListGhosts: [{ name: 'dmon-run1-ghost-cache' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const report = await reconcileOnStartup({ ledger, adapter, subscriptionId: SUBSCRIPTION_ID, resourcePrefix: 'dmon-run1-' });
    assert.deepEqual(report.quarantined, []); // never reported -- it doesn't really exist
    assert.deepEqual(ledger.activeResources(), []);
  });
});

test('reconcileOnStartup DOES quarantine a genuinely live resource with zero ledger evidence, confirmed by both list and direct GET', async () => {
  await withTempLedger(async (ledger) => {
    // Present in BOTH the list response AND the underlying clusters map --
    // a direct GET confirms it is genuinely live, so it must still be
    // quarantined (reported, never adopted).
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-real-orphan' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const report = await reconcileOnStartup({ ledger, adapter, subscriptionId: SUBSCRIPTION_ID, resourcePrefix: 'dmon-run1-' });
    assert.deepEqual(report.quarantined, [{ resourceName: 'dmon-run1-real-orphan', reason: 'no-creation-intent-evidence' }]);
  });
});

test('a prefix-matching live resource with durable creation-intent evidence is safely confirmed (crash recovery)', async () => {
  await withTempLedger(async (ledger) => {
    ledger.append('creation-intent', 'dmon-run1-cache1', {});
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const report = await reconcileOnStartup({ ledger, adapter, subscriptionId: SUBSCRIPTION_ID, resourcePrefix: 'dmon-run1-' });
    assert.deepEqual(report.confirmedIntents, ['dmon-run1-cache1']);
    assert.deepEqual(report.quarantined, []);
    assert.deepEqual(ledger.activeResources(), ['dmon-run1-cache1']);
    assert.equal(ledger.isIntentOnly('dmon-run1-cache1'), false);
  });
});

// ---- Second live-blocking finding: intent reconciliation must confirm the
// ACTUAL direct resource state before ever appending 'created' -- a create
// that never reached Succeeded (still Creating/Updating past a long real
// local-RP provisioning window, or one that terminally Failed/Canceled)
// must never be fabricated as confirmed-created ----

test('reconcileOnStartup confirms Succeeded intent as created (explicit terminal-state confirmation, not just list trust)', async () => {
  await withTempLedger(async (ledger) => {
    ledger.append('creation-intent', 'dmon-run1-cache1', {});
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1', properties: { provisioningState: 'Succeeded' } }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const report = await reconcileOnStartup({ ledger, adapter, subscriptionId: SUBSCRIPTION_ID, resourcePrefix: 'dmon-run1-' });
    assert.deepEqual(report.confirmedIntents, ['dmon-run1-cache1']);
    assert.deepEqual(report.creationFailed, []);
    assert.deepEqual(report.pending, []);
    assert.deepEqual(ledger.activeResources(), ['dmon-run1-cache1']);
  });
});

test('reconcileOnStartup marks a terminally Failed intent as creation-failed, never created -- frees the six-live slot', async () => {
  await withTempLedger(async (ledger) => {
    ledger.append('creation-intent', 'dmon-run1-cache1', {});
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1', properties: { provisioningState: 'Failed' } }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const report = await reconcileOnStartup({ ledger, adapter, subscriptionId: SUBSCRIPTION_ID, resourcePrefix: 'dmon-run1-' });
    assert.deepEqual(report.confirmedIntents, []);
    assert.deepEqual(report.creationFailed, ['dmon-run1-cache1']);
    assert.deepEqual(report.pending, []);
    assert.equal(ledger.hasCreationFailed('dmon-run1-cache1'), true);
    const records = ledger.readAll().filter((r) => r.resourceName === 'dmon-run1-cache1');
    assert.equal(records.some((r) => r.action === 'created'), false); // never fabricated as created
    assert.deepEqual(ledger.activeResources(), []); // six-live slot freed
  });
});

test('reconcileOnStartup marks a terminally Canceled intent as creation-failed, never created', async () => {
  await withTempLedger(async (ledger) => {
    ledger.append('creation-intent', 'dmon-run1-cache1', {});
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1', properties: { provisioningState: 'Canceled' } }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const report = await reconcileOnStartup({ ledger, adapter, subscriptionId: SUBSCRIPTION_ID, resourcePrefix: 'dmon-run1-' });
    assert.deepEqual(report.creationFailed, ['dmon-run1-cache1']);
    assert.equal(ledger.hasCreationFailed('dmon-run1-cache1'), true);
    assert.deepEqual(ledger.activeResources(), []);
  });
});

test('reconcileOnStartup treats a 404 on direct GET as a definitive creation-failed, never created', async () => {
  await withTempLedger(async (ledger) => {
    ledger.append('creation-intent', 'dmon-run1-cache1', {});
    // The resource genuinely never came up (no initialClusters at all --
    // a direct GET 404s), but the list response still reports it as a
    // stale "ghost" entry, so the intent-confirmation branch is reached.
    const fake = createFakeRp({ staleListGhosts: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const report = await reconcileOnStartup({ ledger, adapter, subscriptionId: SUBSCRIPTION_ID, resourcePrefix: 'dmon-run1-' });
    assert.deepEqual(report.creationFailed, ['dmon-run1-cache1']);
    assert.deepEqual(report.confirmedIntents, []);
    assert.equal(ledger.hasCreationFailed('dmon-run1-cache1'), true);
  });
});

test('reconcileOnStartup leaves a still-Creating (non-terminal) intent as pending -- never created, never creation-failed, still admission-active', async () => {
  await withTempLedger(async (ledger) => {
    ledger.append('creation-intent', 'dmon-run1-cache1', {});
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1', properties: { provisioningState: 'Creating' } }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const report = await reconcileOnStartup({ ledger, adapter, subscriptionId: SUBSCRIPTION_ID, resourcePrefix: 'dmon-run1-' });
    assert.deepEqual(report.confirmedIntents, []);
    assert.deepEqual(report.creationFailed, []);
    assert.deepEqual(report.pending, [{ resourceName: 'dmon-run1-cache1', state: 'Creating', classification: 'pending' }]);

    const records = ledger.readAll().filter((r) => r.resourceName === 'dmon-run1-cache1');
    assert.deepEqual(records.map((r) => r.action), ['creation-intent']); // no new ledger entry at all
    assert.equal(ledger.isIntentOnly('dmon-run1-cache1'), true);
    // Still admission-active (occupies a live-cap slot) and still eligible
    // for a future safe cleanup pass -- exactly as before reconciliation ran.
    assert.deepEqual(ledger.activeResources(), ['dmon-run1-cache1']);
  });
});

test('reconcileOnStartup leaves an intent pending (not created, not creation-failed) when the confirming GET fails ambiguously', async () => {
  await withTempLedger(async (ledger) => {
    ledger.append('creation-intent', 'dmon-run1-cache1', {});
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    adapter.getCluster = async () => {
      throw new Error('simulated transient network failure during intent confirmation');
    };

    const report = await reconcileOnStartup({ ledger, adapter, subscriptionId: SUBSCRIPTION_ID, resourcePrefix: 'dmon-run1-' });
    assert.deepEqual(report.confirmedIntents, []);
    assert.deepEqual(report.creationFailed, []);
    assert.deepEqual(report.pending, [{ resourceName: 'dmon-run1-cache1', state: null, classification: 'ambiguous' }]);
    assert.equal(ledger.isIntentOnly('dmon-run1-cache1'), true);
    assert.deepEqual(ledger.activeResources(), ['dmon-run1-cache1']); // still admission-active, still cleanable
  });
});

test('a resource already fully confirmed created is left untouched (no duplicate ledger entries)', async () => {
  await withTempLedger(async (ledger) => {
    ledger.append('creation-intent', 'dmon-run1-cache1', {});
    ledger.append('created', 'dmon-run1-cache1', {});
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const report = await reconcileOnStartup({ ledger, adapter, subscriptionId: SUBSCRIPTION_ID, resourcePrefix: 'dmon-run1-' });
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

    const report = await reconcileOnStartup({ ledger, adapter, subscriptionId: SUBSCRIPTION_ID, resourcePrefix: 'dmon-run1-' });
    assert.deepEqual(report.reconciledDeletions, ['dmon-run1-cache1']);
    assert.deepEqual(ledger.activeResources(), []);
  });
});

test('reconciliation is idempotent: running it twice in a row produces no further changes', async () => {
  await withTempLedger(async (ledger) => {
    ledger.append('creation-intent', 'dmon-run1-cache1', {});
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const first = await reconcileOnStartup({ ledger, adapter, subscriptionId: SUBSCRIPTION_ID, resourcePrefix: 'dmon-run1-' });
    assert.deepEqual(first.confirmedIntents, ['dmon-run1-cache1']);

    const second = await reconcileOnStartup({ ledger, adapter, subscriptionId: SUBSCRIPTION_ID, resourcePrefix: 'dmon-run1-' });
    assert.deepEqual(second.confirmedIntents, []);
    assert.deepEqual(second.reconciledDeletions, []);
    assert.deepEqual(second.quarantined, []);
  });
});

test('reconciliation never adopts/touches a live resource outside our own prefix (isolation)', async () => {
  await withTempLedger(async (ledger) => {
    ledger.append('creation-intent', 'dmon-run1-cache1', {});
    const fake = createFakeRp({ initialClusters: [{ name: 'other-owner-run9-cache1' }, { name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const report = await reconcileOnStartup({ ledger, adapter, subscriptionId: SUBSCRIPTION_ID, resourcePrefix: 'dmon-run1-' });
    assert.deepEqual(report.confirmedIntents, ['dmon-run1-cache1']);
    assert.ok(!ledger.activeResources().includes('other-owner-run9-cache1'));
  });
});

test('reconciliation refuses (defense in depth) if it is ever asked to reconcile a ledger entry outside the prefix', async () => {
  await withTempLedger(async (ledger) => {
    ledger.append('created', 'someone-elses-cache');
    const fake = createFakeRp({ initialClusters: [{ name: 'someone-elses-cache' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    await assert.rejects(
      () => reconcileOnStartup({ ledger, adapter, subscriptionId: SUBSCRIPTION_ID, resourcePrefix: 'dmon-run1-' }),
      GuardViolation
    );
  });
});

test('reconcileOnStartup passes resourceGroup through to listClusters when supplied', async () => {
  await withTempLedger(async (ledger) => {
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    await reconcileOnStartup({ ledger, adapter, subscriptionId: SUBSCRIPTION_ID, resourceGroup: 'rg1', resourcePrefix: 'dmon-run1-' });
    const req = fake._requestLog.find((r) => r.method === 'GET' && r.path.includes('redisEnterprise'));
    assert.ok(req.path.includes('/resourceGroups/rg1/'));
  });
});

// ---- Tag-based eligibility layered on top of durable intent evidence ----

test('tag-based eligibility: intent-evidenced resource with valid ownership tags is confirmed normally', async () => {
  await withTempLedger(async (ledger) => {
    ledger.append('creation-intent', 'dmon-run1-cache1', {});
    const tags = buildResourceTags({ ownerAlias: 'dmon', runId: 'run1', expiresInMs: 3600000 });
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1', tags }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const report = await reconcileOnStartup({
      ledger,
      adapter,
      subscriptionId: SUBSCRIPTION_ID,
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
      initialClusters: [{ name: 'dmon-run1-cache1', tags: { Owner: 'dmon', SoakRunId: 'run1' } }],
    });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const report = await reconcileOnStartup({
      ledger,
      adapter,
      subscriptionId: SUBSCRIPTION_ID,
      resourcePrefix: 'dmon-run1-',
      ownerAlias: 'dmon',
      runId: 'run1',
    });
    assert.deepEqual(report.confirmedIntents, []);
    assert.deepEqual(report.quarantined, [{ resourceName: 'dmon-run1-cache1', reason: 'missing-createdon-fail-closed' }]);
    assert.equal(ledger.isIntentOnly('dmon-run1-cache1'), true);
  });
});

test('tag-based eligibility: an ownership-tag mismatch quarantines even with intent evidence present', async () => {
  await withTempLedger(async (ledger) => {
    ledger.append('creation-intent', 'dmon-run1-cache1', {});
    const tags = buildResourceTags({ ownerAlias: 'someone-else', runId: 'run9', expiresInMs: 3600000 });
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1', tags }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const report = await reconcileOnStartup({
      ledger,
      adapter,
      subscriptionId: SUBSCRIPTION_ID,
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
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1', tags }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const report = await reconcileOnStartup({
      ledger,
      adapter,
      subscriptionId: SUBSCRIPTION_ID,
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
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }] }); // no tags at all
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const report = await reconcileOnStartup({ ledger, adapter, subscriptionId: SUBSCRIPTION_ID, resourcePrefix: 'dmon-run1-' });
    assert.deepEqual(report.confirmedIntents, ['dmon-run1-cache1']);
    assert.deepEqual(report.quarantined, []);
  });
});

// ---- Final-review finding: subscription denylist is a distinct entry point
// check, enforced BEFORE any adapter call ----

test('reconcileOnStartup rejects a denylisted subscription before ever calling listClusters', async () => {
  await withTempLedger(async (ledger) => {
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    await assert.rejects(
      () =>
        reconcileOnStartup({
          ledger,
          adapter,
          subscriptionId: SUBSCRIPTION_ID,
          resourcePrefix: 'dmon-run1-',
          subscriptionDenylist: [SUBSCRIPTION_ID],
        }),
      GuardViolation
    );
    assert.equal(fake._requestLog.length, 0); // no adapter call was ever made
  });
});

test('reconcileOnStartup proceeds normally when the subscription is not denylisted', async () => {
  await withTempLedger(async (ledger) => {
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    await assert.doesNotReject(() =>
      reconcileOnStartup({
        ledger,
        adapter,
        subscriptionId: SUBSCRIPTION_ID,
        resourcePrefix: 'dmon-run1-',
        subscriptionDenylist: ['66666666-7777-8888-9999-aaaaaaaaaaaa'], // unrelated
      })
    );
    assert.ok(fake._requestLog.length > 0);
  });
});

// ---- pollUntilTerminal (generic, no fake "/operations" API assumed) ----

test('pollUntilTerminal polls a resource provisioningState with backoff until terminal', async () => {
  const fake = createFakeRp({ pollsUntilCreateSucceeded: 2 });
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  const context = testContext();
  const coords = { subscriptionId: SUBSCRIPTION_ID, name: 'dmon-run1-cache1' };
  await adapter.createCluster(coords, { location: 'eastus', tags: {}, sku: { name: 'Balanced_B1', capacity: 1 } }, context);

  const sleeps = [];
  const status = await pollUntilTerminal({
    checkStatus: buildResourceProvisioningStateCheck((signal) => adapter.getCluster(coords, { signal })),
    intervalMs: 10,
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.equal(status.state, 'Succeeded');
  assert.ok(sleeps.length >= 1);
});

test('buildDeletionCheck treats a 404 as terminal "Deleted"', async () => {
  const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }] });
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  const context = testContext();
  const coords = { subscriptionId: SUBSCRIPTION_ID, name: 'dmon-run1-cache1' };
  await adapter.deleteCluster(coords, context);

  const status = await pollUntilTerminal({
    checkStatus: buildDeletionCheck((signal) => adapter.getCluster(coords, { signal })),
    intervalMs: 5,
  });
  assert.equal(status.terminal, true);
  assert.equal(status.state, 'Deleted');
});

test('buildAsyncOperationCheck follows a Location/Azure-AsyncOperation header URL to terminal', async () => {
  const fake = createFakeRp({ pollsUntilCreateSucceeded: 1 });
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  const context = testContext();
  const coords = { subscriptionId: SUBSCRIPTION_ID, name: 'dmon-run1-cache1' };
  const created = await adapter.createCluster(
    coords,
    { location: 'eastus', tags: {}, sku: { name: 'Balanced_B1', capacity: 1 }, _testUseAsyncHeaders: true },
    context
  );

  const status = await pollUntilTerminal({
    checkStatus: buildAsyncOperationCheck(adapter, created.headers.azureAsyncOperation),
    intervalMs: 5,
  });
  assert.equal(status.state, 'Succeeded');
});

test('pollUntilTerminal throws ReconciliationError on timeout', async () => {
  await assert.rejects(
    () =>
      pollUntilTerminal({
        checkStatus: async () => ({ terminal: false, state: 'Running' }),
        intervalMs: 5,
        timeoutMs: 15,
        sleep: async () => {},
      }),
    ReconciliationError
  );
});

// ---- Finding #11: AbortController-bounded polling ----

test('pollUntilTerminal bounds a single hung request so it can never let the overall poll exceed its deadline', async () => {
  const start = Date.now();
  await assert.rejects(
    () =>
      pollUntilTerminal({
        checkStatus: (signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
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
  const status = await pollUntilTerminal({
    checkStatus: (signal) => {
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
      return Promise.resolve({ terminal: true, state: 'Succeeded' });
    },
    timeoutMs: 5000,
    perRequestTimeoutMs: 20,
    intervalMs: 5,
    sleep: async () => {},
  });
  assert.equal(status.state, 'Succeeded');
  assert.ok(callCount >= 2);
});
