import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntimeConfig } from '../../src/cache/config.mjs';
import { assertSafeToMutate, GuardViolation } from '../../src/cache/guards.mjs';
import { LocalRpHttpAdapter } from '../../src/cache/http-adapter.mjs';
import { ResourceLedger } from '../../src/cache/ledger.mjs';
import { reverseCleanup } from '../../src/cache/cleanup.mjs';
import { LeaseManager } from '../../src/cache/lease-manager.mjs';
import { createFakeRp } from './fakes/fake-rp.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Dedicated isolation coverage: two runs (different owner/runId) must never
// be able to see, mutate, or clean up each other's resources, even though
// they share the same local RP instance.

function baseEnv(overrides) {
  return {
    AMR_SOAK_SUBSCRIPTION_ID: '11111111-2222-3333-4444-555555555555',
    AMR_SOAK_TENANT_ID: '66666666-7777-8888-9999-aaaaaaaaaaaa',
    AMR_SOAK_ACK_CUSTOMER_SUBSCRIPTION: 'true',
    ...overrides,
  };
}

test('two runs derive disjoint resource prefixes from owner+runId', () => {
  const runA = loadRuntimeConfig(baseEnv({ AMR_SOAK_OWNER: 'dmon', AMR_SOAK_RUN_ID: 'run1' }));
  const runB = loadRuntimeConfig(baseEnv({ AMR_SOAK_OWNER: 'phil', AMR_SOAK_RUN_ID: 'run2' }));
  assert.notEqual(runA.resourcePrefix, runB.resourcePrefix);
  assert.equal('phil-run2-cacheX'.startsWith(runA.resourcePrefix), false);
  assert.equal('dmon-run1-cacheX'.startsWith(runB.resourcePrefix), false);
});

test('run A cannot mutate a resource that belongs to run B, even with no denylist configured', () => {
  const runA = loadRuntimeConfig(baseEnv({ AMR_SOAK_OWNER: 'dmon', AMR_SOAK_RUN_ID: 'run1' }));
  assert.throws(
    () => assertSafeToMutate('phil-run2-cache1', { resourcePrefix: runA.resourcePrefix, denylist: runA.denylist }),
    GuardViolation
  );
});

test('run A cleanup never deletes run B resources sharing the same fake RP instance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amr-soak-isolation-'));
  try {
    const runA = loadRuntimeConfig(baseEnv({ AMR_SOAK_OWNER: 'dmon', AMR_SOAK_RUN_ID: 'run1' }));
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }, { name: 'phil-run2-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const ledgerA = new ResourceLedger({ path: join(dir, 'ledgerA.jsonl') });
    ledgerA.append('created', 'dmon-run1-cache1');

    const leaseManager = new LeaseManager();
    const lease = leaseManager.acquire({ class: 'exclusive' });
    const resultsA = await reverseCleanup({ ledger: ledgerA, adapter, config: runA, lease, leaseManager });
    assert.deepEqual(resultsA.map((r) => r.resourceName), ['dmon-run1-cache1']);
    assert.equal(fake._clusters.has('phil-run2-cache1'), true); // run B's cache is untouched
    assert.equal(fake._clusters.has('dmon-run1-cache1'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
