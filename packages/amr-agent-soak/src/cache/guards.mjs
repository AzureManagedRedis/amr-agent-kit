// Safety guard utilities for the live-cache safety subsystem.
//
// These are the checks that must gate every mutating call: the runtime
// denylist, the owner/run prefix (no unowned/pre-existing mutation), the
// explicit customer-subscription acknowledgement, and the SUBSCRIPTION
// denylist (deliberately distinct from the resource-NAME denylist -- a
// denylisted subscription must block every resource within it, not just a
// resource whose name happens to match some unrelated pattern). Callers
// should treat `assertSafeToMutate` as the single required gate immediately
// before any mutating RP call.

export class GuardViolation extends Error {
  constructor(message) {
    super(message);
    this.name = 'GuardViolation';
  }
}

/** Defense-in-depth check that a config object carries an explicit
 * customer-subscription acknowledgement, even if it was hand-built by a
 * caller that bypassed config.loadRuntimeConfig's own gate. */
export function assertCustomerSubscriptionAcknowledged(config) {
  if (config?.acknowledgedCustomerSubscription !== true) {
    throw new GuardViolation('Explicit customer-subscription acknowledgement is missing. Refusing to proceed.');
  }
}

/**
 * Throws if `subscriptionId` (normalized: trimmed, case-insensitive) is an
 * EXACT match for any entry in `subscriptionDenylist` (each entry
 * normalized the same way -- no wildcard support, unlike the resource-name
 * denylist: a subscription ID either is, or is not, denylisted). This is a
 * deliberately SEPARATE mechanism from `assertNotDenylisted` (which checks
 * resource NAMES) -- the two must never be conflated: a resource name that
 * happens to look like a subscription ID, or a subscription-denylist entry
 * that happens to look like a resource name, must not trip the other
 * check.
 *
 * A missing/falsy `subscriptionId` is not this guard's concern (other
 * guards/config validation require it elsewhere) -- it simply passes
 * through without throwing.
 */
export function assertSubscriptionNotDenylisted(subscriptionId, subscriptionDenylist = []) {
  if (!subscriptionId) return;
  const normalized = String(subscriptionId).trim().toLowerCase();
  for (const entry of subscriptionDenylist) {
    if (!entry) continue;
    if (String(entry).trim().toLowerCase() === normalized) {
      throw new GuardViolation(
        `Subscription "${subscriptionId}" is present in the runtime subscription denylist. Refusing to proceed.`
      );
    }
  }
}

/** Throws if resourceName matches a literal or `prefix*` wildcard entry in the runtime denylist. */
export function assertNotDenylisted(resourceName, denylist = []) {
  for (const entry of denylist) {
    if (!entry) continue;
    if (resourceName === entry) {
      throw new GuardViolation(`Resource "${resourceName}" is present in the runtime denylist.`);
    }
    if (entry.endsWith('*') && resourceName.startsWith(entry.slice(0, -1))) {
      throw new GuardViolation(`Resource "${resourceName}" matches denylist wildcard "${entry}".`);
    }
  }
}

/** Throws unless resourceName carries this run's owner/run prefix -- the core
 * "no unowned/pre-existing mutation" guard. */
export function assertOwnedResource(resourceName, resourcePrefix) {
  if (!resourceName.startsWith(resourcePrefix)) {
    throw new GuardViolation(
      `Refusing to mutate resource "${resourceName}": it does not carry the owner/run prefix "${resourcePrefix}". ` +
        `Only resources created by this run may be mutated.`
    );
  }
}

/** Throws unless resourceName is present in the set of names this run itself
 * created (tracked via the ledger), guarding against mutating something that
 * merely happens to match the prefix but was never actually created by us. */
export function assertNotPreExisting(resourceName, knownResourceNames) {
  if (!(knownResourceNames instanceof Set)) {
    throw new TypeError('knownResourceNames must be a Set.');
  }
  if (!knownResourceNames.has(resourceName)) {
    throw new GuardViolation(
      `Refusing to mutate resource "${resourceName}": it was not created by this run and is not tracked in the ledger.`
    );
  }
}

/** Combined guard: ownership + resource-name denylist + subscription
 * denylist. This is the single call every mutating code path must make
 * immediately before touching the RP. `subscriptionId`/`subscriptionDenylist`
 * are optional to preserve callers that only care about resource-level
 * checks, but every real mutation path in this subsystem supplies them. */
export function assertSafeToMutate(resourceName, { resourcePrefix, denylist = [], subscriptionId, subscriptionDenylist = [] } = {}) {
  assertSubscriptionNotDenylisted(subscriptionId, subscriptionDenylist);
  assertOwnedResource(resourceName, resourcePrefix);
  assertNotDenylisted(resourceName, denylist);
}
