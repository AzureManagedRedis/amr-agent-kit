// Independent janitor process export for the live-cache safety subsystem.
//
// This module is meant to run in its own OS process, separate from whatever
// process is driving soak scenarios, so orphaned resources still get cleaned
// up even if the primary process crashes. It provides exact PID-based
// supervision (refusing to start a second janitor while one is genuinely
// alive, via atomic exclusive file creation with safe stale replacement),
// heartbeat emission, an orphan-reconciliation pass that actually DELETES
// (not merely re-labels as active) tag-expired crash orphans, and a
// "zero-orphan evidence" report proving that, after a fresh re-list, the
// ledger and the live RP agree on every resource this run owns.
//
// The standalone process is expected to run indefinitely: its interval
// timer stays ref'd by default so Node keeps the event loop (and the
// process) alive. Only embedded/test callers -- which must not hang a test
// process waiting on this timer -- opt into `unref: true`.
//
// It can also be *executed directly* as its own process:
//   node packages/amr-agent-soak/src/cache/janitor.mjs

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { reconcileOnStartup } from './reconciliation.mjs';
import { deleteOwnedResource } from './cleanup.mjs';
import { evaluateCleanupEligibility } from './tags.mjs';

export class JanitorError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JanitorError';
  }
}

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ensureDirFor(filePath) {
  const dir = dirname(filePath);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Verifies (and claims) the janitor PID file using atomic exclusive file
 * creation (`wx`) for the initial claim -- never a read-then-write, which
 * would race a concurrent claimant. If the file already exists: re-claiming
 * our own PID is idempotent; a PID file owned by a different, *currently
 * alive* process causes a refusal to start a second janitor instance; a
 * stale PID file (owner no longer alive) is replaced via a temp-file +
 * atomic rename, never a direct overwrite.
 */
export function claimPidFile(pidFilePath, { pid = process.pid, isAlive = defaultIsAlive } = {}) {
  ensureDirFor(pidFilePath);

  try {
    writeFileSync(pidFilePath, String(pid), { encoding: 'utf8', flag: 'wx' });
    return pid;
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }

  const existingPid = Number(readFileSync(pidFilePath, 'utf8').trim());
  if (existingPid === pid) {
    return pid; // Idempotent re-claim of our own PID.
  }
  if (isAlive(existingPid)) {
    throw new JanitorError(`Janitor already running under PID ${existingPid}; refusing to start a second instance.`);
  }

  // Stale: safely replace via temp file + atomic rename rather than a
  // direct overwrite, which could race another claimant doing the same.
  const tmpPath = `${pidFilePath}.${pid}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, String(pid), 'utf8');
  renameSync(tmpPath, pidFilePath);
  return pid;
}

export function writeHeartbeat(heartbeatFilePath, { pid = process.pid, now = () => Date.now() } = {}) {
  ensureDirFor(heartbeatFilePath);
  const record = { pid, ts: now() };
  writeFileSync(heartbeatFilePath, JSON.stringify(record), 'utf8');
  return record;
}

export function readHeartbeat(heartbeatFilePath) {
  if (!existsSync(heartbeatFilePath)) return null;
  return JSON.parse(readFileSync(heartbeatFilePath, 'utf8'));
}

function extractLiveRecordsByName(liveList, resourcePrefix) {
  const rawList = Array.isArray(liveList) ? liveList : (liveList?.caches ?? []);
  const byName = new Map();
  for (const item of rawList) {
    const record = typeof item === 'string' ? { name: item } : item;
    if (typeof record?.name === 'string' && record.name.startsWith(resourcePrefix)) {
      byName.set(record.name, record);
    }
  }
  return byName;
}

/**
 * Performs one orphan-reconciliation pass:
 *   1. reconcile the ledger against the live RP (adopts only durable
 *      creation-intent evidence; quarantines everything else -- see
 *      reconciliation.mjs)
 *   2. for every ledger-confirmed active resource that is ALSO tag-expired,
 *      actually DELETE it (poll terminal, verify absence) under a
 *      short-lived exclusive lease -- merely re-labeling an expired orphan
 *      as "active" is not cleanup
 *   3. re-list live caches fresh (post-deletion) before computing the
 *      final "zero-orphan evidence" -- so a stale pre-deletion snapshot
 *      can never be mistaken for proof of cleanliness
 *
 * @param {object} opts
 * @param {import('./ledger.mjs').ResourceLedger} opts.ledger
 * @param {import('./http-adapter.mjs').LocalRpHttpAdapter} opts.adapter
 * @param {object} opts.config - runtime config (resourcePrefix, denylist, ownerAlias, runId, acknowledgedCustomerSubscription).
 * @param {import('./lease-manager.mjs').LeaseManager} opts.leaseManager - used to acquire a short-lived exclusive lease per expired-orphan delete.
 * @param {import('./kill-switch.mjs').KillSwitch} [opts.killSwitch]
 * @param {() => number} [opts.now]
 * @param {Function} [opts.pollTerminal] - forwarded to deleteOwnedResource.
 */
export async function runJanitorPass({ ledger, adapter, config, leaseManager, killSwitch, now = () => Date.now(), pollTerminal }) {
  if (!config?.resourcePrefix) throw new JanitorError('runJanitorPass requires config.resourcePrefix.');
  if (!leaseManager) throw new JanitorError('runJanitorPass requires a leaseManager to authorize expired-orphan deletes.');

  const resourcePrefix = config.resourcePrefix;
  const reconciliation = await reconcileOnStartup({
    ledger,
    adapter,
    resourcePrefix,
    ownerAlias: config.ownerAlias,
    runId: config.runId,
    now,
  });

  // Step 2: delete (not merely adopt/retain) any ledger-confirmed active
  // resource that is now tag-expired.
  const deletedExpired = [];
  const preDeleteLive = extractLiveRecordsByName(await adapter.listCaches(), resourcePrefix);
  for (const name of ledger.activeResources()) {
    const record = preDeleteLive.get(name);
    if (!record) continue; // Not actually live; reconciliation already handles that mismatch separately.
    const evaluation = evaluateCleanupEligibility(record.tags, { ownerAlias: config.ownerAlias, runId: config.runId, now });
    if (!evaluation.eligible || !evaluation.expired) continue;

    const lease = leaseManager.acquire({ class: 'exclusive', resourceName: name, destructive: true });
    try {
      const context = { config, lease, leaseManager, killSwitch };
      const result = await deleteOwnedResource({ ledger, adapter, resourceName: name, context, pollTerminal });
      if (result.status === 'deleted' || result.status === 'already-absent') {
        deletedExpired.push(name);
      }
    } finally {
      leaseManager.release(lease.id);
    }
  }

  // Step 3: re-list fresh -- never trust the pre-deletion snapshot for the
  // final zero-orphan claim.
  const liveNames = new Set(extractLiveRecordsByName(await adapter.listCaches(), resourcePrefix).keys());
  const activeInLedger = new Set(ledger.activeResources());
  const orphans = [...liveNames].filter((name) => !activeInLedger.has(name));

  return {
    ts: now(),
    resourcePrefix,
    checkedLive: liveNames.size,
    checkedLedger: activeInLedger.size,
    orphanCount: orphans.length,
    orphans,
    quarantined: reconciliation.quarantined,
    deletedExpired,
    zeroOrphans: orphans.length === 0,
    reconciliation,
  };
}

function defaultWriteEvidence(path, evidence) {
  ensureDirFor(path);
  writeFileSync(path, JSON.stringify(evidence, null, 2), 'utf8');
}

/**
 * Runs the janitor loop: claims the PID file, then on an interval writes a
 * heartbeat and performs a reconciliation pass, producing zero-orphan
 * evidence each time. Returns a handle with `stop()`, the raw interval
 * `timer` (for introspection), and the in-memory evidence log (also written
 * to `evidencePath` when supplied).
 *
 * `unref` defaults to false: a standalone janitor process must stay alive
 * indefinitely. Pass `unref: true` only from embedded/test callers that
 * must not let this timer keep their process/test runner alive.
 */
export async function startJanitor({
  pidFilePath,
  heartbeatFilePath,
  evidencePath,
  ledger,
  adapter,
  config,
  leaseManager,
  killSwitch,
  intervalMs = 30000,
  now = () => Date.now(),
  writeEvidence = defaultWriteEvidence,
  signal,
  unref = false,
}) {
  claimPidFile(pidFilePath, { now });
  const evidenceLog = [];

  const tick = async () => {
    writeHeartbeat(heartbeatFilePath, { now });
    const evidence = await runJanitorPass({ ledger, adapter, config, leaseManager, killSwitch, now });
    evidenceLog.push(evidence);
    if (evidencePath) writeEvidence(evidencePath, evidence);
    return evidence;
  };

  await tick();

  const timer = setInterval(() => {
    tick().catch((err) => {
      // A single failed pass must never silently stop orphan detection.
      // eslint-disable-next-line no-console
      console.error('[janitor] reconciliation pass failed:', err.message);
    });
  }, intervalMs);
  if (unref) timer.unref?.();

  signal?.addEventListener?.('abort', () => clearInterval(timer));

  return { stop: () => clearInterval(timer), evidenceLog, tick, timer };
}

const isMainModule = Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  // Standalone entrypoint. Configuration must come from the environment --
  // never hard-coded -- matching the rest of this subsystem's rules. `unref`
  // is intentionally NOT passed here: it defaults to false, so this process
  // stays alive indefinitely, as a standalone janitor must.
  const { loadRuntimeConfig } = await import('./config.mjs');
  const { LocalRpHttpAdapter } = await import('./http-adapter.mjs');
  const { ResourceLedger } = await import('./ledger.mjs');
  const { LeaseManager } = await import('./lease-manager.mjs');

  const config = loadRuntimeConfig();
  const adapter = new LocalRpHttpAdapter();
  const ledger = new ResourceLedger({ path: config.ledgerPath ?? './amr-soak-ledger.jsonl' });
  const leaseManager = new LeaseManager({
    fencingStatePath: process.env.AMR_SOAK_FENCING_STATE_PATH ?? './amr-soak-fencing.json',
  });

  await startJanitor({
    pidFilePath: process.env.AMR_SOAK_JANITOR_PID_PATH ?? './amr-soak-janitor.pid',
    heartbeatFilePath: process.env.AMR_SOAK_JANITOR_HEARTBEAT_PATH ?? './amr-soak-janitor.heartbeat.json',
    evidencePath: process.env.AMR_SOAK_JANITOR_EVIDENCE_PATH ?? './amr-soak-janitor.evidence.json',
    ledger,
    adapter,
    config,
    leaseManager,
    intervalMs: Number(process.env.AMR_SOAK_JANITOR_INTERVAL_MS ?? 30000),
  });
}
