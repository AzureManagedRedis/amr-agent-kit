import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGeoCardinality, GeoTestOnlyViolation } from '../../src/cache/geo-cardinality.mjs';

// Geo cardinality is unit-test-only: these tests set AMR_SOAK_TEST=1
// explicitly via the injectable `env` option (never mutating the real
// process.env) to prove both that (a) the guard blocks non-test contexts and
// (b) the function itself is fully correct when legitimately invoked from a
// test.

test('computeGeoCardinality refuses to run outside the test environment', () => {
  assert.throws(
    () => computeGeoCardinality({ regions: ['eastus'] }, { env: {} }),
    GeoTestOnlyViolation
  );
  assert.throws(
    () => computeGeoCardinality({ regions: ['eastus'] }, { env: { AMR_SOAK_TEST: '0' } }),
    GeoTestOnlyViolation
  );
});

test('computeGeoCardinality runs when AMR_SOAK_TEST=1 is explicitly set', () => {
  const result = computeGeoCardinality({ regions: ['eastus', 'westus'] }, { env: { AMR_SOAK_TEST: '1' } });
  assert.equal(result.cardinality, 2);
  assert.equal(result.withinMax, true);
  assert.equal(result.duplicates, 0);
});

test('computeGeoCardinality counts duplicate regions and reports them separately from cardinality', () => {
  const result = computeGeoCardinality(
    { regions: ['eastus', 'eastus', 'westus'] },
    { env: { AMR_SOAK_TEST: '1' } }
  );
  assert.equal(result.cardinality, 2);
  assert.equal(result.duplicates, 1);
});

test('computeGeoCardinality flags a topology exceeding maxRegions', () => {
  const result = computeGeoCardinality(
    { regions: ['eastus', 'westus', 'northeurope'] },
    { maxRegions: 2, env: { AMR_SOAK_TEST: '1' } }
  );
  assert.equal(result.withinMax, false);
});

test('computeGeoCardinality validates topology.regions shape', () => {
  assert.throws(() => computeGeoCardinality({}, { env: { AMR_SOAK_TEST: '1' } }), TypeError);
});
