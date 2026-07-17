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

import { assertOwnedResource } from './guards.mjs';

export class ReconciliationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReconciliationError';
  }
}

const TERMINAL_STATES = new Set(['Succeeded', 'Failed', 'Canceled']);

function extractLiveNames(liveList, resourcePrefix) {
  const rawList = Array.isArray(liveList) ? liveList : (liveList?.caches ?? []);
  return new Set(
    rawList.map((c) => (typeof c === 'string' ? c : c.name)).filter((name) => typeof name === 'string' && name.startsWith(resourcePrefix))
  );
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
 */
export async function reconcileOnStartup({ ledger, adapter, resourcePrefix }) {
  const liveList = await adapter.listCaches();
  const liveNames = extractLiveNames(liveList, resourcePrefix);

  const { creationOrder, byResource } = ledger.replay();
  const report = { adoptedOrphans: [], reconciledDeletions: [] };

  for (const liveName of liveNames) {
    assertOwnedResource(liveName, resourcePrefix);
    if (!byResource.has(liveName)) {
      // Exists on the RP, matches our own prefix, but the ledger has no
      // record at all -- almost certainly a crash between the RP create call
      // and the ledger append. Adopt it so it becomes trackable/cleanable.
      ledger.append('created', liveName, { reconciled: true, reason: 'orphan-adopted-on-startup' });
      report.adoptedOrphans.push(liveName);
    }
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
