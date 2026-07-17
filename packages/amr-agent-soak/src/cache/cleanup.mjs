// Reverse cleanup orchestration for the live-cache safety subsystem.
//
// Tears down every active resource tracked in the ledger, in reverse
// creation order (LIFO), so dependents are removed before the things they
// depend on. Idempotent: safe to call repeatedly -- an already-deleted or
// already-missing resource is treated as success, never an error.
//
// Real (non-dry-run) mutations require an exclusive lease whose fencing
// token is still valid (see lease-manager.mjs) -- an owner that has lost its
// lease cannot keep deleting things. Each delete waits for the RP operation
// to reach a terminal state before the ledger records it as deleted. A
// max-delete circuit breaker refuses to proceed (fail closed) if a single
// run would delete more than expected, guarding against exactly the kind of
// runaway/duplicate-processing bug the existing (not reused) orphan job is
// known to have.

import { assertSafeToMutate } from './guards.mjs';
import { pollUntilTerminal } from './reconciliation.mjs';
import { assertLeaseAuthorizes, MAX_ACTIVE_LEASES } from './lease-manager.mjs';

export class CleanupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CleanupError';
  }
}

export class CircuitBreakerTripped extends CleanupError {
  constructor(message) {
    super(message);
    this.name = 'CircuitBreakerTripped';
  }
}

/** Default cap on how many resources reverseCleanup will delete in a single
 * call before refusing to proceed. Deliberately conservative and aligned
 * with MAX_ACTIVE_LEASES; override via `allowExceedCircuitBreaker` only
 * after manual review. */
export const DEFAULT_MAX_DELETES_PER_RUN = MAX_ACTIVE_LEASES;

/**
 * @param {object} opts
 * @param {import('./ledger.mjs').ResourceLedger} opts.ledger
 * @param {import('./http-adapter.mjs').LocalRpHttpAdapter} opts.adapter
 * @param {string} opts.resourcePrefix
 * @param {string[]} [opts.denylist]
 * @param {import('./kill-switch.mjs').KillSwitch} [opts.killSwitch]
 * @param {boolean} [opts.dryRun] - when true, guards run normally but nothing is actually deleted.
 * @param {number} [opts.maxDeletes] - circuit breaker cap; see DEFAULT_MAX_DELETES_PER_RUN.
 * @param {boolean} [opts.allowExceedCircuitBreaker] - explicit override to proceed past the cap.
 * @param {object} [opts.lease] - the exclusive lease authorizing these mutations (required unless dryRun).
 * @param {import('./lease-manager.mjs').LeaseManager} [opts.leaseManager] - validates the lease's fencing token (required unless dryRun).
 * @param {typeof pollUntilTerminal} [opts.pollTerminal] - injectable for tests.
 */
export async function reverseCleanup({
  ledger,
  adapter,
  resourcePrefix,
  denylist = [],
  killSwitch,
  dryRun = false,
  maxDeletes = DEFAULT_MAX_DELETES_PER_RUN,
  allowExceedCircuitBreaker = false,
  lease,
  leaseManager,
  pollTerminal = pollUntilTerminal,
}) {
  const active = ledger.activeResources();
  const order = [...active].reverse(); // LIFO: most recently created goes first.

  if (!allowExceedCircuitBreaker && order.length > maxDeletes) {
    throw new CircuitBreakerTripped(
      `Refusing to delete ${order.length} resources in one run: exceeds the max-delete circuit breaker ` +
        `(${maxDeletes}). Pass allowExceedCircuitBreaker: true to override after manual review.`
    );
  }

  if (!dryRun) {
    if (!lease || !leaseManager) {
      throw new CleanupError('reverseCleanup requires an exclusive lease + leaseManager for real (non-dry-run) mutations.');
    }
    assertLeaseAuthorizes(lease, 'write');
  }

  const results = [];

  for (const resourceName of order) {
    killSwitch?.assertNotEngaged(`cleanup(${resourceName})`);
    assertSafeToMutate(resourceName, { resourcePrefix, denylist });

    if (dryRun) {
      results.push({ resourceName, status: 'dry-run' });
      continue;
    }

    // Re-validate on every iteration: a long-running cleanup could outlive
    // the lease's TTL, and an expired owner must not keep mutating.
    leaseManager.assertFencingTokenValid(lease.id, lease.fencingToken);

    try {
      const response = await adapter.deleteCache(resourceName);
      if (response?.operationId) {
        await pollTerminal({ adapter, operationId: response.operationId });
      }
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
