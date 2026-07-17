// Create-side provisioning orchestrator for the live-cache safety subsystem.
//
// This is the only sanctioned way to create an owned resource. It:
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
//  3. Issues the guarded create through the adapter's mutation boundary.
//  4. Confirms with a 'created' ledger append on success.

import { buildResourceTags } from './tags.mjs';

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

/**
 * @param {object} opts
 * @param {import('./ledger.mjs').ResourceLedger} opts.ledger
 * @param {import('./http-adapter.mjs').LocalRpHttpAdapter} opts.adapter
 * @param {string} opts.resourceName
 * @param {object} opts.spec - cache creation spec (SKU, etc.) merged with generated tags.
 * @param {object} opts.config - runtime config (resourcePrefix, denylist, acknowledgedCustomerSubscription, ownerAlias, runId).
 * @param {object} opts.lease - exclusive lease authorizing this create.
 * @param {import('./lease-manager.mjs').LeaseManager} opts.leaseManager
 * @param {import('./kill-switch.mjs').KillSwitch} [opts.killSwitch]
 * @param {boolean} [opts.dryRunOnly] - from sku-catalog.classifySkuRequest; forces a simulated create.
 * @param {number} [opts.expiresInMs] - tag ExpiresOn horizon; default 4 hours.
 * @param {object} [opts.extraTags]
 * @param {number} [opts.maxLiveResources]
 * @param {() => number} [opts.now]
 */
export async function createOwnedCache({
  ledger,
  adapter,
  resourceName,
  spec = {},
  config,
  lease,
  leaseManager,
  killSwitch,
  dryRunOnly = false,
  expiresInMs = 4 * 60 * 60 * 1000,
  extraTags = {},
  maxLiveResources = MAX_LIVE_RESOURCES,
  now = () => Date.now(),
}) {
  if (!config?.resourcePrefix) {
    throw new ProvisioningError('createOwnedCache requires config.resourcePrefix.');
  }
  if (!resourceName.startsWith(config.resourcePrefix)) {
    throw new ProvisioningError(`Refusing to create "${resourceName}": missing owner/run prefix "${config.resourcePrefix}".`);
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
  ledger.append('creation-intent', resourceName, { spec, tags });

  const context = { config, lease, leaseManager, killSwitch, dryRunOnly };
  const fullSpec = { ...spec, tags };

  let response;
  try {
    response = await adapter.createCache(resourceName, fullSpec, context);
  } catch (err) {
    // Intent stays recorded (untouched) so reconciliation can retry or
    // surface this cleanly on the next pass; we do not append 'created'.
    throw new ProvisioningError(`Failed to create "${resourceName}": ${err.message}`);
  }

  ledger.append('created', resourceName, { spec, tags, dryRun: Boolean(response?.dryRun) });
  return { resourceName, tags, response };
}
