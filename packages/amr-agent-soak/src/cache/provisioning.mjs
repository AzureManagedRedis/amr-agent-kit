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

export class ProvisioningError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProvisioningError';
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
 * @param {object} opts
 * @param {import('./ledger.mjs').ResourceLedger} opts.ledger
 * @param {import('./http-adapter.mjs').LocalRpHttpAdapter} opts.adapter
 * @param {string} opts.resourceName - the cluster name.
 * @param {{family: string, name: string, capacity?: number}} opts.sku
 * @param {string} opts.location
 * @param {object} opts.config - runtime config (resourcePrefix, denylist, acknowledgedCustomerSubscription, ownerAlias, runId, subscriptionId, resourceGroup).
 * @param {object} opts.lease - exclusive lease authorizing this create.
 * @param {import('./lease-manager.mjs').LeaseManager} opts.leaseManager
 * @param {import('./kill-switch.mjs').KillSwitch} [opts.killSwitch]
 * @param {boolean} [opts.dryRunOnly] - from sku-catalog.classifySkuRequest (via catalog-provider.mjs); forces a simulated create.
 * @param {number} [opts.expiresInMs] - tag ExpiresOn horizon; default 4 hours.
 * @param {object} [opts.extraTags]
 * @param {object} [opts.databaseSpec] - validated-scenario-only database fields; see VALIDATED_DATABASE_FIELDS.
 * @param {number} [opts.maxLiveResources]
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
    if (!dryRunOnly && clusterResult.body?.properties?.provisioningState !== 'Succeeded') {
      await pollTerminal({
        checkStatus: buildResourceProvisioningStateCheck((signal) => adapter.getCluster(coords, { signal })),
        label: `cluster "${resourceName}" creation`,
      });
    }

    const databaseBody = { properties: pickValidatedDatabaseFields(databaseSpec) };
    const dbCoords = { subscriptionId: config.subscriptionId, resourceGroup: config.resourceGroup, clusterName: resourceName };
    databaseResult = await adapter.createDatabase(dbCoords, databaseBody, context);
    if (!dryRunOnly && databaseResult.body?.properties?.provisioningState !== 'Succeeded') {
      await pollTerminal({
        checkStatus: buildResourceProvisioningStateCheck((signal) => adapter.getDatabase(dbCoords, { signal })),
        label: `database for "${resourceName}" creation`,
      });
    }
  } catch (err) {
    // Intent stays recorded (untouched) so reconciliation can retry or
    // surface this cleanly on the next pass; we do not append 'created'.
    throw new ProvisioningError(`Failed to create "${resourceName}": ${err.message}`);
  }

  ledger.append('created', resourceName, { sku, location, tags, dryRun: Boolean(clusterResult.body?.dryRun) });
  return { resourceName, tags, cluster: clusterResult, database: databaseResult };
}

