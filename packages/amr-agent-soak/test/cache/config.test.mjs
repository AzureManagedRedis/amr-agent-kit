import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntimeConfig, ConfigError, describeConfig, LOCAL_RP_HOST, LOCAL_RP_PORT } from '../../src/cache/config.mjs';

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
