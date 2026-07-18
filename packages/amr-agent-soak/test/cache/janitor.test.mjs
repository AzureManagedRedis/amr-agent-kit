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
  writeJanitorHeartbeat,
  readJanitorHeartbeat,
  isHeartbeatFresh,
  heartbeatMatchesIdentity,
  isJanitorHeartbeatReady,
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

// ---- Final re-review finding: identity-safe heartbeat (not PID-only) --
// closes the same PID-reuse gap for readiness/liveness checks ----

test('writeJanitorHeartbeat / readJanitorHeartbeat round-trip the full structured identity plus timestamp', async () => {
  await withTempDir((dir) => {
    const hbPath = join(dir, 'janitor.heartbeat.json');
    const identity = buildOwnIdentity({ pid: 555, startedAt: 1000, name: 'node', executablePath: '/usr/bin/node' });
    const written = writeJanitorHeartbeat(hbPath, { identity, now: () => 123456 });
    assert.deepEqual(written, { pid: 555, startedAt: 1000, name: 'node', executablePath: '/usr/bin/node', ts: 123456 });
    assert.deepEqual(readJanitorHeartbeat(hbPath), written);
  });
});

test('writeJanitorHeartbeat round-trips an optional commandHash too', async () => {
  await withTempDir((dir) => {
    const hbPath = join(dir, 'janitor.heartbeat.json');
    const identity = buildOwnIdentity({ pid: 555, startedAt: 1000, name: 'node', executablePath: '/usr/bin/node', commandHash: 'abc123' });
    writeJanitorHeartbeat(hbPath, { identity, now: () => 1 });
    assert.equal(readJanitorHeartbeat(hbPath).commandHash, 'abc123');
  });
});

test('writeJanitorHeartbeat fails closed (throws) on a malformed identity shape', async () => {
  await withTempDir((dir) => {
    const hbPath = join(dir, 'janitor.heartbeat.json');
    assert.throws(() => writeJanitorHeartbeat(hbPath, { identity: { pid: 'not-a-number' } }), JanitorError);
    assert.throws(() => writeJanitorHeartbeat(hbPath, { identity: {} }), JanitorError);
    assert.equal(existsSync(hbPath), false); // nothing was ever written
  });
});

test('readJanitorHeartbeat returns null when no heartbeat has ever been written', async () => {
  await withTempDir((dir) => {
    assert.equal(readJanitorHeartbeat(join(dir, 'never-written.json')), null);
  });
});

test('readJanitorHeartbeat returns null (fails closed) for a corrupt/unparseable heartbeat file', async () => {
  await withTempDir((dir) => {
    const hbPath = join(dir, 'janitor.heartbeat.json');
    writeFileSync(hbPath, 'not-json-at-all{{{', 'utf8');
    assert.equal(readJanitorHeartbeat(hbPath), null);
  });
});

test('readJanitorHeartbeat returns null (fails closed) for valid JSON missing required identity fields', async () => {
  await withTempDir((dir) => {
    const hbPath = join(dir, 'janitor.heartbeat.json');
    writeFileSync(hbPath, JSON.stringify({ pid: 555, ts: 123 }), 'utf8'); // legacy shape -- no startedAt/name/executablePath
    assert.equal(readJanitorHeartbeat(hbPath), null);
  });
});

test('isHeartbeatFresh is true within maxAgeMs and false once stale', () => {
  const heartbeat = { pid: 1, startedAt: 0, name: 'node', executablePath: '/usr/bin/node', ts: 100000 };
  assert.equal(isHeartbeatFresh(heartbeat, { now: () => 150000, maxAgeMs: 90000 }), true); // 50s old, within 90s window
  assert.equal(isHeartbeatFresh(heartbeat, { now: () => 250000, maxAgeMs: 90000 }), false); // 150s old -- stale
});

test('isHeartbeatFresh rejects a null/missing heartbeat and a heartbeat claiming to be from the future', () => {
  assert.equal(isHeartbeatFresh(null), false);
  assert.equal(isHeartbeatFresh({ ts: 999999 }, { now: () => 0 }), false); // ts is "in the future" relative to now()
});

test('heartbeatMatchesIdentity: a same PID with a different startedAt/name/executablePath (PID reuse) is NOT a match', () => {
  const heartbeat = { pid: 111, startedAt: 1000, name: 'node', executablePath: '/usr/bin/node', ts: 5000 };
  const reusedProcessIdentity = buildOwnIdentity({ pid: 111, startedAt: 999999, name: 'bash', executablePath: '/bin/bash' });
  assert.equal(heartbeatMatchesIdentity(heartbeat, reusedProcessIdentity), false);
});

test('heartbeatMatchesIdentity: matching identity (same pid/startedAt/name/executablePath) is a match', () => {
  const heartbeat = { pid: 111, startedAt: 1000, name: 'node', executablePath: '/usr/bin/node', ts: 5000 };
  const sameIdentity = buildOwnIdentity({ pid: 111, startedAt: 1000, name: 'node', executablePath: '/usr/bin/node' });
  assert.equal(heartbeatMatchesIdentity(heartbeat, sameIdentity), true);
});

test('isJanitorHeartbeatReady requires fresh AND identity-matching -- a stale heartbeat fails readiness even with matching identity', async () => {
  await withTempDir((dir) => {
    const hbPath = join(dir, 'janitor.heartbeat.json');
    const identity = buildOwnIdentity({ pid: 111, startedAt: 1000, name: 'node', executablePath: '/usr/bin/node' });
    writeJanitorHeartbeat(hbPath, { identity, now: () => 0 });

    assert.equal(isJanitorHeartbeatReady(hbPath, { identity, now: () => 200000, maxAgeMs: 90000 }), false); // stale
  });
});

test('isJanitorHeartbeatReady fails for a fresh heartbeat whose PID matches but identity does not (PID reuse) -- readiness is not satisfied by PID alone', async () => {
  await withTempDir((dir) => {
    const hbPath = join(dir, 'janitor.heartbeat.json');
    const originalIdentity = buildOwnIdentity({ pid: 111, startedAt: 1000, name: 'node', executablePath: '/usr/bin/node' });
    writeJanitorHeartbeat(hbPath, { identity: originalIdentity, now: () => 0 });

    // A different process reused PID 111 and is now writing its OWN
    // "fresh" heartbeats under that same file -- readiness must still
    // fail against the ORIGINAL expected identity.
    const reusedIdentity = buildOwnIdentity({ pid: 111, startedAt: 999999, name: 'bash', executablePath: '/bin/bash' });
    writeJanitorHeartbeat(hbPath, { identity: reusedIdentity, now: () => 1000 });

    assert.equal(isJanitorHeartbeatReady(hbPath, { identity: originalIdentity, now: () => 2000, maxAgeMs: 90000 }), false);
  });
});

test('isJanitorHeartbeatReady succeeds for a fresh heartbeat with a matching identity', async () => {
  await withTempDir((dir) => {
    const hbPath = join(dir, 'janitor.heartbeat.json');
    const identity = buildOwnIdentity({ pid: 111, startedAt: 1000, name: 'node', executablePath: '/usr/bin/node' });
    writeJanitorHeartbeat(hbPath, { identity, now: () => 1000 });

    assert.equal(isJanitorHeartbeatReady(hbPath, { identity, now: () => 2000, maxAgeMs: 90000 }), true);
  });
});

test('isJanitorHeartbeatReady without an expected identity only checks freshness (backward-compatible readiness probe)', async () => {
  await withTempDir((dir) => {
    const hbPath = join(dir, 'janitor.heartbeat.json');
    const identity = buildOwnIdentity({ pid: 111, startedAt: 1000, name: 'node', executablePath: '/usr/bin/node' });
    writeJanitorHeartbeat(hbPath, { identity, now: () => 1000 });

    assert.equal(isJanitorHeartbeatReady(hbPath, { now: () => 2000, maxAgeMs: 90000 }), true);
    assert.equal(isJanitorHeartbeatReady(hbPath, { now: () => 500000, maxAgeMs: 90000 }), false); // stale regardless
  });
});

test('isJanitorHeartbeatReady returns false when no heartbeat has ever been written', async () => {
  await withTempDir((dir) => {
    assert.equal(isJanitorHeartbeatReady(join(dir, 'never-written.json'), { now: () => 1000 }), false);
  });
});

test('startJanitor emits an identity-safe heartbeat (not the legacy {pid,ts} shape) using the claimed identity', async () => {
  await withTempDir(async (dir) => {
    const ledger = new ResourceLedger({ path: join(dir, 'ledger.jsonl') });
    const fake = createFakeRp({});
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    const leaseManager = new LeaseManager();
    const hbPath = join(dir, 'j.hb.json');
    const identity = buildOwnIdentity({ pid: 4242, startedAt: 1000, name: 'node', executablePath: '/usr/bin/node' });

    const handle = await startJanitor({
      pidFilePath: join(dir, 'j.json'),
      heartbeatFilePath: hbPath,
      ledger,
      adapter,
      config: testConfig(),
      leaseManager,
      intervalMs: 100000,
      unref: true,
      identity,
      resolveIdentity: () => null,
      isAlive: () => false,
      now: () => 55555,
    });
    try {
      const heartbeat = readJanitorHeartbeat(hbPath);
      assert.deepEqual(heartbeat, { pid: 4242, startedAt: 1000, name: 'node', executablePath: '/usr/bin/node', ts: 55555 });
      assert.deepEqual(handle.identity, identity);
      // Readiness against the SAME identity that was claimed must hold.
      assert.equal(isJanitorHeartbeatReady(hbPath, { identity, now: () => 55555 + 1000, maxAgeMs: 90000 }), true);
      // ...but not against some unrelated identity (e.g. a reused PID).
      const unrelated = buildOwnIdentity({ pid: 4242, startedAt: 999999, name: 'bash', executablePath: '/bin/bash' });
      assert.equal(isJanitorHeartbeatReady(hbPath, { identity: unrelated, now: () => 55555 + 1000, maxAgeMs: 90000 }), false);
    } finally {
      handle.stop();
    }
  });
});

test('startJanitor heartbeat identity matches whatever claimJanitorIdentity actually returned, even when startJanitor was given no explicit identity', async () => {
  await withTempDir(async (dir) => {
    const ledger = new ResourceLedger({ path: join(dir, 'ledger.jsonl') });
    const fake = createFakeRp({});
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    const leaseManager = new LeaseManager();
    const hbPath = join(dir, 'j.hb.json');

    const handle = await startJanitor({
      pidFilePath: join(dir, 'j.json'),
      heartbeatFilePath: hbPath,
      ledger,
      adapter,
      config: testConfig(),
      leaseManager,
      intervalMs: 100000,
      unref: true,
      resolveIdentity: () => null,
      isAlive: () => false,
    });
    try {
      const heartbeat = readJanitorHeartbeat(hbPath);
      assert.ok(heartbeat); // a valid, schema-conforming heartbeat exists
      assert.equal(heartbeat.pid, process.pid); // default identity resolves to the current process
      assert.deepEqual(readJanitorIdentity(join(dir, 'j.json')), handle.identity);
      assert.equal(heartbeat.pid, handle.identity.pid);
      assert.equal(heartbeat.startedAt, handle.identity.startedAt);
    } finally {
      handle.stop();
    }
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

// ---- Final launch-blocking finding: real local-RP list endpoints can lag
// well behind a completed DELETE (a stale "ghost" entry can persist in a
// non-terminal list state for a long time after direct GET already 404s);
// the final orphan computation must never trust list membership alone ----

test('runJanitorPass reports zero orphans when the only "orphan candidate" is a stale list ghost that direct GET confirms is already gone (404)', async () => {
  await withTempDir(async (dir) => {
    const ledger = new ResourceLedger({ path: join(dir, 'ledger.jsonl') });
    // The ledger has never heard of this name (a real orphan candidate by
    // list-membership alone), but the list response is stale: it still
    // reports the resource in "Deleting" even though direct GET 404s
    // (the fake's clusters map has no such entry at all).
    const fake = createFakeRp({ staleListGhosts: [{ name: 'dmon-run1-ghost-cache' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    const leaseManager = new LeaseManager();

    const evidence = await runJanitorPass({ ledger, adapter, config: testConfig(), leaseManager });
    assert.equal(evidence.zeroOrphans, true);
    assert.equal(evidence.orphanCount, 0);
    assert.deepEqual(evidence.orphans, []);
    assert.deepEqual(evidence.quarantined, []); // also never reported as an unrecognized resource
  });
});

test('runJanitorPass still reports a genuine orphan when BOTH the list AND a direct GET confirm it is actually live', async () => {
  await withTempDir(async (dir) => {
    const ledger = new ResourceLedger({ path: join(dir, 'ledger.jsonl') });
    // Present in BOTH the list response AND the underlying clusters map --
    // a direct GET confirms it is genuinely live, so it must remain a
    // reported orphan (and quarantined candidate) -- never silently
    // dropped just because SOME list entries are stale ghosts elsewhere.
    const fake = createFakeRp({
      initialClusters: [{ name: 'dmon-run1-real-orphan' }],
      staleListGhosts: [{ name: 'dmon-run1-ghost-cache' }], // an unrelated stale ghost in the same list response
    });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    const leaseManager = new LeaseManager();

    const evidence = await runJanitorPass({ ledger, adapter, config: testConfig(), leaseManager });
    assert.equal(evidence.zeroOrphans, false);
    assert.deepEqual(evidence.orphans, ['dmon-run1-real-orphan']); // the ghost is excluded, the real one is not
    assert.deepEqual(evidence.quarantined, [{ resourceName: 'dmon-run1-real-orphan', reason: 'no-creation-intent-evidence' }]);
  });
});

test('runJanitorPass still reports an orphan candidate when its confirming GET fails ambiguously (fails safe, never silently hidden)', async () => {
  await withTempDir(async (dir) => {
    const ledger = new ResourceLedger({ path: join(dir, 'ledger.jsonl') });
    const fake = createFakeRp({ initialClusters: [{ name: 'dmon-run1-cache1' }] });
    const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl });
    const originalGetCluster = adapter.getCluster.bind(adapter);
    let getClusterCalls = 0;
    adapter.getCluster = async (...args) => {
      getClusterCalls += 1;
      throw new Error('simulated transient network failure during confirmation');
    };
    const leaseManager = new LeaseManager();

    const evidence = await runJanitorPass({ ledger, adapter, config: testConfig(), leaseManager });
    assert.ok(getClusterCalls > 0); // the confirmation GET was actually attempted
    assert.deepEqual(evidence.orphans, ['dmon-run1-cache1']); // ambiguous verification -- still reported, not dropped
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
