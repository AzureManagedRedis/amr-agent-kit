// Mutation-context validation for the live-cache safety subsystem.
//
// This is the single boundary gate every mutating RP call must pass through.
// http-adapter.mjs invokes it internally, before ever issuing a create,
// delete, or topology-patch request -- so no caller can forget a check by
// calling the adapter directly: the adapter itself refuses to proceed
// without a fully validated context.

import { assertCustomerSubscriptionAcknowledged, assertSafeToMutate } from './guards.mjs';
import { assertLeaseAuthorizes } from './lease-manager.mjs';

export class MutationContextError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MutationContextError';
  }
}

/**
 * Validates a mutation context immediately before a mutating adapter call.
 * Checks, in order: shape of the context itself, customer-subscription
 * acknowledgement, the kill switch, subscription denylist + ownership +
 * resource-name denylist, lease-class operation authorization, and
 * fencing-token liveness. Throws the specific underlying error class on
 * the first failing check.
 *
 * @param {object} context
 * @param {object} context.config - runtime config (acknowledgedCustomerSubscription, resourcePrefix, denylist, subscriptionId, subscriptionDenylist).
 * @param {object} context.lease - the lease authorizing this operation.
 * @param {import('./lease-manager.mjs').LeaseManager} context.leaseManager
 * @param {import('./kill-switch.mjs').KillSwitch} [context.killSwitch]
 * @param {string} resourceName
 * @param {'read'|'write'|'topology'} operationKind
 */
export function assertValidMutationContext(context, resourceName, operationKind) {
  if (!context || typeof context !== 'object') {
    throw new MutationContextError('A mutation context is required for this operation.');
  }
  const { config, lease, leaseManager, killSwitch } = context;
  if (!config) throw new MutationContextError('Mutation context is missing "config".');
  if (!lease) throw new MutationContextError('Mutation context is missing "lease".');
  if (!leaseManager) throw new MutationContextError('Mutation context is missing "leaseManager".');

  assertCustomerSubscriptionAcknowledged(config);
  killSwitch?.assertNotEngaged(`mutate(${operationKind}) ${resourceName}`);
  assertSafeToMutate(resourceName, {
    resourcePrefix: config.resourcePrefix,
    denylist: config.denylist,
    subscriptionId: config.subscriptionId,
    subscriptionDenylist: config.subscriptionDenylist,
  });
  assertLeaseAuthorizes(lease, operationKind);
  leaseManager.assertFencingTokenValid(lease.id, lease.fencingToken);
}
