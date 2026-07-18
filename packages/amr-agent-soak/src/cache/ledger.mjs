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

const VALID_ACTIONS = new Set([
  'creation-intent',
  'created',
  'creation-failed',
  'mutated',
  'deleted',
  'lease-acquired',
  'lease-released',
  'heartbeat',
]);

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
      // A resource stops counting as "active"/"live" once it is either
      // actually deleted, or the RP gave a DEFINITIVE answer that creation
      // never succeeded (`creation-failed` -- see provisioning.mjs's
      // ConfirmedCreationFailure). Either way, this reflects the MOST
      // RECENT lifecycle event, exactly like `deleted` always has -- so a
      // later 'created' event (e.g. reconciliation confirming the resource
      // actually did come up despite our earlier ambiguous view) correctly
      // un-marks it.
      entry.deleted = record.action === 'deleted' || record.action === 'creation-failed';
    }
    return { creationOrder, byResource };
  }

  /** Resources created (or mutated) but not yet marked deleted (or
   * confirmed-failed to ever create), in creation order. */
  activeResources() {
    const { creationOrder, byResource } = this.replay();
    return creationOrder.filter((name) => !byResource.get(name).deleted);
  }

  /**
   * True if the ledger holds durable creation evidence for `name` -- a
   * 'creation-intent' or 'created' event recorded by *this run itself*.
   * This is the minimum bar for ever adopting a live resource discovered
   * during reconciliation: a name/prefix match alone is not evidence, since
   * names (and even tags) could coincidentally collide or be spoofed. Only
   * our own durable, previously-appended record counts.
   */
  hasCreationEvidence(name) {
    const { byResource } = this.replay();
    const entry = byResource.get(name);
    if (!entry) return false;
    return entry.events.some((e) => e.action === 'creation-intent' || e.action === 'created');
  }

  /**
   * True if the ledger recorded intent to create `name` (durably, before the
   * RP call was made) but never recorded a confirming 'created' event --
   * the signature of a crash between the intent append and the create
   * confirmation. Reconciliation uses this to safely upgrade such entries
   * to 'created' once it confirms the resource is actually live.
   */
  isIntentOnly(name) {
    const { byResource } = this.replay();
    const entry = byResource.get(name);
    if (!entry) return false;
    const hasCreated = entry.events.some((e) => e.action === 'created');
    const hasIntent = entry.events.some((e) => e.action === 'creation-intent');
    return hasIntent && !hasCreated;
  }

  /**
   * True if the RP gave a definitive answer that `name` never successfully
   * came up (a confirmed terminal "Failed"/"Canceled" provisioningState --
   * see provisioning.mjs's ConfirmedCreationFailure), as opposed to an
   * ambiguous/transient failure. The `creation-intent` event itself is
   * never removed (it remains as audit evidence), but this resource is
   * excluded from `activeResources()` and therefore no longer consumes
   * six-live-resource admission capacity.
   */
  hasCreationFailed(name) {
    const { byResource } = this.replay();
    const entry = byResource.get(name);
    if (!entry) return false;
    return entry.events.some((e) => e.action === 'creation-failed');
  }
}
