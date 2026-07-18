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

/** Default ARM api-version used against the local RP's Microsoft.Cache
 * (redisEnterprise) contract when the caller/environment does not override
 * it. Runtime-configurable via AMR_SOAK_API_VERSION -- never hard-coded past
 * this default. */
export const DEFAULT_API_VERSION = '2024-09-01-preview';

/** Default overall deadline for polling a cluster/database CREATE to a
 * terminal provisioningState. Real local RP provisioning is multi-minute
 * (e.g. B0/E1-stage creates), not the ~60s generic default used elsewhere
 * for reconciliation-style polling -- so this has its own, much larger,
 * runtime-configurable default. Override via AMR_SOAK_CREATE_POLL_TIMEOUT_MS. */
export const DEFAULT_CREATE_POLL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/** Default overall deadline for polling a DELETE to terminal absence.
 * Deletes are typically faster than creates but still bounded, not
 * unbounded -- override via AMR_SOAK_DELETE_POLL_TIMEOUT_MS. */
export const DEFAULT_DELETE_POLL_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

/** Upper bound on any poll-timeout value (create or delete), guarding
 * against absurd overflow (e.g. a stray extra zero, or a value pasted in
 * the wrong unit) being silently accepted and effectively disabling the
 * overall deadline. Nothing in this subsystem's real create/delete
 * lifecycle plausibly needs longer than this. */
export const MAX_POLL_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

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

/** Parses a denylist-shaped value (array, comma-separated string, or
 * absent) into a normalized array. Shared by the resource-name denylist
 * and the (deliberately separate) subscription denylist. */
function parseListValue(raw) {
  return Array.isArray(raw)
    ? raw
    : typeof raw === 'string' && raw.length > 0
      ? raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
}

/**
 * Resolves and validates a poll-timeout value (createPollTimeoutMs or
 * deletePollTimeoutMs) sourced from env/runtime-file, or falls back to
 * `defaultValue` when unset. Fails closed: anything other than a finite,
 * positive, whole-millisecond integer no greater than MAX_POLL_TIMEOUT_MS
 * is rejected BEFORE any polling ever happens -- NaN (e.g. a typo'd env
 * value), Infinity, zero, negative values, non-integer values, and absurd
 * overflow (e.g. a stray extra zero) are all refused rather than silently
 * coerced into some other behavior (an unbounded or instantly-expiring
 * deadline would defeat the entire point of an overall poll timeout).
 */
function resolvePollTimeoutMs(rawValue, { envVarName, defaultValue }) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return defaultValue;
  const num = typeof rawValue === 'number' ? rawValue : Number(rawValue);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0 || num > MAX_POLL_TIMEOUT_MS) {
    throw new ConfigError(
      `${envVarName} (or the matching runtime-config-file field) must be a finite, positive, whole-millisecond ` +
        `integer no greater than ${MAX_POLL_TIMEOUT_MS}ms; got "${rawValue}".`
    );
  }
  return num;
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

  const denylist = parseListValue(denylistRaw);
  // Deliberately a SEPARATE list from `denylist` (resource NAMES) -- see
  // guards.mjs's assertSubscriptionNotDenylisted. A denylisted subscription
  // blocks every resource within it; the two lists/checks must never be
  // conflated.
  const subscriptionDenylist = parseListValue(env.AMR_SOAK_SUBSCRIPTION_DENYLIST ?? fileConfig.subscriptionDenylist);

  return {
    subscriptionId,
    tenantId,
    ownerAlias,
    runId,
    resourcePrefix: `${ownerAlias}-${runId}-`,
    denylist,
    subscriptionDenylist,
    resourceGroup: env.AMR_SOAK_RESOURCE_GROUP ?? fileConfig.resourceGroup ?? null,
    apiVersion: env.AMR_SOAK_API_VERSION ?? fileConfig.apiVersion ?? DEFAULT_API_VERSION,
    killSwitchPath: env.AMR_SOAK_KILL_SWITCH_PATH ?? fileConfig.killSwitchPath ?? null,
    ledgerPath: env.AMR_SOAK_LEDGER_PATH ?? fileConfig.ledgerPath ?? null,
    createPollTimeoutMs: resolvePollTimeoutMs(env.AMR_SOAK_CREATE_POLL_TIMEOUT_MS ?? fileConfig.createPollTimeoutMs, {
      envVarName: 'AMR_SOAK_CREATE_POLL_TIMEOUT_MS',
      defaultValue: DEFAULT_CREATE_POLL_TIMEOUT_MS,
    }),
    deletePollTimeoutMs: resolvePollTimeoutMs(env.AMR_SOAK_DELETE_POLL_TIMEOUT_MS ?? fileConfig.deletePollTimeoutMs, {
      envVarName: 'AMR_SOAK_DELETE_POLL_TIMEOUT_MS',
      defaultValue: DEFAULT_DELETE_POLL_TIMEOUT_MS,
    }),
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
    subscriptionDenylistSize: config.subscriptionDenylist?.length ?? 0,
    rpHost: config.rpHost,
    rpPort: config.rpPort,
    subscriptionId: config.subscriptionId,
    tenantId: config.tenantId,
  });
}
