import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalRpHttpAdapter, AdapterError } from '../../src/cache/http-adapter.mjs';
import { MutationContextError } from '../../src/cache/mutation-context.mjs';
import { LeaseManager, LeaseNotAuthorized, FencingTokenStale } from '../../src/cache/lease-manager.mjs';
import { GuardViolation } from '../../src/cache/guards.mjs';
import { createFakeRp, fakeSkuCatalog } from './fakes/fake-rp.mjs';

// No Azure calls: every test here injects a fake fetch. If any of these
// tests ever hit a real network socket, they would hang/fail in CI, which
// itself is a guard against accidental real HTTP usage creeping in.

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

test('adapter constructs successfully for localhost:8443 and never calls the real global fetch', async () => {
  let realFetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    realFetchCalled = true;
    throw new Error('real fetch should never be invoked in tests');
  };
  try {
    const fake = createFakeRp({ initialCaches: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    const result = await adapter.listCaches();
    assert.equal(result.caches.length, 1);
    assert.equal(realFetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('adapter CRUD round-trip against the fake RP, under a valid mutation context', async () => {
  const fake = createFakeRp({});
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  const context = testContext();

  await adapter.createCache('dmon-run1-cache1', { sku: 'B1' }, context);
  const got = await adapter.getCache('dmon-run1-cache1');
  assert.equal(got.name, 'dmon-run1-cache1');

  const list = await adapter.listCaches();
  assert.equal(list.caches.length, 1);

  await adapter.deleteCache('dmon-run1-cache1', context);
  await assert.rejects(() => adapter.getCache('dmon-run1-cache1'));
});

test('adapter surfaces non-2xx responses as AdapterError with status', async () => {
  const fake = createFakeRp({});
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  await assert.rejects(
    () => adapter.getCache('does-not-exist'),
    (err) => {
      assert.ok(err instanceof AdapterError);
      assert.equal(err.status, 404);
      return true;
    }
  );
});

test('adapter redacts logged detail (no raw subscription/tenant GUID leakage to the logger)', async () => {
  const fake = createFakeRp({});
  const logs = [];
  const adapter = new LocalRpHttpAdapter({
    fetchImpl: fake.fetchImpl,
    logger: (event, detail) => logs.push({ event, detail }),
  });
  const nameWithGuid = 'dmon-run1-11111111-2222-3333-4444-555555555555';
  await adapter.getCache(nameWithGuid).catch(() => {}); // 404 expected; the request is still logged first.
  const entry = logs.find((l) => l.event === 'http-adapter.request');
  assert.ok(entry);
  assert.doesNotMatch(entry.detail.url, /11111111-2222-3333-4444-555555555555/);
  assert.match(entry.detail.url, /\[REDACTED\]/);
});

test('adapter can fetch the runtime SKU catalog', async () => {
  const fake = createFakeRp({ skuCatalog: fakeSkuCatalog() });
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  const catalog = await adapter.getSkuCatalog();
  assert.ok(catalog.skus.some((s) => s.name === 'B5' && s.family === 'Balanced'));
});

// ---- Finding #1: mutation boundary enforcement ----

test('createCache requires a mutation context; refuses without one', async () => {
  const fake = createFakeRp({});
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  await assert.rejects(() => adapter.createCache('dmon-run1-cache1', {}), MutationContextError);
});

test('deleteCache requires a mutation context; refuses without one', async () => {
  const fake = createFakeRp({ initialCaches: [{ name: 'dmon-run1-cache1' }] });
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  await assert.rejects(() => adapter.deleteCache('dmon-run1-cache1'), MutationContextError);
});

test('patchCacheTopology requires a mutation context; refuses without one', async () => {
  const fake = createFakeRp({ initialCaches: [{ name: 'dmon-run1-cache1' }] });
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  await assert.rejects(() => adapter.patchCacheTopology('dmon-run1-cache1', {}), MutationContextError);
});

test('createCache rejects a name outside the mutation context resourcePrefix (ownership boundary)', async () => {
  const fake = createFakeRp({});
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  await assert.rejects(() => adapter.createCache('other-owner-cache1', {}, testContext()), GuardViolation);
});

test('createCache rejects a denylisted name even within the owner prefix', async () => {
  const fake = createFakeRp({});
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  const context = testContext({ config: { denylist: ['dmon-run1-locked*'] } });
  await assert.rejects(() => adapter.createCache('dmon-run1-locked-cache', {}, context), GuardViolation);
});

test('createCache rejects a shared (read-only) lease -- write requires exclusive', async () => {
  const fake = createFakeRp({});
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  const leaseManager = new LeaseManager();
  const lease = leaseManager.acquire({ class: 'shared' });
  await assert.rejects(
    () => adapter.createCache('dmon-run1-cache1', {}, { config: testConfig(), lease, leaseManager }),
    LeaseNotAuthorized
  );
});

test('deleteCache rejects a stale fencing token', async () => {
  const fake = createFakeRp({ initialCaches: [{ name: 'dmon-run1-cache1' }] });
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  let now = 1000;
  const leaseManager = new LeaseManager({ now: () => now });
  const lease = leaseManager.acquire({ class: 'exclusive', ttlMs: 100 });
  now += 200;
  await assert.rejects(
    () => adapter.deleteCache('dmon-run1-cache1', { config: testConfig(), lease, leaseManager }),
    FencingTokenStale
  );
});

test('createCache checks the kill switch immediately, before any network call', async () => {
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
    () => adapter.createCache('dmon-run1-cache1', {}, testContext({ killSwitch })),
    KillSwitchEngaged
  );
  assert.equal(fetchCalled, false);
});

test('createCache uses create-only semantics: refuses to overwrite an already-existing cache', async () => {
  const fake = createFakeRp({ initialCaches: [{ name: 'dmon-run1-cache1', sku: 'B1' }] });
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  await assert.rejects(
    () => adapter.createCache('dmon-run1-cache1', { sku: 'B5' }, testContext()),
    (err) => {
      assert.ok(err instanceof AdapterError);
      assert.equal(err.status, 409);
      return true;
    }
  );
  // Confirm the original spec was never overwritten.
  assert.equal(fake._caches.get('dmon-run1-cache1').sku, 'B1');
});

test('createCache with dryRunOnly context never issues a real request and returns a simulated result', async () => {
  const fake = createFakeRp({});
  let fetchCalled = false;
  const wrappedFetch = async (...args) => {
    fetchCalled = true;
    return fake.fetchImpl(...args);
  };
  const adapter = new LocalRpHttpAdapter({ fetchImpl: wrappedFetch });
  const result = await adapter.createCache('dmon-run1-cache1', { sku: 'M10' }, testContext({ dryRunOnly: true }));
  assert.equal(result.simulated, true);
  assert.equal(result.dryRun, true);
  assert.equal(fetchCalled, false);
  assert.equal(fake._caches.size, 0); // nothing actually created
});

test('mutating calls are serialized: two concurrent deletes never overlap in flight', async () => {
  const fake = createFakeRp({ initialCaches: [{ name: 'dmon-run1-cache1' }, { name: 'dmon-run1-cache2' }] });
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
    adapter.deleteCache('dmon-run1-cache1', context),
    adapter.deleteCache('dmon-run1-cache2', context),
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
  await assert.rejects(() => adapter.listCaches(), /aborted|timed out/i);
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
  await assert.rejects(() => adapter.listCaches({ signal: controller.signal }), /aborted/i);
});
