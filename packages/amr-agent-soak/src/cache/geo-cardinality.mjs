// Geo-replication cardinality logic for the live-cache safety subsystem.
//
// This logic is UNIT-TEST-ONLY: it must never be exercised against the live
// local RP or wired into any live mutating path. The runtime guard below
// enforces that -- the function refuses to execute unless AMR_SOAK_TEST=1 is
// set, which only the test suite should ever set.

export class GeoTestOnlyViolation extends Error {
  constructor(message) {
    super(message);
    this.name = 'GeoTestOnlyViolation';
  }
}

function assertTestOnlyContext(env) {
  if (env.AMR_SOAK_TEST !== '1') {
    throw new GeoTestOnlyViolation(
      'Geo cardinality logic is unit-test-only and may not run outside the test environment (AMR_SOAK_TEST=1).'
    );
  }
}

/**
 * Computes geo-replication cardinality for a proposed topology: the number
 * of unique linked regions and whether it is within an allowed maximum.
 * Unit-test-only -- see module header.
 *
 * @param {{ regions: string[] }} topology
 * @param {{ maxRegions?: number, env?: NodeJS.ProcessEnv }} [opts]
 */
export function computeGeoCardinality(topology, { maxRegions = 5, env = process.env } = {}) {
  assertTestOnlyContext(env);
  if (!topology || !Array.isArray(topology.regions)) {
    throw new TypeError('topology.regions must be an array of region names.');
  }
  const uniqueRegions = new Set(topology.regions);
  return {
    cardinality: uniqueRegions.size,
    withinMax: uniqueRegions.size <= maxRegions,
    duplicates: topology.regions.length - uniqueRegions.size,
  };
}
