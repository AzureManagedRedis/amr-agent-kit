import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalRpHttpAdapter, AdapterError, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_MAX_LIST_PAGES } from '../../src/cache/http-adapter.mjs';
import { DEFAULT_API_VERSION } from '../../src/cache/config.mjs';
import { MutationContextError } from '../../src/cache/mutation-context.mjs';
import { LeaseManager, LeaseNotAuthorized, FencingTokenStale } from '../../src/cache/lease-manager.mjs';
import { GuardViolation } from '../../src/cache/guards.mjs';
import { createFakeRp } from './fakes/fake-rp.mjs';

// No Azure calls, no localhost calls: every test here injects a fake fetch.
// If any of these tests ever hit a real network socket, they would hang/fail
// in CI, which itself is a guard against accidental real HTTP usage
// creeping in.

const COORDS = { subscriptionId: '11111111-2222-3333-4444-555555555555', resourceGroup: 'rg1', name: 'dmon-run1-cache1' };

function testConfig(overrides = {}) {
  return { resourcePrefix: 'dmon-run1-', denylist: [], acknowledgedCustomerSubscription: true, ...overrides };
}

function testContext(overrides = {}) {
  const leaseManager = overrides.leaseManager ?? new LeaseManager();
  const lease = overrides.lease ?? leaseManager.acquire({ class: 'exclusive' });
  return { config: testConfig(overrides.config), lease, leaseManager, ...overrides };
}

test('adapter refuses any host other than localhost', () => {
  assert.throws(() => new LocalRpHttpAdapter({ host: 'management.azure.com', port: 8443 }), AdapterError);
});

test('adapter refuses the forbidden fallback port 8444', () => {
  assert.throws(() => new LocalRpHttpAdapter({ port: 8444 }), AdapterError);
});

test('adapter refuses any other non-8443 port', () => {
  assert.throws(() => new LocalRpHttpAdapter({ port: 9999 }), AdapterError);
  assert.throws(() => new LocalRpHttpAdapter({ port: 80 }), AdapterError);
});

test('adapter defaults to the contract api-version and never calls the real global fetch', async () => {
  let realFetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    realFetchCalled = true;
    throw new Error('real fetch should never be invoked in tests');
  };
  try {
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    assert.equal(adapter.apiVersion, DEFAULT_API_VERSION);
    const result = await adapter.listClusters({ subscriptionId: COORDS.subscriptionId, resourceGroup: COORDS.resourceGroup });
    assert.equal(result.value.length, 1);
    assert.equal(realFetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---- Real ARM contract: paths/query/header/body ----

test('listClusters builds the real ARM list path with resourceGroup, and appends api-version', async () => {
  const fake = createFakeRp({});
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  await adapter.listClusters({ subscriptionId: COORDS.subscriptionId, resourceGroup: 'rg1' });
  const req = fake._requestLog.at(-1);
  assert.equal(req.method, 'GET');
  assert.equal(
    req.path,
    `/subscriptions/${COORDS.subscriptionId}/resourceGroups/rg1/providers/Microsoft.Cache/redisEnterprise`
  );
  assert.equal(req.query['api-version'], DEFAULT_API_VERSION);
});

test('listClusters builds the subscription-scoped path when resourceGroup is omitted', async () => {
  const fake = createFakeRp({});
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  await adapter.listClusters({ subscriptionId: COORDS.subscriptionId });
  const req = fake._requestLog.at(-1);
  assert.equal(req.path, `/subscriptions/${COORDS.subscriptionId}/providers/Microsoft.Cache/redisEnterprise`);
});

test('getCluster/createCluster/deleteCluster build the real single-cluster ARM path', async () => {
  const fake = createFakeRp({});
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  const context = testContext();
  await adapter.createCluster(COORDS, { location: 'eastus', tags: {}, sku: { name: 'Balanced_B1', capacity: 1 } }, context);
  const expectedPath = `/subscriptions/${COORDS.subscriptionId}/resourceGroups/${COORDS.resourceGroup}/providers/Microsoft.Cache/redisEnterprise/${COORDS.name}`;
  assert.equal(fake._requestLog.at(-1).path, expectedPath);

  await adapter.getCluster(COORDS);
  assert.equal(fake._requestLog.at(-1).path, expectedPath);
});

test('database paths append /databases/default (and /listKeys) to the cluster path', async () => {
  const fake = createFakeRp({});
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  const context = testContext();
  await adapter.createCluster(COORDS, { location: 'eastus', tags: {}, sku: { name: 'Balanced_B0' } }, context);
  await adapter.createDatabase({ ...COORDS, clusterName: COORDS.name }, { properties: {} }, context);
  const expectedDbPath = `/subscriptions/${COORDS.subscriptionId}/resourceGroups/${COORDS.resourceGroup}/providers/Microsoft.Cache/redisEnterprise/${COORDS.name}/databases/default`;
  assert.equal(fake._requestLog.at(-1).path, expectedDbPath);

  await adapter.listKeys({ ...COORDS, clusterName: COORDS.name }, context);
  assert.equal(fake._requestLog.at(-1).path, `${expectedDbPath}/listKeys`);
  assert.equal(fake._requestLog.at(-1).method, 'POST');
});

test('every request carries the required Referer header pointed at this adapter', async () => {
  const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }] });
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  await adapter.getCluster(COORDS);
  const req = fake._requestLog.at(-1);
  assert.equal(req.headers.referer, 'http://localhost:8443');
});

test('the fake RP itself enforces the real contract: rejects a missing Referer and a missing api-version', async () => {
  const fake = createFakeRp({});
  const res1 = await fake.fetchImpl('http://localhost:8443/subscriptions/s/providers/Microsoft.Cache/redisEnterprise?api-version=2024-09-01-preview', {
    method: 'GET',
    headers: {},
  });
  assert.equal(res1.status, 400);

  const res2 = await fake.fetchImpl('http://localhost:8443/subscriptions/s/providers/Microsoft.Cache/redisEnterprise', {
    method: 'GET',
    headers: { referer: 'http://localhost:8443' },
  });
  assert.equal(res2.status, 400);
});

test('createCluster sends the real creation body shape: location, tags, sku, minimumTlsVersion', async () => {
  const fake = createFakeRp({});
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  const context = testContext();
  const body = { location: 'eastus', tags: { Owner: 'dmon' }, sku: { name: 'Balanced_B1', capacity: 1 }, properties: { minimumTlsVersion: '1.2' } };
  await adapter.createCluster(COORDS, body, context);
  const stored = fake._clusters.get(COORDS.name);
  assert.equal(stored.location, 'eastus');
  assert.deepEqual(stored.tags, { Owner: 'dmon' });
  assert.deepEqual(stored.sku, { name: 'Balanced_B1', capacity: 1 });
  assert.equal(stored.properties.minimumTlsVersion, '1.2');
});

test('Balanced B0 creation omits capacity from the sku body entirely', async () => {
  const fake = createFakeRp({});
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  const context = testContext();
  await adapter.createCluster(COORDS, { location: 'eastus', tags: {}, sku: { name: 'Balanced_B0' } }, context);
  const stored = fake._clusters.get(COORDS.name);
  assert.deepEqual(stored.sku, { name: 'Balanced_B0' });
  assert.equal('capacity' in stored.sku, false);
});

// ---- CRUD round-trip + async polling ----

test('adapter cluster CRUD round-trip against the fake RP, under a valid mutation context', async () => {
  const fake = createFakeRp({});
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  const context = testContext();

  await adapter.createCluster(COORDS, { location: 'eastus', tags: {}, sku: { name: 'Balanced_B1', capacity: 1 } }, context);
  const got = await adapter.getCluster(COORDS);
  assert.equal(got.name, COORDS.name);

  const list = await adapter.listClusters({ subscriptionId: COORDS.subscriptionId, resourceGroup: COORDS.resourceGroup });
  assert.equal(list.value.length, 1);

  await adapter.deleteCluster(COORDS, context);
  await assert.rejects(() => adapter.getCluster(COORDS));
});

test('async creation: the cluster stays non-terminal for N polls before Succeeded', async () => {
  const fake = createFakeRp({ pollsUntilCreateSucceeded: 2 });
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  const context = testContext();
  const created = await adapter.createCluster(COORDS, { location: 'eastus', tags: {}, sku: { name: 'Balanced_B1', capacity: 1 } }, context);
  assert.equal(created.status, 202);
  assert.equal(created.body.properties.provisioningState, 'Creating');

  const poll1 = await adapter.getCluster(COORDS);
  assert.equal(poll1.properties.provisioningState, 'Creating');
  const poll2 = await adapter.getCluster(COORDS);
  assert.equal(poll2.properties.provisioningState, 'Succeeded');
});

test('DELETE terminal absence: the cluster 404s only after the simulated deletion completes', async () => {
  const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }], pollsUntilDeleteComplete: 2 });
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  const context = testContext();
  await adapter.deleteCluster(COORDS, context);

  const poll1 = await adapter.getCluster(COORDS);
  assert.equal(poll1.properties.provisioningState, 'Deleting');
  await assert.rejects(() => adapter.getCluster(COORDS), (err) => {
    assert.equal(err.status, 404);
    return true;
  });
});

test('respects an Azure-AsyncOperation header when the RP happens to provide one', async () => {
  const fake = createFakeRp({ pollsUntilCreateSucceeded: 1 });
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  const context = testContext();
  const created = await adapter.createCluster(
    COORDS,
    { location: 'eastus', tags: {}, sku: { name: 'Balanced_B1', capacity: 1 }, _testUseAsyncHeaders: true },
    context
  );
  assert.ok(created.headers.azureAsyncOperation);
  assert.ok(created.headers.azureAsyncOperation.startsWith('http://localhost:8443/'));

  const status1 = await adapter.pollOperationUrl(created.headers.azureAsyncOperation);
  assert.equal(status1.status, 'InProgress');
  const status2 = await adapter.pollOperationUrl(created.headers.azureAsyncOperation);
  assert.equal(status2.status, 'Succeeded');
});

test('pollOperationUrl refuses a follow-up URL outside this adapter origin', async () => {
  const fake = createFakeRp({});
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  await assert.rejects(() => adapter.pollOperationUrl('http://evil.example.com/status'), AdapterError);
});

// ---- listKeys + redaction ----

test('listKeys returns the database keys and never logs the response body', async () => {
  const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }] });
  const logs = [];
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl, logger: (event, detail) => logs.push({ event, detail }) });
  const context = testContext();
  const keys = await adapter.listKeys({ ...COORDS, clusterName: COORDS.name }, context);
  assert.ok(keys.primaryKey);
  assert.ok(keys.secondaryKey);
  // Only method/url/headers are ever logged -- never the response body/keys.
  for (const entry of logs) {
    assert.doesNotMatch(JSON.stringify(entry), /FAKE-(PRIMARY|SECONDARY)-KEY/);
  }
});

test('listKeys requires a mutation context (ownership/denylist/fencing apply even to reading secrets)', async () => {
  const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }] });
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  await assert.rejects(() => adapter.listKeys({ ...COORDS, clusterName: COORDS.name }), MutationContextError);
});

test('listKeys rejects a resource outside the mutation context resourcePrefix (ownership boundary)', async () => {
  const fake = createFakeRp({ initialClusters: [{ name: 'other-owner-cache1' }] });
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  await assert.rejects(
    () => adapter.listKeys({ ...COORDS, name: undefined, clusterName: 'other-owner-cache1' }, testContext()),
    GuardViolation
  );
});

// ---- Finding #1 (still enforced): mutation boundary, create-only, non-owned collision ----

test('createCluster requires a mutation context; refuses without one', async () => {
  const fake = createFakeRp({});
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  await assert.rejects(() => adapter.createCluster(COORDS, { location: 'eastus', tags: {}, sku: {} }), MutationContextError);
});

test('deleteCluster requires a mutation context; refuses without one', async () => {
  const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }] });
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  await assert.rejects(() => adapter.deleteCluster(COORDS), MutationContextError);
});

test('createCluster rejects a name outside the mutation context resourcePrefix (ownership boundary)', async () => {
  const fake = createFakeRp({});
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  await assert.rejects(
    () => adapter.createCluster({ ...COORDS, name: 'other-owner-cache1' }, { location: 'eastus', tags: {}, sku: {} }, testContext()),
    GuardViolation
  );
});

test('createCluster rejects a shared (read-only) lease -- write requires exclusive', async () => {
  const fake = createFakeRp({});
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  const leaseManager = new LeaseManager();
  const lease = leaseManager.acquire({ class: 'shared' });
  await assert.rejects(
    () => adapter.createCluster(COORDS, { location: 'eastus', tags: {}, sku: {} }, { config: testConfig(), lease, leaseManager }),
    LeaseNotAuthorized
  );
});

test('deleteCluster rejects a stale fencing token', async () => {
  const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }] });
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  let now = 1000;
  const leaseManager = new LeaseManager({ now: () => now });
  const lease = leaseManager.acquire({ class: 'exclusive', ttlMs: 100 });
  now += 200;
  await assert.rejects(
    () => adapter.deleteCluster(COORDS, { config: testConfig(), lease, leaseManager }),
    FencingTokenStale
  );
});

test('createCluster checks the kill switch immediately, before any network call', async () => {
  const fake = createFakeRp({});
  let fetchCalled = false;
  const wrappedFetch = async (...args) => {
    fetchCalled = true;
    return fake.fetchImpl(...args);
  };
  const adapter = new LocalRpHttpAdapter({ fetchImpl: wrappedFetch });
  const { KillSwitch, KillSwitchEngaged } = await import('../../src/cache/kill-switch.mjs');
  const killSwitch = new KillSwitch({ path: '/tmp/engaged.killswitch', exists: () => true });
  await assert.rejects(
    () => adapter.createCluster(COORDS, { location: 'eastus', tags: {}, sku: {} }, testContext({ killSwitch })),
    KillSwitchEngaged
  );
  assert.equal(fetchCalled, false);
});

test('createCluster uses create-only semantics: refuses to overwrite an already-existing cluster (non-owned collision)', async () => {
  // The pre-existing cluster carries no ownership tags at all -- a
  // "non-owned collision" -- yet create-only semantics must still refuse,
  // regardless of ownership, because ANY existing resource at that exact
  // name blocks a create.
  const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1', sku: { name: 'Balanced_B1', capacity: 1 } }] });
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  await assert.rejects(
    () => adapter.createCluster(COORDS, { location: 'eastus', tags: {}, sku: { name: 'Balanced_B5', capacity: 5 } }, testContext()),
    (err) => {
      assert.ok(err instanceof AdapterError);
      assert.equal(err.status, 409);
      return true;
    }
  );
  // Confirm the original spec was never overwritten.
  assert.deepEqual(fake._clusters.get('dmon-run1-cache1').sku, { name: 'Balanced_B1', capacity: 1 });
});

test('createCluster with dryRunOnly context never issues a real request and returns a simulated result', async () => {
  const fake = createFakeRp({});
  let fetchCalled = false;
  const wrappedFetch = async (...args) => {
    fetchCalled = true;
    return fake.fetchImpl(...args);
  };
  const adapter = new LocalRpHttpAdapter({ fetchImpl: wrappedFetch });
  const result = await adapter.createCluster(
    COORDS,
    { location: 'eastus', tags: {}, sku: { name: 'MemoryOptimized_M10', capacity: 10 } },
    testContext({ dryRunOnly: true })
  );
  assert.equal(result.body.simulated, true);
  assert.equal(result.body.dryRun, true);
  assert.equal(fetchCalled, false);
  assert.equal(fake._clusters.size, 0); // nothing actually created
});

test('mutating calls are serialized: two concurrent deletes never overlap in flight', async () => {
  const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }, { name: 'dmon-run1-cache2' }] });
  let inFlight = 0;
  let maxInFlight = 0;
  const trackingFetch = async (...args) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const res = await fake.fetchImpl(...args);
    inFlight -= 1;
    return res;
  };
  const adapter = new LocalRpHttpAdapter({ fetchImpl: trackingFetch });
  const context = testContext();
  await Promise.all([
    adapter.deleteCluster(COORDS, context),
    adapter.deleteCluster({ ...COORDS, name: 'dmon-run1-cache2' }, context),
  ]);
  assert.equal(maxInFlight, 1, 'no two mutating requests should ever be in flight at the same time');
});

// ---- Finding #11: AbortController-backed timeouts ----

test('a hung request is aborted once it exceeds the per-request timeout, instead of hanging forever', async () => {
  const hangingFetch = (url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  const adapter = new LocalRpHttpAdapter({ fetchImpl: hangingFetch, defaultTimeoutMs: 30 });
  const start = Date.now();
  await assert.rejects(() => adapter.listClusters({ subscriptionId: COORDS.subscriptionId }), /aborted|timed out/i);
  assert.ok(Date.now() - start < 2000, 'the call must not hang indefinitely');
});

test('an externally supplied AbortSignal also bounds the request', async () => {
  const hangingFetch = (url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  const adapter = new LocalRpHttpAdapter({ fetchImpl: hangingFetch, defaultTimeoutMs: 60000 });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(() => adapter.listClusters({ subscriptionId: COORDS.subscriptionId }, { signal: controller.signal }), /aborted/i);
});

test('DEFAULT_REQUEST_TIMEOUT_MS is a sane positive default', () => {
  assert.ok(DEFAULT_REQUEST_TIMEOUT_MS > 0);
});

// ---- Review finding #3: ARM nextLink pagination, origin-locked and loop-guarded ----

test('listClusters follows nextLink across multiple pages and returns every owned resource', async () => {
  const fake = createFakeRp({
    initialClusters: [
      { name: 'dmon-run1-cache1' },
      { name: 'dmon-run1-cache2' },
      { name: 'dmon-run1-cache3' },
      { name: 'dmon-run1-cache4' },
      { name: 'dmon-run1-cache5' },
    ],
    listPageSize: 2,
  });
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

  const result = await adapter.listClusters({ subscriptionId: COORDS.subscriptionId, resourceGroup: COORDS.resourceGroup });

  assert.equal(result.value.length, 5);
  assert.deepEqual(
    result.value.map((c) => c.name).sort(),
    ['dmon-run1-cache1', 'dmon-run1-cache2', 'dmon-run1-cache3', 'dmon-run1-cache4', 'dmon-run1-cache5']
  );
  // 5 items at 2 per page: three pages (2/2/1) should have been fetched.
  const listPath = `/subscriptions/${COORDS.subscriptionId}/resourceGroups/${COORDS.resourceGroup}/providers/Microsoft.Cache/redisEnterprise`;
  const listRequests = fake._requestLog.filter((r) => r.path === listPath);
  assert.equal(listRequests.length, 3);
});

test('listClusters refuses to follow a nextLink pointing outside this adapter origin (malicious/buggy nextLink)', async () => {
  let evilFetchCalled = false;
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.origin === 'http://evil.example:9999') {
      evilFetchCalled = true;
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ value: [] }) };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          value: [{ name: 'dmon-run1-cache1' }],
          nextLink: 'http://evil.example:9999/subscriptions/x/providers/Microsoft.Cache/redisEnterprise?api-version=2024-09-01-preview',
        }),
    };
  };
  const adapter = new LocalRpHttpAdapter({ fetchImpl });

  await assert.rejects(
    () => adapter.listClusters({ subscriptionId: COORDS.subscriptionId }),
    (err) => err instanceof AdapterError && /outside/i.test(err.message)
  );
  assert.equal(evilFetchCalled, false); // the cross-origin nextLink must never actually be requested
});

test('listClusters refuses to follow a nextLink cycle forever, bounded by maxPages', async () => {
  let callCount = 0;
  const cyclicalNextLink =
    'http://localhost:8443/subscriptions/loop/providers/Microsoft.Cache/redisEnterprise?api-version=2024-09-01-preview&_loop=1';
  const fetchImpl = async () => {
    callCount += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ value: [], nextLink: cyclicalNextLink }), // always "more" -- would loop forever unguarded
    };
  };
  const adapter = new LocalRpHttpAdapter({ fetchImpl });

  await assert.rejects(
    () => adapter.listClusters({ subscriptionId: COORDS.subscriptionId }, { maxPages: 3 }),
    (err) => err instanceof AdapterError && /maximum page count/i.test(err.message)
  );
  assert.equal(callCount, 3); // stopped exactly at the configured cap -- never looped indefinitely
});

test('DEFAULT_MAX_LIST_PAGES is a sane positive default', () => {
  assert.ok(DEFAULT_MAX_LIST_PAGES > 0);
});
