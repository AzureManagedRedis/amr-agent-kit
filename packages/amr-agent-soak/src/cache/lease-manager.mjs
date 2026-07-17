// Lease manager for the live-cache safety subsystem.
//
// Every mutating (or read) interaction with the local RP happens under a
// lease. Leases have a class (shared/exclusive/topology/dry-run), a TTL that
// must be renewed via heartbeat, and consume a slice of a fixed connection
// budget. At most six leases may be active at once, global/destructive
// scenarios require an exclusive lease, and the kill switch is checked
// before any mutating-class lease is acquired.

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
