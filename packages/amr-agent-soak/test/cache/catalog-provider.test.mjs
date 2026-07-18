import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSkuCatalog, classifySkuViaProvider, CatalogUnavailableError } from '../../src/cache/catalog-provider.mjs';
import { CatalogError } from '../../src/cache/sku-catalog.mjs';
import { fakeSkuCatalog } from './fakes/fake-rp.mjs';

// There is no real "/catalog/skus" endpoint -- SKU data must come from an
// injected provider, and resolution must fail closed (never invent live
// SKU data) whenever no provider is configured or it returns garbage.

test('resolveSkuCatalog fails closed when no provider is configured', async () => {
  await assert.rejects(() => resolveSkuCatalog(undefined), CatalogUnavailableError);
  await assert.rejects(() => resolveSkuCatalog(null), CatalogUnavailableError);
});

test('resolveSkuCatalog fails closed when the provider returns something unusable', async () => {
  await assert.rejects(() => resolveSkuCatalog(() => undefined), CatalogUnavailableError);
  await assert.rejects(() => resolveSkuCatalog(() => ({})), CatalogUnavailableError);
  await assert.rejects(() => resolveSkuCatalog(() => ({ skus: 'not-an-array' })), CatalogUnavailableError);
});

test('resolveSkuCatalog accepts a plain catalog object provider', async () => {
  const catalog = await resolveSkuCatalog(fakeSkuCatalog());
  assert.ok(Array.isArray(catalog.skus));
});

test('resolveSkuCatalog accepts a synchronous function provider', async () => {
  const catalog = await resolveSkuCatalog(() => fakeSkuCatalog());
  assert.ok(Array.isArray(catalog.skus));
});

test('resolveSkuCatalog accepts an asynchronous function provider (e.g. a runtime control-plane fetch)', async () => {
  const catalog = await resolveSkuCatalog(async () => fakeSkuCatalog());
  assert.ok(Array.isArray(catalog.skus));
});

test('classifySkuViaProvider composes resolution (fail-closed) with classification', async () => {
  const result = await classifySkuViaProvider(fakeSkuCatalog(), 'B1', 'Balanced');
  assert.equal(result.withinCeiling, true);
  assert.equal(result.dryRunOnly, false);
});

test('classifySkuViaProvider fails closed if the provider is unavailable, before ever attempting classification', async () => {
  await assert.rejects(() => classifySkuViaProvider(undefined, 'B1', 'Balanced'), CatalogUnavailableError);
});

test('classifySkuViaProvider still surfaces a genuine CatalogError for an unknown SKU once the catalog resolves', async () => {
  await assert.rejects(() => classifySkuViaProvider(fakeSkuCatalog(), 'DOES-NOT-EXIST', 'Balanced'), CatalogError);
});
