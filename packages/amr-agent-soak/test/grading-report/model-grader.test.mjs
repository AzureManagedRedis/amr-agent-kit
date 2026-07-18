import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AgreementError,
  CalibrationError,
  GraderConfigurationError,
  GraderProtocolError,
  GraderTimeoutError,
  createBlindModelGrader,
} from '../../src/grading/model-grader.mjs'

const rubric = {
  id: 'rub-model',
  criteria: [{ id: 'c1', statement: 'The answer is correct.', weight: 1, required: true }],
  scoring: { method: 'weighted', pass_threshold: 0.5 },
}

function canaries() {
  return [
    {
      id: 'known-good',
      prompt: 'known-good',
      with_skill: { answer: 'good canary output' },
      without_skill: { answer: 'good canary output' },
      expected_pass: true,
    },
    {
      id: 'known-bad',
      prompt: 'known-bad',
      with_skill: { answer: 'bad canary output' },
      without_skill: { answer: 'bad canary output' },
      expected_pass: false,
    },
  ]
}

function pairs() {
  return [
    {
      bundle_id: 'pair-1',
      with_skill: { answer: 'skill output', arm: 'with_skill', skill_contents: 'private skill text' },
      without_skill: { answer: 'baseline output', arm: 'without_skill', skill_contents: 'private skill text' },
    },
    {
      bundle_id: 'pair-2',
      with_skill: { answer: 'second skill output' },
      without_skill: { answer: 'second baseline output' },
    },
  ]
}

function grade(pass) {
  return {
    assertions: [{ id: 'c1', statement: 'The answer is correct.', passed: pass, evidence: pass ? 'evidence' : undefined }],
    score: pass ? 1 : 0,
    passed: pass,
  }
}

function response(request, pass = true, note) {
  return JSON.stringify({
    grades: Object.fromEntries(request.arms.map((arm) => [arm.label, { ...grade(pass), ...(note ? { note } : {}) }])),
  })
}

function grader(options = {}) {
  const calls = []
  const artifacts = new Map()
  const modelExecutor = options.modelExecutor ?? (async (request, context) => {
    calls.push({ request, context })
    const canaryPass = request.prompt !== 'known-bad'
    const pass = context.phase === 'evaluation'
      ? options.actualPassByModel?.[context.modelId] ?? canaryPass
      : canaryPass
    return response(request, pass)
  })
  const instance = createBlindModelGrader({
    modelExecutor,
    graderModelIds: ['grader-a', 'grader-b'],
    executorModelId: options.executorModelId,
    policy: { requireExecutorDiversity: options.requireExecutorDiversity ?? false, agreementThreshold: options.agreementThreshold ?? 0.8, calibrationThreshold: options.calibrationThreshold ?? 1 },
    moduleHash: 'test-module-hash',
    timeoutMs: options.timeoutMs ?? 100,
    artifactWriter: async (name, content) => {
      artifacts.set(name, content)
      return name
    },
  })
  return { calls, artifacts, instance }
}

async function runGrader(options = {}) {
  const setup = grader(options)
  const result = await setup.instance.grade({
    prompt: 'evaluation',
    pairs: pairs(),
    rubric,
    canaries: canaries(),
    sourceEvidence: { source_fact: 'independent evidence' },
    outputArtifacts: { transcript_hash: 'hash' },
    seed: 77,
  })
  return { ...setup, result }
}

test('executes two distinct blind graders and adjudicates paired outputs', async () => {
  const { calls, artifacts, result, instance } = await runGrader()
  const evaluationCalls = calls.filter((call) => call.context.phase === 'evaluation')
  assert.deepEqual(evaluationCalls.map((call) => call.context.modelId).sort(), ['grader-a', 'grader-b'])
  for (const call of calls) {
    const serialized = JSON.stringify(call.request)
    assert.ok(!serialized.includes('with_skill'))
    assert.ok(!serialized.includes('without_skill'))
    assert.ok(!serialized.includes('private skill text'))
    assert.ok(call.request.arms.every((arm) => /^arm-[ab]$|^pair-\d+-arm-[ab]$/.test(arm.label)))
  }
  assert.equal(result.accepted, true)
  assert.equal(instance.deterministic, false)
  assert.equal(instance.preflightOnly, false)
  assert.equal(result.adjudicated.length, 4)
  assert.equal(result.kappa, 1)
  assert.ok(artifacts.size >= 6)
})

test('rejects missing, duplicate, or non-diverse grader identities', () => {
  assert.throws(() => createBlindModelGrader({ modelExecutor: async () => '', graderModelIds: ['one'] }), GraderConfigurationError)
  assert.throws(() => createBlindModelGrader({ modelExecutor: async () => '', graderModelIds: ['same', 'same'] }), GraderConfigurationError)
  assert.throws(() => createBlindModelGrader({
    modelExecutor: async () => '',
    graderModelIds: ['executor', 'other'],
    executorModelId: 'executor',
    policy: { requireExecutorDiversity: true },
  }), GraderConfigurationError)
})

test('rejects invalid JSON without a prose fallback', async () => {
  await assert.rejects(() => runGrader({
    modelExecutor: async (request, context) => {
      if (context.phase === 'calibration') return response(request, request.prompt !== 'known-bad')
      return 'Here is the grade: {"score": 1}'
    },
  }), GraderProtocolError)
})

test('fails closed when calibration accuracy is below threshold', async () => {
  const setup = grader({
    modelExecutor: async (request) => response(request, true),
  })
  await assert.rejects(() => setup.instance.grade({
    prompt: 'evaluation',
    pairs: pairs(),
    rubric,
    canaries: canaries(),
  }), CalibrationError)
  assert.equal([...setup.calls].filter((call) => call.context.phase === 'evaluation').length, 0)
})

test('fails closed below the configured kappa threshold', async () => {
  await assert.rejects(() => runGrader({
    actualPassByModel: { 'grader-a': true, 'grader-b': false },
  }), AgreementError)
})

test('does not average an individual low-kappa pair away', async () => {
  await assert.rejects(() => runGrader({
    agreementThreshold: 0.1,
    modelExecutor: async (request, context) => {
      if (context.phase === 'calibration') return response(request, request.prompt !== 'known-bad')
      const grades = Object.fromEntries(request.arms.map((arm) => [
        arm.label,
        grade(context.modelId === 'grader-a' || arm.label.includes('pair-1')),
      ]))
      return JSON.stringify({ grades })
    },
  }), AgreementError)
})

test('surfaces disagreements as contested claims when the threshold permits them', async () => {
  const { result } = await runGrader({
    actualPassByModel: { 'grader-a': true, 'grader-b': false },
    agreementThreshold: 0,
  })
  assert.equal(result.accepted, true)
  assert.equal(result.disagreements.length, 4)
  assert.ok(result.disagreements.every((claim) => claim.assertion_id === 'c1'))
  assert.ok(result.adjudicated.every((item) => item.passed === false))
})

test('persists redacted transcripts with timing, hashes, model, and parsed results', async () => {
  const setup = grader({
    modelExecutor: async (request, context) => {
      setup?.calls?.push({ request, context })
      return response(request, request.prompt !== 'known-bad', 'access_token=secret-value')
    },
  })
  const result = await setup.instance.grade({
    prompt: 'evaluation',
    pairs: pairs(),
    rubric,
    canaries: canaries(),
  })
  assert.ok(result.accepted)
  const transcript = [...setup.artifacts.values()].find((content) => content.includes('"phase": "evaluation"'))
  assert.ok(transcript)
  assert.ok(transcript.includes('"prompt_hash"'))
  assert.ok(transcript.includes('"module_hash": "test-module-hash"'))
  assert.ok(transcript.includes('"duration_ms"'))
  assert.ok(!transcript.includes('secret-value'))
})

test('fails closed on executor timeout and executor errors', async () => {
  const timeout = grader({
    timeoutMs: 5,
    modelExecutor: async () => new Promise((resolve) => setTimeout(() => resolve('{}'), 50)),
  })
  await assert.rejects(() => timeout.instance.grade({
    prompt: 'evaluation',
    pairs: pairs(),
    rubric,
    canaries: canaries(),
  }), GraderTimeoutError)

  const error = grader({ modelExecutor: async () => { throw new Error('executor unavailable') } })
  await assert.rejects(() => error.instance.grade({
    prompt: 'evaluation',
    pairs: pairs(),
    rubric,
    canaries: canaries(),
  }), GraderProtocolError)
})
