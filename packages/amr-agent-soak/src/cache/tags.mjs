// Resource tag metadata for the live-cache safety subsystem.
//
// Tag fields intentionally mirror what the existing testing-repo tests
// already assert on -- CreatedOn/UpdatedOn/build/user -- and add the fields
// this subsystem additionally requires: SoakRunId/Owner/ExpiresOn.
//
// Eligibility for automated action (orphan adoption, cleanup) is evaluated
// with a FAIL-CLOSED predicate. This is deliberately the inverse of the
// existing (deliberately-not-reused) orphan job's behavior, which is known
// to treat a MISSING CreatedOn as *eligible* for deletion, is subscription-
// wide, and excludes only a couple of narrow name-substring markers
// ("longevity" / "-persistent-"). Here: missing/invalid metadata always
// excludes a resource from automated action, and persistence is signaled by
// explicit tags rather than name substrings.

export class TagError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TagError';
  }
}

const PERSISTENCE_TAG_KEYS = ['Persistent', 'Longevity'];

function isoNow(now) {
  return new Date(now()).toISOString();
}

/**
 * Builds the tag set applied to a newly created resource.
 * @param {object} opts
 * @param {string} opts.ownerAlias
 * @param {string} opts.runId
 * @param {number} opts.expiresInMs - how far in the future ExpiresOn is set.
 * @param {() => number} [opts.now]
 * @param {object} [opts.extraTags] - passthrough tags such as build/user.
 */
export function buildResourceTags({ ownerAlias, runId, expiresInMs, now = () => Date.now(), extraTags = {} } = {}) {
  if (!ownerAlias || !runId) {
    throw new TagError('buildResourceTags requires ownerAlias and runId.');
  }
  if (typeof expiresInMs !== 'number' || expiresInMs <= 0) {
    throw new TagError('buildResourceTags requires a positive expiresInMs.');
  }
  const createdOn = isoNow(now);
  return {
    Owner: ownerAlias,
    SoakRunId: runId,
    CreatedOn: createdOn,
    UpdatedOn: createdOn,
    ExpiresOn: new Date(now() + expiresInMs).toISOString(),
    ...extraTags,
  };
}

/** Returns a copy of tags with UpdatedOn refreshed (e.g. after a topology mutation). */
export function touchTags(tags, now = () => Date.now()) {
  return { ...tags, UpdatedOn: isoNow(now) };
}

/** True if tags carry an exact Owner + SoakRunId match for this run. Defense
 * in depth beyond the name-prefix check -- guards against a name collision
 * spoofing ownership of a resource we did not actually create. */
export function matchesExactOwnership(tags, { ownerAlias, runId }) {
  return Boolean(tags) && tags.Owner === ownerAlias && tags.SoakRunId === runId;
}

/** True if tags mark the resource as intentionally long-lived/protected, in
 * which case it must never be treated as an orphan regardless of prefix or
 * expiry. Uses explicit boolean tags rather than name-substring matching. */
export function isMarkedPersistent(tags) {
  if (!tags) return false;
  return PERSISTENCE_TAG_KEYS.some((key) => tags[key] === true || tags[key] === 'true');
}

/**
 * Evaluates whether a resource is eligible for *automated* action (orphan
 * adoption / cleanup consideration). Fail-closed throughout: anything
 * ambiguous or incomplete is NOT eligible, and is left for manual review
 * instead.
 *
 * Returns `{ eligible, reason, expired? }`. `expired` (only present when
 * eligible) tells the caller whether the resource is already past its
 * ExpiresOn -- eligibility itself does not require expiry, since a run's
 * own live resources are legitimately "eligible" (owned, tagged, not
 * persistent) well before they expire.
 */
export function evaluateCleanupEligibility(tags, { ownerAlias, runId, now = () => Date.now() } = {}) {
  if (!tags || !tags.CreatedOn) {
    return { eligible: false, reason: 'missing-createdon-fail-closed' };
  }
  if (!tags.ExpiresOn) {
    return { eligible: false, reason: 'missing-expireson-fail-closed' };
  }
  if (isMarkedPersistent(tags)) {
    return { eligible: false, reason: 'marked-persistent' };
  }
  if (!matchesExactOwnership(tags, { ownerAlias, runId })) {
    return { eligible: false, reason: 'ownership-tag-mismatch' };
  }
  const expiresAt = Date.parse(tags.ExpiresOn);
  if (Number.isNaN(expiresAt)) {
    return { eligible: false, reason: 'invalid-expireson-fail-closed' };
  }
  return { eligible: true, reason: 'ok', expired: now() >= expiresAt };
}
