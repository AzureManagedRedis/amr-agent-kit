import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as CacheSafety from '../../src/cache/index.mjs';

// Smoke test: the public API surface aggregates every module's exports and
// nothing throws merely from importing the barrel file (in particular,
// janitor.mjs's "run standalone" detection must be a no-op under test).

test('index.mjs re-exports the full public API surface', () => {
  const expectedExports = [
    'redactString',
    'redactValue',
    'redactForLog',
    'createRedactingLogger',
    'loadRuntimeConfig',
    'ConfigError',
    'describeConfig',
    'LOCAL_RP_HOST',
    'LOCAL_RP_PORT',
    'LocalRpHttpAdapter',
    'AdapterError',
    'deriveLiveCeiling',
    'isSkuWithinLiveCeiling',
    'classifySkuRequest',
    'CatalogError',
    'KillSwitch',
    'KillSwitchEngaged',
    'assertCustomerSubscriptionAcknowledged',
    'assertNotDenylisted',
    'assertOwnedResource',
    'assertNotPreExisting',
    'assertSafeToMutate',
    'GuardViolation',
    'LeaseManager',
    'LeaseError',
    'LEASE_CLASSES',
    'MAX_ACTIVE_LEASES',
    'ResourceLedger',
    'LedgerError',
    'reconcileOnStartup',
    'pollUntilTerminal',
    'ReconciliationError',
    'reverseCleanup',
    'CleanupError',
    'claimPidFile',
    'writeHeartbeat',
    'readHeartbeat',
    'runJanitorPass',
    'startJanitor',
    'JanitorError',
    'computeGeoCardinality',
    'GeoTestOnlyViolation',
  ];
  for (const name of expectedExports) {
    assert.notEqual(CacheSafety[name], undefined, `expected export "${name}" to be defined`);
  }
});
