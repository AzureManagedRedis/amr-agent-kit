import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
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
