import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeInput, validateBenchmark, validateRunManifest } from '../grading/schema.mjs'
import { adjudicateTwoGraders } from '../grading/grade.mjs'
import { confidenceInterval95, pairedStatistics, perModelVariance, summarizeScores } from '../grading/statistics.mjs'
import { buildClientArtifactIndex, candidateFixesFromRuns, redact } from './artifacts.mjs'

const DEFAULT_WRITER = async (filePath, content) => {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, filePath)
}

function eligible(run) {
  const status = String(run.status ?? '').toLowerCase()
  const reasons = [
    ...(Array.isArray(run.exclusion_reasons) ? run.exclusion_reasons : []),
    ...(Array.isArray(run.exclude_reasons) ? run.exclude_reasons : []),
  ]
  if (run.contaminated === true || run.contamination === true || run.contamination_status === 'contaminated') reasons.push('contaminated')
  if (run.excluded === true || run.include === false) reasons.push('explicitly excluded')
  if (run.complete === false || status === 'incomplete') reasons.push('incomplete')
  if (status === 'contaminated') reasons.push('contaminated')
  if (run.grading?.complete === false || run.timing?.complete === false) reasons.push('missing grading or timing')
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)] }
}

function redactJson(value) {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map(redactJson)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactJson(item)]))
  return value
}

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function benchmarkRows(metadataById, runs) {
  const byEval = new Map()
  for (const run of runs) {
    if (!byEval.has(run.eval_id)) byEval.set(run.eval_id, { eval_id: run.eval_id, eval_name: metadataById.get(run.eval_id)?.eval_name ?? run.eval_id, with_skill: [], without_skill: [] })
    const target = ['with_skill', 'with-skill'].includes(run.arm) ? 'with_skill' : 'without_skill'
    byEval.get(run.eval_id)[target].push({
      run_id: run.run_id,
      model: run.model ?? 'unknown',
      score: run.grading.score,
      efficacy_score: run.grading.efficacy_score ?? run.grading.score,
      correctness_score: run.grading.correctness_score,
      safety_score: run.grading.safety_score,
      duration_ms: run.timing.duration_ms,
    })
  }
  return [...byEval.values()].sort((a, b) => a.eval_id.localeCompare(b.eval_id)).map((row) => {
    const pairs = []
    const withoutById = new Map(row.without_skill.map((item) => [item.run_id, item]))
    for (const withSkill of row.with_skill) {
      const without = withoutById.get(withSkill.run_id)
      if (without) pairs.push({ pair_id: withSkill.run_id, withSkill: withSkill.score, withoutSkill: without.score })
    }
    return {
      ...row,
      with_skill_summary: summarizeScores(row.with_skill),
      without_skill_summary: summarizeScores(row.without_skill),
      paired_statistics: pairedStatistics(pairs),
    }
  })
}

function reportMarkdown({ manifest, rows, artifactIndex, fixes, graderAgreement }) {
  const lines = [
    '# AMR Agent Soak Report',
    '',
    `- SoakRunId: \`${htmlEscape(manifest.SoakRunId ?? 'unknown')}\``,
    `- Selector: \`${htmlEscape(manifest.selector ?? 'unknown')}\``,
    `- Lease class: \`${htmlEscape(manifest.lease_class ?? 'unknown')}\``,
    `- Resource ID: \`${htmlEscape(manifest.resource_id ?? 'unknown')}\``,
    `- Namespace: \`${htmlEscape(manifest.namespace ?? 'unknown')}\``,
    `- Cleanup terminal state: \`${htmlEscape(manifest.cleanup_terminal_state ?? 'unknown')}\``,
    `- Cleanup success: **${manifest.cleanup_success ? 'yes' : 'no'}**`,
    `- Orphan count: \`${manifest.orphan_count ?? 'unknown'}\``,
    '',
    '## Decision rules',
    '',
    'The score boundary is **0.85** and the paired uplift boundary is **0.20**. A confidence interval crossing a boundary is reported as **inconclusive**, not as a pass.',
    '',
    '| Eval | With skill | Without skill | Paired uplift | Verdict |',
    '| --- | ---: | ---: | ---: | --- |',
  ]
  for (const row of rows) {
    const stats = row.paired_statistics
    lines.push(`| ${htmlEscape(row.eval_name)} | ${stats.withSkill.mean?.toFixed(3) ?? 'n/a'} | ${stats.withoutSkill.mean?.toFixed(3) ?? 'n/a'} | ${stats.uplift?.toFixed(3) ?? 'n/a'} | ${stats.verdict} |`)
  }
  lines.push('', `## Grader agreement`, '', `- Cohen's kappa: ${graderAgreement === null ? 'n/a' : graderAgreement.toFixed(3)}`, '', `## Retained clients`, '', `- Complete: **${artifactIndex.complete ? 'yes' : 'no'}**`, `- Entries: **${artifactIndex.entries.length}**`, '', '## Candidate fixes', '')
  for (const entry of artifactIndex.entries) {
    const links = [
      `[input-bad](${htmlEscape(entry.variants['input-bad'])})`,
      `[reference-good](${htmlEscape(entry.variants['reference-good'])})`,
      `[with-skill](${htmlEscape(entry.variants['with-skill'])})`,
      `[without-skill](${htmlEscape(entry.variants['without-skill'])})`,
      `[patches](${htmlEscape(entry.links.patches)})`,
      `[with-skill transcript](${htmlEscape(entry.links.transcripts[0])})`,
      `[without-skill transcript](${htmlEscape(entry.links.transcripts[1])})`,
      `[with-skill build log](${htmlEscape(entry.links.build_logs[0])})`,
      `[without-skill build log](${htmlEscape(entry.links.build_logs[1])})`,
      `[with-skill live log](${htmlEscape(entry.links.live_logs[0])})`,
      `[without-skill live log](${htmlEscape(entry.links.live_logs[1])})`,
      `[hashes](${htmlEscape(entry.links.hashes)})`,
      `[reproduce](${htmlEscape(entry.links.reproduction)})`,
    ]
    lines.splice(lines.length - 2, 0, `- \`${htmlEscape(entry.client_id)}\`: ${links.join(', ')}`)
  }
  if (fixes.length === 0) lines.push('No candidate fixes were generated.')
  else fixes.forEach((fix) => lines.push(`- ${htmlEscape(fix.fix)} (${htmlEscape(fix.eval_id)}/${htmlEscape(fix.run_id)})`))
  return `${lines.join('\n')}\n`
}

function reviewHtml(benchmark, report, safety, sourceCorrectness) {
  const payload = JSON.stringify(redactJson({ benchmark, report, safety, sourceCorrectness }))
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>AMR Agent Soak Review</title><style>body{font:16px system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;background:#fafafa;color:#17202a}pre{white-space:pre-wrap;background:#fff;padding:1rem;border:1px solid #ddd;border-radius:6px}.card{background:#fff;padding:1rem;margin:1rem 0;border:1px solid #ddd;border-radius:6px}</style></head><body><h1>AMR Agent Soak Review</h1><div class="card"><p>This static review contains only redacted metadata and links; retained source is not embedded.</p></div><pre id="data"></pre><script>const data=${payload};document.getElementById('data').textContent=JSON.stringify(data,null,2)</script></body></html>`
}

export async function generateReport(input, {
  outDir = '.',
  writer = DEFAULT_WRITER,
  atomicWriter,
  artifactRoot = input.artifact_root ?? input.artifactRoot ?? '.',
  clients = input.clients ?? [],
  benchmark = input.benchmark,
} = {}) {
  const normalized = normalizeInput(input)
  const metadataById = normalized.metadataById
  for (const run of normalized.runs) {
    if (!metadataById.has(run.eval_id)) throw new Error(`Missing eval metadata for ${run.eval_id}`)
  }
  if (benchmark) validateBenchmark(benchmark)
  const decisions = normalized.runs.map((run) => ({ run, ...eligible(run) }))
  const retainedRuns = decisions.filter((item) => item.eligible).map((item) => item.run)
  const excludedRuns = decisions.filter((item) => !item.eligible).map((item) => ({ ...item.run, exclusion_reasons: item.reasons }))
  const rows = benchmarkRows(metadataById, retainedRuns)
  const artifactIndex = await buildClientArtifactIndex({ root: artifactRoot, clients })
  const graderPairs = []
  for (const run of retainedRuns) {
    const graders = run.graders ?? [run.grader_a, run.grader_b]
    if (graders[0] && graders[1]) {
      const adjudicated = adjudicateTwoGraders(graders[0], graders[1])
      graderPairs.push({ first: graders[0].assertions.map((item) => Boolean(item.pass ?? item.passed)), second: graders[1].assertions.map((item) => Boolean(item.pass ?? item.passed)), adjudicated })
    }
  }
  const graderAgreement = graderPairs.length === 0 ? null : confidenceInterval95(graderPairs.map((pair) => pair.adjudicated.kappa)).mean
  const safety = {
    schema_version: 1,
    runs: retainedRuns.map((run) => ({ eval_id: run.eval_id, run_id: run.run_id, score: run.grading.safety_score ?? 1, violations: run.grading.safety_violations ?? [] })),
    summary: confidenceInterval95(retainedRuns.map((run) => run.grading.safety_score ?? 1)),
  }
  const sourceCorrectness = {
    schema_version: 1,
    runs: retainedRuns.map((run) => ({
      eval_id: run.eval_id,
      run_id: run.run_id,
      categories: Object.fromEntries((run.grading.assertions ?? []).map((item) => [item.id ?? item.assertion_id, item.category ?? (item.source_fact_ref ? (item.passed ? 'source-anchored' : 'unsupported') : 'not-applicable')])),
    })),
  }
  sourceCorrectness.summary = Object.values(sourceCorrectness.runs.flatMap((run) => Object.values(run.categories))).reduce((counts, category) => {
    counts[category] = (counts[category] ?? 0) + 1
    return counts
  }, {})
  const manifest = validateRunManifest(input.manifest ?? input.run_manifest)
  const cleanupSuccess = ['deleted', 'terminal-deleted', 'deleted-terminal'].includes(manifest.cleanup_terminal_state.toLowerCase()) && manifest.orphan_count === 0
  manifest.cleanup_success = cleanupSuccess
  const benchmarkOutput = {
    schema_version: 1,
    skill_name: input.skill_name ?? input.skillName ?? 'amr-agent-kit',
    results: rows,
    evals: rows,
    excluded_runs: excludedRuns,
    run_manifest: redactJson(manifest),
    model_variance: perModelVariance(retainedRuns.map((run) => ({ model: run.model, score: run.grading.score }))),
  }
  const fixes = candidateFixesFromRuns(retainedRuns)
  const report = reportMarkdown({ manifest, rows, artifactIndex, fixes, graderAgreement })
  const redactedReport = redact(report)
  const files = {
    'report.md': redactedReport,
    'benchmark.json': `${JSON.stringify(redactJson(benchmarkOutput), null, 2)}\n`,
    'benchmark.md': `${redactedReport}\n`,
    'source-correctness.json': `${JSON.stringify(redactJson(sourceCorrectness), null, 2)}\n`,
    'safety.json': `${JSON.stringify(redactJson(safety), null, 2)}\n`,
    'client-artifact-index.json': `${JSON.stringify(redactJson(artifactIndex), null, 2)}\n`,
    'candidate-fixes.json': `${JSON.stringify(redactJson({ schema_version: 1, fixes }), null, 2)}\n`,
    'review.html': reviewHtml(benchmarkOutput, redactedReport, safety, sourceCorrectness),
  }
  const outputWriter = atomicWriter ?? writer
  for (const [name, content] of Object.entries(files)) await outputWriter(path.join(outDir, name), content)
  return { files, benchmark: benchmarkOutput, rows, excludedRuns, artifactIndex, safety, sourceCorrectness, fixes }
}
