import assert from 'node:assert/strict'
import test from 'node:test'
import { EvidenceStore } from '../../src/integration/evidence.mjs'
import { loadSoakRegistry } from '../../src/integration/registry.mjs'

test('accepts public-safe evidence and rejects local paths and identifiers', async () => {
  const runtime = await loadSoakRegistry()
  const store = new EvidenceStore(runtime)
  const record = store.ingest({
    id: 'tls-source',
    kind: 'source',
    provider_id: 'public-docs',
    fact_id: 'src-conn-tls-required',
    status: 'verified',
    public_statement: 'The public contract requires TLS.',
  }, 'source')
  assert.equal(record.status, 'verified')
  assert.equal(store.forFact('src-conn-tls-required').id, 'tls-source')
  assert.throws(
    () => store.ingest({
      id: 'private-source',
      kind: 'source',
      provider_id: 'private',
      fact_id: 'src-conn-tls-required',
      status: 'verified',
      public_statement: 'Implementation is at C:\\private\\file.cs:42',
    }, 'source'),
    /private or environment-specific/,
  )
})

test('effective configuration records expose key names but not values', async () => {
  const runtime = await loadSoakRegistry()
  const store = new EvidenceStore(runtime)
  assert.doesNotThrow(() => store.ingest({
    id: 'geo-limit-resolution',
    kind: 'effective-config',
    provider_id: 'runtime-config',
    fact_id: 'src-geo-5-6-topology',
    status: 'contested',
    public_statement: 'The effective limit was resolved without retaining its raw value.',
    effective_config: [{ key: 'GEO_REPLICATION_LIMIT', resolved: true, value_class: 'override' }],
  }, 'effective-config'))
  assert.throws(() => store.ingest({
    id: 'bad-resolution',
    kind: 'effective-config',
    provider_id: 'runtime-config',
    fact_id: 'src-geo-5-6-topology',
    status: 'verified',
    public_statement: 'Bad raw value.',
    effective_config: [{ key: 'GEO_REPLICATION_LIMIT', resolved: true, value: 5 }],
  }, 'effective-config'), /not public-safe/)
})
