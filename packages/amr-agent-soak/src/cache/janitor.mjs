// Independent janitor process export for the live-cache safety subsystem.
//
// This module is meant to run in its own OS process, separate from whatever
// process is driving soak scenarios, so orphaned resources still get cleaned
// up even if the primary process crashes. It provides exact IDENTITY-based
// supervision (refusing to start a second janitor while one is genuinely
// alive AND actually the process it claims to be -- not merely "some
// process is alive under this PID number", which is vulnerable to PID
// reuse after a crash -- via atomic exclusive file creation with safe
// stale replacement; see claimJanitorIdentity), heartbeat emission, an
// orphan-reconciliation pass that actually DELETES (not merely re-labels
// as active) tag-expired crash orphans, and a "zero-orphan evidence"
// report proving that, after a fresh re-list, the ledger and the live RP
// agree on every resource this run owns.
//
// The standalone process is expected to run indefinitely: its interval
// timer stays ref'd by default so Node keeps the event loop (and the
// process) alive. Only embedded/test callers -- which must not hang a test
// process waiting on this timer -- opt into `unref: true`.
//
// It can also be *executed directly* as its own process:
//   node packages/amr-agent-soak/src/cache/janitor.mjs

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileOnStartup } from './reconciliation.mjs';
import { deleteOwnedResource } from './cleanup.mjs';
import { evaluateCleanupEligibility } from './tags.mjs';
import { assertSubscriptionNotDenylisted } from './guards.mjs';

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

const DEFAULT_MAX_CLAIM_ATTEMPTS = 5;

/**
 * LEGACY / PID-ONLY -- kept for backward compatibility and its own test
 * coverage, but NO LONGER USED on the live standalone path (see
 * startJanitor, which now uses the identity-safe claimJanitorIdentity
 * below). PID-only supervision is vulnerable to PID reuse: after a janitor
 * crashes, the OS is free to reuse its exact PID number for a totally
 * unrelated process, which this function alone cannot distinguish from
 * the original janitor still being alive. Prefer claimJanitorIdentity for
 * any new/live usage.
 *
 * Verifies (and claims) the janitor PID file using atomic exclusive file
 * creation (`wx`) for every claim attempt -- never a read-then-write, which
 * would race a concurrent claimant. If the file already exists: re-claiming
 * our own PID is idempotent; a PID file owned by a different, *currently
 * alive* process causes a refusal to start a second janitor instance; a
 * stale PID file (owner no longer alive) is removed and the exclusive
 * create is retried. The launch scripts are the single spawn authority;
 * this file is a second defensive check, not a cross-host distributed lock.
 *
 * Deliberately NEVER renames a temp file onto an existing destination to
 * replace it: on Windows, `renameSync` cannot reliably replace an existing
 * destination file and can raise EPERM (a real, not merely flaky, failure
 * mode) -- unlike POSIX rename, which is atomic-and-replacing by design.
 * Unlink-then-retry-the-exclusive-create is fully portable and never hits
 * that failure mode, while still preventing two claimants from both
 * winning: if another process wins the race and creates the file before
 * our retry, our next `wx` attempt fails with EEXIST again and we correctly
 * detect its (alive) PID instead of overwriting it.
 */
export function claimPidFile(pidFilePath, { pid = process.pid, isAlive = defaultIsAlive, unlink = unlinkSync, maxAttempts = DEFAULT_MAX_CLAIM_ATTEMPTS } = {}) {
  ensureDirFor(pidFilePath);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      writeFileSync(pidFilePath, String(pid), { encoding: 'utf8', flag: 'wx' });
      return pid;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }

    let existingPid;
    try {
      existingPid = Number(readFileSync(pidFilePath, 'utf8').trim());
    } catch (readErr) {
      if (readErr?.code === 'ENOENT') continue; // Vanished between our wx attempt and this read -- just retry.
      throw readErr;
    }

    if (existingPid === pid) {
      return pid; // Idempotent re-claim of our own PID.
    }
    if (isAlive(existingPid)) {
      throw new JanitorError(`Janitor already running under PID ${existingPid}; refusing to start a second instance.`);
    }

    // Stale: remove it and retry the exclusive create on the next loop
    // iteration rather than renaming onto it.
    try {
      unlink(pidFilePath);
    } catch (unlinkErr) {
      if (unlinkErr?.code !== 'ENOENT') throw unlinkErr;
      // Already gone (another claimant's cleanup got there first) -- fine, just retry.
    }
  }

  throw new JanitorError(`Failed to claim PID file "${pidFilePath}" after ${maxAttempts} attempts (repeated concurrent claims).`);
}

// ---- Identity-safe claim: closes the PID-reuse gap in claimPidFile ----
//
// claimPidFile above is PID-only: it treats "some process is alive under
// PID N" as proof the recorded claimant is still running. After a janitor
// crashes, the OS is free to reuse its exact PID number for a totally
// unrelated process (a shell, a build tool, anything) -- a PID-only check
// would then refuse to start a new janitor FOREVER, even though the
// original janitor is long gone. claimJanitorIdentity persists a
// structured identity `{pid, startedAt, name, executablePath[,
// commandHash]}` instead of a bare PID, and verifies the FULL identity
// (not just "is this PID number alive") before concluding an existing
// claim is still legitimately held by the process it claims to be.
//
// claimPidFile itself is left completely untouched (still available for
// backward compatibility/tests), but the LIVE standalone path
// (startJanitor / the `node janitor.mjs` entrypoint below) now uses
// claimJanitorIdentity instead -- see "Keep legacy PID-only use fail-closed
// or remove it from live path".

/** How much clock skew/measurement imprecision to tolerate when comparing
 * two recorded `startedAt` timestamps for the "same" process instance. */
export const DEFAULT_IDENTITY_STARTED_AT_TOLERANCE_MS = 2000;

/**
 * Best-effort identity resolver: can only genuinely resolve the CURRENT
 * process's own identity. There is no portable, dependency-free way to
 * introspect an ARBITRARY OTHER PID's start time / executable path using
 * pure Node built-ins -- real cross-process identity resolution (to detect
 * PID reuse by a genuinely different OS process) is an INTEGRATION
 * concern: pass a real `resolveIdentity` (e.g. backed by the host's
 * SystemProcessManager) when wiring the standalone janitor for production
 * use. Returning `null` for any other PID means claimJanitorIdentity falls
 * back to a plain liveness check for that PID (fail-closed: "alive but
 * identity unknown" is treated as still theirs, never as free to steal).
 */
export function defaultResolveIdentity(pid) {
  if (pid !== process.pid) return null;
  return buildOwnIdentity();
}

/**
 * Builds this process's own identity record -- what we write into the
 * claim file when we win, and what a real `resolveIdentity` should return
 * when asked about a PID it can positively identify. Every piece is
 * injectable so tests can fabricate a stable identity instead of depending
 * on real process.uptime()/execPath.
 */
export function buildOwnIdentity({
  pid = process.pid,
  startedAt = Math.round(Date.now() - process.uptime() * 1000),
  name = process.argv0 || 'node',
  executablePath = process.execPath,
  commandHash,
} = {}) {
  const identity = { pid, startedAt, name, executablePath };
  if (commandHash !== undefined) identity.commandHash = commandHash;
  return identity;
}

function identitiesMatch(a, b, { startedAtToleranceMs = DEFAULT_IDENTITY_STARTED_AT_TOLERANCE_MS } = {}) {
  if (!a || !b) return false;
  if (a.pid !== b.pid) return false;
  if (a.executablePath !== b.executablePath) return false;
  if (a.name !== b.name) return false;
  if (Number.isFinite(a.startedAt) && Number.isFinite(b.startedAt)) {
    if (Math.abs(a.startedAt - b.startedAt) > startedAtToleranceMs) return false;
  } else if (a.startedAt !== b.startedAt) {
    return false;
  }
  if (a.commandHash !== undefined || b.commandHash !== undefined) {
    if (a.commandHash !== b.commandHash) return false;
  }
  return true;
}

function readJanitorIdentityRaw(identityFilePath) {
  try {
    return JSON.parse(readFileSync(identityFilePath, 'utf8'));
  } catch {
    // Corrupt/unparseable/vanished claim file -- cannot trust it as
    // evidence of a live claimant.
    return null;
  }
}

/**
 * Identity-safe janitor claim. Preserves the EXACT same bounded
 * wx/unlink-retry single-winner semantics as claimPidFile -- exclusive
 * (`wx`) create every attempt, never a read-then-write, and never a
 * rename onto an existing destination (Windows-safe) -- but persists and
 * verifies a full process identity instead of a bare PID number, so a
 * reused PID belonging to an unrelated process is correctly recognized as
 * stale (safe to replace) rather than "still alive" (refuse forever).
 *
 * @param {string} identityFilePath
 * @param {object} [opts]
 * @param {object} [opts.identity] - this claimant's own identity; defaults to buildOwnIdentity().
 * @param {(pid: number) => (object|null)} [opts.resolveIdentity] - resolves the identity of whatever process (if any) is currently running under `pid`. Defaults to defaultResolveIdentity (self only) -- inject a real resolver (e.g. backed by SystemProcessManager) for genuine cross-process PID-reuse detection in production.
 * @param {(pid: number) => boolean} [opts.isAlive] - fallback liveness check used only when resolveIdentity cannot determine identity for a PID other than our own. When false, the claim is unconditionally treated as stale regardless of identity. When true (identity unknown), fails closed: treated as still alive/theirs.
 * @param {number} [opts.startedAtToleranceMs]
 * @param {(path: string) => void} [opts.unlink]
 * @param {number} [opts.maxAttempts]
 * @returns {object} the identity that won the claim.
 */
export function claimJanitorIdentity(identityFilePath, {
  identity = buildOwnIdentity(),
  resolveIdentity = defaultResolveIdentity,
  isAlive = defaultIsAlive,
  startedAtToleranceMs = DEFAULT_IDENTITY_STARTED_AT_TOLERANCE_MS,
  unlink = unlinkSync,
  maxAttempts = DEFAULT_MAX_CLAIM_ATTEMPTS,
} = {}) {
  ensureDirFor(identityFilePath);
  const payload = JSON.stringify(identity);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      writeFileSync(identityFilePath, payload, { encoding: 'utf8', flag: 'wx' });
      return identity;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }

    const existing = readJanitorIdentityRaw(identityFilePath);

    if (existing && identitiesMatch(existing, identity, { startedAtToleranceMs })) {
      return identity; // idempotent re-claim of our own identity
    }

    // Determine whether the recorded claimant is still genuinely alive AND
    // is actually the process it claims to be (not a PID-reuse collision).
    let stillAliveAndMatching = false;
    if (existing && typeof existing.pid === 'number') {
      const resolved = resolveIdentity(existing.pid);
      if (resolved) {
        stillAliveAndMatching = identitiesMatch(resolved, existing, { startedAtToleranceMs });
      } else {
        // resolveIdentity couldn't determine identity for this PID --
        // fall back to a plain liveness check as the best available
        // signal. Fails CLOSED: "alive but identity unknown" is treated
        // as still theirs (never silently stolen), exactly matching the
        // legacy PID-only behavior claimPidFile always had.
        stillAliveAndMatching = isAlive(existing.pid);
      }
    }

    if (stillAliveAndMatching) {
      throw new JanitorError(
        `Janitor already running under PID ${existing.pid} (identity-verified); refusing to start a second instance.`
      );
    }

    // Stale (dead, PID-reused-by-a-different-process, or corrupt/
    // unreadable): remove it and retry the exclusive create on the next
    // iteration, never renaming onto it.
    try {
      unlink(identityFilePath);
    } catch (unlinkErr) {
      if (unlinkErr?.code !== 'ENOENT') throw unlinkErr;
    }
  }

  throw new JanitorError(`Failed to claim identity file "${identityFilePath}" after ${maxAttempts} attempts (repeated concurrent claims).`);
}

/** Reads and parses a janitor identity file, or `null` if absent/corrupt. */
export function readJanitorIdentity(identityFilePath) {
  if (!existsSync(identityFilePath)) return null;
  return readJanitorIdentityRaw(identityFilePath);
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
  const rawList = Array.isArray(liveList) ? liveList : (liveList?.value ?? []);
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
  // Subscription-denylist entry point: fail BEFORE any adapter call this
  // pass would otherwise make (listClusters, deletes, etc.) -- deliberately
  // checked here too, on top of reconciliation.mjs/cleanup.mjs's own
  // internal checks, so a denylisted subscription is refused at the very
  // first thing the janitor does.
  assertSubscriptionNotDenylisted(config.subscriptionId, config.subscriptionDenylist);

  const resourcePrefix = config.resourcePrefix;
  const listCoords = { subscriptionId: config.subscriptionId, resourceGroup: config.resourceGroup };
  const reconciliation = await reconcileOnStartup({
    ledger,
    adapter,
    subscriptionId: config.subscriptionId,
    resourceGroup: config.resourceGroup,
    resourcePrefix,
    subscriptionDenylist: config.subscriptionDenylist,
    ownerAlias: config.ownerAlias,
    runId: config.runId,
    now,
  });

  // Step 2: delete (not merely adopt/retain) any ledger-confirmed active
  // resource that is now tag-expired.
  const deletedExpired = [];
  const preDeleteLive = extractLiveRecordsByName(await adapter.listClusters(listCoords), resourcePrefix);
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
  const liveNames = new Set(extractLiveRecordsByName(await adapter.listClusters(listCoords), resourcePrefix).keys());
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
 * Runs the janitor loop: claims the identity file (see claimJanitorIdentity
 * -- PID-reuse-safe, not merely PID-only), then on an interval writes a
 * heartbeat and performs a reconciliation pass, producing zero-orphan
 * evidence each time. Returns a handle with `stop()`, the raw interval
 * `timer` (for introspection), and the in-memory evidence log (also written
 * to `evidencePath` when supplied).
 *
 * `unref` defaults to false: a standalone janitor process must stay alive
 * indefinitely. Pass `unref: true` only from embedded/test callers that
 * must not let this timer keep their process/test runner alive.
 *
 * `identity`/`resolveIdentity` are the integration points for a real host
 * process manager: pass a `resolveIdentity` backed by the host's
 * SystemProcessManager (or equivalent) to get genuine cross-process
 * PID-reuse detection in production; the default only resolves this
 * process's own identity.
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
  identity,
  resolveIdentity,
  isAlive,
}) {
  claimJanitorIdentity(pidFilePath, {
    ...(identity !== undefined ? { identity } : {}),
    ...(resolveIdentity !== undefined ? { resolveIdentity } : {}),
    ...(isAlive !== undefined ? { isAlive } : {}),
  });
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
    // Optional integration point: a real host process manager (e.g. this
    // team's SystemProcessManager) may supply a stable commandHash so
    // claimJanitorIdentity's identity match is even more precise than
    // pid+startedAt+executablePath alone. Left unset by default.
    identity: process.env.AMR_SOAK_JANITOR_COMMAND_HASH ? buildOwnIdentity({ commandHash: process.env.AMR_SOAK_JANITOR_COMMAND_HASH }) : undefined,
  });
}
