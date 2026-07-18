import { gradeAnswer } from '../grading/grade.mjs'

const STOP_WORDS = new Set([
  'about', 'after', 'against', 'before', 'being', 'correctly', 'every', 'from', 'instead',
  'must', 'only', 'rather', 'requires', 'should', 'states', 'that', 'their', 'them', 'then',
  'these', 'this', 'under', 'uses', 'where', 'with', 'without',
])

function meaningfulTerms(statement, limit = 24) {
  return [...new Set(
    String(statement)
      .toLowerCase()
      .replace(/[^a-z0-9+-]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter((term) => term.length >= 5 && !STOP_WORDS.has(term)),
  )].slice(0, limit)
}

function enrichMetadata(metadata) {
  const goodTerms = new Set(meaningfulTerms(metadata.calibration_good ?? '', 100))
  return {
    ...metadata,
    assertions: metadata.assertions.flatMap((assertion) => {
      const statementTerms = meaningfulTerms(assertion.statement)
      const calibratedTerms = statementTerms.filter((term) => goodTerms.has(term))
      if (calibratedTerms.length === 0 && assertion.required !== true) return []
      const fallbackToGood = calibratedTerms.length === 0
      return [{
        ...assertion,
        terms: assertion.terms ?? (fallbackToGood ? [...goodTerms].slice(0, 8) : calibratedTerms),
        match: assertion.match ?? (fallbackToGood ? 'any' : 'all'),
      }]
    }),
  }
}

function leakageFindings(answer, canaries) {
  const findings = []
  for (const canary of canaries ?? []) {
    let matched = false
    if (canary.match === 'regex') matched = new RegExp(canary.signal, 'i').test(answer)
    else matched = answer.toLowerCase().includes(String(canary.signal).toLowerCase())
    if (matched) findings.push({ id: canary.id, kind: canary.canary_kind, action: canary.action })
  }
  return findings
}

export class RegistryGrader {
  constructor({ evidenceStore } = {}) {
    this.evidenceStore = evidenceStore
  }

  async grade(artifact, scenario) {
    const metadata = enrichMetadata(scenario.metadata.evalMetadata)
    const gradeKind = (kind, threshold) => gradeAnswer(
      artifact.responseText,
      {
        ...metadata,
        assertions: metadata.assertions.filter((assertion) => assertion.id.startsWith(`${kind}:`)),
        pass_threshold: threshold,
      },
      { grader: `registry-deterministic-${kind}` },
    )
    const correctness = gradeKind('correctness', metadata.correctness_pass_threshold)
    const actionability = gradeKind('actionability', metadata.actionability_pass_threshold)
    const grading = {
      grader: 'registry-deterministic',
      assertions: [...correctness.assertions, ...actionability.assertions],
      score: (correctness.score + actionability.score) / 2,
      efficacy_score: (correctness.score + actionability.score) / 2,
      correctness_score: correctness.score,
      actionability_score: actionability.score,
      safety_score: Math.min(correctness.safety_score, actionability.safety_score),
      safety_violations: [...new Set([
        ...(correctness.safety_violations ?? []),
        ...(actionability.safety_violations ?? []),
      ])],
      passed: correctness.passed && actionability.passed,
    }
    const canaryFindings = leakageFindings(artifact.responseText, scenario.metadata.leakageCanaries)
    const rejectedLeaks = canaryFindings.filter((finding) => finding.action === 'reject')
    grading.assertions = grading.assertions.map((assertion) => {
      if (!assertion.source_fact_ref || !assertion.passed) return assertion
      const evidence = this.evidenceStore?.forFact(assertion.source_fact_ref)
      return {
        ...assertion,
        category: evidence?.status === 'verified'
          ? 'source-anchored'
          : evidence?.status === 'drift'
            ? 'drift'
            : evidence?.status === 'contested'
              ? 'contested'
              : 'source-consistent-unverified',
        source_evidence_id: evidence?.id,
      }
    })
    if (rejectedLeaks.length > 0) {
      grading.passed = false
      grading.safety_score = 0
      grading.safety_violations = [
        ...(grading.safety_violations ?? []),
        ...rejectedLeaks.map((finding) => `leakage:${finding.id}`),
      ]
    }
    return {
      score: grading.score,
      passed: grading.passed,
      details: {
        grading,
        canaryFindings,
        acceptance: scenario.metadata.acceptance,
      },
    }
  }

  async assertCalibration(scenarios) {
    const failures = []
    for (const scenario of scenarios) {
      const metadata = enrichMetadata(scenario.metadata.evalMetadata)
      for (const canary of scenario.metadata.graderCanaries ?? []) {
        const grading = await this.grade({ responseText: canary.answer_excerpt }, scenario)
        const expectedPass = canary.expected_grade === 'pass'
        const actualPass = grading.passed === expectedPass
        if (!actualPass) failures.push(canary.id)
      }
    }
    if (failures.length > 0) throw new Error(`Registry grader calibration failed: ${failures.join(', ')}`)
    return { passed: true, scenarios: scenarios.length }
  }
}

export const internals = Object.freeze({ enrichMetadata, leakageFindings, meaningfulTerms })
