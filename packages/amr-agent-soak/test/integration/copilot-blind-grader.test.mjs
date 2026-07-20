import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createBlindGrader } from '../../src/integration/copilot-blind-grader.mjs'
import { EvidenceStore } from '../../src/integration/evidence.mjs'
import { loadSoakRegistry, RegistryScenarioProvider } from '../../src/integration/registry.mjs'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

function strictResponse(request) {
  return JSON.stringify({
    grades: Object.fromEntries(request.arms.map((arm) => {
      const passed = !arm.output.includes('redis://')
      return [arm.label, {
        assertions: request.rubric.criteria.map((criterion) => ({
          id: criterion.id,
          statement: criterion.statement,
          passed,
          evidence: arm.output,
        })),
        score: passed ? 1 : 0,
        passed,
      }]
    })),
  })
}

function disagreeingResponse(request, { modelId }, shouldDisagree) {
  return JSON.stringify({
    grades: Object.fromEntries(request.arms.map((arm) => {
      const baselinePassed = !arm.output.includes('redis://')
      const passed = modelId === 'grader-b' && shouldDisagree(arm)
        ? !baselinePassed
        : baselinePassed
      return [arm.label, {
        assertions: request.rubric.criteria.map((criterion) => ({
          id: criterion.id,
          statement: criterion.statement,
          passed,
          evidence: arm.output,
        })),
        score: passed ? 1 : 0,
        passed,
      }]
    })),
  })
}

function artifact(answer, arm) {
  return {
    responseText: answer,
    status: 'completed',
    trace: { executableHash: `${arm}-hash` },
  }
}

test('bridges paired model grading through calibration and preserves both raw graders', async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-blind-grader-'))
  try {
    const runtime = await loadSoakRegistry()
    const [scenario] = await new RegistryScenarioProvider(runtime, {
      targetSkill: 'redis-code',
      scenarioIds: ['scn-connection-auth-tls-entra'],
      runId: 'blind-grader-test',
    }).listScenarios()
    const grader = await createBlindGrader({
      runtime,
      evidenceStore: new EvidenceStore(runtime),
      config: {
        modelIds: ['grader-a', 'grader-b'],
        minimumKappa: 0.8,
        requireExecutorDiversity: true,
        modelExecutor: async (request) => strictResponse(request),
      },
      repositoryRoot: repoRoot,
      processManager: {},
      controllerConfig: { runId: 'blind-grader-test', model: 'executor-model' },
      runDir,
      skillSnapshotPath: path.join(repoRoot, 'skills', 'redis-code'),
    })
    const calibration = await grader.assertCalibration([scenario])
    assert.equal(calibration.passed, true)
    assert.deepEqual(calibration.modelIds, ['grader-a', 'grader-b'])
    assert.equal(calibration.kappa, 1)
    assert.equal(grader.snapshot.maxConcurrentPairs, 4)
    assert.equal(grader.snapshot.maximumActiveModelProcesses, 16)
    const provenanceFiles = new Set(grader.snapshot.dependencies.map((item) => item.file))
    for (const required of [
      'src/core/hash.ts',
      'src/core/atomic.ts',
      'dist/src/core/hash.js',
      'dist/src/core/atomic.js',
    ]) {
      assert.ok(provenanceFiles.has(required), required)
    }

    const good = scenario.metadata.graderCanaries.find((item) => item.expected_grade === 'pass').answer_excerpt
    const bad = scenario.metadata.graderCanaries.find((item) => item.expected_grade === 'fail').answer_excerpt
    const evaluatedGood = `${good} EVAL_WITH`
    const evaluatedBad = `${bad} EVAL_WITHOUT`
    const grades = await grader.gradePair({
      'with-skill': artifact(evaluatedGood, 'with'),
      'without-skill': artifact(evaluatedBad, 'without'),
    }, scenario, 'pair-1')
    assert.equal(grades['with-skill'].passed, true)
    assert.equal(grades['without-skill'].passed, false)
    assert.equal(grades['with-skill'].details.graders.length, 2)
    assert.ok(grades['with-skill'].details.graders.every((raw) =>
      raw.assertions.every((assertion) => assertion.evidence.includes('EVAL_WITH')),
    ))
    assert.ok(grades['without-skill'].details.graders.every((raw) =>
      raw.assertions.every((assertion) => assertion.evidence.includes('EVAL_WITHOUT')),
    ))
    assert.equal(grades['without-skill'].details.blind.kappa, 1)
  } finally {
    await rm(runDir, { recursive: true, force: true })
  }
})

function fakeCapabilities(calibratedModels) {
  return {
    executablePath: 'fake-copilot',
    executableHash: 'fake',
    version: 'fake',
    helpHash: 'fake',
    supportsPrompt: true,
    supportsJsonOutput: true,
    supportsNoAskUser: true,
    supportsToolApproval: true,
    supportsInstructionDisable: true,
    supportsMcpDisable: true,
    supportsNoRemote: true,
    supportsNoRemoteExport: true,
    supportsNoAutoUpdate: true,
    supportsStreamControl: true,
    calibratedModels,
  }
}

test('supplies fresh calibration workspaces for every configured grader model', async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-grader-probe-'))
  const runtime = await loadSoakRegistry()
  const [scenario] = await new RegistryScenarioProvider(runtime, {
    targetSkill: 'redis-code',
    scenarioIds: ['scn-connection-auth-tls-entra'],
    runId: 'blind-probe-test',
  }).listScenarios()
  const probeCalls = []
  const strictExecutor = {
    async probe(input) {
      probeCalls.push(input)
      assert.equal(input.calibrations.length, 2)
      assert.deepEqual(input.calibrations.map((item) => item.model), ['grader-a', 'grader-b'])
      assert.notEqual(input.calibrations[0].workspace.root, input.calibrations[1].workspace.root)
      assert.ok(input.calibrations.every((item) => item.workspace.arm === 'without-skill'))
      return fakeCapabilities(input.calibrations.map((item) => item.model))
    },
    async execute(request) {
      const graderRequest = JSON.parse(
        await readFile(path.join(request.workspace.projectDir, 'grader-request.json'), 'utf8'),
      )
      const now = new Date().toISOString()
      return {
        soakRunId: 'blind-probe-test',
        executionId: request.executionId,
        scenarioId: request.scenario.id,
        arm: request.arm,
        status: 'completed',
        startedAt: now,
        finishedAt: now,
        responseText: strictResponse(graderRequest),
        events: [{ type: 'assistant.message', content: 'strict JSON' }],
        trace: {
          executablePath: 'fake',
          executableHash: 'fake',
          args: [],
          cwd: request.workspace.projectDir,
          pid: process.pid,
          processIdentity: { pid: process.pid, startedAt: now, name: 'node' },
          descendants: [],
          startedAt: now,
          finishedAt: now,
          exitCode: 0,
          signal: null,
          timedOut: false,
          cancelled: false,
          stdoutFile: '',
          stderrFile: '',
          projectHashBefore: request.workspace.projectHash,
          projectHashAfter: request.workspace.projectHash,
          profileHashBefore: request.workspace.profileHash,
          profileHashAfter: request.workspace.profileHash,
          contamination: [],
        },
      }
    },
  }
  try {
    const grader = await createBlindGrader({
      runtime,
      evidenceStore: new EvidenceStore(runtime),
      config: {
        modelIds: ['grader-a', 'grader-b'],
        minimumKappa: 0.8,
        requireExecutorDiversity: true,
        copilotExecutor: strictExecutor,
      },
      repositoryRoot: repoRoot,
      processManager: {},
      controllerConfig: { runId: 'blind-probe-test', model: 'executor-model' },
      runDir,
      skillSnapshotPath: path.join(repoRoot, 'skills', 'redis-code'),
    })

    const calibration = await grader.assertCalibration([scenario])
    assert.equal(calibration.passed, true)
    assert.equal(probeCalls.length, 1)

    const incompleteGrader = await createBlindGrader({
      runtime,
      evidenceStore: new EvidenceStore(runtime),
      config: {
        modelIds: ['grader-a', 'grader-b'],
        minimumKappa: 0.8,
        requireExecutorDiversity: true,
        copilotExecutor: {
          ...strictExecutor,
          async probe(input) {
            assert.equal(input.calibrations.length, 2)
            return fakeCapabilities(['grader-a'])
          },
        },
      },
      repositoryRoot: repoRoot,
      processManager: {},
      controllerConfig: { runId: 'blind-probe-incomplete', model: 'executor-model' },
      runDir: path.join(runDir, 'incomplete'),
      skillSnapshotPath: path.join(repoRoot, 'skills', 'redis-code'),
    })
    await assert.rejects(
      () => incompleteGrader.assertCalibration([scenario]),
      /did not calibrate configured models: grader-b/,
    )
  } finally {
    await rm(runDir, { recursive: true, force: true })
  }
})

test('throws on calibration disagreement but retains low-kappa pairs as inconclusive', async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-contested-grader-'))
  try {
    const runtime = await loadSoakRegistry()
    const [scenario] = await new RegistryScenarioProvider(runtime, {
      targetSkill: 'redis-code',
      scenarioIds: ['scn-connection-auth-tls-entra'],
      runId: 'blind-contested-test',
    }).listScenarios()
    const common = {
      runtime,
      evidenceStore: new EvidenceStore(runtime),
      repositoryRoot: repoRoot,
      processManager: {},
      controllerConfig: { runId: 'blind-contested-test', model: 'executor-model' },
      skillSnapshotPath: path.join(repoRoot, 'skills', 'redis-code'),
    }
    const strictCalibration = await createBlindGrader({
      ...common,
      config: {
        modelIds: ['grader-a', 'grader-b'],
        minimumKappa: 0.8,
        modelExecutor: async (request, context) =>
          disagreeingResponse(request, context, () => true),
      },
      runDir: path.join(runDir, 'strict-calibration'),
    })
    await assert.rejects(
      () => strictCalibration.assertCalibration([scenario]),
      /calibration (?:accuracy|Cohen's kappa)/,
    )

    let contestEvaluation = false
    const pairGrader = await createBlindGrader({
      ...common,
      config: {
        modelIds: ['grader-a', 'grader-b'],
        minimumKappa: 0.8,
        modelExecutor: async (request, context) =>
          disagreeingResponse(
            request,
            context,
            (arm) => contestEvaluation && arm.output.includes('EVAL_CONTESTED'),
          ),
      },
      runDir: path.join(runDir, 'pair-grading'),
    })
    await pairGrader.assertCalibration([scenario])
    contestEvaluation = true
    const grades = await pairGrader.gradePair({
      'with-skill': artifact('safe EVAL_CONTESTED', 'with'),
      'without-skill': artifact('redis://unsafe EVAL_CONTESTED', 'without'),
    }, scenario, 'pair-contested')

    for (const arm of ['with-skill', 'without-skill']) {
      const grade = grades[arm]
      assert.equal(grade.passed, false)
      assert.equal(grade.inconclusive, true)
      assert.equal(grade.details.grading.inconclusive, true)
      assert.equal(grade.details.grading.accepted, false)
      assert.ok(grade.details.adjudication)
      assert.equal(grade.details.graders.length, 2)
      assert.equal(grade.details.rawGraders.length, 2)
      assert.ok(grade.details.blind.pairKappa < 0.8)
      assert.ok(grade.details.blind.contestedClaims.length > 0)
    }
  } finally {
    await rm(runDir, { recursive: true, force: true })
  }
})

test('bounds concurrent pair grading and rejects invalid semaphore limits', async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-grader-semaphore-'))
  try {
    const runtime = await loadSoakRegistry()
    const [scenario] = await new RegistryScenarioProvider(runtime, {
      targetSkill: 'redis-code',
      scenarioIds: ['scn-connection-auth-tls-entra'],
      runId: 'blind-semaphore-test',
    }).listScenarios()
    let trackEvaluation = false
    let activeModelCalls = 0
    let maximumModelCalls = 0
    let startedModelCalls = 0
    let releaseFirstWave
    const firstWave = new Promise((resolve) => {
      releaseFirstWave = resolve
    })
    const grader = await createBlindGrader({
      runtime,
      evidenceStore: new EvidenceStore(runtime),
      config: {
        modelIds: ['grader-a', 'grader-b'],
        minimumKappa: 0.8,
        maxConcurrentPairs: 2,
        modelExecutor: async (request) => {
          if (trackEvaluation) {
            activeModelCalls += 1
            startedModelCalls += 1
            maximumModelCalls = Math.max(maximumModelCalls, activeModelCalls)
            if (startedModelCalls === 4) queueMicrotask(releaseFirstWave)
            await firstWave
            activeModelCalls -= 1
          }
          return strictResponse(request)
        },
      },
      repositoryRoot: repoRoot,
      processManager: {},
      controllerConfig: { runId: 'blind-semaphore-test', model: 'executor-model' },
      runDir,
      skillSnapshotPath: path.join(repoRoot, 'skills', 'redis-code'),
    })
    assert.equal(grader.snapshot.maxConcurrentPairs, 2)
    await grader.assertCalibration([scenario])
    trackEvaluation = true
    await Promise.all(Array.from({ length: 6 }, (_, index) =>
      grader.gradePair({
        'with-skill': artifact(`safe EVAL_${index}`, 'with'),
        'without-skill': artifact(`redis://unsafe EVAL_${index}`, 'without'),
      }, scenario, `pair-${index}`),
    ))
    assert.equal(maximumModelCalls, 4)
    assert.equal(activeModelCalls, 0)

    const common = {
      runtime,
      evidenceStore: new EvidenceStore(runtime),
      repositoryRoot: repoRoot,
      processManager: {},
      controllerConfig: { runId: 'blind-invalid-semaphore', model: 'executor-model' },
      runDir: path.join(runDir, 'invalid'),
      skillSnapshotPath: path.join(repoRoot, 'skills', 'redis-code'),
    }
    for (const maxConcurrentPairs of [0, 5, 1.5, '2', Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        () => createBlindGrader({
          ...common,
          config: {
            modelIds: ['grader-a', 'grader-b'],
            maxConcurrentPairs,
            modelExecutor: async (request) => strictResponse(request),
          },
        }),
        /maxConcurrentPairs must be an integer from 1 through 4/,
      )
    }
    await assert.rejects(
      () => createBlindGrader({
        ...common,
        controllerConfig: {
          ...common.controllerConfig,
          concurrency: 13,
        },
        config: {
          modelIds: ['grader-a', 'grader-b'],
          maxConcurrentPairs: 4,
          modelExecutor: async (request) => strictResponse(request),
        },
      }),
      /controller concurrency plus integration\.grading\.maxConcurrentPairs must not exceed 16/,
    )
  } finally {
    await rm(runDir, { recursive: true, force: true })
  }
})

test('uses only full-coverage DB0-style anchors for startup and embedded calibration', async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-db0-canaries-'))
  try {
    const scenario = {
      id: 'db0-style-canaries',
      prompt: 'Distinguish clustered DB0 behavior from non-clustered databases.',
      metadata: {
        correctnessRubric: {
          criteria: [
            { id: 'c1', statement: 'Clustered deployments are DB0-only.', required: true, weight: 0.4 },
            { id: 'c2', statement: 'Non-clustered behavior is qualified.', required: true, weight: 0.4 },
            { id: 'c3', statement: 'Key prefixes are recommended.', required: false, weight: 0.2 },
          ],
          scoring: { pass_threshold: 0.8 },
        },
        actionabilityRubric: { criteria: [] },
        graderCanaries: [
          {
            id: 'db0-canonical-good',
            expected_grade: 'pass',
            must_trigger_criteria: ['c1', 'c2', 'c3'],
            answer_excerpt: 'CANONICAL_GOOD covers clustered and non-clustered DB behavior.',
          },
          {
            id: 'db0-canonical-bad',
            expected_grade: 'fail',
            must_trigger_criteria: ['c1', 'c2'],
            answer_excerpt: 'CANONICAL_BAD applies one database rule to every deployment.',
          },
          {
            id: 'db0-supplemental-axis',
            expected_grade: 'fail',
            must_trigger_criteria: ['c1'],
            answer_excerpt: 'SUPPLEMENTAL_AXIS isolates one DB0 regression.',
          },
        ],
        sourceFacts: {},
      },
    }
    let supplementalSeen = false
    const grader = await createBlindGrader({
      runtime: {},
      evidenceStore: { forFact: () => undefined },
      config: {
        modelIds: ['grader-a', 'grader-b'],
        minimumKappa: 0.8,
        modelExecutor: async (request, { modelId }) => JSON.stringify({
          grades: Object.fromEntries(request.arms.map((arm) => {
            if (arm.output.includes('SUPPLEMENTAL_AXIS')) supplementalSeen = true
            const passed = arm.output.includes('SUPPLEMENTAL_AXIS')
              ? modelId === 'grader-a'
              : !arm.output.includes('CANONICAL_BAD')
            return [arm.label, {
              assertions: request.rubric.criteria.map((criterion) => ({
                id: criterion.id,
                statement: criterion.statement,
                passed,
                evidence: arm.output,
              })),
              score: passed ? 1 : 0,
              passed,
            }]
          })),
        }),
      },
      repositoryRoot: repoRoot,
      processManager: {},
      controllerConfig: { runId: 'db0-canary-test', model: 'executor-model' },
      runDir,
      skillSnapshotPath: path.join(repoRoot, 'skills', 'redis-code'),
    })

    await grader.assertCalibration([scenario])
    await grader.gradePair({
      'with-skill': artifact('CANONICAL_GOOD evaluated answer', 'with'),
      'without-skill': artifact('CANONICAL_BAD evaluated answer', 'without'),
    }, scenario, 'db0-pair')
    assert.equal(supplementalSeen, false)

    const missingNegativeAnchor = {
      ...scenario,
      id: 'db0-missing-negative-anchor',
      metadata: {
        ...scenario.metadata,
        graderCanaries: scenario.metadata.graderCanaries.filter(
          (canary) => canary.id !== 'db0-canonical-bad',
        ),
      },
    }
    await assert.rejects(
      () => grader.assertCalibration([missingNegativeAnchor]),
      /requires exactly one canonical expected-fail grader canary covering required correctness criteria: c1, c2/,
    )
  } finally {
    await rm(runDir, { recursive: true, force: true })
  }
})
