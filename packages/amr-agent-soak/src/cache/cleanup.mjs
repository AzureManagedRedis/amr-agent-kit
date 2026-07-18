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
// to reach a terminal state AND is verified actually absent (a fresh GET)
// before the ledger ever records it as deleted; a delete that does not
// reach a Succeeded terminal state, or whose target is somehow still
// present afterward, is NOT ledgered as deleted -- it is preserved as still
// active so a future reconciliation/cleanup pass retries it, rather than
// the ledger falsely believing the resource is gone. A max-delete circuit
// breaker refuses to proceed (fail closed) if a single run would delete
// more than expected, guarding against exactly the kind of
// runaway/duplicate-processing bug the existing (not reused) orphan job is
// known to have.

import { assertSafeToMutate } from './guards.mjs';
import { pollUntilTerminal, buildDeletionCheck } from './reconciliation.mjs';
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
 * Deletes a single owned resource (a Microsoft.Cache/redisEnterprise
 * cluster), verifying full completion before ever ledgering it as deleted:
 *   1. issue the delete through the guarded adapter boundary
 *   2. poll the cluster resource until it 404s (fully gone) or reports a
 *      terminal "Deleted" provisioningState -- never assuming a fake
 *      "/operations" API
 *   3. only then append 'deleted' to the ledger
 *
 * If the poll does not reach a terminal deleted state (times out on
 * something other than 404/Deleted), this does NOT ledger a deletion -- it
 * returns a 'failed-pending-retry' result so the resource stays "active"
 * for a future reconciliation/cleanup pass to retry, rather than the
 * ledger falsely believing cleanup already succeeded. A hard/unexpected
 * error throws CleanupError (the resource likewise stays active).
 *
 * @param {object} opts
 * @param {import('./ledger.mjs').ResourceLedger} opts.ledger
 * @param {import('./http-adapter.mjs').LocalRpHttpAdapter} opts.adapter
 * @param {string} opts.resourceName
 * @param {object} opts.context - mutation context (see mutation-context.mjs); context.config must carry subscriptionId/resourceGroup.
 * @param {typeof pollUntilTerminal} [opts.pollTerminal]
 */
export async function deleteOwnedResource({ ledger, adapter, resourceName, context, pollTerminal = pollUntilTerminal }) {
  const coords = {
    subscriptionId: context?.config?.subscriptionId,
    resourceGroup: context?.config?.resourceGroup,
    name: resourceName,
  };
  try {
    await adapter.deleteCluster(coords, context);

    const status = await pollTerminal({
      checkStatus: buildDeletionCheck((signal) => adapter.getCluster(coords, { signal })),
      label: `deletion of "${resourceName}"`,
    });

    if (status.state !== 'Deleted') {
      return { resourceName, status: 'failed-pending-retry', state: status.state };
    }

    ledger.append('deleted', resourceName, { via: 'deleteOwnedResource' });
    return { resourceName, status: 'deleted' };
  } catch (err) {
    if (err?.status === 404) {
      // Already gone: idempotent success, not a failure.
      ledger.append('deleted', resourceName, { via: 'deleteOwnedResource', reason: 'already-absent' });
      return { resourceName, status: 'already-absent' };
    }
    throw new CleanupError(`Failed to delete "${resourceName}": ${err.message}`);
  }
}

/**
 * @param {object} opts
 * @param {import('./ledger.mjs').ResourceLedger} opts.ledger
 * @param {import('./http-adapter.mjs').LocalRpHttpAdapter} opts.adapter
 * @param {object} opts.config - runtime config (resourcePrefix, denylist, acknowledgedCustomerSubscription); required for real (non-dry-run) mutations.
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
  config,
  killSwitch,
  dryRun = false,
  maxDeletes = DEFAULT_MAX_DELETES_PER_RUN,
  allowExceedCircuitBreaker = false,
  lease,
  leaseManager,
  pollTerminal = pollUntilTerminal,
}) {
  const resourcePrefix = config?.resourcePrefix;
  const denylist = config?.denylist ?? [];
  const active = ledger.activeResources();
  const order = [...active].reverse(); // LIFO: most recently created goes first.

  if (!allowExceedCircuitBreaker && order.length > maxDeletes) {
    throw new CircuitBreakerTripped(
      `Refusing to delete ${order.length} resources in one run: exceeds the max-delete circuit breaker ` +
        `(${maxDeletes}). Pass allowExceedCircuitBreaker: true to override after manual review.`
    );
  }

  if (!dryRun) {
    if (!config || !lease || !leaseManager) {
      throw new CleanupError('reverseCleanup requires config + an exclusive lease + leaseManager for real (non-dry-run) mutations.');
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

    const context = { config, lease, leaseManager, killSwitch };
    const result = await deleteOwnedResource({ ledger, adapter, resourceName, context, pollTerminal });
    results.push(result);
  }

  return results;
}
