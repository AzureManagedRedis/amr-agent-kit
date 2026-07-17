import { randomBytes } from 'node:crypto'
import { validateEvalMetadata, validateGrading } from './schema.mjs'
import { cohensKappa } from './statistics.mjs'

function text(value) {
  return String(value ?? '')
}

function termsForAssertion(assertion) {
  const terms = assertion.terms ?? assertion.keywords ?? assertion.must_include ?? assertion.any_of
  if (Array.isArray(terms)) return terms.map(text).filter(Boolean)
  if (typeof terms === 'string') return [terms]
  const pattern = assertion.pattern ?? assertion.regex
  return pattern ? [pattern] : []
}

function matches(answer, assertion) {
  const candidate = text(answer)
  const patterns = assertion.patterns ?? assertion.must_match
  if (Array.isArray(patterns) && patterns.length > 0) {
    return patterns.every((pattern) => new RegExp(pattern, 'i').test(candidate))
  }
  const terms = termsForAssertion(assertion)
  if (terms.length === 0) return false
  if (assertion.match === 'all' || assertion.all_of) return terms.every((term) => candidate.toLowerCase().includes(text(term).toLowerCase()))
  return terms.some((term) => candidate.toLowerCase().includes(text(term).toLowerCase()))
}

function weightedScore(assertions) {
  const total = assertions.reduce((sum, assertion) => sum + (Number.isFinite(assertion.weight) ? assertion.weight : 1), 0)
  if (total === 0) return 0
  return assertions.reduce((sum, assertion) => sum + (assertion.passed ? (assertion.weight ?? 1) : 0), 0) / total
}

export function classifySourceCorrectness(assertionResults) {
  return assertionResults.map((result) => {
    if (!result.source_fact_ref) return { ...result, category: 'not-applicable' }
    if (result.passed && result.evidence) return { ...result, category: 'source-anchored' }
    if (result.passed) return { ...result, category: 'source-consistent' }
    if (result.contradicted) return { ...result, category: 'contradicts-source' }
    return { ...result, category: 'unsupported' }
  })
}

export function gradeAnswer(answer, metadata, { grader = 'deterministic' } = {}) {
  const normalized = validateEvalMetadata(metadata)
  const answerText = text(answer)
  const assertionResults = normalized.assertions.map((assertion) => {
    const passed = matches(answerText, assertion)
    const antiPattern = assertion.anti_pattern === true || assertion.kind === 'safety'
    return {
      id: String(assertion.id ?? assertion.assertion_id),
      statement: String(assertion.statement ?? assertion.description ?? assertion.text),
      required: assertion.required === true,
      weight: assertion.weight ?? 1,
      passed,
      contradicted: antiPattern && !passed,
      evidence: passed ? 'deterministic term/pattern match' : null,
      source_fact_ref: assertion.source_fact_ref,
    }
  })
  const antiPatterns = normalized.anti_patterns.filter((pattern) => answerText.toLowerCase().includes(pattern.toLowerCase()))
  const correctnessResults = classifySourceCorrectness(assertionResults)
  const correctness = correctnessResults.filter((result) => result.source_fact_ref)
  const actionability = correctnessResults.filter((result) => !result.source_fact_ref)
  const correctnessScore = correctness.length === 0 ? null : weightedScore(correctness)
  const actionabilityScore = actionability.length === 0 ? null : weightedScore(actionability)
  const efficacyScore = weightedScore(assertionResults)
  const safetyScore = normalized.anti_patterns.length === 0
    ? 1
    : Math.max(0, 1 - antiPatterns.length / normalized.anti_patterns.length)
  const requiredPassed = assertionResults.filter((result) => result.required).every((result) => result.passed)
  const passed = requiredPassed && efficacyScore >= normalized.pass_threshold && antiPatterns.length === 0
  return {
    grader,
    assertions: correctnessResults,
    score: efficacyScore,
    efficacy_score: efficacyScore,
    correctness_score: correctnessScore ?? efficacyScore,
    actionability_score: actionabilityScore ?? efficacyScore,
    safety_score: safetyScore,
    safety_violations: antiPatterns,
    passed,
  }
}

export function adjudicateTwoGraders(first, second) {
  const left = validateGrading(first, '$.grader_a')
  const right = validateGrading(second, '$.grader_b')
  const byId = new Map(right.assertions.map((item) => [String(item.id ?? item.assertion_id), item]))
  const assertions = left.assertions.map((item) => {
    const id = String(item.id ?? item.assertion_id)
    const other = byId.get(id)
    const leftPass = Boolean(item.pass ?? item.passed)
    const rightPass = Boolean(other?.pass ?? other?.passed)
    return {
      ...item,
      id,
      passed: leftPass && rightPass,
      agreement: leftPass === rightPass,
      graders: [leftPass, rightPass],
    }
  })
  const score = assertions.length === 0 ? 0 : assertions.filter((item) => item.passed).length / assertions.length
  const disagreements = assertions.filter((item) => !item.agreement).map((item) => item.id)
  return {
    ...left,
    assertions,
    score,
    efficacy_score: score,
    correctness_score: Math.min(left.correctness_score ?? score, right.correctness_score ?? score),
    safety_score: Math.min(left.safety_score ?? 1, right.safety_score ?? 1),
    passed: Boolean(left.passed && right.passed && disagreements.length === 0),
    disagreements,
    kappa: cohensKappa(
      left.assertions.map((item) => Boolean(item.pass ?? item.passed)),
      right.assertions.map((item) => Boolean(item.pass ?? item.passed)),
    ),
    adjudicated: true,
  }
}

function rng(seed) {
  let state = Number.isInteger(seed) ? seed >>> 0 : randomBytes(4).readUInt32LE(0)
  return () => {
    state = (1664525 * state + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function pairedMembers(pair, index) {
  const withSkill = pair?.with_skill ?? pair?.withSkill
  const withoutSkill = pair?.without_skill ?? pair?.withoutSkill
  if (!withSkill || !withoutSkill) {
    throw new TypeError(`pair ${index} must contain with_skill and without_skill members`)
  }
  return { withSkill, withoutSkill }
}

export function buildBlindArmBundle(pair, { seed = 1 } = {}) {
  const random = rng(seed)
  const { withSkill, withoutSkill } = pairedMembers(pair, 0)
  const arms = [
    { label: 'with_skill', payload: withSkill },
    { label: 'without_skill', payload: withoutSkill },
  ]
  if (random() >= 0.5) [arms[0], arms[1]] = [arms[1], arms[0]]
  return {
    bundle_id: pair.bundle_id ?? pair.bundleId ?? `${withSkill.eval_id ?? withSkill.evalId}:${withSkill.run_id ?? withSkill.runId ?? withSkill.id}`,
    arms: arms.map((arm, index) => ({ ...arm, blind_label: `arm-${String.fromCharCode(97 + index)}` })),
  }
}

export function createBlindArmBundles(pairs, options = {}) {
  if (!Array.isArray(pairs)) throw new TypeError('pairs must be an array')
  return pairs.map((pair, index) => buildBlindArmBundle({ ...pair, ...pairedMembers(pair, index) }, {
    ...options,
    seed: Number.isInteger(options.seed) ? options.seed + index : undefined,
  }))
}

export function unblindArmBundles(bundles) {
  return bundles.map((bundle) => ({
    ...bundle,
    arms: bundle.arms.map((arm) => ({ ...arm, blind_label: undefined })),
  }))
}

export function runCalibrationCanaries(canaries, grade = gradeAnswer) {
  const results = canaries.map((canary) => {
    const grading = grade(canary.answer, canary.metadata, { grader: 'calibration' })
    const passed = canary.expected_pass === undefined
      ? grading.passed === Boolean(canary.expected_score >= 0.5)
      : grading.passed === canary.expected_pass
    return { id: canary.id, passed, actual: grading.passed, expected: canary.expected_pass, score: grading.score }
  })
  return { passed: results.every((result) => result.passed), results }
}

export function assertCalibrationCanaries(canaries, grade = gradeAnswer) {
  const result = runCalibrationCanaries(canaries, grade)
  if (!result.passed) {
    const failed = result.results.filter((item) => !item.passed).map((item) => item.id).join(', ')
    throw new Error(`Calibration canary failure: ${failed}`)
  }
  return result
}
