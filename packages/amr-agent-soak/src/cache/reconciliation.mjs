// Startup reconciliation and terminal-state polling for the live-cache
// safety subsystem.
//
// Reconciliation never deletes anything itself -- it only reconciles the
// ledger's view of the world against what the local RP actually reports, so
// that a process that crashed mid-operation resumes with an accurate picture
// instead of silently drifting. This is what makes "crash reconciliation"
// safe: an orphan discovered here is only *adopted* into the ledger (so it
// becomes trackable/cleanable by the normal, guarded cleanup path), never
// deleted directly.
//
// Orphan adoption is additionally gated by tag-based eligibility (see
// tags.mjs) whenever `ownerAlias`/`runId` are supplied: a live resource
// matching our name prefix is only adopted if its tags prove exact
// ownership, are not marked persistent, and carry valid CreatedOn/ExpiresOn
// metadata. Anything that merely matches the prefix but fails that
// fail-closed check is quarantined (reported, never touched) instead of
// being silently adopted -- unlike the existing (not reused) orphan job,
// which treats missing metadata as license to delete.

import { assertOwnedResource } from './guards.mjs';
import { evaluateCleanupEligibility } from './tags.mjs';

export class ReconciliationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReconciliationError';
  }
}

const TERMINAL_STATES = new Set(['Succeeded', 'Failed', 'Canceled']);

function extractLiveRecords(liveList, resourcePrefix) {
  const rawList = Array.isArray(liveList) ? liveList : (liveList?.caches ?? []);
  const byName = new Map();
  for (const item of rawList) {
    const record = typeof item === 'string' ? { name: item } : item;
    if (typeof record?.name === 'string' && record.name.startsWith(resourcePrefix)) {
      byName.set(record.name, record);
    }
  }
  return byName;
}

/**
 * Reconciles ledger state against the live local RP at process startup (or
 * from the janitor, on each pass). Never touches resources outside
 * `resourcePrefix` (defense in depth on top of the guard layer), and never
 * deletes anything itself.
 *
 * @param {object} opts
 * @param {import('./ledger.mjs').ResourceLedger} opts.ledger
 * @param {import('./http-adapter.mjs').LocalRpHttpAdapter} opts.adapter
 * @param {string} opts.resourcePrefix
 * @param {string} [opts.ownerAlias] - enables tag-based eligibility checking when supplied with runId.
 * @param {string} [opts.runId]
 * @param {() => number} [opts.now]
 */
export async function reconcileOnStartup({ ledger, adapter, resourcePrefix, ownerAlias, runId, now = () => Date.now() }) {
  const liveList = await adapter.listCaches();
  const liveRecordsByName = extractLiveRecords(liveList, resourcePrefix);
  const liveNames = new Set(liveRecordsByName.keys());
  const tagCheckEnabled = Boolean(ownerAlias && runId);

  const { creationOrder, byResource } = ledger.replay();
  const report = { adoptedOrphans: [], reconciledDeletions: [], quarantined: [] };

  for (const [liveName, record] of liveRecordsByName) {
    assertOwnedResource(liveName, resourcePrefix);
    if (byResource.has(liveName)) continue;

    // Exists on the RP, matches our own prefix, but the ledger has no record
    // at all -- almost certainly a crash between the RP create call and the
    // ledger append. Before adopting it (so it becomes trackable/cleanable),
    // verify tag-based eligibility when we have enough context to do so.
    if (tagCheckEnabled) {
      const evaluation = evaluateCleanupEligibility(record.tags, { ownerAlias, runId, now });
      if (!evaluation.eligible) {
        report.quarantined.push({ resourceName: liveName, reason: evaluation.reason });
        continue; // Fail closed: do NOT adopt. Left for manual review.
      }
    }

    ledger.append('created', liveName, { reconciled: true, reason: 'orphan-adopted-on-startup' });
    report.adoptedOrphans.push(liveName);
  }

  for (const name of creationOrder) {
    const entry = byResource.get(name);
    if (entry.deleted) continue;
    assertOwnedResource(name, resourcePrefix);
    if (!liveNames.has(name)) {
      // The ledger believes this is active, but it no longer exists on the
      // RP (e.g. deleted out-of-band, or the delete succeeded but the ledger
      // append never happened before a crash).
      ledger.append('deleted', name, { reconciled: true, reason: 'missing-on-startup' });
      report.reconciledDeletions.push(name);
    }
  }

  return report;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls the local RP for an operation's terminal state with exponential
 * backoff, up to `timeoutMs`.
 */
export async function pollUntilTerminal({
  adapter,
  operationId,
  intervalMs = 250,
  backoffFactor = 2,
  maxIntervalMs = 5000,
  timeoutMs = 60000,
  sleep = defaultSleep,
}) {
  const start = Date.now();
  let interval = intervalMs;
  for (;;) {
    const status = await adapter.getOperationStatus(operationId);
    if (TERMINAL_STATES.has(status.state)) return status;
    if (Date.now() - start >= timeoutMs) {
      throw new ReconciliationError(
        `Operation "${operationId}" did not reach a terminal state within ${timeoutMs}ms (last state: ${status.state}).`
      );
    }
    await sleep(interval);
    interval = Math.min(interval * backoffFactor, maxIntervalMs);
  }
}
