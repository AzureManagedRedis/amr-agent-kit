import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runIntegrationPreflight } from '../../src/integration/preflight.mjs'

test('runs fake-RP lifecycle and produces a linked miniature paired report', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'amr-soak-integration-'))
  try {
    const result = await runIntegrationPreflight({ outDir: root })
    assert.equal(result.cache_smoke.zero_orphans, true)
    assert.ok(result.cache_smoke.pagination_requests >= 2)
    assert.equal(result.paired_runs, 2)
    assert.equal(result.retained_clients, 2)
    assert.ok(result.report_files.includes('review.html'))
    assert.ok(result.report_files.includes('safety-report.json'))
    const artifactIndex = JSON.parse(await readFile(path.join(root, 'client-artifact-index.json'), 'utf8'))
    assert.equal(artifactIndex.complete, true)
    assert.equal(artifactIndex.entries.length, 2)
    const report = await readFile(path.join(root, 'report.md'), 'utf8')
    assert.match(report, /input-bad/)
    assert.match(report, /reference-good/)
    assert.match(report, /with-skill/)
    assert.match(report, /without-skill/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
