import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResourceLedger } from '../../src/cache/ledger.mjs';
import { LocalRpHttpAdapter } from '../../src/cache/http-adapter.mjs';
import { claimPidFile, writeHeartbeat, readHeartbeat, runJanitorPass, JanitorError } from '../../src/cache/janitor.mjs';
import { createFakeRp } from './fakes/fake-rp.mjs';

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'amr-soak-janitor-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('claimPidFile writes this process PID when no PID file exists yet', () => {
  withTempDir((dir) => {
    const pidPath = join(dir, 'janitor.pid');
    const claimed = claimPidFile(pidPath, { pid: 4242, isAlive: () => false });
    assert.equal(claimed, 4242);
    assert.equal(readFileSync(pidPath, 'utf8').trim(), '4242');
  });
});

test('claimPidFile replaces a stale PID file whose process is no longer alive', () => {
  withTempDir((dir) => {
    const pidPath = join(dir, 'janitor.pid');
    claimPidFile(pidPath, { pid: 111, isAlive: () => false }); // first (dead) janitor
    const claimed = claimPidFile(pidPath, { pid: 222, isAlive: (pid) => pid === 111 ? false : true });
    assert.equal(claimed, 222);
    assert.equal(readFileSync(pidPath, 'utf8').trim(), '222');
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

test('runJanitorPass produces zero-orphan evidence when the ledger and RP already agree', async () => {
  await withTempDir(async (dir) => {
    const ledger = new ResourceLedger({ path: join(dir, 'ledger.jsonl') });
    ledger.append('created', 'dmon-run1-cache1');
    const fake = createFakeRp({ initialCaches: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const evidence = await runJanitorPass({ ledger, adapter, resourcePrefix: 'dmon-run1-', now: () => 42 });
    assert.equal(evidence.zeroOrphans, true);
    assert.equal(evidence.orphanCount, 0);
    assert.deepEqual(evidence.orphans, []);
    assert.equal(evidence.ts, 42);
  });
});

test('runJanitorPass adopts a crash-orphaned resource and reports zero orphans afterward', async () => {
  await withTempDir(async (dir) => {
    const ledger = new ResourceLedger({ path: join(dir, 'ledger.jsonl') });
    // Ledger has nothing; RP has a resource under our prefix (simulated crash before ledger append).
    const fake = createFakeRp({ initialCaches: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const evidence = await runJanitorPass({ ledger, adapter, resourcePrefix: 'dmon-run1-' });
    // reconcileOnStartup adopts the orphan into the ledger *during this pass*,
    // so by the time orphan-detection runs, ledger and RP already agree.
    assert.deepEqual(evidence.reconciliation.adoptedOrphans, ['dmon-run1-cache1']);
    assert.equal(evidence.zeroOrphans, true);
    assert.deepEqual(ledger.activeResources(), ['dmon-run1-cache1']);
  });
});

test('runJanitorPass never reports resources outside our prefix as orphans (isolation)', async () => {
  await withTempDir(async (dir) => {
    const ledger = new ResourceLedger({ path: join(dir, 'ledger.jsonl') });
    const fake = createFakeRp({ initialCaches: [{ name: 'other-owner-run9-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });

    const evidence = await runJanitorPass({ ledger, adapter, resourcePrefix: 'dmon-run1-' });
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
