import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KillSwitch, KillSwitchEngaged } from '../../src/cache/kill-switch.mjs';

test('kill switch is disengaged when no path is configured', () => {
  const ks = new KillSwitch();
  assert.equal(ks.isEngaged(), false);
  assert.doesNotThrow(() => ks.assertNotEngaged());
});

test('kill switch is disengaged when the sentinel file does not exist', () => {
  const ks = new KillSwitch({ path: '/tmp/does-not-exist.killswitch', exists: () => false });
  assert.equal(ks.isEngaged(), false);
});

test('kill switch engages and throws KillSwitchEngaged when the sentinel exists', () => {
  const ks = new KillSwitch({ path: '/tmp/fake.killswitch', exists: () => true });
  assert.equal(ks.isEngaged(), true);
  assert.throws(() => ks.assertNotEngaged('acquire(exclusive)'), KillSwitchEngaged);
});

test('kill switch is re-checked every call, not cached', () => {
  let engaged = false;
  const ks = new KillSwitch({ path: '/tmp/toggle.killswitch', exists: () => engaged });
  assert.doesNotThrow(() => ks.assertNotEngaged());
  engaged = true;
  assert.throws(() => ks.assertNotEngaged(), KillSwitchEngaged);
  engaged = false;
  assert.doesNotThrow(() => ks.assertNotEngaged());
});
