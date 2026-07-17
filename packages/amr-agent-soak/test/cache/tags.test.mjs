import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildResourceTags,
  touchTags,
  matchesExactOwnership,
  isMarkedPersistent,
  evaluateCleanupEligibility,
  TagError,
} from '../../src/cache/tags.mjs';

test('buildResourceTags exposes CreatedOn/UpdatedOn/Owner/SoakRunId/ExpiresOn plus passthrough tags', () => {
  const tags = buildResourceTags({
    ownerAlias: 'dmon',
    runId: 'run1',
    expiresInMs: 3600000,
    now: () => 1000,
    extraTags: { build: '20260101.1', user: 'dmon' },
  });
  assert.equal(tags.Owner, 'dmon');
  assert.equal(tags.SoakRunId, 'run1');
  assert.equal(tags.CreatedOn, new Date(1000).toISOString());
  assert.equal(tags.UpdatedOn, new Date(1000).toISOString());
  assert.equal(tags.ExpiresOn, new Date(1000 + 3600000).toISOString());
  assert.equal(tags.build, '20260101.1');
  assert.equal(tags.user, 'dmon');
});

test('buildResourceTags requires ownerAlias, runId, and a positive expiresInMs', () => {
  assert.throws(() => buildResourceTags({ runId: 'run1', expiresInMs: 1000 }), TagError);
  assert.throws(() => buildResourceTags({ ownerAlias: 'dmon', expiresInMs: 1000 }), TagError);
  assert.throws(() => buildResourceTags({ ownerAlias: 'dmon', runId: 'run1', expiresInMs: 0 }), TagError);
  assert.throws(() => buildResourceTags({ ownerAlias: 'dmon', runId: 'run1', expiresInMs: -5 }), TagError);
});

test('touchTags refreshes UpdatedOn without disturbing other fields', () => {
  const original = buildResourceTags({ ownerAlias: 'dmon', runId: 'run1', expiresInMs: 1000, now: () => 1000 });
  const touched = touchTags(original, () => 5000);
  assert.equal(touched.UpdatedOn, new Date(5000).toISOString());
  assert.equal(touched.CreatedOn, original.CreatedOn);
  assert.equal(touched.Owner, original.Owner);
});

test('matchesExactOwnership requires both Owner and SoakRunId to match', () => {
  const tags = { Owner: 'dmon', SoakRunId: 'run1' };
  assert.equal(matchesExactOwnership(tags, { ownerAlias: 'dmon', runId: 'run1' }), true);
  assert.equal(matchesExactOwnership(tags, { ownerAlias: 'dmon', runId: 'run2' }), false);
  assert.equal(matchesExactOwnership(tags, { ownerAlias: 'phil', runId: 'run1' }), false);
  assert.equal(matchesExactOwnership(null, { ownerAlias: 'dmon', runId: 'run1' }), false);
});

test('isMarkedPersistent recognizes explicit boolean/string-true Persistent or Longevity tags', () => {
  assert.equal(isMarkedPersistent({ Persistent: true }), true);
  assert.equal(isMarkedPersistent({ Persistent: 'true' }), true);
  assert.equal(isMarkedPersistent({ Longevity: true }), true);
  assert.equal(isMarkedPersistent({ Persistent: false }), false);
  assert.equal(isMarkedPersistent({}), false);
  assert.equal(isMarkedPersistent(null), false);
});

test('isMarkedPersistent does NOT rely on name substrings (unlike the existing job)', () => {
  // A resource literally named with "longevity"/"-persistent-" in it is NOT
  // automatically protected by this predicate -- only explicit tags are.
  assert.equal(isMarkedPersistent({ Owner: 'dmon', SoakRunId: 'run1' }), false);
});

test('evaluateCleanupEligibility fails closed when CreatedOn is missing (opposite of the buggy existing job)', () => {
  const result = evaluateCleanupEligibility(
    { Owner: 'dmon', SoakRunId: 'run1', ExpiresOn: new Date(Date.now() + 1000).toISOString() },
    { ownerAlias: 'dmon', runId: 'run1' }
  );
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'missing-createdon-fail-closed');
});

test('evaluateCleanupEligibility fails closed when tags are entirely absent', () => {
  const result = evaluateCleanupEligibility(undefined, { ownerAlias: 'dmon', runId: 'run1' });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'missing-createdon-fail-closed');
});

test('evaluateCleanupEligibility fails closed when ExpiresOn is missing', () => {
  const result = evaluateCleanupEligibility(
    { Owner: 'dmon', SoakRunId: 'run1', CreatedOn: new Date().toISOString() },
    { ownerAlias: 'dmon', runId: 'run1' }
  );
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'missing-expireson-fail-closed');
});

test('evaluateCleanupEligibility excludes explicitly persistent-tagged resources', () => {
  const tags = buildResourceTags({ ownerAlias: 'dmon', runId: 'run1', expiresInMs: 1000, extraTags: { Persistent: true } });
  const result = evaluateCleanupEligibility(tags, { ownerAlias: 'dmon', runId: 'run1' });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'marked-persistent');
});

test('evaluateCleanupEligibility rejects a name-prefix match whose tags belong to a different owner/run', () => {
  const tags = buildResourceTags({ ownerAlias: 'someone-else', runId: 'run9', expiresInMs: 1000 });
  const result = evaluateCleanupEligibility(tags, { ownerAlias: 'dmon', runId: 'run1' });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'ownership-tag-mismatch');
});

test('evaluateCleanupEligibility fails closed on an unparsable ExpiresOn', () => {
  const result = evaluateCleanupEligibility(
    { Owner: 'dmon', SoakRunId: 'run1', CreatedOn: new Date().toISOString(), ExpiresOn: 'not-a-date' },
    { ownerAlias: 'dmon', runId: 'run1' }
  );
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'invalid-expireson-fail-closed');
});

test('evaluateCleanupEligibility reports eligible + expired for a fully valid, past-expiry resource', () => {
  const tags = buildResourceTags({ ownerAlias: 'dmon', runId: 'run1', expiresInMs: 1000, now: () => 1000 });
  const result = evaluateCleanupEligibility(tags, { ownerAlias: 'dmon', runId: 'run1', now: () => 999999 });
  assert.equal(result.eligible, true);
  assert.equal(result.expired, true);
});

test('evaluateCleanupEligibility reports eligible + not-expired for a fully valid, still-live resource', () => {
  const tags = buildResourceTags({ ownerAlias: 'dmon', runId: 'run1', expiresInMs: 3600000, now: () => 1000 });
  const result = evaluateCleanupEligibility(tags, { ownerAlias: 'dmon', runId: 'run1', now: () => 2000 });
  assert.equal(result.eligible, true);
  assert.equal(result.expired, false);
});
