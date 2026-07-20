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
  adjudicateTwoGraders,
  assertCalibrationCanaries,
  buildBlindArmBundle,
  createBlindArmBundles,
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

function run({ arm, runId, score = 1, status, excluded = false, inconclusive = false } = {}) {
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
      passed: !inconclusive && score >= 0.5,
      inconclusive,
      contested_claims: inconclusive ? [{ assertion_id: 'c1' }] : [],
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

test('paired statistics require at least two valid pairs', () => {
  const result = pairedStatistics([{ withSkill: 1, withoutSkill: 0 }])
  assert.equal(result.n, 1)
  assert.equal(result.verdict, 'inconclusive')
})

test('blind bundles shuffle actual paired members before assigning labels', () => {
  const pair = {
    with_skill: { run_id: 'with', answer: 'skill answer' },
    without_skill: { run_id: 'without', answer: 'baseline answer' },
  }
  const observed = new Map([['with_skill', new Set()], ['without_skill', new Set()]])
  for (const seed of [1, 682]) {
    const bundle = buildBlindArmBundle(pair, { seed })
    for (const arm of bundle.arms) {
      observed.get(arm.label).add(arm.blind_label)
      assert.notEqual(arm.payload, undefined)
    }
    assert.notEqual(bundle.arms[0].payload.answer, bundle.arms[1].payload.answer)
  }
  assert.deepEqual([...observed.get('with_skill')].sort(), ['arm-a', 'arm-b'])
  assert.deepEqual([...observed.get('without_skill')].sort(), ['arm-a', 'arm-b'])
})

test('blind bundle batches are reproducible with explicit seeds and non-degenerate', () => {
  const pairs = Array.from({ length: 64 }, (_, index) => ({
    with_skill: { run_id: `with-${index}`, answer: `skill-${index}` },
    without_skill: { run_id: `without-${index}`, answer: `baseline-${index}` },
  }))
  const first = createBlindArmBundles(pairs, { seed: 12345 })
  const second = createBlindArmBundles(pairs, { seed: 12345 })
  assert.deepEqual(first, second)
  assert.ok(new Set(first.map((bundle) => bundle.arms.find((arm) => arm.label === 'with_skill').blind_label)).size > 1)
})

test('no-seed blind bundle batches use a non-degenerate random stream', () => {
  const pairs = Array.from({ length: 64 }, (_, index) => ({
    with_skill: { run_id: `with-${index}` },
    without_skill: { run_id: `without-${index}` },
  }))
  const bundles = createBlindArmBundles(pairs)
  assert.ok(new Set(bundles.map((bundle) => bundle.arms.find((arm) => arm.label === 'with_skill').blind_label)).size > 1)
})

test('computes Cohen kappa for two graders', () => {
  assert.equal(cohensKappa([true, true, false, false], [true, true, false, false]), 1)
  assert.equal(cohensKappa([true, false], [false, true]), -1)
})

test('shared adjudication computes kappa from canonical ID-aligned pairs', () => {
  const result = adjudicateTwoGraders(
    {
      assertions: [
        { id: 'c1', statement: 'first', passed: true },
        { id: 'c2', statement: 'second', passed: false },
      ],
      score: 0.5,
    },
    {
      assertions: [
        { id: 'c2', statement: 'second', passed: true },
        { id: 'c1', statement: 'first', passed: false },
      ],
      score: 0.5,
    },
  )
  assert.equal(result.kappa, -1)
  assert.deepEqual(result.disagreements, ['c1', 'c2'])
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

async function createRetainedClient(root, { mode = 'offline', includeLiveResults = false } = {}) {
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
    if (includeLiveResults) {
      await writeFile(path.join(clientRoot, arm, 'live-result.json'), '{"status":"ok"}')
    }
  }
  return { client_id: 'client-1', root: 'client-1', mode }
}

test('reports incomplete retained artifact trees', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'amr-soak-'))
  const index = await buildClientArtifactIndex({ root, clients: [{ client_id: 'missing', root: 'missing' }] })
  assert.equal(index.complete, false)
  assert.ok(index.entries[0].completeness.missing.includes('reference-good'))
})

test('requires live results only for live retained bundles and omits offline live links', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'amr-soak-live-artifacts-'))
  const offline = await createRetainedClient(root)
  const offlineIndex = await buildClientArtifactIndex({ root, clients: [offline] })
  assert.equal(offlineIndex.complete, true)
  assert.deepEqual(offlineIndex.entries[0].links.live_logs, [])

  const live = { ...offline, mode: 'live' }
  const missingLive = await buildClientArtifactIndex({ root, clients: [live] })
  assert.equal(missingLive.complete, false)
  assert.ok(missingLive.entries[0].completeness.missing.includes('with-skill/live-result.json'))
  assert.deepEqual(missingLive.entries[0].links.live_logs, [])
  await writeFile(path.join(root, 'client-1', 'with-skill', 'live-result.json'), '{}')
  await writeFile(path.join(root, 'client-1', 'without-skill', 'live-result.json'), '{}')
  const completeLive = await buildClientArtifactIndex({ root, clients: [live] })
  assert.equal(completeLive.complete, true)
  assert.equal(completeLive.entries[0].links.live_logs.length, 2)
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
      resource_id: 'access_token=do-not-publish',
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
  assert.ok(!written.get('report.md').includes('do-not-publish'))
  assert.ok(!written.get('benchmark.md').includes('do-not-publish'))
  assert.ok(written.get('report.md').includes('0.85'))
  assert.ok(written.get('report.md').includes('0.20'))
  assert.ok(!written.get('report.md').includes('live log'))
})

test('counts contested grades as inconclusive without aggregating their scores', async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'amr-soak-contested-report-'))
  const written = new Map()
  const result = await generateReport({
    skill_name: 'amr-agent-kit',
    metadata: metadata(),
    runs: [
      run({ arm: 'with_skill', runId: 'pair-contested', score: 0, inconclusive: true }),
      run({ arm: 'without_skill', runId: 'pair-contested', score: 0, inconclusive: true }),
    ],
    manifest: {
      SoakRunId: 'soak-contested',
      selector: 'offline',
      lease_class: 'dry-run',
      resource_id: 'not-applicable',
      namespace: 'test',
      cleanup_terminal_state: 'not-applicable',
      orphan_count: 0,
    },
  }, {
    outDir,
    writer: async (filePath, content) => written.set(path.basename(filePath), content),
  })

  assert.deepEqual(result.outcomeCounts, {
    passed_runs: 0,
    failed_runs: 0,
    inconclusive_runs: 2,
    inconclusive_pairs: 1,
  })
  assert.equal(result.rows[0].paired_statistics.n, 0)
  assert.equal(result.rows[0].with_skill_summary.efficacy.mean, null)
  assert.equal(result.rows[0].without_skill_summary.efficacy.mean, null)
  assert.equal(result.safety.summary.n, 0)
  assert.deepEqual(result.benchmark.model_variance, {})
  assert.equal(result.sourceCorrectness.summary.contested, 2)
  assert.equal(result.fixes.length, 0)
  assert.match(written.get('report.md'), /Inconclusive pairs: \*\*1\*\*/)
  assert.doesNotMatch(written.get('report.md'), /\| 0\.000 \| 0\.000 \|/)
})

test('deterministic grader separates safety from efficacy', () => {
  const result = gradeAnswer('Use TLS with bounded retries and reuse one client.', metadata())
  assert.equal(result.safety_score, 1)
  assert.equal(result.correctness_score, 1)
  assert.equal(result.efficacy_score, 1)
  const unsafe = gradeAnswer('disable TLS', metadata())
  assert.equal(unsafe.safety_score, 0)
})
