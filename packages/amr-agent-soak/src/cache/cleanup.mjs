// Reverse cleanup orchestration for the live-cache safety subsystem.
//
// Tears down every active resource tracked in the ledger, in reverse
// creation order (LIFO), so dependents are removed before the things they
// depend on. Idempotent: safe to call repeatedly -- an already-deleted or
// already-missing resource is treated as success, never an error.

import { assertSafeToMutate } from './guards.mjs';

export class CleanupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CleanupError';
  }
}

/**
 * @param {object} opts
 * @param {import('./ledger.mjs').ResourceLedger} opts.ledger
 * @param {import('./http-adapter.mjs').LocalRpHttpAdapter} opts.adapter
 * @param {string} opts.resourcePrefix
 * @param {string[]} [opts.denylist]
 * @param {import('./kill-switch.mjs').KillSwitch} [opts.killSwitch]
 */
export async function reverseCleanup({ ledger, adapter, resourcePrefix, denylist = [], killSwitch }) {
  const active = ledger.activeResources();
  const order = [...active].reverse(); // LIFO: most recently created goes first.
  const results = [];

  for (const resourceName of order) {
    killSwitch?.assertNotEngaged(`cleanup(${resourceName})`);
    assertSafeToMutate(resourceName, { resourcePrefix, denylist });

    try {
      await adapter.deleteCache(resourceName);
      ledger.append('deleted', resourceName, { via: 'reverseCleanup' });
      results.push({ resourceName, status: 'deleted' });
    } catch (err) {
      if (err?.status === 404) {
        // Already gone: idempotent success, not a failure.
        ledger.append('deleted', resourceName, { via: 'reverseCleanup', reason: 'already-absent' });
        results.push({ resourceName, status: 'already-absent' });
        continue;
      }
      results.push({ resourceName, status: 'failed', error: err.message });
      throw new CleanupError(`Failed to delete "${resourceName}" during reverse cleanup: ${err.message}`);
    }
  }

  return results;
}
