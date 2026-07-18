import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadRuntimeConfig,
  ConfigError,
  describeConfig,
  LOCAL_RP_HOST,
  LOCAL_RP_PORT,
  DEFAULT_CREATE_POLL_TIMEOUT_MS,
  DEFAULT_DELETE_POLL_TIMEOUT_MS,
} from '../../src/cache/config.mjs';

const BASE_ENV = {
  AMR_SOAK_SUBSCRIPTION_ID: '11111111-2222-3333-4444-555555555555',
  AMR_SOAK_TENANT_ID: '66666666-7777-8888-9999-aaaaaaaaaaaa',
  AMR_SOAK_OWNER: 'dmon',
  AMR_SOAK_RUN_ID: 'run42',
  AMR_SOAK_ACK_CUSTOMER_SUBSCRIPTION: 'true',
};

test('loadRuntimeConfig succeeds with all required env vars and the explicit ack', () => {
  const config = loadRuntimeConfig(BASE_ENV);
  assert.equal(config.subscriptionId, BASE_ENV.AMR_SOAK_SUBSCRIPTION_ID);
  assert.equal(config.tenantId, BASE_ENV.AMR_SOAK_TENANT_ID);
  assert.equal(config.resourcePrefix, 'dmon-run42-');
  assert.equal(config.rpHost, LOCAL_RP_HOST);
  assert.equal(config.rpPort, LOCAL_RP_PORT);
  assert.equal(config.acknowledgedCustomerSubscription, true);
});

test('loadRuntimeConfig never invents a subscription id: missing env throws ConfigError', () => {
  const env = { ...BASE_ENV };
  delete env.AMR_SOAK_SUBSCRIPTION_ID;
  assert.throws(() => loadRuntimeConfig(env), ConfigError);
});

test('loadRuntimeConfig never invents a tenant id: missing env throws ConfigError', () => {
  const env = { ...BASE_ENV };
  delete env.AMR_SOAK_TENANT_ID;
  assert.throws(() => loadRuntimeConfig(env), ConfigError);
});

test('loadRuntimeConfig requires explicit customer-subscription acknowledgement', () => {
  const env = { ...BASE_ENV };
  delete env.AMR_SOAK_ACK_CUSTOMER_SUBSCRIPTION;
  assert.throws(() => loadRuntimeConfig(env), ConfigError);
});

// ---- Review finding #2: real local-RP provisioning is multi-minute; poll
// timeouts must be configurable, with safe multi-minute defaults ----

test('loadRuntimeConfig defaults create/delete poll timeouts to multi-minute constants, not a short generic default', () => {
  const config = loadRuntimeConfig(BASE_ENV);
  assert.equal(config.createPollTimeoutMs, DEFAULT_CREATE_POLL_TIMEOUT_MS);
  assert.equal(config.deletePollTimeoutMs, DEFAULT_DELETE_POLL_TIMEOUT_MS);
  // Sanity: these must be far larger than reconciliation's ~60s generic
  // default -- real B0/E1-stage creates are multi-minute.
  assert.ok(DEFAULT_CREATE_POLL_TIMEOUT_MS >= 30 * 60 * 1000);
  assert.ok(DEFAULT_DELETE_POLL_TIMEOUT_MS >= 10 * 60 * 1000);
});

test('loadRuntimeConfig honors AMR_SOAK_CREATE_POLL_TIMEOUT_MS / AMR_SOAK_DELETE_POLL_TIMEOUT_MS env overrides', () => {
  const config = loadRuntimeConfig({
    ...BASE_ENV,
    AMR_SOAK_CREATE_POLL_TIMEOUT_MS: '900000',
    AMR_SOAK_DELETE_POLL_TIMEOUT_MS: '450000',
  });
  assert.equal(config.createPollTimeoutMs, 900000);
  assert.equal(config.deletePollTimeoutMs, 450000);
});

test('loadRuntimeConfig honors createPollTimeoutMs/deletePollTimeoutMs from the runtime file config', () => {
  const fileReader = () => ({ createPollTimeoutMs: 123000, deletePollTimeoutMs: 45000 });
  const config = loadRuntimeConfig(BASE_ENV, fileReader);
  assert.equal(config.createPollTimeoutMs, 123000);
  assert.equal(config.deletePollTimeoutMs, 45000);
});

// ---- Final hardening: poll timeouts must fail closed on invalid values,
// BEFORE any polling ever happens -- never silently coerced ----

const INVALID_POLL_TIMEOUT_VALUES = [
  ['NaN', 'NaN'],
  ['Infinity', 'Infinity'],
  ['-Infinity', '-Infinity'],
  ['zero', '0'],
  ['negative', '-5000'],
  ['non-integer', '1000.5'],
  ['absurd overflow (100 years in ms)', String(100 * 365 * 24 * 60 * 60 * 1000)],
  ['non-numeric garbage', 'not-a-number'],
  ['empty-ish whitespace', '   '],
];

for (const [label, rawValue] of INVALID_POLL_TIMEOUT_VALUES) {
  test(`loadRuntimeConfig rejects an invalid createPollTimeoutMs env value (${label})`, () => {
    const env = { ...BASE_ENV, AMR_SOAK_CREATE_POLL_TIMEOUT_MS: rawValue };
    assert.throws(() => loadRuntimeConfig(env), ConfigError);
  });

  test(`loadRuntimeConfig rejects an invalid deletePollTimeoutMs env value (${label})`, () => {
    const env = { ...BASE_ENV, AMR_SOAK_DELETE_POLL_TIMEOUT_MS: rawValue };
    assert.throws(() => loadRuntimeConfig(env), ConfigError);
  });
}

test('loadRuntimeConfig rejects an invalid createPollTimeoutMs/deletePollTimeoutMs sourced from the runtime file', () => {
  assert.throws(() => loadRuntimeConfig(BASE_ENV, () => ({ createPollTimeoutMs: Number.NaN })), ConfigError);
  assert.throws(() => loadRuntimeConfig(BASE_ENV, () => ({ createPollTimeoutMs: 0 })), ConfigError);
  assert.throws(() => loadRuntimeConfig(BASE_ENV, () => ({ createPollTimeoutMs: -1 })), ConfigError);
  assert.throws(() => loadRuntimeConfig(BASE_ENV, () => ({ createPollTimeoutMs: Infinity })), ConfigError);
  assert.throws(() => loadRuntimeConfig(BASE_ENV, () => ({ deletePollTimeoutMs: Number.NaN })), ConfigError);
  assert.throws(() => loadRuntimeConfig(BASE_ENV, () => ({ deletePollTimeoutMs: -1 })), ConfigError);
});

test('loadRuntimeConfig accepts a valid createPollTimeoutMs/deletePollTimeoutMs at the exact MAX_POLL_TIMEOUT_MS boundary', async () => {
  const { MAX_POLL_TIMEOUT_MS } = await import('../../src/cache/config.mjs');
  const config = loadRuntimeConfig({
    ...BASE_ENV,
    AMR_SOAK_CREATE_POLL_TIMEOUT_MS: String(MAX_POLL_TIMEOUT_MS),
    AMR_SOAK_DELETE_POLL_TIMEOUT_MS: String(MAX_POLL_TIMEOUT_MS),
  });
  assert.equal(config.createPollTimeoutMs, MAX_POLL_TIMEOUT_MS);
  assert.equal(config.deletePollTimeoutMs, MAX_POLL_TIMEOUT_MS);
});

test('loadRuntimeConfig rejects a value one millisecond past MAX_POLL_TIMEOUT_MS', async () => {
  const { MAX_POLL_TIMEOUT_MS } = await import('../../src/cache/config.mjs');
  const env = { ...BASE_ENV, AMR_SOAK_CREATE_POLL_TIMEOUT_MS: String(MAX_POLL_TIMEOUT_MS + 1) };
  assert.throws(() => loadRuntimeConfig(env), ConfigError);
});

test('loadRuntimeConfig falls back to the safe default when the env var is unset or an empty string, rather than treating it as invalid', () => {
  const configUnset = loadRuntimeConfig(BASE_ENV);
  assert.equal(configUnset.createPollTimeoutMs, DEFAULT_CREATE_POLL_TIMEOUT_MS);

  const configEmpty = loadRuntimeConfig({ ...BASE_ENV, AMR_SOAK_CREATE_POLL_TIMEOUT_MS: '' });
  assert.equal(configEmpty.createPollTimeoutMs, DEFAULT_CREATE_POLL_TIMEOUT_MS);
});

test('loadRuntimeConfig still accepts valid, in-range numeric-string overrides for both poll timeouts', () => {
  const config = loadRuntimeConfig({
    ...BASE_ENV,
    AMR_SOAK_CREATE_POLL_TIMEOUT_MS: '600000',
    AMR_SOAK_DELETE_POLL_TIMEOUT_MS: '300000',
  });
  assert.equal(config.createPollTimeoutMs, 600000);
  assert.equal(config.deletePollTimeoutMs, 300000);
});

test('loadRuntimeConfig rejects a falsy/typo ack value (e.g. "yes")', () => {
  const env = { ...BASE_ENV, AMR_SOAK_ACK_CUSTOMER_SUBSCRIPTION: 'yes' };
  assert.throws(() => loadRuntimeConfig(env), ConfigError);
});

test('loadRuntimeConfig falls back to a git-ignored local runtime file when env vars are absent', () => {
  const env = { AMR_SOAK_RUNTIME_CONFIG_PATH: '/fake/path/runtime.json' };
  const fileReader = (path) => {
    assert.equal(path, '/fake/path/runtime.json');
    return {
      subscriptionId: 'sub-from-file',
      tenantId: 'tenant-from-file',
      owner: 'dmon',
      runId: 'run7',
      ackCustomerSubscription: 'true',
    };
  };
  const config = loadRuntimeConfig(env, fileReader);
  assert.equal(config.subscriptionId, 'sub-from-file');
  assert.equal(config.resourcePrefix, 'dmon-run7-');
});

test('loadRuntimeConfig parses a comma-separated denylist', () => {
  const config = loadRuntimeConfig({ ...BASE_ENV, AMR_SOAK_DENYLIST: 'prod-cache, shared-infra*, ' });
  assert.deepEqual(config.denylist, ['prod-cache', 'shared-infra*']);
});

test('describeConfig redacts subscription and tenant ids', () => {
  const config = loadRuntimeConfig(BASE_ENV);
  const described = describeConfig(config);
  assert.equal(described.subscriptionId, '[REDACTED]');
  assert.equal(described.tenantId, '[REDACTED]');
  assert.equal(described.ownerAlias, 'dmon');
});
