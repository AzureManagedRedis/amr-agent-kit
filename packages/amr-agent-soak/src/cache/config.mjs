// Runtime configuration loader for the live-cache safety subsystem.
//
// Nothing in this module may hard-code a subscription ID, tenant ID,
// internal endpoint, or credential. Every such value must be supplied by the
// caller's environment (or an optional, git-ignored local JSON file) at run
// time. This module also enforces the single most important safety gate:
// an explicit, human-confirmed acknowledgement that operations will run
// against a real, customer-facing subscription.

import { readFileSync, existsSync } from 'node:fs';
import { redactForLog } from './redact.mjs';

/** The local RP simulator's host. Never anything else. */
export const LOCAL_RP_HOST = 'localhost';

/** The local RP simulator's fixed port. There is intentionally no fallback
 * (e.g. 8444) -- see http-adapter.mjs for the hard enforcement of this. */
export const LOCAL_RP_PORT = 8443;

const REQUIRED_ACK_VALUE = 'true';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readRuntimeFile(path) {
  if (!path) return {};
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Failed to read runtime config file at ${path}: ${err.message}`);
  }
}

/**
 * Loads runtime configuration exclusively from environment variables and an
 * optional, git-ignored local JSON file (path given by
 * AMR_SOAK_RUNTIME_CONFIG_PATH). Throws ConfigError if any required value is
 * missing or if the customer-subscription acknowledgement is absent.
 *
 * @param {NodeJS.ProcessEnv} [env] - defaults to process.env, injectable for tests.
 * @param {(path: string|undefined) => object} [fileReader] - injectable for tests.
 */
export function loadRuntimeConfig(env = process.env, fileReader = readRuntimeFile) {
  const fileConfig = fileReader(env.AMR_SOAK_RUNTIME_CONFIG_PATH);

  const subscriptionId = env.AMR_SOAK_SUBSCRIPTION_ID ?? fileConfig.subscriptionId;
  const tenantId = env.AMR_SOAK_TENANT_ID ?? fileConfig.tenantId;
  const ownerAlias = env.AMR_SOAK_OWNER ?? fileConfig.owner;
  const runId = env.AMR_SOAK_RUN_ID ?? fileConfig.runId;
  const ack = env.AMR_SOAK_ACK_CUSTOMER_SUBSCRIPTION ?? fileConfig.ackCustomerSubscription;
  const denylistRaw = env.AMR_SOAK_DENYLIST ?? fileConfig.denylist;

  if (!subscriptionId || typeof subscriptionId !== 'string') {
    throw new ConfigError(
      'AMR_SOAK_SUBSCRIPTION_ID (or runtime file "subscriptionId") is required and must never be hard-coded in source.'
    );
  }
  if (!tenantId || typeof tenantId !== 'string') {
    throw new ConfigError(
      'AMR_SOAK_TENANT_ID (or runtime file "tenantId") is required and must never be hard-coded in source.'
    );
  }
  if (!ownerAlias || typeof ownerAlias !== 'string') {
    throw new ConfigError('AMR_SOAK_OWNER (or runtime file "owner") is required to build the owner/run resource prefix.');
  }
  if (!runId || typeof runId !== 'string') {
    throw new ConfigError('AMR_SOAK_RUN_ID (or runtime file "runId") is required to build the owner/run resource prefix.');
  }

  const ackValue = typeof ack === 'boolean' ? String(ack) : ack;
  if (ackValue !== REQUIRED_ACK_VALUE) {
    throw new ConfigError(
      'Explicit customer-subscription acknowledgement is required. Set AMR_SOAK_ACK_CUSTOMER_SUBSCRIPTION=true ' +
        'only after confirming the target subscription is an approved, non-production soak subscription.'
    );
  }

  const denylist = Array.isArray(denylistRaw)
    ? denylistRaw
    : typeof denylistRaw === 'string' && denylistRaw.length > 0
      ? denylistRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

  return {
    subscriptionId,
    tenantId,
    ownerAlias,
    runId,
    resourcePrefix: `${ownerAlias}-${runId}-`,
    denylist,
    killSwitchPath: env.AMR_SOAK_KILL_SWITCH_PATH ?? fileConfig.killSwitchPath ?? null,
    ledgerPath: env.AMR_SOAK_LEDGER_PATH ?? fileConfig.ledgerPath ?? null,
    rpHost: LOCAL_RP_HOST,
    rpPort: LOCAL_RP_PORT,
    // Reaching this point means the ack check above passed; carry that fact
    // forward as an explicit field so downstream guards (see guards.mjs) can
    // assert it defensively even if a config object was hand-built by a
    // caller that bypassed loadRuntimeConfig.
    acknowledgedCustomerSubscription: true,
  };
}

/** Produces a safe-to-log summary of a config object (subscription/tenant redacted). */
export function describeConfig(config) {
  return redactForLog({
    ownerAlias: config.ownerAlias,
    runId: config.runId,
    resourcePrefix: config.resourcePrefix,
    denylistSize: config.denylist.length,
    rpHost: config.rpHost,
    rpPort: config.rpPort,
    subscriptionId: config.subscriptionId,
    tenantId: config.tenantId,
  });
}
