// Append-only resource ledger for the live-cache safety subsystem.
//
// Every lifecycle event for every resource this run touches is appended as
// an immutable JSON-Lines record; nothing is ever rewritten or removed.
// Replaying the ledger reconstructs current known state, which underpins
// startup reconciliation, reverse cleanup ordering, and janitor orphan
// detection.

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class LedgerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LedgerError';
  }
}

const VALID_ACTIONS = new Set(['created', 'mutated', 'deleted', 'lease-acquired', 'lease-released', 'heartbeat']);

export class ResourceLedger {
  /**
   * @param {object} opts
   * @param {string} opts.path - file path for the JSONL ledger.
   * @param {() => number} [opts.now]
   */
  constructor({ path, now = () => Date.now() }) {
    if (!path) throw new LedgerError('ResourceLedger requires a path.');
    this.path = path;
    this.now = now;
    const dir = dirname(path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  /** Appends one immutable event record. Never mutates or removes prior records. */
  append(action, resourceName, detail = {}) {
    if (!VALID_ACTIONS.has(action)) {
      throw new LedgerError(`Unknown ledger action "${action}".`);
    }
    const record = { id: randomUUID(), ts: this.now(), action, resourceName, detail };
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }

  /** Returns every record ever appended, in append order. */
  readAll() {
    if (!existsSync(this.path)) return [];
    const raw = readFileSync(this.path, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  /**
   * Replays the ledger into current known state: an ordered list of resource
   * names in first-seen (creation) order, plus per-resource event history.
   */
  replay() {
    const byResource = new Map();
    const creationOrder = [];
    for (const record of this.readAll()) {
      if (!byResource.has(record.resourceName)) {
        byResource.set(record.resourceName, { resourceName: record.resourceName, events: [] });
        creationOrder.push(record.resourceName);
      }
      const entry = byResource.get(record.resourceName);
      entry.events.push(record);
      entry.lastAction = record.action;
      entry.lastEventAt = record.ts;
      entry.deleted = record.action === 'deleted';
    }
    return { creationOrder, byResource };
  }

  /** Resources created (or mutated) but not yet marked deleted, in creation order. */
  activeResources() {
    const { creationOrder, byResource } = this.replay();
    return creationOrder.filter((name) => !byResource.get(name).deleted);
  }
}
