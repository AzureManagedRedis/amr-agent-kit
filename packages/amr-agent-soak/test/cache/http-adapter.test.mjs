import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalRpHttpAdapter, AdapterError } from '../../src/cache/http-adapter.mjs';
import { createFakeRp, fakeSkuCatalog } from './fakes/fake-rp.mjs';

// No Azure calls: every test here injects a fake fetch. If any of these
// tests ever hit a real network socket, they would hang/fail in CI, which
// itself is a guard against accidental real HTTP usage creeping in.

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

test('adapter CRUD round-trip against the fake RP', async () => {
  const fake = createFakeRp({});
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

  await adapter.createCache('dmon-run1-cache1', { sku: 'B1' });
  const got = await adapter.getCache('dmon-run1-cache1');
  assert.equal(got.name, 'dmon-run1-cache1');

  const list = await adapter.listCaches();
  assert.equal(list.caches.length, 1);

  await adapter.deleteCache('dmon-run1-cache1');
  await assert.rejects(() => adapter.getCache('dmon-run1-cache1'));
});

test('adapter surfaces non-2xx responses as AdapterError with status', async () => {
  const fake = createFakeRp({});
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  await assert.rejects(() => adapter.getCache('does-not-exist'), (err) => {
    assert.ok(err instanceof AdapterError);
    assert.equal(err.status, 404);
    return true;
  });
});

test('adapter redacts logged detail (no raw subscription/tenant leakage to logger)', async () => {
  const fake = createFakeRp({});
  const logs = [];
  const adapter = new LocalRpHttpAdapter({
    fetchImpl: fake.fetchImpl,
    logger: (event, detail) => logs.push({ event, detail }),
  });
  await adapter.createCache('dmon-run1-cache1', { headers: { authorization: 'Bearer sometoken123' } });
  const entry = logs.find((l) => l.event === 'http-adapter.request');
  assert.ok(entry);
  assert.doesNotMatch(JSON.stringify(entry.detail), /sometoken123/);
});

test('adapter can fetch the runtime SKU catalog', async () => {
  const fake = createFakeRp({ skuCatalog: fakeSkuCatalog() });
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
  const catalog = await adapter.getSkuCatalog();
  assert.ok(catalog.skus.some((s) => s.name === 'B5' && s.family === 'Balanced'));
});
