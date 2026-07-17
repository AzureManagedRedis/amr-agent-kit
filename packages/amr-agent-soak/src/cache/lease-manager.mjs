// Lease manager for the live-cache safety subsystem.
//
// Every mutating (or read) interaction with the local RP happens under a
// lease. Leases have a class (shared/exclusive/topology/dry-run), a TTL that
// must be renewed via heartbeat, and consume a slice of a fixed connection
// budget. At most six leases may be active at once, global/destructive
// scenarios require an exclusive lease, and the kill switch is checked
// before any mutating-class lease is acquired.
//
// Leases also carry a monotonically increasing fencing token. If a lease
// expires (or is released) and is reaped, its token is no longer recognized
// -- so a caller that kept mutating after losing its lease (e.g. a stalled
// worker that missed its heartbeat window) cannot continue: any mutation
// path must present (leaseId, fencingToken) and have it validated via
// assertFencingTokenValid before touching the RP.
//
// Lease *class* additionally gates *what kind* of operation it authorizes:
// shared leases are read-only (connectivity checks only); exclusive leases
// authorize write/control-plane mutations; topology leases authorize
// topology-shape changes only; dry-run leases authorize everything because
// nothing they "authorize" ever reaches the real adapter.

import { randomUUID } from 'node:crypto';
import { KillSwitch } from './kill-switch.mjs';

export const LEASE_CLASSES = Object.freeze(['shared', 'exclusive', 'topology', 'dry-run']);
const MUTATING_CLASSES = new Set(['exclusive', 'topology']);

export const MAX_ACTIVE_LEASES = 6;

export class LeaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LeaseError';
  }
}

export class FencingTokenStale extends LeaseError {
  constructor(message) {
    super(message);
    this.name = 'FencingTokenStale';
  }
}

export class LeaseNotAuthorized extends LeaseError {
  constructor(message) {
    super(message);
    this.name = 'LeaseNotAuthorized';
  }
}

/** The kinds of operation a lease can be asked to authorize. */
export const OPERATION_KINDS = Object.freeze(['read', 'write', 'topology']);

const CLASS_ALLOWED_OPERATIONS = {
  shared: new Set(['read']),
  exclusive: new Set(['read', 'write', 'topology']),
  topology: new Set(['read', 'topology']),
  'dry-run': new Set(['read', 'write', 'topology']),
};

/**
 * Asserts that `lease` (as returned by LeaseManager#acquire) authorizes the
 * given operation kind. Shared leases are read-only/connectivity-only;
 * write and control-plane mutations require an exclusive lease; topology
 * leases authorize topology-shape changes only.
 */
export function assertLeaseAuthorizes(lease, operationKind) {
  if (!OPERATION_KINDS.includes(operationKind)) {
    throw new LeaseError(`Unknown operation kind "${operationKind}". Expected one of: ${OPERATION_KINDS.join(', ')}.`);
  }
  const allowed = CLASS_ALLOWED_OPERATIONS[lease?.class];
  if (!allowed || !allowed.has(operationKind)) {
    throw new LeaseNotAuthorized(
      `Lease class "${lease?.class}" does not authorize "${operationKind}" operations ` +
        `(shared leases are read-only/connectivity; write and control-plane mutations require an exclusive lease).`
    );
  }
}

export class LeaseManager {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxActiveLeases] - hard-capped at MAX_ACTIVE_LEASES.
   * @param {number} [opts.connectionBudget] - total concurrent connections all active leases may consume.
   * @param {KillSwitch} [opts.killSwitch]
   * @param {() => number} [opts.now] - injectable clock for tests.
   */
  constructor({
    maxActiveLeases = MAX_ACTIVE_LEASES,
    connectionBudget = MAX_ACTIVE_LEASES * 2,
    killSwitch = new KillSwitch(),
    now = () => Date.now(),
  } = {}) {
    if (maxActiveLeases > MAX_ACTIVE_LEASES) {
      throw new LeaseError(`maxActiveLeases (${maxActiveLeases}) may not exceed the hard cap of ${MAX_ACTIVE_LEASES}.`);
    }
    this.maxActiveLeases = maxActiveLeases;
    this.connectionBudget = connectionBudget;
    this.killSwitch = killSwitch;
    this.now = now;
    /** @type {Map<string, object>} */
    this.leases = new Map();
    this.fencingCounter = 0;
  }

  #reapExpired() {
    const nowMs = this.now();
    for (const [id, lease] of this.leases) {
      if (lease.expiresAt <= nowMs) this.leases.delete(id);
    }
  }

  #activeConnectionTotal() {
    let total = 0;
    for (const lease of this.leases.values()) total += lease.connections;
    return total;
  }

  /**
   * Acquires a new lease.
   * @param {object} request
   * @param {'shared'|'exclusive'|'topology'|'dry-run'} request.class
   * @param {boolean} [request.destructive] - global/destructive scenarios must use 'exclusive'.
   * @param {number} [request.connections] - connection budget cost, default 1.
   * @param {number} [request.ttlMs] - default 5 minutes.
   * @param {string} [request.resourceName]
   */
  acquire({ class: leaseClass, destructive = false, connections = 1, ttlMs = 5 * 60 * 1000, resourceName } = {}) {
    if (!LEASE_CLASSES.includes(leaseClass)) {
      throw new LeaseError(`Unknown lease class "${leaseClass}". Expected one of: ${LEASE_CLASSES.join(', ')}.`);
    }
    if (destructive && leaseClass !== 'exclusive') {
      throw new LeaseError(`Global/destructive scenarios require an "exclusive" lease (got "${leaseClass}").`);
    }
    if (MUTATING_CLASSES.has(leaseClass)) {
      this.killSwitch.assertNotEngaged(`acquire(${leaseClass}) for ${resourceName ?? '<unnamed>'}`);
    }

    this.#reapExpired();

    if (this.leases.size >= this.maxActiveLeases) {
      throw new LeaseError(`Cannot acquire lease: ${this.maxActiveLeases} active leases already held (max reached).`);
    }
    const currentConnections = this.#activeConnectionTotal();
    if (currentConnections + connections > this.connectionBudget) {
      throw new LeaseError(
        `Cannot acquire lease: connection budget exceeded (${currentConnections} + ${connections} > ${this.connectionBudget}).`
      );
    }

    const id = randomUUID();
    const nowMs = this.now();
    const fencingToken = ++this.fencingCounter;
    const lease = {
      id,
      class: leaseClass,
      destructive,
      connections,
      resourceName: resourceName ?? null,
      acquiredAt: nowMs,
      expiresAt: nowMs + ttlMs,
      ttlMs,
      lastHeartbeatAt: nowMs,
      fencingToken,
    };
    this.leases.set(id, lease);
    return { ...lease };
  }

  /** Renews a lease's TTL. Throws if the lease is unknown or already expired/reaped. */
  heartbeat(leaseId) {
    this.#reapExpired();
    const lease = this.leases.get(leaseId);
    if (!lease) {
      throw new LeaseError(`Cannot heartbeat unknown or expired lease "${leaseId}".`);
    }
    const nowMs = this.now();
    lease.lastHeartbeatAt = nowMs;
    lease.expiresAt = nowMs + lease.ttlMs;
    return { ...lease };
  }

  release(leaseId) {
    this.leases.delete(leaseId);
  }

  /**
   * Throws FencingTokenStale unless `fencingToken` matches the token
   * currently held by lease `leaseId` AND that lease is still active (not
   * expired/reaped/released). This is what prevents an owner that has lost
   * its lease -- e.g. missed heartbeats past TTL -- from continuing to
   * mutate: once reaped, its token is never recognized again, even if the
   * same leaseId were somehow presented.
   */
  assertFencingTokenValid(leaseId, fencingToken) {
    this.#reapExpired();
    const lease = this.leases.get(leaseId);
    if (!lease) {
      throw new FencingTokenStale(
        `Fencing token rejected: lease "${leaseId}" is no longer active (expired, released, or never existed).`
      );
    }
    if (lease.fencingToken !== fencingToken) {
      throw new FencingTokenStale(
        `Fencing token rejected: token ${fencingToken} does not match the current token for lease "${leaseId}".`
      );
    }
    return true;
  }

  /** Boolean form of assertFencingTokenValid, for callers that want to check without throwing. */
  isFencingTokenValid(leaseId, fencingToken) {
    try {
      this.assertFencingTokenValid(leaseId, fencingToken);
      return true;
    } catch {
      return false;
    }
  }

  isActive(leaseId) {
    this.#reapExpired();
    return this.leases.has(leaseId);
  }

  listActive() {
    this.#reapExpired();
    return [...this.leases.values()].map((l) => ({ ...l }));
  }

  activeCount() {
    this.#reapExpired();
    return this.leases.size;
  }
}
