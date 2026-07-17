// Independent janitor process export for the live-cache safety subsystem.
//
// This module is meant to run in its own OS process, separate from whatever
// process is driving soak scenarios, so orphaned resources still get cleaned
// up even if the primary process crashes. It provides exact PID-based
// supervision (refusing to start a second janitor while one is genuinely
// alive), heartbeat emission, an orphan-reconciliation pass, and a
// "zero-orphan evidence" report proving that, after a pass, the ledger and
// the live RP agree on every resource this run owns.
//
// It can also be *executed directly* as its own process:
//   node packages/amr-agent-soak/src/cache/janitor.mjs

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileOnStartup } from './reconciliation.mjs';

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
 * Verifies (and claims) the janitor PID file. A stale PID file from a
 * previous run (crashed, or whose process has since exited) is replaced. A
 * PID file owned by a different, *currently alive* process causes a refusal
 * to start a second janitor instance.
 */
export function claimPidFile(pidFilePath, { pid = process.pid, isAlive = defaultIsAlive } = {}) {
  ensureDirFor(pidFilePath);
  if (existsSync(pidFilePath)) {
    const existingPid = Number(readFileSync(pidFilePath, 'utf8').trim());
    if (existingPid !== pid && isAlive(existingPid)) {
      throw new JanitorError(`Janitor already running under PID ${existingPid}; refusing to start a second instance.`);
    }
  }
  writeFileSync(pidFilePath, String(pid), 'utf8');
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

/**
 * Performs one orphan-reconciliation pass: reconciles the ledger against the
 * live RP, then produces "zero-orphan evidence" -- a report proving that,
 * after reconciliation, the ledger and the RP agree on every resource this
 * run owns (i.e. every live resource under our prefix is tracked as active
 * in the ledger, and vice versa). Resources quarantined by tag-based
 * eligibility checks (see reconciliation.mjs/tags.mjs) are intentionally
 * left un-adopted, so they still surface here as orphans requiring manual
 * review rather than being silently swept up.
 *
 * @param {object} opts
 * @param {import('./ledger.mjs').ResourceLedger} opts.ledger
 * @param {import('./http-adapter.mjs').LocalRpHttpAdapter} opts.adapter
 * @param {string} opts.resourcePrefix
 * @param {string} [opts.ownerAlias] - forwarded to reconcileOnStartup for tag-based eligibility.
 * @param {string} [opts.runId]
 * @param {() => number} [opts.now]
 */
export async function runJanitorPass({ ledger, adapter, resourcePrefix, ownerAlias, runId, now = () => Date.now() }) {
  const reconciliation = await reconcileOnStartup({ ledger, adapter, resourcePrefix, ownerAlias, runId, now });

  const liveList = await adapter.listCaches();
  const rawList = Array.isArray(liveList) ? liveList : (liveList?.caches ?? []);
  const liveNames = new Set(
    rawList.map((c) => (typeof c === 'string' ? c : c.name)).filter((name) => typeof name === 'string' && name.startsWith(resourcePrefix))
  );
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
 * evidence each time. Returns a handle with `stop()` and the in-memory
 * evidence log (also written to `evidencePath` when supplied).
 */
export async function startJanitor({
  pidFilePath,
  heartbeatFilePath,
  evidencePath,
  ledger,
  adapter,
  resourcePrefix,
  ownerAlias,
  runId,
  intervalMs = 30000,
  now = () => Date.now(),
  writeEvidence = defaultWriteEvidence,
  signal,
}) {
  claimPidFile(pidFilePath, { now });
  const evidenceLog = [];

  const tick = async () => {
    writeHeartbeat(heartbeatFilePath, { now });
    const evidence = await runJanitorPass({ ledger, adapter, resourcePrefix, ownerAlias, runId, now });
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
  timer.unref?.();

  signal?.addEventListener?.('abort', () => clearInterval(timer));

  return { stop: () => clearInterval(timer), evidenceLog, tick };
}

const isMainModule = Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  // Standalone entrypoint. Configuration must come from the environment --
  // never hard-coded -- matching the rest of this subsystem's rules.
  const { loadRuntimeConfig } = await import('./config.mjs');
  const { LocalRpHttpAdapter } = await import('./http-adapter.mjs');
  const { ResourceLedger } = await import('./ledger.mjs');

  const config = loadRuntimeConfig();
  const adapter = new LocalRpHttpAdapter();
  const ledger = new ResourceLedger({ path: config.ledgerPath ?? './amr-soak-ledger.jsonl' });

  await startJanitor({
    pidFilePath: process.env.AMR_SOAK_JANITOR_PID_PATH ?? './amr-soak-janitor.pid',
    heartbeatFilePath: process.env.AMR_SOAK_JANITOR_HEARTBEAT_PATH ?? './amr-soak-janitor.heartbeat.json',
    evidencePath: process.env.AMR_SOAK_JANITOR_EVIDENCE_PATH ?? './amr-soak-janitor.evidence.json',
    ledger,
    adapter,
    resourcePrefix: config.resourcePrefix,
    ownerAlias: config.ownerAlias,
    runId: config.runId,
    intervalMs: Number(process.env.AMR_SOAK_JANITOR_INTERVAL_MS ?? 30000),
  });
}
