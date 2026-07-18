import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync } from 'node:fs';
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
  claimJanitorIdentity,
  buildOwnIdentity,
  readJanitorIdentity,
} from '../../src/cache/janitor.mjs';
import { GuardViolation } from '../../src/cache/guards.mjs';
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

test('claimPidFile writes this process PID when no PID file exists yet (atomic exclusive create)', async () => {
  await withTempDir((dir) => {
    const pidPath = join(dir, 'janitor.pid');
    const claimed = claimPidFile(pidPath, { pid: 4242, isAlive: () => false });
    assert.equal(claimed, 4242);
    assert.equal(readFileSync(pidPath, 'utf8').trim(), '4242');
  });
});

test('claimPidFile replaces a stale PID file whose process is no longer alive (unlink + retry, never rename-onto-existing)', async () => {
  await withTempDir((dir) => {
    const pidPath = join(dir, 'janitor.pid');
    claimPidFile(pidPath, { pid: 111, isAlive: () => false }); // first (dead) janitor
    const claimed = claimPidFile(pidPath, { pid: 222, isAlive: (pid) => (pid === 111 ? false : true) });
    assert.equal(claimed, 222);
    assert.equal(readFileSync(pidPath, 'utf8').trim(), '222');
    // No temp files are ever created by this implementation (no rename-onto-existing-destination step).
    const leftoverTemps = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftoverTemps, []);
  });
});

test('claimPidFile refuses a second janitor while the existing PID is genuinely alive', async () => {
  await withTempDir((dir) => {
    const pidPath = join(dir, 'janitor.pid');
    claimPidFile(pidPath, { pid: 111, isAlive: () => true });
    assert.throws(() => claimPidFile(pidPath, { pid: 222, isAlive: (pid) => pid === 111 }), JanitorError);
  });
});

test('claimPidFile is idempotent for exactly the same PID (re-claiming your own PID succeeds)', async () => {
  await withTempDir((dir) => {
    const pidPath = join(dir, 'janitor.pid');
    claimPidFile(pidPath, { pid: 111, isAlive: () => true });
    assert.doesNotThrow(() => claimPidFile(pidPath, { pid: 111, isAlive: () => true }));
  });
});

// ---- Windows regression: renameSync cannot reliably replace an existing
// destination file (raises EPERM); claimPidFile must never rely on that. ----

test('claimPidFile reliably replaces a stale PID file across many repeated cycles (Windows regression)', async () => {
  await withTempDir((dir) => {
    const pidPath = join(dir, 'janitor.pid');
    claimPidFile(pidPath, { pid: 1000, isAlive: () => false });
    for (let pid = 1001; pid <= 1025; pid += 1) {
      const claimed = claimPidFile(pidPath, { pid, isAlive: () => false });
      assert.equal(claimed, pid);
      assert.equal(readFileSync(pidPath, 'utf8').trim(), String(pid));
    }
  });
});

test('claimPidFile never lets two concurrent claimants both win a stale replacement (regression)', async () => {
  await withTempDir((dir) => {
    const pidPath = join(dir, 'janitor.pid');
    claimPidFile(pidPath, { pid: 111, isAlive: () => false }); // a stale, dead janitor's leftover file

    // Simulate a genuine concurrent claimant: the instant our stale file is
    // unlinked, another process's exclusive create "wins" the race and
    // plants its own (alive) PID before we get to retry ours.
    const unlink = (targetPath) => {
      unlinkSync(targetPath);
      writeFileSync(targetPath, '333', 'utf8');
    };

    assert.throws(
      () => claimPidFile(pidPath, { pid: 222, isAlive: (candidatePid) => candidatePid === 333, unlink }),
      JanitorError
    );
    // The concurrent claimant's file must be left completely untouched by us.
    assert.equal(readFileSync(pidPath, 'utf8').trim(), '333');
  });
});
// ---- Final-review finding: identity-safe janitor claim (not PID-only) --
// closes the PID-reuse gap in claimPidFile ----

test('claimJanitorIdentity writes a structured identity when no claim file exists yet', async () => {
  await withTempDir((dir) => {
    const identityPath = join(dir, 'janitor.json');
    const identity = buildOwnIdentity({ pid: 4242, startedAt: 1000, name: 'node', executablePath: '/usr/bin/node' });
    const claimed = claimJanitorIdentity(identityPath, { identity, resolveIdentity: () => null, isAlive: () => false });
    assert.deepEqual(claimed, identity);
    assert.deepEqual(readJanitorIdentity(identityPath), identity);
  });
});

test('claimJanitorIdentity is idempotent for exactly the same identity (re-claiming our own identity succeeds)', async () => {
  await withTempDir((dir) => {
    const identityPath = join(dir, 'janitor.json');
    const identity = buildOwnIdentity({ pid: 111, startedAt: 1000, name: 'node', executablePath: '/usr/bin/node' });
    claimJanitorIdentity(identityPath, { identity, resolveIdentity: () => identity, isAlive: () => true });
    assert.doesNotThrow(() => claimJanitorIdentity(identityPath, { identity, resolveIdentity: () => identity, isAlive: () => true }));
  });
});

test('claimJanitorIdentity refuses a second janitor while the recorded identity is confirmed still alive AND matching', async () => {
  await withTempDir((dir) => {
    const identityPath = join(dir, 'janitor.json');
    const firstIdentity = buildOwnIdentity({ pid: 111, startedAt: 1000, name: 'node', executablePath: '/usr/bin/node' });
    claimJanitorIdentity(identityPath, { identity: firstIdentity, resolveIdentity: () => null, isAlive: () => false });

    const secondIdentity = buildOwnIdentity({ pid: 222, startedAt: 2000, name: 'node', executablePath: '/usr/bin/node' });
    // resolveIdentity confirms PID 111 is alive AND is genuinely the same
    // process that recorded the claim (matching identity).
    assert.throws(
      () =>
        claimJanitorIdentity(identityPath, {
          identity: secondIdentity,
          resolveIdentity: (pid) => (pid === 111 ? firstIdentity : null),
        }),
      JanitorError
    );
    // The original claim must be left untouched.
    assert.deepEqual(readJanitorIdentity(identityPath), firstIdentity);
  });
});

test('claimJanitorIdentity rejects PID reuse: same PID number, but resolveIdentity proves it is a DIFFERENT process (different startedAt/executablePath) -- treated as stale, not alive', async () => {
  await withTempDir((dir) => {
    const identityPath = join(dir, 'janitor.json');
    // The ORIGINAL janitor recorded this identity under PID 111, then crashed.
    const originalIdentity = buildOwnIdentity({ pid: 111, startedAt: 1000, name: 'node', executablePath: '/usr/bin/node' });
    claimJanitorIdentity(identityPath, { identity: originalIdentity, resolveIdentity: () => null, isAlive: () => false });

    // The OS reused PID 111 for a completely unrelated process (e.g. a
    // shell) that started much later -- same PID number, different
    // identity entirely.
    const reusedProcessIdentity = buildOwnIdentity({ pid: 111, startedAt: 999999, name: 'bash', executablePath: '/bin/bash' });
    const newIdentity = buildOwnIdentity({ pid: 222, startedAt: 5000, name: 'node', executablePath: '/usr/bin/node' });

    const claimed = claimJanitorIdentity(identityPath, {
      identity: newIdentity,
      resolveIdentity: (pid) => (pid === 111 ? reusedProcessIdentity : null),
      // A naive PID-only liveness check would say "alive" here -- but it
      // must never even be consulted for a PID resolveIdentity CAN answer.
      isAlive: () => true,
    });

    assert.deepEqual(claimed, newIdentity);
    assert.deepEqual(readJanitorIdentity(identityPath), newIdentity); // the reused-PID claim was safely replaced
  });
});

test('claimJanitorIdentity treats the SAME PID with a materially different startedAt as a non-match (PID reuse variant)', async () => {
  await withTempDir((dir) => {
    const identityPath = join(dir, 'janitor.json');
    const originalIdentity = buildOwnIdentity({ pid: 111, startedAt: 1000, name: 'node', executablePath: '/usr/bin/node' });
    claimJanitorIdentity(identityPath, { identity: originalIdentity, resolveIdentity: () => null, isAlive: () => false });

    // Same pid, same name/executablePath, but startedAt is wildly
    // different (far beyond the tolerance) -- a different process
    // instance that happened to reuse both the PID and the executable.
    const differentInstanceSamePid = buildOwnIdentity({ pid: 111, startedAt: 999999999, name: 'node', executablePath: '/usr/bin/node' });
    const newIdentity = buildOwnIdentity({ pid: 222, startedAt: 5000, name: 'node', executablePath: '/usr/bin/node' });

    const claimed = claimJanitorIdentity(identityPath, {
      identity: newIdentity,
      resolveIdentity: (pid) => (pid === 111 ? differentInstanceSamePid : null),
    });
    assert.deepEqual(claimed, newIdentity);
  });
});

test('claimJanitorIdentity: a small startedAt difference within tolerance is still considered the SAME process (measurement imprecision)', async () => {
  await withTempDir((dir) => {
    const identityPath = join(dir, 'janitor.json');
    const originalIdentity = buildOwnIdentity({ pid: 111, startedAt: 1000, name: 'node', executablePath: '/usr/bin/node' });
    claimJanitorIdentity(identityPath, { identity: originalIdentity, resolveIdentity: () => null, isAlive: () => false });

    const slightlyDifferentReading = buildOwnIdentity({ pid: 111, startedAt: 1500, name: 'node', executablePath: '/usr/bin/node' }); // 500ms off, well within default tolerance
    const newIdentity = buildOwnIdentity({ pid: 222, startedAt: 5000 });

    assert.throws(
      () =>
        claimJanitorIdentity(identityPath, {
          identity: newIdentity,
          resolveIdentity: (pid) => (pid === 111 ? slightlyDifferentReading : null),
        }),
      JanitorError
    );
  });
});

test('claimJanitorIdentity falls back to a plain liveness check (fail closed) when resolveIdentity cannot determine identity for another PID', async () => {
  await withTempDir((dir) => {
    const identityPath = join(dir, 'janitor.json');
    const originalIdentity = buildOwnIdentity({ pid: 111, startedAt: 1000 });
    claimJanitorIdentity(identityPath, { identity: originalIdentity, resolveIdentity: () => null, isAlive: () => false });

    const newIdentity = buildOwnIdentity({ pid: 222, startedAt: 5000 });
    // resolveIdentity cannot answer for PID 111 (returns null); isAlive says
    // "yes, something is running there" -- fail closed: refuse, exactly
    // like the legacy PID-only claimPidFile always did.
    assert.throws(
      () => claimJanitorIdentity(identityPath, { identity: newIdentity, resolveIdentity: () => null, isAlive: () => true }),
      JanitorError
    );
  });
});

test('claimJanitorIdentity replaces a genuinely dead claimant (resolveIdentity null AND isAlive false)', async () => {
  await withTempDir((dir) => {
    const identityPath = join(dir, 'janitor.json');
    const originalIdentity = buildOwnIdentity({ pid: 111, startedAt: 1000 });
    claimJanitorIdentity(identityPath, { identity: originalIdentity, resolveIdentity: () => null, isAlive: () => false });

    const newIdentity = buildOwnIdentity({ pid: 222, startedAt: 5000 });
    const claimed = claimJanitorIdentity(identityPath, { identity: newIdentity, resolveIdentity: () => null, isAlive: () => false });
    assert.deepEqual(claimed, newIdentity);
  });
});

test('claimJanitorIdentity never lets two concurrent claimants both win a stale replacement (regression, identity-based)', async () => {
  await withTempDir((dir) => {
    const identityPath = join(dir, 'janitor.json');
    const originalIdentity = buildOwnIdentity({ pid: 111, startedAt: 1000 });
    claimJanitorIdentity(identityPath, { identity: originalIdentity, resolveIdentity: () => null, isAlive: () => false });

    // A genuine concurrent claimant: the instant our stale file is
    // unlinked, another process's exclusive create wins the race and
    // plants its OWN (alive, matching) identity before our retry.
    const concurrentIdentity = buildOwnIdentity({ pid: 333, startedAt: 9000 });
    const unlink = (targetPath) => {
      unlinkSync(targetPath);
      writeFileSync(targetPath, JSON.stringify(concurrentIdentity), 'utf8');
    };

    const ourIdentity = buildOwnIdentity({ pid: 222, startedAt: 5000 });
    assert.throws(
      () =>
        claimJanitorIdentity(identityPath, {
          identity: ourIdentity,
          resolveIdentity: (pid) => (pid === 333 ? concurrentIdentity : null),
          unlink,
        }),
      JanitorError
    );
    // The concurrent claimant's identity must be left completely untouched by us.
    assert.deepEqual(readJanitorIdentity(identityPath), concurrentIdentity);
  });
});

test('claimJanitorIdentity treats a corrupt/unparseable claim file as stale rather than blocking forever', async () => {
  await withTempDir((dir) => {
    const identityPath = join(dir, 'janitor.json');
    writeFileSync(identityPath, 'not-json-at-all{{{', 'utf8');

    const newIdentity = buildOwnIdentity({ pid: 222, startedAt: 5000 });
    const claimed = claimJanitorIdentity(identityPath, { identity: newIdentity, resolveIdentity: () => null, isAlive: () => false });
    assert.deepEqual(claimed, newIdentity);
  });
});

test('startJanitor accepts an injectable identity/resolveIdentity for real SystemProcessManager integration', async () => {
  await withTempDir(async (dir) => {
    const ledger = new ResourceLedger({ path: join(dir, 'ledger.jsonl') });
    const fake = createFakeRp({});
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    const leaseManager = new LeaseManager();
    const identityPath = join(dir, 'j.json');
    const identity = buildOwnIdentity({ pid: 4242, startedAt: 1000, name: 'node', executablePath: '/usr/bin/node' });

    const handle = await startJanitor({
      pidFilePath: identityPath,
      heartbeatFilePath: join(dir, 'j.hb.json'),
      ledger,
      adapter,
      config: testConfig(),
      leaseManager,
      intervalMs: 100000,
      unref: true,
      identity,
      resolveIdentity: () => null,
      isAlive: () => false,
    });
    try {
      assert.deepEqual(readJanitorIdentity(identityPath), identity);
    } finally {
      handle.stop();
    }
  });
});

test('writeHeartbeat / readHeartbeat round-trip exact PID and timestamp', async () => {
  await withTempDir((dir) => {
    const hbPath = join(dir, 'janitor.heartbeat.json');
    const written = writeHeartbeat(hbPath, { pid: 555, now: () => 123456 });
    assert.deepEqual(written, { pid: 555, ts: 123456 });
    assert.deepEqual(readHeartbeat(hbPath), { pid: 555, ts: 123456 });
  });
});

test('readHeartbeat returns null when no heartbeat has ever been written', async () => {
  await withTempDir((dir) => {
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

// ---- Final-review finding: subscription denylist -- rejected BEFORE any
// adapter call, including the janitor's own entry point ----

test('runJanitorPass rejects a denylisted subscription before ever calling the adapter', async () => {
  await withTempDir(async (dir) => {
    const ledger = new ResourceLedger({ path: join(dir, 'ledger.jsonl') });
    ledger.append('created', 'dmon-run1-cache1');
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    const leaseManager = new LeaseManager();

    await assert.rejects(
      () =>
        runJanitorPass({
          ledger,
          adapter,
          config: testConfig({ subscriptionDenylist: ['11111111-2222-3333-4444-555555555555'] }),
          leaseManager,
        }),
      GuardViolation
    );
    assert.equal(fake._requestLog.length, 0); // no adapter call was ever made
    assert.deepEqual(ledger.activeResources(), ['dmon-run1-cache1']); // untouched
  });
});

test('runJanitorPass proceeds normally when the subscription is not denylisted', async () => {
  await withTempDir(async (dir) => {
    const ledger = new ResourceLedger({ path: join(dir, 'ledger.jsonl') });
    ledger.append('created', 'dmon-run1-cache1');
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    const leaseManager = new LeaseManager();

    const evidence = await runJanitorPass({
      ledger,
      adapter,
      config: testConfig({ subscriptionDenylist: ['66666666-7777-8888-9999-aaaaaaaaaaaa'] }), // unrelated
      leaseManager,
    });
    assert.equal(evidence.zeroOrphans, true);
    assert.ok(fake._requestLog.length > 0);
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

test('janitor evidence path files exist after claimPidFile + writeHeartbeat are exercised together', async () => {
  await withTempDir((dir) => {
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
