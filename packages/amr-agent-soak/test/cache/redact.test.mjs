import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactString, redactValue, redactForLog, createRedactingLogger } from '../../src/cache/redact.mjs';

test('redactString scrubs GUIDs (subscription/tenant ids)', () => {
  const input = 'subscription 11111111-2222-3333-4444-555555555555 in tenant 66666666-7777-8888-9999-aaaaaaaaaaaa';
  const out = redactString(input);
  assert.doesNotMatch(out, /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  assert.match(out, /\[REDACTED\]/);
});

test('redactString scrubs bearer tokens', () => {
  const out = redactString('Authorization: Bearer abc.def-ghi_123');
  assert.doesNotMatch(out, /abc\.def-ghi_123/);
});

test('redactString scrubs key/secret/token/password key=value pairs', () => {
  const out = redactString('accessKey=SUPERSECRETVALUE and password: "hunter2"');
  assert.doesNotMatch(out, /SUPERSECRETVALUE/);
  assert.doesNotMatch(out, /hunter2/);
});

test('redactValue redacts object properties whose key name looks sensitive', () => {
  const out = redactValue({ subscriptionId: 'sub-123', tenantId: 'tenant-456', ownerAlias: 'dmon', nested: { apiKey: 'topsecret' } });
  assert.equal(out.subscriptionId, '[REDACTED]');
  assert.equal(out.tenantId, '[REDACTED]');
  assert.equal(out.ownerAlias, 'dmon');
  assert.equal(out.nested.apiKey, '[REDACTED]');
});

test('redactValue handles arrays and circular references without throwing', () => {
  const circular = { name: 'x' };
  circular.self = circular;
  const out = redactValue({ list: ['a', 'b'], circular });
  assert.deepEqual(out.list, ['a', 'b']);
  assert.equal(out.circular.self, '[CIRCULAR]');
});

test('redactForLog dispatches to string or object redaction', () => {
  assert.match(redactForLog('token=hunter2xyz'), /\[REDACTED\]/);
  assert.equal(redactForLog({ password: 'x' }).password, '[REDACTED]');
});

test('createRedactingLogger redacts every argument before delegating', () => {
  const seen = [];
  const fakeConsole = {
    log: (...args) => seen.push(args),
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  const logger = createRedactingLogger(fakeConsole);
  logger.log('sub', { subscriptionId: '11111111-2222-3333-4444-555555555555' });
  assert.equal(seen[0][1].subscriptionId, '[REDACTED]');
});
