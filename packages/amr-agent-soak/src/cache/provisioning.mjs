// Create-side provisioning orchestrator for the live-cache safety subsystem.
//
// This is the only sanctioned way to create an owned resource, and it
// speaks the real Microsoft.Cache/redisEnterprise ARM contract (cluster +
// nested default database), not a fake "cache" shape. It:
//  1. Atomically admits the request against the SIX-LIVE-RESOURCE cap --
//     counted from ledger-confirmed live resources (creation-intent or
//     created, not yet deleted), never from LeaseManager.activeCount().
//     Releasing a lease never frees resource capacity; only a
//     terminal-confirmed delete does (see cleanup.mjs).
//  2. Durably records creation-intent in the ledger BEFORE ever calling the
//     RP, so that if the process crashes between the RP call and the
//     confirming ledger append, reconciliation has authoritative evidence
//     that this run intended to create this exact resource (see
//     reconciliation.mjs) -- rather than trusting a bare name/tag match.
//  3. Issues the guarded cluster create (location/tags/sku/minimumTlsVersion,
//     with Balanced B0 omitting capacity -- see sku-catalog.mjs) through the
//     adapter's mutation boundary, then polls the cluster's own
//     properties.provisioningState to terminal.
//  4. Issues the guarded database create (databases/default), passing
//     through ONLY validated-scenario fields (clientProtocol/encryption,
//     evictionPolicy, clusteringPolicy, and optionally modules/persistence/
//     geo) -- nothing invented here -- then polls it to terminal too.
//  5. Confirms with a 'created' ledger append only once both resources have
//     reached a terminal Succeeded state.

import { buildResourceTags } from './tags.mjs';
import { buildArmSkuBody } from './sku-catalog.mjs';
import { pollUntilTerminal, buildResourceProvisioningStateCheck } from './reconciliation.mjs';
import { DEFAULT_CREATE_POLL_TIMEOUT_MS } from './config.mjs';

export class ProvisioningError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProvisioningError';
  }
}

/**
 * A more specific ProvisioningError: the RP gave a DEFINITIVE answer (an
 * immediate PUT response, or a polled-to-terminal result, reporting
 * "Failed"/"Canceled" provisioningState) that creation did NOT succeed --
 * as opposed to an ambiguous/transient failure (network error, guard
 * rejection, etc.) where we cannot be sure whether the RP actually created
 * something server-side. Only this confirmed case frees the six-live-
 * resource admission slot (see createOwnedCache's catch block); an
 * ambiguous failure leaves the creation-intent reserved so a future
 * reconciliation pass can safely determine the truth instead of risking
 * silently over-admitting past the cap.
 */
export class ConfirmedCreationFailure extends ProvisioningError {
  constructor(message) {
    super(message);
    this.name = 'ConfirmedCreationFailure';
  }
}

/** Hard cap on ledger-confirmed LIVE resources for a single run. This is a
 * resource-count admission control, deliberately independent of
 * LeaseManager.activeCount() -- leases are temporary access grants; this cap
 * tracks durable, ledger-confirmed cache existence. */
export const MAX_LIVE_RESOURCES = 6;

/** Database body fields that may ONLY come from validated scenario inputs --
 * never invented/defaulted here. */
const VALIDATED_DATABASE_FIELDS = [
  'clientProtocol',
  'encryption',
  'evictionPolicy',
  'clusteringPolicy',
  'modules',
  'persistence',
  'geoReplication',
];

function pickValidatedDatabaseFields(databaseSpec = {}) {
  const picked = {};
  for (const field of VALIDATED_DATABASE_FIELDS) {
    if (databaseSpec[field] !== undefined) picked[field] = databaseSpec[field];
  }
  return picked;
}

/**
 * Captures a create-call's poll result and REQUIRES the terminal
 * provisioningState to be exactly "Succeeded". An immediate PUT response
 * body already reporting "Failed"/"Canceled" is rejected without ever
 * polling (no point waiting on a definitive answer we already have). A
 * state that reaches any OTHER terminal value via polling (Failed/Canceled)
 * is likewise rejected. Both throw ConfirmedCreationFailure -- a
 * DEFINITIVE, RP-confirmed answer, distinct from an ambiguous/transient
 * error -- so the caller can safely free admission capacity for it.
 */
async function ensureTerminalSucceeded({ result, kind, resourceName, dryRunOnly, pollTerminal, timeoutMs, getResource }) {
  if (dryRunOnly) return result;

  let state = result.body?.properties?.provisioningState;
  if (state === 'Failed' || state === 'Canceled') {
    throw new ConfirmedCreationFailure(
      `${kind} for "${resourceName}" was immediately reported as "${state}" by the RP -- refusing to confirm creation.`
    );
  }

  if (state !== 'Succeeded') {
    const finalStatus = await pollTerminal({
      checkStatus: buildResourceProvisioningStateCheck(getResource),
      label: `${kind} "${resourceName}" creation`,
      timeoutMs,
    });
    state = finalStatus.state;
  }

  if (state !== 'Succeeded') {
    throw new ConfirmedCreationFailure(
      `${kind} for "${resourceName}" reached terminal state "${state}", not "Succeeded" -- refusing to confirm creation.`
    );
  }
  return result;
}

/**
 * @param {object} opts
 * @param {import('./ledger.mjs').ResourceLedger} opts.ledger
 * @param {import('./http-adapter.mjs').LocalRpHttpAdapter} opts.adapter
 * @param {string} opts.resourceName - the cluster name.
 * @param {{family: string, name: string, capacity?: number}} opts.sku
 * @param {string} opts.location
 * @param {object} opts.config - runtime config (resourcePrefix, denylist, acknowledgedCustomerSubscription, ownerAlias, runId, subscriptionId, resourceGroup, createPollTimeoutMs).
 * @param {object} opts.lease - exclusive lease authorizing this create.
 * @param {import('./lease-manager.mjs').LeaseManager} opts.leaseManager
 * @param {import('./kill-switch.mjs').KillSwitch} [opts.killSwitch]
 * @param {boolean} [opts.dryRunOnly] - from sku-catalog.classifySkuRequest (via catalog-provider.mjs); forces a simulated create.
 * @param {number} [opts.expiresInMs] - tag ExpiresOn horizon; default 4 hours.
 * @param {object} [opts.extraTags]
 * @param {object} [opts.databaseSpec] - validated-scenario-only database fields; see VALIDATED_DATABASE_FIELDS.
 * @param {number} [opts.maxLiveResources]
 * @param {number} [opts.createPollTimeoutMs] - overall deadline for polling cluster/database creation to terminal; defaults to config.createPollTimeoutMs, then DEFAULT_CREATE_POLL_TIMEOUT_MS. Real local RP provisioning is multi-minute.
 * @param {() => number} [opts.now]
 * @param {typeof pollUntilTerminal} [opts.pollTerminal]
 */
export async function createOwnedCache({
  ledger,
  adapter,
  resourceName,
  sku,
  location,
  config,
  lease,
  leaseManager,
  killSwitch,
  dryRunOnly = false,
  expiresInMs = 4 * 60 * 60 * 1000,
  extraTags = {},
  databaseSpec = {},
  maxLiveResources = MAX_LIVE_RESOURCES,
  createPollTimeoutMs = config?.createPollTimeoutMs ?? DEFAULT_CREATE_POLL_TIMEOUT_MS,
  now = () => Date.now(),
  pollTerminal = pollUntilTerminal,
}) {
  if (!config?.resourcePrefix) {
    throw new ProvisioningError('createOwnedCache requires config.resourcePrefix.');
  }
  if (!resourceName.startsWith(config.resourcePrefix)) {
    throw new ProvisioningError(`Refusing to create "${resourceName}": missing owner/run prefix "${config.resourcePrefix}".`);
  }
  if (!location) {
    throw new ProvisioningError('createOwnedCache requires a location.');
  }

  // Atomic six-cache admission: count and reserve (via the intent append)
  // synchronously, with no `await` between the check and the reservation,
  // so no other synchronous caller in this single-threaded process can
  // interleave and overshoot the cap. Ledger-confirmed only -- lease count
  // is irrelevant here.
  const liveCount = ledger.activeResources().length;
  if (liveCount >= maxLiveResources) {
    throw new ProvisioningError(
      `Refusing to create "${resourceName}": ${liveCount} ledger-confirmed live resource(s) already exist ` +
        `(max ${maxLiveResources}). Releasing a lease does not free capacity -- only a confirmed delete does.`
    );
  }
  const tags = buildResourceTags({
    ownerAlias: config.ownerAlias,
    runId: config.runId,
    expiresInMs,
    now,
    extraTags,
  });
  // Durable pre-create intent -- written BEFORE the RP call, so a crash
  // between here and the 'created' confirmation still leaves authoritative
  // evidence for reconciliation to safely confirm later.
  ledger.append('creation-intent', resourceName, { sku, location, tags });

  const coords = { subscriptionId: config.subscriptionId, resourceGroup: config.resourceGroup, name: resourceName };
  const context = { config, lease, leaseManager, killSwitch, dryRunOnly };

  const clusterBody = {
    location,
    tags,
    sku: buildArmSkuBody(sku),
    properties: { minimumTlsVersion: '1.2' },
  };

  let clusterResult;
  let databaseResult;
  try {
    clusterResult = await adapter.createCluster(coords, clusterBody, context);
    await ensureTerminalSucceeded({
      result: clusterResult,
      kind: 'cluster',
      resourceName,
      dryRunOnly,
      pollTerminal,
      timeoutMs: createPollTimeoutMs,
      getResource: (signal) => adapter.getCluster(coords, { signal }),
    });

    const databaseBody = { properties: pickValidatedDatabaseFields(databaseSpec) };
    const dbCoords = { subscriptionId: config.subscriptionId, resourceGroup: config.resourceGroup, clusterName: resourceName };
    databaseResult = await adapter.createDatabase(dbCoords, databaseBody, context);
    await ensureTerminalSucceeded({
      result: databaseResult,
      kind: 'database',
      resourceName,
      dryRunOnly,
      pollTerminal,
      timeoutMs: createPollTimeoutMs,
      getResource: (signal) => adapter.getDatabase(dbCoords, { signal }),
    });
  } catch (err) {
    if (err instanceof ConfirmedCreationFailure) {
      // The RP gave a DEFINITIVE answer: creation did not succeed. Free
      // the six-live admission slot -- an intent confirmed to never
      // become a real resource must not permanently consume capacity.
      // The original 'creation-intent' event is left untouched as audit
      // evidence; 'created' is (and must remain) never appended.
      ledger.append('creation-failed', resourceName, { reason: err.message });
      throw err;
    }
    // Ambiguous/transient failure (network error, guard rejection, etc.):
    // we cannot be sure whether the RP actually created something
    // server-side, so the creation-intent stays reserved (untouched) --
    // not appended 'created' -- so a future reconciliation pass can
    // safely determine the truth rather than risking over-admission past
    // the cap by prematurely freeing this slot.
    throw new ProvisioningError(`Failed to create "${resourceName}": ${err.message}`);
  }

  ledger.append('created', resourceName, { sku, location, tags, dryRun: Boolean(clusterResult.body?.dryRun) });
  return { resourceName, tags, cluster: clusterResult, database: databaseResult };
}

