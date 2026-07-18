import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResourceLedger } from '../../src/cache/ledger.mjs';
import { LocalRpHttpAdapter } from '../../src/cache/http-adapter.mjs';
import { LeaseManager } from '../../src/cache/lease-manager.mjs';
import { buildResourceTags } from '../../src/cache/tags.mjs';
import {
  claimPidFile,
  writeHeartbeat,
  readHeartbeat,
  runJanitorPass,
  startJanitor,
  JanitorError,
} from '../../src/cache/janitor.mjs';
import { createFakeRp } from './fakes/fake-rp.mjs';

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'amr-soak-janitor-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function testConfig(overrides = {}) {
  return {
    subscriptionId: '11111111-2222-3333-4444-555555555555',
    resourceGroup: 'rg1',
    resourcePrefix: 'dmon-run1-',
    denylist: [],
    ownerAlias: 'dmon',
    runId: 'run1',
    acknowledgedCustomerSubscription: true,
    ...overrides,
  };
}

// ---- Finding #9: atomic PID claim ----

test('claimPidFile writes this process PID when no PID file exists yet (atomic exclusive create)', () => {
  withTempDir((dir) => {
    const pidPath = join(dir, 'janitor.pid');
    const claimed = claimPidFile(pidPath, { pid: 4242, isAlive: () => false });
    assert.equal(claimed, 4242);
    assert.equal(readFileSync(pidPath, 'utf8').trim(), '4242');
  });
});

test('claimPidFile replaces a stale PID file whose process is no longer alive, via temp-file + rename', () => {
  withTempDir((dir) => {
    const pidPath = join(dir, 'janitor.pid');
    claimPidFile(pidPath, { pid: 111, isAlive: () => false }); // first (dead) janitor
    const claimed = claimPidFile(pidPath, { pid: 222, isAlive: (pid) => (pid === 111 ? false : true) });
    assert.equal(claimed, 222);
    assert.equal(readFileSync(pidPath, 'utf8').trim(), '222');
    // No leftover temp files from the rename-based replacement.
    const leftoverTemps = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftoverTemps, []);
  });
});

test('claimPidFile refuses a second janitor while the existing PID is genuinely alive', () => {
  withTempDir((dir) => {
    const pidPath = join(dir, 'janitor.pid');
    claimPidFile(pidPath, { pid: 111, isAlive: () => true });
    assert.throws(() => claimPidFile(pidPath, { pid: 222, isAlive: (pid) => pid === 111 }), JanitorError);
  });
});

test('claimPidFile is idempotent for exactly the same PID (re-claiming your own PID succeeds)', () => {
  withTempDir((dir) => {
    const pidPath = join(dir, 'janitor.pid');
    claimPidFile(pidPath, { pid: 111, isAlive: () => true });
    assert.doesNotThrow(() => claimPidFile(pidPath, { pid: 111, isAlive: () => true }));
  });
});

test('writeHeartbeat / readHeartbeat round-trip exact PID and timestamp', () => {
  withTempDir((dir) => {
    const hbPath = join(dir, 'janitor.heartbeat.json');
    const written = writeHeartbeat(hbPath, { pid: 555, now: () => 123456 });
    assert.deepEqual(written, { pid: 555, ts: 123456 });
    assert.deepEqual(readHeartbeat(hbPath), { pid: 555, ts: 123456 });
  });
});

test('readHeartbeat returns null when no heartbeat has ever been written', () => {
  withTempDir((dir) => {
    assert.equal(readHeartbeat(join(dir, 'never-written.json')), null);
  });
});

// ---- runJanitorPass: zero-orphan evidence, quarantine, and real expired-orphan cleanup ----

test('runJanitorPass produces zero-orphan evidence when the ledger and RP already agree', async () => {
  await withTempDir(async (dir) => {
    const ledger = new ResourceLedger({ path: join(dir, 'ledger.jsonl') });
    ledger.append('created', 'dmon-run1-cache1');
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    const leaseManager = new LeaseManager();

    const evidence = await runJanitorPass({ ledger, adapter, config: testConfig(), leaseManager, now: () => 42 });
    assert.equal(evidence.zeroOrphans, true);
    assert.equal(evidence.orphanCount, 0);
    assert.deepEqual(evidence.orphans, []);
    assert.equal(evidence.ts, 42);
  });
});

test('runJanitorPass quarantines (never adopts) a live resource with zero ledger evidence, and reports it as an orphan', async () => {
  await withTempDir(async (dir) => {
    const ledger = new ResourceLedger({ path: join(dir, 'ledger.jsonl') });
    // Ledger has never heard of this resource at all -- no intent, no created.
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    const leaseManager = new LeaseManager();

    const evidence = await runJanitorPass({ ledger, adapter, config: testConfig(), leaseManager });
    assert.deepEqual(evidence.reconciliation.confirmedIntents, []);
    assert.deepEqual(evidence.quarantined, [{ resourceName: 'dmon-run1-cache1', reason: 'no-creation-intent-evidence' }]);
    assert.equal(evidence.zeroOrphans, false);
    assert.deepEqual(evidence.orphans, ['dmon-run1-cache1']);
    assert.deepEqual(ledger.activeResources(), []); // never adopted
  });
});

test('runJanitorPass confirms an intent-evidenced crash orphan (legitimate recovery case) and reports zero orphans', async () => {
  await withTempDir(async (dir) => {
    const ledger = new ResourceLedger({ path: join(dir, 'ledger.jsonl') });
    ledger.append('creation-intent', 'dmon-run1-cache1', {});
    const tags = buildResourceTags({ ownerAlias: 'dmon', runId: 'run1', expiresInMs: 3600000 });
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1', tags }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    const leaseManager = new LeaseManager();

    const evidence = await runJanitorPass({ ledger, adapter, config: testConfig(), leaseManager });
    assert.deepEqual(evidence.reconciliation.confirmedIntents, ['dmon-run1-cache1']);
    assert.equal(evidence.zeroOrphans, true);
    assert.deepEqual(ledger.activeResources(), ['dmon-run1-cache1']);
  });
});

test('runJanitorPass DELETES (not merely retains) an intent-evidenced resource that is now tag-expired', async () => {
  await withTempDir(async (dir) => {
    const ledger = new ResourceLedger({ path: join(dir, 'ledger.jsonl') });
    ledger.append('creation-intent', 'dmon-run1-cache1', {});
    ledger.append('created', 'dmon-run1-cache1', {});
    const tags = buildResourceTags({ ownerAlias: 'dmon', runId: 'run1', expiresInMs: 1000, now: () => 1000 });
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1', tags }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    const leaseManager = new LeaseManager();

    // now() is far past ExpiresOn -- this resource is expired.
    const evidence = await runJanitorPass({ ledger, adapter, config: testConfig(), leaseManager, now: () => 999999 });

    assert.deepEqual(evidence.deletedExpired, ['dmon-run1-cache1']);
    assert.equal(fake._clusters.has('dmon-run1-cache1'), false); // actually deleted, not just re-labeled
    assert.equal(evidence.zeroOrphans, true);
    assert.deepEqual(ledger.activeResources(), []); // confirmed deleted in the ledger, not "active"
  });
});

test('runJanitorPass leaves a still-live, non-expired resource alone (does not delete it)', async () => {
  await withTempDir(async (dir) => {
    const ledger = new ResourceLedger({ path: join(dir, 'ledger.jsonl') });
    ledger.append('creation-intent', 'dmon-run1-cache1', {});
    ledger.append('created', 'dmon-run1-cache1', {});
    const tags = buildResourceTags({ ownerAlias: 'dmon', runId: 'run1', expiresInMs: 3600000, now: () => 1000 });
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1', tags }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    const leaseManager = new LeaseManager();

    const evidence = await runJanitorPass({ ledger, adapter, config: testConfig(), leaseManager, now: () => 2000 });
    assert.deepEqual(evidence.deletedExpired, []);
    assert.equal(fake._clusters.has('dmon-run1-cache1'), true);
    assert.deepEqual(ledger.activeResources(), ['dmon-run1-cache1']);
  });
});

test('runJanitorPass never reports resources outside our prefix as orphans (isolation)', async () => {
  await withTempDir(async (dir) => {
    const ledger = new ResourceLedger({ path: join(dir, 'ledger.jsonl') });
    const fake = createFakeRp({ initialClusters: [{ name: 'other-owner-run9-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    const leaseManager = new LeaseManager();

    const evidence = await runJanitorPass({ ledger, adapter, config: testConfig(), leaseManager });
    assert.equal(evidence.checkedLive, 0);
    assert.equal(evidence.zeroOrphans, true);
  });
});

test('janitor evidence path files exist after claimPidFile + writeHeartbeat are exercised together', () => {
  withTempDir((dir) => {
    const pidPath = join(dir, 'janitor.pid');
    const hbPath = join(dir, 'janitor.heartbeat.json');
    claimPidFile(pidPath, { pid: 999, isAlive: () => false });
    writeHeartbeat(hbPath, { pid: 999, now: () => 1 });
    assert.equal(existsSync(pidPath), true);
    assert.equal(existsSync(hbPath), true);
  });
});

// ---- Finding #3: standalone janitor must stay alive; only embedded/test mode unrefs ----

test('startJanitor keeps its interval timer ref-d (alive) by default -- a standalone process must not exit early', async () => {
  await withTempDir(async (dir) => {
    const ledger = new ResourceLedger({ path: join(dir, 'ledger.jsonl') });
    const fake = createFakeRp({});
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    const leaseManager = new LeaseManager();

    const handle = await startJanitor({
      pidFilePath: join(dir, 'j.pid'),
      heartbeatFilePath: join(dir, 'j.hb.json'),
      ledger,
      adapter,
      config: testConfig(),
      leaseManager,
      intervalMs: 100000,
    });
    try {
      assert.equal(handle.timer.hasRef(), true);
    } finally {
      handle.stop();
    }
  });
});

test('startJanitor(unref: true) unrefs the timer for embedded/test callers so it cannot hang their process', async () => {
  await withTempDir(async (dir) => {
    const ledger = new ResourceLedger({ path: join(dir, 'ledger.jsonl') });
    const fake = createFakeRp({});
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    const leaseManager = new LeaseManager();

    const handle = await startJanitor({
      pidFilePath: join(dir, 'j.pid'),
      heartbeatFilePath: join(dir, 'j.hb.json'),
      ledger,
      adapter,
      config: testConfig(),
      leaseManager,
      intervalMs: 100000,
      unref: true,
    });
    try {
      assert.equal(handle.timer.hasRef(), false);
    } finally {
      handle.stop();
    }
  });
});
