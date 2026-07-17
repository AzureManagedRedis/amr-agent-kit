const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

export class SoakSchemaError extends Error {
  constructor(message, path = '$') {
    super(`${path}: ${message}`)
    this.name = 'SoakSchemaError'
    this.path = path
  }
}

function object(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SoakSchemaError('expected an object', path)
  }
  return value
}

function array(value, path) {
  if (!Array.isArray(value)) throw new SoakSchemaError('expected an array', path)
  return value
}

function required(value, name, path) {
  if (value === undefined || value === null || value === '') {
    throw new SoakSchemaError(`missing required field "${name}"`, path)
  }
}

function finiteNumber(value, name, path, { min = -Infinity, max = Infinity } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new SoakSchemaError(`"${name}" must be a finite number in [${min}, ${max}]`, path)
  }
}

function string(value, name, path) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SoakSchemaError(`"${name}" must be a non-empty string`, path)
  }
}

export function validateEvalMetadata(value) {
  const metadata = object(value, '$.eval_metadata')
  const evalId = metadata.eval_id ?? metadata.id
  required(evalId, 'eval_id', '$.eval_metadata')
  required(metadata.eval_name ?? metadata.name, 'eval_name', '$.eval_metadata')
  required(metadata.target_skill ?? metadata.skill_name, 'target_skill', '$.eval_metadata')
  required(metadata.prompt, 'prompt', '$.eval_metadata')
  const rawAssertions = metadata.assertions ?? metadata.expectations
  array(rawAssertions, '$.eval_metadata.assertions')
  const assertions = rawAssertions.map((item, index) => typeof item === 'string'
    ? {
        id: `c${index + 1}`,
        statement: item,
        terms: item.split(/\W+/).filter((term) => term.length >= 3),
      }
    : item)
  if (assertions.length === 0) throw new SoakSchemaError('must contain at least one assertion', '$.eval_metadata.assertions')
  assertions.forEach((assertion, index) => validateAssertion(assertion, `$.eval_metadata.assertions[${index}]`))
  if (metadata.minimum_skill_score !== undefined) {
    finiteNumber(metadata.minimum_skill_score, 'minimum_skill_score', '$.eval_metadata', { min: 0, max: 1 })
  }
  if (metadata.minimum_uplift !== undefined) {
    finiteNumber(metadata.minimum_uplift, 'minimum_uplift', '$.eval_metadata', { min: -1, max: 1 })
  }
  if (metadata.anti_patterns !== undefined) {
    array(metadata.anti_patterns, '$.eval_metadata.anti_patterns')
    metadata.anti_patterns.forEach((item, index) => string(item, 'anti_pattern', `$.eval_metadata.anti_patterns[${index}]`))
  }
  return {
    ...metadata,
    eval_id: String(evalId),
    eval_name: String(metadata.eval_name ?? metadata.name),
    target_skill: String(metadata.target_skill ?? metadata.skill_name),
    assertions,
    minimum_skill_score: metadata.minimum_skill_score ?? 0.85,
    minimum_uplift: metadata.minimum_uplift ?? 0.20,
    pass_threshold: metadata.pass_threshold ?? metadata.scoring?.pass_threshold ?? 0.85,
    anti_patterns: metadata.anti_patterns ?? [],
  }
}

export function validateAssertion(value, path = '$.assertion') {
  if (typeof value === 'string') {
    return { id: 'c1', statement: value, terms: value.split(/\W+/).filter((term) => term.length >= 3) }
  }
  const assertion = object(value, path)
  required(assertion.id ?? assertion.assertion_id, 'id', path)
  required(assertion.statement ?? assertion.description ?? assertion.text, 'statement', path)
  if (assertion.weight !== undefined) finiteNumber(assertion.weight, 'weight', path, { min: 0, max: 1 })
  if (assertion.required !== undefined && typeof assertion.required !== 'boolean') {
    throw new SoakSchemaError('"required" must be boolean', path)
  }
  return assertion
}

export function validateGrading(value, path = '$.grading') {
  const grading = object(value, path)
  const rawAssertions = grading.assertions ?? grading.criteria ?? grading.expectations
  array(rawAssertions, `${path}.assertions`)
  if (rawAssertions.length === 0) throw new SoakSchemaError('must contain at least one assertion', `${path}.assertions`)
  const assertions = rawAssertions.map((item, index) => {
    const assertion = object(item, `${path}.assertions[${index}]`)
    required(assertion.id ?? assertion.assertion_id ?? `c${index + 1}`, 'id', `${path}.assertions[${index}]`)
    required(assertion.statement ?? assertion.text ?? assertion.description ?? `assertion ${index + 1}`, 'statement', `${path}.assertions[${index}]`)
    if (typeof assertion.pass !== 'boolean' && typeof assertion.passed !== 'boolean') {
      throw new SoakSchemaError('must contain boolean "pass" or "passed"', `${path}.assertions[${index}]`)
    }
    return {
      ...assertion,
      id: String(assertion.id ?? assertion.assertion_id ?? `c${index + 1}`),
      statement: String(assertion.statement ?? assertion.text ?? assertion.description ?? `assertion ${index + 1}`),
      passed: Boolean(assertion.pass ?? assertion.passed),
    }
  })
  const score = grading.score ?? grading.overall_score ?? grading.total_score ?? grading.efficacy_score
  finiteNumber(score, 'score', path, { min: 0, max: 1 })
  if (grading.correctness_score !== undefined) finiteNumber(grading.correctness_score, 'correctness_score', path, { min: 0, max: 1 })
  if (grading.safety_score !== undefined) finiteNumber(grading.safety_score, 'safety_score', path, { min: 0, max: 1 })
  return { ...grading, assertions, score }
}

export function validateTiming(value, path = '$.timing') {
  const timing = object(value, path)
  const duration = timing.duration_ms ?? timing.durationMs ?? timing.elapsed_ms ?? (timing.duration_seconds === undefined ? undefined : timing.duration_seconds * 1000)
  finiteNumber(duration, 'duration_ms', path, { min: 0 })
  if (timing.started_at !== undefined) string(timing.started_at, 'started_at', path)
  if (timing.finished_at !== undefined) string(timing.finished_at, 'finished_at', path)
  return { ...timing, duration_ms: duration }
}

export function validateRun(value, path = '$.run') {
  const run = object(value, path)
  required(run.eval_id ?? run.evalId, 'eval_id', path)
  required(run.run_id ?? run.runId ?? run.id, 'run_id', path)
  required(run.arm ?? run.configuration ?? run.variant, 'arm', path)
  if (run.grading === undefined) throw new SoakSchemaError('missing required field "grading"', path)
  if (run.timing === undefined) throw new SoakSchemaError('missing required field "timing"', path)
  const grading = validateGrading(run.grading, `${path}.grading`)
  const timing = validateTiming(run.timing, `${path}.timing`)
  const arm = String(run.arm ?? run.configuration ?? run.variant)
  if (!['with_skill', 'without_skill', 'with-skill', 'without-skill', 'arm-a', 'arm-b'].includes(arm)) {
    throw new SoakSchemaError(`unsupported arm "${arm}"`, `${path}.arm`)
  }
  return {
    ...run,
    eval_id: String(run.eval_id ?? run.evalId),
    run_id: String(run.run_id ?? run.runId ?? run.id),
    arm,
    grading,
    timing,
  }
}

export function validateBenchmark(value, path = '$.benchmark') {
  const benchmark = object(value, path)
  const rows = benchmark.results ?? benchmark.evals ?? benchmark.runs
  array(rows, `${path}.results`)
  rows.forEach((row, index) => {
    object(row, `${path}.results[${index}]`)
    required(row.eval_id ?? row.evalId ?? row.id, 'eval_id', `${path}.results[${index}]`)
  })
  return benchmark
}

export function validateRunManifest(value, path = '$.run_manifest') {
  const manifest = object(value, path)
  const fields = [
    ['SoakRunId', manifest.SoakRunId ?? manifest.soak_run_id],
    ['selector', manifest.selector],
    ['lease_class', manifest.lease_class ?? manifest.leaseClass],
    ['resource_id', manifest.resource_id ?? manifest.resourceId],
    ['namespace', manifest.namespace],
    ['cleanup_terminal_state', manifest.cleanup_terminal_state ?? manifest.cleanupTerminalState],
  ]
  for (const [name, field] of fields) required(field, name, path)
  const orphanCount = manifest.orphan_count ?? manifest.orphanCount
  if (!Number.isInteger(orphanCount) || orphanCount < 0) throw new SoakSchemaError('"orphan_count" must be a non-negative integer', path)
  return {
    ...manifest,
    SoakRunId: String(fields[0][1]),
    selector: String(fields[1][1]),
    lease_class: String(fields[2][1]),
    resource_id: String(fields[3][1]),
    namespace: String(fields[4][1]),
    cleanup_terminal_state: String(fields[5][1]),
    orphan_count: orphanCount,
  }
}

export function normalizeInput(input) {
  const root = object(input, '$')
  const metadata = root.eval_metadata ?? root.evalMetadata ?? root.metadata
  const runValues = root.runs ?? root.results
  array(runValues, '$.runs')
  const runs = runValues.map((run, index) => validateRun(run, `$.runs[${index}]`))
  const metadataById = new Map()
  if (Array.isArray(metadata)) {
    metadata.forEach((item, index) => {
      const normalized = validateEvalMetadata(item)
      metadataById.set(normalized.eval_id, normalized)
    })
  } else if (metadata) {
    const normalized = validateEvalMetadata(metadata)
    metadataById.set(normalized.eval_id, normalized)
  }
  for (const run of runs) {
    if (!metadataById.has(run.eval_id) && root.metadataByEvalId?.[run.eval_id]) {
      metadataById.set(run.eval_id, validateEvalMetadata(root.metadataByEvalId[run.eval_id]))
    }
  }
  return {
    ...root,
    metadataById,
    runs,
  }
}

export function assertSafeIdentifier(value, name = 'identifier') {
  string(value, name, '$')
  if (!ID.test(value)) throw new SoakSchemaError(`"${name}" contains unsafe characters`, '$')
  return value
}
