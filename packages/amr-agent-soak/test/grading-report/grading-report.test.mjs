import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  SoakSchemaError,
  validateEvalMetadata,
  validateGrading,
} from '../../src/grading/schema.mjs'
import {
  cohensKappa,
  pairedStatistics,
} from '../../src/grading/statistics.mjs'
import {
  assertCalibrationCanaries,
  gradeAnswer,
} from '../../src/grading/grade.mjs'
import { buildClientArtifactIndex } from '../../src/report/artifacts.mjs'
import { generateReport } from '../../src/report/generate.mjs'

function metadata() {
  return {
    eval_id: 'eval-1',
    eval_name: 'Cache safety <review>',
    target_skill: 'redis-code',
    prompt: 'Review a cache design.',
    assertions: [
      { id: 'c1', statement: 'Use TLS and bounded retries.', terms: ['TLS', 'bounded retries'], source_fact_ref: 'src-tls', required: true, weight: 1 },
      { id: 'c2', statement: 'Reuse one client.', terms: ['reuse', 'client'], required: false, weight: 1 },
    ],
    anti_patterns: ['disable TLS'],
    minimum_skill_score: 0.85,
    minimum_uplift: 0.2,
  }
}

function run({ arm, runId, score = 1, status, excluded = false } = {}) {
  return {
    eval_id: 'eval-1',
    run_id: runId,
    arm,
    model: 'test-model',
    status,
    excluded,
    grading: {
      assertions: [
        { id: 'c1', passed: score >= 0.5, source_fact_ref: 'src-tls', statement: 'Use TLS.' },
        { id: 'c2', passed: score >= 0.5, statement: 'Reuse one client.' },
      ],
      score,
      efficacy_score: score,
      correctness_score: score,
      safety_score: 1,
      safety_violations: [],
    },
    timing: { duration_ms: 10 },
  }
}

test('rejects incomplete eval metadata and grading shapes', () => {
  assert.throws(() => validateEvalMetadata({ eval_id: 'x' }), SoakSchemaError)
  assert.throws(() => validateGrading({ score: 1 }), SoakSchemaError)
})

test('normalizes skill-creator string assertions', () => {
  const result = validateEvalMetadata({
    eval_id: 1,
    eval_name: 'string assertions',
    target_skill: 'skill',
    prompt: 'prompt',
    assertions: ['Use TLS on port 10000.'],
  })
  assert.equal(result.assertions[0].id, 'c1')
  assert.ok(result.assertions[0].terms.includes('TLS'))
})

test('paired statistics preserve visible thresholds and mark crossing uplift inconclusive', () => {
  const result = pairedStatistics([
    { withSkill: 0.9, withoutSkill: 0.7 },
    { withSkill: 0.8, withoutSkill: 0.6 },
  ])
  assert.equal(result.scoreThreshold, 0.85)
  assert.equal(result.upliftThreshold, 0.2)
  assert.ok(Math.abs(result.uplift - 0.2) < 1e-12)
  assert.equal(result.verdict, 'inconclusive')
})

test('computes Cohen kappa for two graders', () => {
  assert.equal(cohensKappa([true, true, false, false], [true, true, false, false]), 1)
  assert.equal(cohensKappa([true, false], [false, true]), -1)
})

test('fails calibration canaries instead of silently accepting drift', () => {
  const badCanary = [{
    id: 'canary-1',
    answer: 'unsafe answer',
    metadata: {
      ...metadata(),
      assertions: [{ id: 'c1', statement: 'must mention TLS', terms: ['TLS'], required: true }],
    },
    expected_pass: true,
  }]
  assert.throws(() => assertCalibrationCanaries(badCanary), /Calibration canary failure/)
})

async function createRetainedClient(root) {
  const clientRoot = path.join(root, 'client-1')
  for (const variant of ['input-bad', 'reference-good', 'with-skill', 'without-skill']) {
    await mkdir(path.join(clientRoot, variant), { recursive: true })
  }
  await mkdir(path.join(clientRoot, 'patches'), { recursive: true })
  await writeFile(path.join(clientRoot, 'run-manifest.json'), '{}')
  await writeFile(path.join(clientRoot, 'hashes.json'), '{}')
  await writeFile(path.join(clientRoot, 'reproduce.ps1'), 'Write-Output ok')
  await writeFile(path.join(clientRoot, 'patches', 'fix.patch'), 'diff --git a/a b/a')
  for (const arm of ['with-skill', 'without-skill']) {
    await writeFile(path.join(clientRoot, arm, 'transcript.md'), 'redacted transcript')
    await writeFile(path.join(clientRoot, arm, 'build-result.json'), '{}')
  }
  return { client_id: 'client-1', root: 'client-1' }
}

test('reports incomplete retained artifact trees', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'amr-soak-'))
  const index = await buildClientArtifactIndex({ root, clients: [{ client_id: 'missing', root: 'missing' }] })
  assert.equal(index.complete, false)
  assert.ok(index.entries[0].completeness.missing.includes('reference-good'))
})

test('generates complete reports with excluded runs and escaped static HTML', async () => {
  const artifactRoot = await mkdtemp(path.join(tmpdir(), 'amr-soak-artifacts-'))
  const client = await createRetainedClient(artifactRoot)
  const outDir = await mkdtemp(path.join(tmpdir(), 'amr-soak-report-'))
  const written = new Map()
  const result = await generateReport({
    skill_name: 'amr-agent-kit',
    metadata: metadata(),
    runs: [
      run({ arm: 'with_skill', runId: 'pair-1', score: 0.95 }),
      run({ arm: 'without_skill', runId: 'pair-1', score: 0.65 }),
      run({ arm: 'with_skill', runId: 'excluded', score: 0.1, excluded: true }),
    ],
    clients: [client],
    artifact_root: artifactRoot,
    manifest: {
      SoakRunId: 'soak-1',
      selector: '<script>alert(1)</script>',
      lease_class: 'test',
      resource_id: 'resource-id',
      namespace: 'test-namespace',
      secret: 'access_token=do-not-publish',
      cleanup_terminal_state: 'deleted',
      orphan_count: 0,
    },
  }, {
    outDir,
    writer: async (filePath, content) => written.set(path.basename(filePath), content),
    artifactRoot,
  })
  assert.equal(result.excludedRuns.length, 1)
  assert.equal(result.artifactIndex.complete, true)
  assert.ok(written.has('benchmark.json'))
  assert.ok(written.get('review.html').includes('\\u0026lt;script\\u0026gt;'))
  assert.ok(!written.get('review.html').includes('do-not-publish'))
  assert.ok(written.get('report.md').includes('0.85'))
  assert.ok(written.get('report.md').includes('0.20'))
})

test('deterministic grader separates safety from efficacy', () => {
  const result = gradeAnswer('Use TLS with bounded retries and reuse one client.', metadata())
  assert.equal(result.safety_score, 1)
  assert.equal(result.correctness_score, 1)
  assert.equal(result.efficacy_score, 1)
  const unsafe = gradeAnswer('disable TLS', metadata())
  assert.equal(unsafe.safety_score, 0)
})
