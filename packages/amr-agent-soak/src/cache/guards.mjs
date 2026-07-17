// Safety guard utilities for the live-cache safety subsystem.
//
// These are the checks that must gate every mutating call: the runtime
// denylist, the owner/run prefix (no unowned/pre-existing mutation), and the
// explicit customer-subscription acknowledgement. Callers should treat
// `assertSafeToMutate` as the single required gate immediately before any
// mutating RP call.

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

/** Combined guard: ownership + denylist. This is the single call every
 * mutating code path must make immediately before touching the RP. */
export function assertSafeToMutate(resourceName, { resourcePrefix, denylist = [] } = {}) {
  assertOwnedResource(resourceName, resourcePrefix);
  assertNotDenylisted(resourceName, denylist);
}
