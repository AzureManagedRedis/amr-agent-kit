// Startup reconciliation and terminal-state polling for the live-cache
// safety subsystem.
//
// Reconciliation never deletes anything itself -- it only reconciles the
// ledger's view of the world against what the local RP actually reports, so
// that a process that crashed mid-operation resumes with an accurate picture
// instead of silently drifting.
//
// Adoption requires DURABLE PRE-CREATE INTENT EVIDENCE, not merely a
// name-prefix (or even a tag) match: a live resource is only ever upgraded
// to "created" in the ledger if the ledger itself already holds a
// 'creation-intent' record for that exact name (see ledger.mjs and
// provisioning.mjs) -- proof that *this run* durably recorded, before ever
// calling the RP, that it intended to create this specific resource. Any
// prefix-matching live resource with NO ledger evidence at all is
// unconditionally quarantined (reported, never touched) for manual review,
// regardless of what its tags claim -- a name or tag match alone is never
// sufficient, since either could coincidentally collide or be spoofed.
// Where evidence exists (a 'creation-intent' entry with no confirming
// 'created' yet -- the signature of a crash in between), tag-based
// eligibility (tags.mjs) is layered on top as an additional check before
// confirming the ledger entry.

import { assertOwnedResource } from './guards.mjs';
import { evaluateCleanupEligibility } from './tags.mjs';

export class ReconciliationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReconciliationError';
  }
}

const TERMINAL_STATES = new Set(['Succeeded', 'Failed', 'Canceled']);
const TRANSIENT_REQUEST_ERROR_NAMES = new Set(['AbortError', 'TimeoutError']);

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
  const report = { confirmedIntents: [], reconciledDeletions: [], quarantined: [] };

  for (const [liveName, record] of liveRecordsByName) {
    assertOwnedResource(liveName, resourcePrefix);

    if (!ledger.hasCreationEvidence(liveName)) {
      // Zero durable evidence that this run ever intended to create this
      // resource -- a prefix (or tag) match alone is never sufficient.
      // Fail closed: quarantine unconditionally, never adopt.
      report.quarantined.push({ resourceName: liveName, reason: 'no-creation-intent-evidence' });
      continue;
    }

    if (!ledger.isIntentOnly(liveName)) {
      continue; // Already confirmed 'created' previously -- nothing to do.
    }

    // Durable 'creation-intent' evidence exists with no confirming 'created'
    // yet: the signature of a crash between the intent append and the
    // create confirmation. Layer tag-based eligibility on top before
    // confirming, when we have enough context to check it.
    if (tagCheckEnabled) {
      const evaluation = evaluateCleanupEligibility(record.tags, { ownerAlias, runId, now });
      if (!evaluation.eligible) {
        report.quarantined.push({ resourceName: liveName, reason: evaluation.reason });
        continue;
      }
    }

    ledger.append('created', liveName, { reconciled: true, reason: 'intent-confirmed-on-startup' });
    report.confirmedIntents.push(liveName);
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

async function callWithAbortTimeout(fn, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Polls the local RP for an operation's terminal state with exponential
 * backoff, up to an overall `timeoutMs` deadline. Every individual poll
 * request is itself bounded by an AbortController -- `remaining` overall
 * deadline time, capped at `perRequestTimeoutMs` -- so a single hung request
 * can never let the overall poll exceed its deadline; a request that times
 * out is treated as transient and retried against the remaining budget.
 */
export async function pollUntilTerminal({
  adapter,
  operationId,
  intervalMs = 250,
  backoffFactor = 2,
  maxIntervalMs = 5000,
  timeoutMs = 60000,
  perRequestTimeoutMs = 5000,
  sleep = defaultSleep,
}) {
  const start = Date.now();
  let interval = intervalMs;
  for (;;) {
    const remaining = timeoutMs - (Date.now() - start);
    if (remaining <= 0) {
      throw new ReconciliationError(`Operation "${operationId}" did not reach a terminal state within ${timeoutMs}ms.`);
    }

    const requestTimeout = Math.min(perRequestTimeoutMs, remaining);
    let status = null;
    try {
      status = await callWithAbortTimeout((signal) => adapter.getOperationStatus(operationId, { signal }), requestTimeout);
    } catch (err) {
      if (!TRANSIENT_REQUEST_ERROR_NAMES.has(err?.name)) throw err;
      // A single hung/aborted request is transient -- fall through to the
      // overall-deadline check below instead of retrying indefinitely.
    }

    if (status && TERMINAL_STATES.has(status.state)) return status;

    if (Date.now() - start >= timeoutMs) {
      throw new ReconciliationError(
        `Operation "${operationId}" did not reach a terminal state within ${timeoutMs}ms` +
          (status ? ` (last state: ${status.state}).` : ' (last request timed out).')
      );
    }
    await sleep(interval);
    interval = Math.min(interval * backoffFactor, maxIntervalMs);
  }
}
