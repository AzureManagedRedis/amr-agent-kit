import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResourceLedger, LedgerError } from '../../src/cache/ledger.mjs';

function withTempLedger(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'amr-soak-ledger-'));
  try {
    const ledger = new ResourceLedger({ path: join(dir, 'ledger.jsonl') });
    return fn(ledger, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('append rejects unknown action names', () => {
  withTempLedger((ledger) => {
    assert.throws(() => ledger.append('teleported', 'dmon-run1-cache1'), LedgerError);
  });
});

test('ledger is append-only: records accumulate and are never rewritten', () => {
  withTempLedger((ledger) => {
    ledger.append('created', 'dmon-run1-cache1');
    ledger.append('mutated', 'dmon-run1-cache1', { topology: 'patched' });
    ledger.append('deleted', 'dmon-run1-cache1');
    const all = ledger.readAll();
    assert.equal(all.length, 3);
    assert.deepEqual(
      all.map((r) => r.action),
      ['created', 'mutated', 'deleted']
    );
  });
});

test('replay reconstructs creation order and last-known state per resource', () => {
  withTempLedger((ledger) => {
    ledger.append('created', 'dmon-run1-cache1');
    ledger.append('created', 'dmon-run1-cache2');
    ledger.append('deleted', 'dmon-run1-cache1');

    const { creationOrder, byResource } = ledger.replay();
    assert.deepEqual(creationOrder, ['dmon-run1-cache1', 'dmon-run1-cache2']);
    assert.equal(byResource.get('dmon-run1-cache1').deleted, true);
    assert.equal(byResource.get('dmon-run1-cache2').deleted, false);
  });
});

test('activeResources excludes deleted resources but preserves creation order', () => {
  withTempLedger((ledger) => {
    ledger.append('created', 'dmon-run1-cache1');
    ledger.append('created', 'dmon-run1-cache2');
    ledger.append('created', 'dmon-run1-cache3');
    ledger.append('deleted', 'dmon-run1-cache2');
    assert.deepEqual(ledger.activeResources(), ['dmon-run1-cache1', 'dmon-run1-cache3']);
  });
});

test('a fresh ledger with no file yet reports no records and no active resources', () => {
  withTempLedger((ledger) => {
    assert.deepEqual(ledger.readAll(), []);
    assert.deepEqual(ledger.activeResources(), []);
  });
});

test('a second ResourceLedger instance pointed at the same path sees prior records (durability across process restarts)', () => {
  withTempLedger((ledger, dir) => {
    ledger.append('created', 'dmon-run1-cache1');
    const reopened = new ResourceLedger({ path: join(dir, 'ledger.jsonl') });
    assert.deepEqual(reopened.activeResources(), ['dmon-run1-cache1']);
  });
});
