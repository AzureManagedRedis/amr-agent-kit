import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AgreementError,
  CalibrationError,
  GraderConfigurationError,
  GraderProtocolError,
  GraderTimeoutError,
  assertFiniteKappas,
  createBlindModelGrader,
  extractSingleJsonObject,
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
      with_skill: { answer: 'skill output' },
      without_skill: { answer: 'baseline output' },
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
    grades: Object.fromEntries(request.arms.map((arm) => [
      arm.label,
      { ...grade(typeof pass === 'function' ? pass(arm) : pass), ...(note ? { note } : {}) },
    ])),
  })
}

function grader(options = {}) {
  const calls = []
  const artifacts = new Map()
  const modelExecutor = options.modelExecutor ?? (async (request, context) => {
    calls.push({ request, context })
    return response(request, (arm) => arm.output.includes('canary')
      ? !arm.output.includes('bad canary output')
      : options.actualPassByModel?.[context.modelId] ?? true)
  })
  const instance = createBlindModelGrader({
    modelExecutor,
    graderModelIds: ['grader-a', 'grader-b'],
    executorModelId: options.executorModelId,
    policy: {
      requireExecutorDiversity: options.requireExecutorDiversity ?? false,
      agreementThreshold: options.agreementThreshold ?? 0.8,
      calibrationThreshold: options.calibrationThreshold ?? 1,
      agreementMode: options.agreementMode ?? { calibration: 'throw', evaluation: 'return-contested' },
    },
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
  assert.deepEqual(calls.map((call) => call.context.modelId).sort(), ['grader-a', 'grader-b'])
  for (const call of calls) {
    const serialized = JSON.stringify(call.request)
    assert.ok(!serialized.includes('with_skill'))
    assert.ok(!serialized.includes('without_skill'))
    assert.ok(!serialized.includes('known-good'))
    assert.ok(!serialized.includes('known-bad'))
    assert.deepEqual(Object.keys(call.request).sort(), ['arms', 'output_artifacts', 'prompt', 'response_format', 'rubric', 'source_evidence'])
    assert.ok(call.request.arms.every((arm) => /^pair-\d+-arm-[ab]$/.test(arm.label)))
    assert.ok(call.context.phase === undefined)
  }
  assert.equal(calls[0].request.arms.length, 8)
  assert.ok(calls[0].request.arms.some((arm) => arm.output.includes('canary')))
  assert.ok(calls[0].request.arms.some((arm) => !arm.output.includes('canary')))
  assert.equal(result.accepted, true)
  assert.equal(instance.deterministic, false)
  assert.equal(instance.preflightOnly, false)
  assert.equal(result.adjudicated.length, 4)
  assert.equal(result.kappa, 1)
  assert.equal(artifacts.size, 2)
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
      return 'Here is the grade: {"score": 1}'
    },
  }), GraderProtocolError)
})

  test('extracts one embedded JSON object from prose and preserves strict grading', async () => {
    const setup = grader({
      modelExecutor: async (request) => `I reviewed both answers.\n${response(request, (arm) => !arm.output.includes('bad canary output'))}\nNo further notes.`,
    })
    const result = await setup.instance.grade({
      prompt: 'evaluation',
      pairs: pairs(),
      rubric,
      canaries: canaries(),
    })
    assert.equal(result.accepted, true)
  })

  test('extracts fenced JSON with braces inside evidence strings', () => {
    const parsed = extractSingleJsonObject('```json\n{"grades":{"arm-a":{"assertions":[],"evidence":"brace {inside}","score":1}}}\n```')
    assert.equal(parsed.grades['arm-a'].evidence, 'brace {inside}')
  })

  test('rejects multiple, truncated, and unknown-field JSON responses', async () => {
    await assert.rejects(() => runGrader({
      modelExecutor: async (request) => {
        const object = response(request, (arm) => !arm.output.includes('bad canary output'))
        return `${object}\n${object}`
      },
    }), GraderProtocolError)
    await assert.rejects(() => runGrader({
      modelExecutor: async () => '{"grades":',
    }), GraderProtocolError)
    await assert.rejects(() => runGrader({
      modelExecutor: async (request) => {
        const object = JSON.parse(response(request, (arm) => !arm.output.includes('bad canary output')))
        object.extra = 'not permitted'
        return JSON.stringify(object)
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
})

test('calibration inspects both arms and fails if either arm is wrong', async () => {
  const setup = grader({
    modelExecutor: async (request) => response(request, (arm) => arm.label.endsWith('arm-a')),
  })
  await assert.rejects(() => setup.instance.grade({
    prompt: 'evaluation',
    pairs: pairs(),
    rubric,
    canaries: canaries(),
  }), CalibrationError)
})

test('fails closed below the configured kappa threshold', async () => {
  const { result } = await runGrader({
    actualPassByModel: { 'grader-a': true, 'grader-b': false },
  })
  assert.equal(result.accepted, false)
  assert.equal(result.inconclusive, true)
  assert.match(result.agreement_failure_reason, /below/)
  assert.equal(result.grader_results.length, 2)
})

test('does not average an individual low-kappa pair away', async () => {
  const { result } = await runGrader({
    agreementThreshold: 0.1,
    modelExecutor: async (request, context) => {
      return response(request, (arm) => arm.output.includes('canary')
        ? !arm.output.includes('bad canary output')
        : context.modelId === 'grader-a')
    },
  })
  assert.equal(result.accepted, false)
  assert.equal(result.inconclusive, true)
  assert.ok(result.kappa_by_arm.some((value) => value < 0.1))
})

test('evaluation agreement can explicitly use throw mode', async () => {
  await assert.rejects(() => runGrader({
    actualPassByModel: { 'grader-a': true, 'grader-b': false },
    agreementMode: { calibration: 'throw', evaluation: 'throw' },
  }), AgreementError)
})

test('calibration kappa always fails closed before evaluation acceptance', async () => {
  await assert.rejects(() => runGrader({
    calibrationThreshold: 0,
    modelExecutor: async (request, context) => response(request, (arm) => arm.output.includes('canary')
      ? context.modelId === 'grader-a'
      : true),
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

test('aligns reordered assertion IDs before kappa and adjudication', async () => {
  const setup = grader({
    modelExecutor: async (request, context) => {
      const reverse = context.modelId === 'grader-b'
      const assertions = reverse
        ? [{ id: 'c2', statement: 'second', passed: false }, { id: 'c1', statement: 'first', passed: true }]
        : [{ id: 'c1', statement: 'first', passed: true }, { id: 'c2', statement: 'second', passed: false }]
      const grades = Object.fromEntries(request.arms.map((arm) => [
        arm.label,
        arm.output.includes('canary')
          ? grade(!arm.output.includes('bad canary output'))
          : { assertions, score: 0.5, passed: false },
      ]))
      return JSON.stringify({
        grades,
      })
    },
  })
  const result = await setup.instance.grade({
    prompt: 'evaluation',
    pairs: pairs(),
    rubric,
    canaries: canaries(),
    agreementThreshold: 0,
  })
  assert.equal(result.kappa, 1)
  assert.ok(result.adjudicated.every((item) => item.disagreements.length === 0))
})

test('fails closed when reordered IDs contain opposite pass values', async () => {
  const { result } = await runGrader({
    modelExecutor: async (request, context) => {
      const assertions = context.modelId === 'grader-b'
        ? [{ id: 'c2', statement: 'second', passed: true }, { id: 'c1', statement: 'first', passed: false }]
        : [{ id: 'c1', statement: 'first', passed: true }, { id: 'c2', statement: 'second', passed: false }]
      const grades = Object.fromEntries(request.arms.map((arm) => [
        arm.label,
        arm.output.includes('canary')
          ? grade(!arm.output.includes('bad canary output'))
          : { assertions, score: 0.5, passed: false },
      ]))
      return JSON.stringify({
        grades,
      })
    },
  })
  assert.equal(result.accepted, false)
  assert.equal(result.inconclusive, true)
  assert.equal(result.kappa, -1)
})

test('rejects custom identity fields and unknown rubric fields', async () => {
  const setup = grader()
  await assert.rejects(() => setup.instance.grade({
    prompt: 'evaluation',
    pairs: [{
      with_skill: { answer: 'output', arm_label: 'treatment', skill_id: 'secret' },
      without_skill: { answer: 'output' },
    }],
    rubric,
    canaries: canaries(),
  }), GraderProtocolError)
  await assert.rejects(() => setup.instance.grade({
    prompt: 'evaluation',
    pairs: pairs(),
    rubric: { ...rubric, unknown: 'field' },
    canaries: canaries(),
  }), GraderProtocolError)
})

test('allows ordinary control and treatment domain language', async () => {
  const setup = grader()
  const result = await setup.instance.grade({
    prompt: 'Review control plane concurrency control and treatment of failures.',
    pairs: pairs(),
    rubric: {
      ...rubric,
      description: 'Evaluate traffic control and treatment of failures.',
    },
    sourceEvidence: {
      source_fact: 'Control plane behavior and treatment of failures are documented.',
    },
    canaries: canaries(),
  })
  assert.equal(result.accepted, true)
})

test('rejects non-finite kappa values fail closed', () => {
  assert.throws(() => assertFiniteKappas([1, Number.NaN]), AgreementError)
  assert.throws(() => assertFiniteKappas([1, null]), AgreementError)
})

test('persists redacted transcripts with timing, hashes, model, and parsed results', async () => {
  const setup = grader({
    modelExecutor: async (request, context) => {
      setup?.calls?.push({ request, context })
      return response(request, (arm) => arm.output.includes('canary')
        ? !arm.output.includes('bad canary output')
        : true, 'access_token=secret-value')
    },
  })
  const result = await setup.instance.grade({
    prompt: 'evaluation',
    pairs: pairs(),
    rubric,
    canaries: canaries(),
  })
  assert.ok(result.accepted)
  const transcript = [...setup.artifacts.values()].find((content) => content.includes('"phase": "blind-batch"'))
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
