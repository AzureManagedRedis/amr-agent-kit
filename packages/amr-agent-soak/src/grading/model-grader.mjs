import { createHash } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { adjudicateTwoGraders, createBlindArmBundles } from './grade.mjs'
import { validateGrading } from './schema.mjs'
import { cohensKappa } from './statistics.mjs'
import { redact } from '../report/artifacts.mjs'

export const MODEL_GRADER_API_VERSION = '1'

class BlindModelGraderError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = new.target.name
    this.details = details
  }
}

export class GraderConfigurationError extends BlindModelGraderError {}
export class GraderProtocolError extends BlindModelGraderError {}
export class CalibrationError extends BlindModelGraderError {}
export class AgreementError extends BlindModelGraderError {}
export class GraderTimeoutError extends BlindModelGraderError {}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new GraderConfigurationError(`${name} is required`)
  return value
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function safeFilePart(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '_')
}

function redactJson(value) {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map(redactJson)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactJson(item)]))
  return value
}

function stripIdentityFields(value) {
  if (Array.isArray(value)) return value.map(stripIdentityFields)
  if (!value || typeof value !== 'object') return typeof value === 'string' ? redact(value) : value
  const output = {}
  for (const [key, item] of Object.entries(value)) {
    if (/^(arm|true[_-]?arm|configuration|variant|skill(?:[_-].*)?|label|model[_-]?id)$/i.test(key)) continue
    output[key] = stripIdentityFields(item)
  }
  return output
}

function outputPayload(member) {
  if (typeof member === 'string') return { output: redact(member) }
  if (!member || typeof member !== 'object') throw new GraderProtocolError('paired output must be an object or string')
  const output = member.output ?? member.answer ?? member.response ?? member.text
  if (typeof output !== 'string') throw new GraderProtocolError('paired output is missing answer/output text')
  return {
    output: redact(output),
    artifacts: stripIdentityFields(member.artifacts ?? member.output_artifacts ?? {}),
  }
}

function requestArms(bundle, prefix = '') {
  return bundle.arms.map((arm) => ({
    label: `${prefix}${arm.blind_label}`,
    ...outputPayload(arm.payload),
  }))
}

function assertNoIdentityLeakage(request) {
  const serialized = stableJson(request).toLowerCase()
  for (const forbidden of ['with_skill', 'without_skill', 'with-skill', 'without-skill']) {
    if (serialized.includes(forbidden)) throw new GraderProtocolError(`true arm identity leaked into grader request: ${forbidden}`)
  }
  if (serialized.includes('skill_contents') || serialized.includes('skillcontents')) {
    throw new GraderProtocolError('skill contents leaked into grader request')
  }
}

function parseGrades(raw, labels) {
  if (typeof raw !== 'string') throw new GraderProtocolError('grader executor must return a JSON string')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new GraderProtocolError('grader returned invalid JSON', { cause: error })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GraderProtocolError('grader response must be a JSON object')
  }
  const grades = parsed.grades ?? parsed.arm_results
  if (!grades || typeof grades !== 'object' || Array.isArray(grades)) {
    throw new GraderProtocolError('grader response must contain a grades object')
  }
  const result = {}
  for (const label of labels) {
    if (!(label in grades)) throw new GraderProtocolError(`grader response is missing ${label}`)
    result[label] = validateGrading(grades[label], `$.grades.${label}`)
  }
  if (Object.keys(grades).some((label) => !labels.includes(label))) {
    throw new GraderProtocolError('grader response contains an unknown arm label')
  }
  return { grades: result, raw: parsed }
}

function canaryExpected(canary) {
  const expected = canary.expected_pass ?? canary.expected?.passed ?? canary.expected?.pass
  if (typeof expected === 'boolean') return expected
  if (typeof canary.expected_score === 'number') return canary.expected_score >= 0.5
  if (typeof canary.expected?.score === 'number') return canary.expected.score >= 0.5
  throw new CalibrationError(`canary ${canary.id ?? 'unknown'} is missing expected pass/fail outcome`)
}

function validateCanaries(canaries) {
  if (!Array.isArray(canaries) || canaries.length < 2) {
    throw new CalibrationError('at least two calibration canaries are required')
  }
  const expected = canaries.map(canaryExpected)
  if (!expected.includes(true) || !expected.includes(false)) {
    throw new CalibrationError('calibration canaries must include known-good and known-bad cases')
  }
}

function validateModels({ graderModelIds, executorModelId, policy }) {
  if (!Array.isArray(graderModelIds) || graderModelIds.length !== 2) {
    throw new GraderConfigurationError('exactly two grader model IDs are required')
  }
  graderModelIds.forEach((id, index) => requiredString(id, `graderModelIds[${index}]`))
  if (graderModelIds[0] === graderModelIds[1]) throw new GraderConfigurationError('grader model IDs must be distinct')
  const requireDiversity = policy.requireExecutorDiversity ?? policy.requireModelDiversity ?? false
  if (requireDiversity) {
    if (!executorModelId) throw new GraderConfigurationError('executorModelId is required when executor diversity is enabled')
    if (graderModelIds.includes(executorModelId)) throw new GraderConfigurationError('grader model must differ from the executor model')
  }
}

function pairedCanary(canary) {
  return canary.pair ?? canary
}

async function defaultArtifactWriter(artifactDir, name, content) {
  if (!artifactDir) throw new GraderConfigurationError('artifactWriter or artifactDir is required')
  await mkdir(artifactDir, { recursive: true })
  const filePath = path.join(artifactDir, name)
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, filePath)
  return filePath
}

function timeoutPromise(timeoutMs) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new GraderTimeoutError(`grader executor timed out after ${timeoutMs}ms`)), timeoutMs)
    timer.unref?.()
  })
}

export function createBlindModelGrader({
  modelExecutor,
  executor,
  graderModelIds,
  graderModels,
  executorModelId,
  policy = {},
  moduleHash = sha256(`amr-agent-soak-model-grader:${MODEL_GRADER_API_VERSION}`),
  timeoutMs = 120000,
  artifactWriter,
  artifactDir,
} = {}) {
  const execute = modelExecutor ?? executor
  if (typeof execute !== 'function') throw new GraderConfigurationError('an async modelExecutor callback is required')
  const models = graderModelIds ?? graderModels
  validateModels({ graderModelIds: models, executorModelId, policy })
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new GraderConfigurationError('timeoutMs must be a positive integer')
  const calibrationThreshold = policy.calibrationThreshold ?? 1
  const agreementThreshold = policy.agreementThreshold ?? 0.8
  if (!Number.isFinite(calibrationThreshold) || calibrationThreshold < 0 || calibrationThreshold > 1) {
    throw new GraderConfigurationError('calibrationThreshold must be between 0 and 1')
  }
  if (!Number.isFinite(agreementThreshold) || agreementThreshold < -1 || agreementThreshold > 1) {
    throw new GraderConfigurationError('agreementThreshold must be between -1 and 1')
  }
  requiredString(moduleHash, 'moduleHash')
  const writeArtifact = artifactWriter
    ? (name, content) => artifactWriter(name, content)
    : (name, content) => defaultArtifactWriter(artifactDir, name, content)

  async function invoke({ modelId, request, phase, index }) {
    assertNoIdentityLeakage(request)
    const promptHash = sha256(stableJson(request))
    const startedAt = new Date().toISOString()
    const started = Date.now()
    let raw
    let parsedResult = null
    let failure = null
    try {
      raw = await Promise.race([
        Promise.resolve(execute(request, { modelId, phase, index })),
        timeoutPromise(timeoutMs),
      ])
      parsedResult = parseGrades(raw, request.arms.map((arm) => arm.label))
    } catch (error) {
      failure = {
        name: error.name,
        message: redact(error.message),
      }
    }
    const timing = {
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
    }
    const transcript = {
      schema_version: 1,
      phase,
      model_id: modelId,
      prompt_hash: promptHash,
      module_hash: moduleHash,
      timing,
      raw_transcript: raw === undefined ? null : redact(raw),
      parsed_result: redactJson(parsedResult?.grades ?? null),
      error: failure,
    }
    const artifactName = `blind-grader-${phase}-${index}-${safeFilePart(modelId)}.json`
    const artifactPath = await writeArtifact(artifactName, `${JSON.stringify(transcript, null, 2)}\n`)
    if (failure) {
      if (failure.name === 'GraderTimeoutError') throw new GraderTimeoutError(failure.message, { transcript: artifactPath })
      throw new GraderProtocolError(failure.message, { transcript: artifactPath })
    }
    return { modelId, parsed: parsedResult.grades, transcript: artifactPath, timing, promptHash }
  }

  async function grade({ prompt, pairs, rubric, sourceEvidence = {}, outputArtifacts = {}, canaries, seed } = {}) {
    validateCanaries(canaries)
    if (!Array.isArray(pairs) || pairs.length === 0) throw new GraderProtocolError('at least one paired output is required')
    if (!rubric || typeof rubric !== 'object' || Array.isArray(rubric)) throw new GraderProtocolError('independent rubric is required')
    const bundles = createBlindArmBundles(pairs, { seed })
    const calibrationResults = []
    for (let canaryIndex = 0; canaryIndex < canaries.length; canaryIndex += 1) {
      const canaryBundle = createBlindArmBundles([pairedCanary(canaries[canaryIndex])], { seed: Number.isInteger(seed) ? seed + canaryIndex : undefined })[0]
      const request = {
        prompt: canaries[canaryIndex].prompt ?? prompt,
        arms: requestArms(canaryBundle),
        rubric: stripIdentityFields(rubric),
        source_evidence: stripIdentityFields(sourceEvidence),
        output_artifacts: stripIdentityFields(outputArtifacts),
        response_format: 'strict-json-grades',
      }
      const graderResults = await Promise.all(models.map((modelId, graderIndex) => invoke({
        modelId,
        request,
        phase: 'calibration',
        index: canaryIndex * models.length + graderIndex,
      })))
      const expected = canaryExpected(canaries[canaryIndex])
      const outcomes = graderResults.map((grader) => {
        const grade = Object.values(grader.parsed)[0]
        return Boolean(grade.passed ?? (grade.score >= 0.5)) === expected
      })
      calibrationResults.push({
        id: canaries[canaryIndex].id,
        expected,
        outcomes,
        correct: outcomes.filter(Boolean).length,
        total: outcomes.length,
        transcripts: graderResults.map((grader) => grader.transcript),
      })
    }
    const calibrationCorrect = calibrationResults.reduce((sum, result) => sum + result.correct, 0)
    const calibrationTotal = calibrationResults.reduce((sum, result) => sum + result.total, 0)
    const calibrationAccuracy = calibrationTotal === 0 ? 0 : calibrationCorrect / calibrationTotal
    if (calibrationAccuracy < calibrationThreshold) {
      throw new CalibrationError(`calibration accuracy ${calibrationAccuracy} is below ${calibrationThreshold}`, { calibrationResults, calibrationAccuracy })
    }

    const request = {
      prompt,
      arms: bundles.flatMap((bundle, bundleIndex) => requestArms(bundle, `pair-${bundleIndex}-`)),
      rubric: stripIdentityFields(rubric),
      source_evidence: stripIdentityFields(sourceEvidence),
      output_artifacts: stripIdentityFields(outputArtifacts),
      response_format: 'strict-json-grades',
    }
    const graderResults = await Promise.all(models.map((modelId, graderIndex) => invoke({
      modelId,
      request,
      phase: 'evaluation',
      index: graderIndex,
    })))
    const adjudicated = []
    const contestedClaims = []
    for (const bundle of bundles) {
      const firstGrades = {}
      const secondGrades = {}
      const bundleIndex = bundles.indexOf(bundle)
      for (const arm of bundle.arms) {
        const requestLabel = `pair-${bundleIndex}-${arm.blind_label}`
        firstGrades[arm.label] = graderResults[0].parsed[requestLabel]
        secondGrades[arm.label] = graderResults[1].parsed[requestLabel]
      }
      for (const arm of bundle.arms) {
        const first = firstGrades[arm.label]
        const second = secondGrades[arm.label]
        const ids = new Set(first.assertions.map((item) => item.id))
        if (ids.size !== second.assertions.length || second.assertions.some((item) => !ids.has(item.id))) {
          throw new AgreementError(`grader assertion sets differ for ${bundle.bundle_id}/${arm.label}`)
        }
        const result = adjudicateTwoGraders(first, second)
        const record = { bundle_id: bundle.bundle_id, arm: arm.label, blind_label: arm.blind_label, ...result }
        adjudicated.push(record)
        for (const assertionId of result.disagreements) {
          const assertion = result.assertions.find((item) => item.id === assertionId)
          contestedClaims.push({
            bundle_id: bundle.bundle_id,
            arm: arm.label,
            assertion_id: assertionId,
            statement: assertion?.statement,
            grader_pass: assertion?.graders,
          })
        }
      }
    }
    const allKappas = adjudicated.map((result) => result.kappa).filter((value) => Number.isFinite(value))
    const meanKappa = allKappas.length === 0 ? null : allKappas.reduce((sum, value) => sum + value, 0) / allKappas.length
    const kappa = allKappas.length === 0 ? null : Math.min(...allKappas)
    if (kappa === null || kappa < agreementThreshold) {
      throw new AgreementError(`Cohen's kappa ${kappa ?? 'n/a'} is below ${agreementThreshold}`, { kappa, meanKappa, kappaByArm: allKappas, agreementThreshold, contestedClaims, adjudicated })
    }
    return {
      api_version: MODEL_GRADER_API_VERSION,
      accepted: true,
      calibration: { accuracy: calibrationAccuracy, threshold: calibrationThreshold, results: calibrationResults },
      grader_models: models,
      bundles,
      grader_results: graderResults,
      adjudicated,
      kappa,
      mean_kappa: meanKappa,
      kappa_by_arm: allKappas,
      agreement_threshold: agreementThreshold,
      disagreements: contestedClaims,
    }
  }

  return Object.freeze({ apiVersion: MODEL_GRADER_API_VERSION, deterministic: false, preflightOnly: false, grade })
}

export { BlindModelGraderError }

export const createExternalBlindGrader = createBlindModelGrader

export async function runBlindModelGrading(config, input) {
  return createBlindModelGrader(config).grade(input)
}
