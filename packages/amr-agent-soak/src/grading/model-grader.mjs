import { createHash } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { adjudicateTwoGraders, createBlindArmBundles } from './grade.mjs'
import { validateGrading } from './schema.mjs'
import { cohensKappa } from './statistics.mjs'
import { redact } from '../report/artifacts.mjs'

export const MODEL_GRADER_API_VERSION = '1'
const STRICT_RESPONSE_INSTRUCTION = '\nRespond with exactly one JSON object: start with "{" and end with "}", with no commentary.'

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

export function assertFiniteKappas(values) {
  if (!Array.isArray(values) || values.some((value) => !Number.isFinite(value))) {
    throw new AgreementError('Cohen\'s kappa must be finite for every evaluated arm', { kappaByArm: values })
  }
  return values
}

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

const ARM_FIELDS = new Set(['output', 'answer', 'response', 'text', 'artifacts', 'output_artifacts'])
const ARTIFACT_FIELDS = new Set(['path', 'relative_path', 'name', 'type', 'hash', 'sha256', 'transcript_hash', 'size', 'size_bytes', 'mime_type', 'content', 'url'])
const EVIDENCE_FIELDS = new Set(['id', 'source_fact_ref', 'source_fact', 'fact', 'statement', 'text', 'value', 'citation', 'source', 'category', 'hash', 'sha256', 'evidence'])
const RUBRIC_FIELDS = new Set(['id', 'kind', 'description', 'criteria', 'assertions', 'expectations', 'scoring', 'anti_patterns', 'minimum_skill_score', 'minimum_uplift', 'pass_threshold'])
const CRITERION_FIELDS = new Set(['id', 'statement', 'description', 'text', 'weight', 'required', 'source_fact_ref', 'kind', 'terms', 'patterns'])
const SCORING_FIELDS = new Set(['method', 'pass_threshold'])

function allowObject(value, allowed, pathName, transform = (item) => item) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GraderProtocolError(`${pathName} must be an object`)
  const output = {}
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key)) throw new GraderProtocolError(`${pathName} contains an unknown or identity field: ${key}`)
    output[key] = transform(item, key)
  }
  return output
}

function sanitizeArtifactData(value, pathName = '$.artifacts') {
  if (Array.isArray(value)) return value.map((item, index) => sanitizeArtifactData(item, `${pathName}[${index}]`))
  if (!value || typeof value !== 'object') return redact(value)
  return allowObject(value, ARTIFACT_FIELDS, pathName, (item) => sanitizeArtifactData(item, `${pathName}.value`))
}

function sanitizeEvidence(value, pathName = '$.source_evidence') {
  if (Array.isArray(value)) return value.map((item, index) => sanitizeEvidence(item, `${pathName}[${index}]`))
  return allowObject(value, EVIDENCE_FIELDS, pathName, (item) => Array.isArray(item) ? item.map((entry) => sanitizeEvidence(entry, `${pathName}.value`)) : redact(item))
}

function sanitizeRubric(value) {
  return allowObject(value, RUBRIC_FIELDS, '$.rubric', (item, key) => {
    if (key === 'criteria' || key === 'assertions' || key === 'expectations') {
      if (!Array.isArray(item)) throw new GraderProtocolError(`$.rubric.${key} must be an array`)
      return item.map((criterion, index) => allowObject(criterion, CRITERION_FIELDS, `$.rubric.${key}[${index}]`, (entry) => Array.isArray(entry) ? entry.map(redact) : redact(entry)))
    }
    if (key === 'scoring') return allowObject(item, SCORING_FIELDS, '$.rubric.scoring', (entry) => redact(entry))
    if (key === 'anti_patterns') {
      if (!Array.isArray(item)) throw new GraderProtocolError('$.rubric.anti_patterns must be an array')
      return item.map(redact)
    }
    return redact(item)
  })
}

function outputPayload(member) {
  if (typeof member === 'string') return { output: redact(member) }
  if (!member || typeof member !== 'object') throw new GraderProtocolError('paired output must be an object or string')
  for (const key of Object.keys(member)) {
    if (!ARM_FIELDS.has(key)) throw new GraderProtocolError(`paired output contains an unknown or identity field: ${key}`)
  }
  const output = member.output ?? member.answer ?? member.response ?? member.text
  if (typeof output !== 'string') throw new GraderProtocolError('paired output is missing answer/output text')
  return {
    output: redact(output),
    artifacts: sanitizeArtifactData(member.artifacts ?? member.output_artifacts ?? {}),
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
  for (const forbidden of ['arm_label', 'skill_id', 'skill_path', 'skill_contents', 'skillcontents']) {
    if (serialized.includes(forbidden)) throw new GraderProtocolError(`identity field leaked into grader request: ${forbidden}`)
  }
}

function balancedObjectEnd(text, start) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      continue
    }
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return index
      if (depth < 0) return null
    }
  }
  return null
}

export function extractSingleJsonObject(raw) {
  if (typeof raw !== 'string') throw new GraderProtocolError('grader executor must return text containing one JSON object')
  const candidates = []
  for (let start = 0; start < raw.length; start += 1) {
    if (raw[start] !== '{') continue
    const end = balancedObjectEnd(raw, start)
    if (end === null) continue
    const candidate = raw.slice(start, end + 1)
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        candidates.push(parsed)
        if (candidates.length > 1) throw new GraderProtocolError('grader response contains multiple top-level JSON objects')
        start = end
      }
    } catch (error) {
      if (error instanceof GraderProtocolError) throw error
    }
  }
  if (candidates.length === 0) throw new GraderProtocolError('grader response does not contain one complete JSON object')
  return candidates[0]
}

function parseGrades(raw, labels) {
  const parsed = extractSingleJsonObject(raw)
  const allowedResponseFields = new Set(['grades', 'arm_results'])
  const unknownFields = Object.keys(parsed).filter((key) => !allowedResponseFields.has(key))
  if (unknownFields.length > 0) throw new GraderProtocolError(`grader response contains unknown fields: ${unknownFields.join(', ')}`)
  const responseFields = ['grades', 'arm_results'].filter((key) => key in parsed)
  if (responseFields.length !== 1) throw new GraderProtocolError('grader response must contain exactly one grades field')
  const grades = parsed[responseFields[0]]
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

function expectedForCanary(canary, armLabel) {
  const perArm = canary.expected_pass_by_arm ?? canary.expectedByArm
  if (perArm && typeof perArm === 'object' && typeof perArm[armLabel] === 'boolean') return perArm[armLabel]
  return canaryExpected(canary)
}

function interleaveEntries(canaryEntries, evaluationEntries) {
  const entries = []
  const count = Math.max(canaryEntries.length, evaluationEntries.length)
  for (let index = 0; index < count; index += 1) {
    if (canaryEntries[index]) entries.push(canaryEntries[index])
    if (evaluationEntries[index]) entries.push(evaluationEntries[index])
  }
  return entries
}

function requestLabel(bundleIndex, arm) {
  return `pair-${bundleIndex}-${arm.blind_label}`
}

function assertionIds(grading) {
  return grading.assertions.map((assertion) => assertion.id)
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
        Promise.resolve(execute(request, { modelId, index })),
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
    const safePrompt = requiredString(prompt, 'prompt')
    if (!rubric || typeof rubric !== 'object' || Array.isArray(rubric)) throw new GraderProtocolError('independent rubric is required')
    const safeRubric = sanitizeRubric(rubric)
    const safeEvidence = sanitizeEvidence(sourceEvidence)
    const safeArtifacts = sanitizeArtifactData(outputArtifacts, '$.output_artifacts')
    const evaluationBundles = createBlindArmBundles(pairs, { seed })
    const canaryBundles = createBlindArmBundles(canaries.map(pairedCanary), { seed: Number.isInteger(seed) ? seed + 1 : undefined })
    const entries = interleaveEntries(
      canaryBundles.map((bundle, index) => ({ kind: 'canary', bundle, canary: canaries[index] })),
      evaluationBundles.map((bundle) => ({ kind: 'evaluation', bundle })),
    )
    const request = {
      prompt: redact(`${safePrompt}${STRICT_RESPONSE_INSTRUCTION}`),
      arms: entries.flatMap((entry, bundleIndex) => requestArms(entry.bundle, `pair-${bundleIndex}-`)),
      rubric: safeRubric,
      source_evidence: safeEvidence,
      output_artifacts: safeArtifacts,
      response_format: 'strict-json-grades',
    }
    const graderResults = await Promise.all(models.map((modelId, graderIndex) => invoke({
      modelId,
      request,
      phase: 'blind-batch',
      index: graderIndex,
    })))
    const calibrationResults = []
    for (const entry of entries.filter((item) => item.kind === 'canary')) {
      const bundleIndex = entries.indexOf(entry)
      const arms = entry.bundle.arms.map((arm) => {
        const label = requestLabel(bundleIndex, arm)
        const expected = expectedForCanary(entry.canary, arm.label)
        const outcomes = graderResults.map((grader) => Boolean(grader.parsed[label].passed ?? (grader.parsed[label].score >= 0.5)) === expected)
        return { arm: arm.label, expected, outcomes, correct: outcomes.filter(Boolean).length, total: outcomes.length }
      })
      calibrationResults.push({
        id: entry.canary.id,
        arms,
        correct: arms.reduce((sum, arm) => sum + arm.correct, 0),
        total: arms.reduce((sum, arm) => sum + arm.total, 0),
        transcripts: graderResults.map((grader) => grader.transcript),
      })
    }
    const calibrationCorrect = calibrationResults.reduce((sum, result) => sum + result.correct, 0)
    const calibrationTotal = calibrationResults.reduce((sum, result) => sum + result.total, 0)
    const calibrationAccuracy = calibrationTotal === 0 ? 0 : calibrationCorrect / calibrationTotal
    if (calibrationAccuracy < calibrationThreshold) {
      throw new CalibrationError(`calibration accuracy ${calibrationAccuracy} is below ${calibrationThreshold}`, { calibrationResults, calibrationAccuracy })
    }

    const adjudicated = []
    const contestedClaims = []
    for (const entry of entries.filter((item) => item.kind === 'evaluation')) {
      const bundle = entry.bundle
      const firstGrades = {}
      const secondGrades = {}
      const bundleIndex = entries.indexOf(entry)
      for (const arm of bundle.arms) {
        const label = requestLabel(bundleIndex, arm)
        firstGrades[arm.label] = graderResults[0].parsed[label]
        secondGrades[arm.label] = graderResults[1].parsed[label]
      }
      for (const arm of bundle.arms) {
        const first = firstGrades[arm.label]
        const second = secondGrades[arm.label]
        const firstIds = assertionIds(first)
        const secondIds = assertionIds(second)
        if (new Set(firstIds).size !== firstIds.length || new Set(secondIds).size !== secondIds.length ||
            firstIds.length !== secondIds.length || firstIds.some((id) => !secondIds.includes(id))) {
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
    const allKappas = adjudicated.map((result) => result.kappa)
    assertFiniteKappas(allKappas)
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
      bundles: evaluationBundles,
      blind_batch: entries.map((entry) => ({ kind: entry.kind, bundle_id: entry.bundle.bundle_id })),
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
