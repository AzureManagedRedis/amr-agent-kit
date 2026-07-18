import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveLiveCeiling,
  isSkuWithinLiveCeiling,
  classifySkuRequest,
  buildArmSkuName,
  buildArmSkuBody,
  CatalogError,
} from '../../src/cache/sku-catalog.mjs';
import { fakeSkuCatalog } from './fakes/fake-rp.mjs';

test('deriveLiveCeiling reads Balanced B5 memory/capacity from the runtime catalog', () => {
  const ceiling = deriveLiveCeiling(fakeSkuCatalog());
  assert.equal(ceiling.memoryGb, 6);
  assert.equal(ceiling.capacityGb, 6);
  assert.equal(ceiling.sourceSku, 'Balanced B5');
});

test('deriveLiveCeiling never hard-codes the ceiling: changing the runtime catalog changes it', () => {
  const catalog = { skus: [{ name: 'B5', family: 'Balanced', memoryGb: 42, capacityGb: 42 }] };
  const ceiling = deriveLiveCeiling(catalog);
  assert.equal(ceiling.memoryGb, 42);
  assert.equal(ceiling.capacityGb, 42);
});

test('deriveLiveCeiling throws if the catalog has no Balanced B5 entry', () => {
  assert.throws(() => deriveLiveCeiling({ skus: [] }), CatalogError);
});

test('B0 omits capacity: ceiling check only compares memory', () => {
  const ceiling = deriveLiveCeiling(fakeSkuCatalog());
  const b0 = { name: 'B0', family: 'Balanced', memoryGb: 0.025 };
  assert.equal('capacityGb' in b0, false);
  assert.equal(isSkuWithinLiveCeiling(b0, ceiling), true);
});

test('capacity omission is allowed ONLY for Balanced B0 -- any other SKU missing capacity fails closed', () => {
  const ceiling = deriveLiveCeiling(fakeSkuCatalog());
  // Same tiny memory footprint as B0, but NOT Balanced B0 -- must NOT get a free pass.
  const m0 = { name: 'M0', family: 'MemoryOptimized', memoryGb: 0.025 };
  const x0 = { name: 'X0', family: 'ComputeOptimized', memoryGb: 0.025 };
  const balancedButNotB0 = { name: 'B1', family: 'Balanced', memoryGb: 0.5 }; // capacity omitted, not B0
  assert.equal('capacityGb' in m0, false);
  assert.equal(isSkuWithinLiveCeiling(m0, ceiling), false);
  assert.equal(isSkuWithinLiveCeiling(x0, ceiling), false);
  assert.equal(isSkuWithinLiveCeiling(balancedButNotB0, ceiling), false);
});

test('B/M/X equivalents at or below the ceiling are within budget', () => {
  const ceiling = deriveLiveCeiling(fakeSkuCatalog());
  assert.equal(isSkuWithinLiveCeiling({ name: 'B1', family: 'Balanced', memoryGb: 1, capacityGb: 1 }, ceiling), true);
  assert.equal(isSkuWithinLiveCeiling({ name: 'M10', family: 'MemoryOptimized', memoryGb: 12, capacityGb: 10 }, ceiling), false);
  assert.equal(isSkuWithinLiveCeiling({ name: 'X5', family: 'ComputeOptimized', memoryGb: 6, capacityGb: 5 }, ceiling), true);
});

test('SKUs above the ceiling on memory or capacity are rejected as within-budget', () => {
  const ceiling = deriveLiveCeiling(fakeSkuCatalog());
  assert.equal(isSkuWithinLiveCeiling({ name: 'B10', family: 'Balanced', memoryGb: 10, capacityGb: 10 }, ceiling), false);
  assert.equal(isSkuWithinLiveCeiling({ name: 'X50', family: 'ComputeOptimized', memoryGb: 60, capacityGb: 50 }, ceiling), false);
});

test('classifySkuRequest marks out-of-budget SKUs dry-run-only rather than rejecting them', () => {
  const catalog = fakeSkuCatalog();
  const withinBudget = classifySkuRequest(catalog, 'B1', 'Balanced');
  assert.equal(withinBudget.dryRunOnly, false);

  const overBudget = classifySkuRequest(catalog, 'M10', 'MemoryOptimized');
  assert.equal(overBudget.withinCeiling, false);
  assert.equal(overBudget.dryRunOnly, true);
});

test('classifySkuRequest throws for an unknown SKU/family combination', () => {
  assert.throws(() => classifySkuRequest(fakeSkuCatalog(), 'DOES-NOT-EXIST', 'Balanced'), CatalogError);
});

test('isSkuWithinLiveCeiling rejects unrecognized families', () => {
  const ceiling = deriveLiveCeiling(fakeSkuCatalog());
  assert.throws(
    () => isSkuWithinLiveCeiling({ name: 'Z1', family: 'Quantum', memoryGb: 1 }, ceiling),
    CatalogError
  );
});

// ---- Real ARM sku naming: "Family_Size" combined string, B0 omits capacity ----

test('buildArmSkuName combines family and size into the real ARM sku.name string', () => {
  assert.equal(buildArmSkuName({ family: 'Balanced', name: 'B0' }), 'Balanced_B0');
  assert.equal(buildArmSkuName({ family: 'MemoryOptimized', name: 'M10' }), 'MemoryOptimized_M10');
  assert.equal(buildArmSkuName({ family: 'ComputeOptimized', name: 'X5' }), 'ComputeOptimized_X5');
});

test('buildArmSkuName rejects an unrecognized family or a missing size name', () => {
  assert.throws(() => buildArmSkuName({ family: 'Quantum', name: 'Q1' }), CatalogError);
  assert.throws(() => buildArmSkuName({ family: 'Balanced' }), CatalogError);
});

test('buildArmSkuBody omits capacity ONLY for exactly Balanced B0', () => {
  const b0Body = buildArmSkuBody({ family: 'Balanced', name: 'B0' });
  assert.deepEqual(b0Body, { name: 'Balanced_B0' });
  assert.equal('capacity' in b0Body, false);
});

test('buildArmSkuBody requires and includes capacity for every SKU other than Balanced B0', () => {
  assert.deepEqual(buildArmSkuBody({ family: 'Balanced', name: 'B1', capacity: 1 }), { name: 'Balanced_B1', capacity: 1 });
  assert.deepEqual(
    buildArmSkuBody({ family: 'MemoryOptimized', name: 'M10', capacity: 10 }),
    { name: 'MemoryOptimized_M10', capacity: 10 }
  );
  assert.deepEqual(buildArmSkuBody({ family: 'Balanced', name: 'B1', capacityGb: 1 }), { name: 'Balanced_B1', capacity: 1 });
});

test('buildArmSkuBody fails closed if a non-B0 SKU is missing capacity entirely', () => {
  assert.throws(() => buildArmSkuBody({ family: 'MemoryOptimized', name: 'M10' }), CatalogError);
  assert.throws(() => buildArmSkuBody({ family: 'Balanced', name: 'B1' }), CatalogError);
});
