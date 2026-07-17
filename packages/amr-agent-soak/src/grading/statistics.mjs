export const SCORE_THRESHOLD = 0.85
export const UPLIFT_THRESHOLD = 0.20

function numeric(values) {
  return values.filter((value) => typeof value === 'number' && Number.isFinite(value))
}

export function mean(values) {
  const valuesToUse = numeric(values)
  return valuesToUse.length === 0 ? null : valuesToUse.reduce((sum, value) => sum + value, 0) / valuesToUse.length
}

export function variance(values, sample = true) {
  const valuesToUse = numeric(values)
  if (valuesToUse.length < (sample ? 2 : 1)) return null
  const average = mean(valuesToUse)
  const divisor = sample ? valuesToUse.length - 1 : valuesToUse.length
  return valuesToUse.reduce((sum, value) => sum + ((value - average) ** 2), 0) / divisor
}

export function standardDeviation(values, sample = true) {
  const value = variance(values, sample)
  return value === null ? null : Math.sqrt(value)
}

export function confidenceInterval95(values) {
  const valuesToUse = numeric(values)
  const average = mean(valuesToUse)
  const deviation = standardDeviation(valuesToUse)
  if (average === null) return { mean: null, standardDeviation: null, lower: null, upper: null, n: 0, margin: null }
  if (valuesToUse.length < 2) return { mean: average, standardDeviation: deviation, lower: average, upper: average, n: 1, margin: 0 }
  const margin = 1.96 * (deviation / Math.sqrt(valuesToUse.length))
  return { mean: average, standardDeviation: deviation, lower: average - margin, upper: average + margin, n: valuesToUse.length, margin }
}

export function pairedStatistics(pairs, { scoreThreshold = SCORE_THRESHOLD, upliftThreshold = UPLIFT_THRESHOLD } = {}) {
  const validPairs = pairs
    .filter((pair) => pair && Number.isFinite(pair.withSkill) && Number.isFinite(pair.withoutSkill))
    .map((pair) => ({ ...pair, difference: pair.withSkill - pair.withoutSkill }))
  const differences = validPairs.map((pair) => pair.difference)
  const interval = confidenceInterval95(differences)
  const withSkill = confidenceInterval95(validPairs.map((pair) => pair.withSkill))
  const withoutSkill = confidenceInterval95(validPairs.map((pair) => pair.withoutSkill))
  const uplift = mean(differences)
  const thresholdResult = validPairs.length < 2 || withSkill.mean === null || uplift === null
    ? 'inconclusive'
    : withSkill.mean >= scoreThreshold && uplift >= upliftThreshold
      ? 'pass'
      : 'fail'
  const upliftCiCrossesBoundary = interval.lower !== null &&
    interval.lower <= upliftThreshold && interval.upper >= upliftThreshold
  const scoreCiCrossesBoundary = withSkill.lower !== null &&
    withSkill.lower <= scoreThreshold && withSkill.upper >= scoreThreshold
  const ciCrossesBoundary = upliftCiCrossesBoundary || scoreCiCrossesBoundary
  return {
    n: validPairs.length,
    pairs: validPairs,
    withSkill,
    withoutSkill,
    differences: interval,
    uplift,
    scoreThreshold,
    upliftThreshold,
    scoreCiCrossesBoundary,
    upliftCiCrossesBoundary,
    ciCrossesBoundary,
    verdict: ciCrossesBoundary && thresholdResult === 'pass' ? 'inconclusive' : thresholdResult,
  }
}

export function cohensKappa(first, second) {
  if (!Array.isArray(first) || !Array.isArray(second) || first.length !== second.length || first.length === 0) return null
  const n = first.length
  const labels = [...new Set([...first, ...second])]
  const observed = first.reduce((count, value, index) => count + (value === second[index] ? 1 : 0), 0) / n
  const expected = labels.reduce((sum, label) => {
    const firstRate = first.filter((value) => value === label).length / n
    const secondRate = second.filter((value) => value === label).length / n
    return sum + firstRate * secondRate
  }, 0)
  if (expected === 1) return 1
  return (observed - expected) / (1 - expected)
}

export function perModelVariance(rows) {
  const grouped = new Map()
  for (const row of rows) {
    const model = row.model ?? 'unknown'
    if (!grouped.has(model)) grouped.set(model, [])
    if (Number.isFinite(row.score)) grouped.get(model).push(row.score)
  }
  return Object.fromEntries([...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([model, scores]) => [
    model,
    {
      n: scores.length,
      mean: mean(scores),
      variance: variance(scores),
      standardDeviation: standardDeviation(scores),
      confidenceInterval95: confidenceInterval95(scores),
    },
  ]))
}

export function summarizeScores(rows) {
  const efficacy = confidenceInterval95(rows.map((row) => row.efficacy_score ?? row.score))
  const correctness = confidenceInterval95(rows.map((row) => row.correctness_score))
  const safety = confidenceInterval95(rows.map((row) => row.safety_score))
  return { efficacy, correctness, safety }
}
