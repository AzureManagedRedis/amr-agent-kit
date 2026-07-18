import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const DEFAULT_REGISTRY_PATH = path.join(REPO_ROOT, 'evals', 'soak', 'registry', 'registry.json')
const DEFAULT_CLIENT_CORPUS_ROOT = path.join(REPO_ROOT, 'samples', 'soak-clients')
const SAFE_ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const INFRA_DOMAINS = new Set([
  'routing',
  'sku-sizing',
  'cp-negative',
  'ha-persistence-geo',
  'geo-active',
  'migration',
  'lifecycle',
  'networking-identity-observability',
])

const CLIENT_MUTATION_BY_DOMAIN = new Map([
  ['connection-auth', 'per-request-clients'],
  ['stampede', 'unsafe-lock'],
  ['cluster-policy', 'cross-slot-atomicity'],
  ['db0-select', 'select-assumption'],
  ['streams-pubsub', 'missing-stream-recovery'],
  ['memory-oom', 'missing-deadlines-and-ttls'],
  ['vector-rag', 'tenant-post-filtering'],
  ['crdb', 'non-idempotent-ingestion'],
  ['skill-harm-staleness', 'stale-credentials'],
])

function safeChild(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) {
    throw new Error(`Registry path must be relative: ${relative}`)
  }
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(root, relative)
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Registry path escapes its root: ${relative}`)
  }
  return resolved
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

function mapById(items, label) {
  const result = new Map()
  for (const item of items) {
    if (!item?.id || result.has(item.id)) throw new Error(`${label} contains a missing or duplicate id`)
    result.set(item.id, item)
  }
  return result
}

function deterministicIndex(seed, count) {
  if (count < 1) return -1
  const value = createHash('sha256').update(seed).digest().readUInt32BE(0)
  return value % count
}

function targetSkillForScenario(scenario, configuredTarget) {
  if (scenario.domain === 'skill-harm-staleness') return configuredTarget
  return INFRA_DOMAINS.has(scenario.domain) ? 'azure-redis-infra' : 'redis-code'
}

async function readTree(root, prefix) {
  const files = {}
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (['node_modules', 'bin', 'obj', 'target', '.offline-output', '__pycache__'].includes(entry.name)) continue
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) {
        const relative = path.relative(root, absolute).split(path.sep).join('/')
        files[`${prefix}/${relative}`] = await readFile(absolute, 'utf8')
      }
    }
  }
  await visit(root)
  return files
}

export function applyUnifiedPatch(original, patchText) {
  const source = original.replace(/\r\n/g, '\n').split('\n')
  const lines = patchText.replace(/\r\n/g, '\n').split('\n')
  const output = []
  let sourceIndex = 0
  let inHunk = false
  for (const line of lines) {
    if (line.startsWith('@@')) {
      const match = line.match(/^@@ -(\d+)/)
      if (!match) throw new Error(`Unsupported patch hunk: ${line}`)
      const oldStart = Number(match[1]) - 1
      output.push(...source.slice(sourceIndex, oldStart))
      sourceIndex = oldStart
      inHunk = true
      continue
    }
    if (!inHunk || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('\\ ')) continue
    const marker = line[0]
    const content = line.slice(1)
    if (marker === ' ') {
      if (source[sourceIndex] !== content) throw new Error(`Patch context mismatch at source line ${sourceIndex + 1}`)
      output.push(content)
      sourceIndex += 1
    } else if (marker === '-') {
      if (source[sourceIndex] !== content) throw new Error(`Patch removal mismatch at source line ${sourceIndex + 1}`)
      sourceIndex += 1
    } else if (marker === '+') {
      output.push(content)
    }
  }
  if (!inHunk) throw new Error('Patch has no supported hunk')
  output.push(...source.slice(sourceIndex))
  return output.join('\n')
}

export async function loadSoakRegistry({
  registryPath = DEFAULT_REGISTRY_PATH,
  clientCorpusRoot = DEFAULT_CLIENT_CORPUS_ROOT,
} = {}) {
  const resolvedRegistryPath = path.resolve(registryPath)
  const registryRoot = path.dirname(resolvedRegistryPath)
  const registry = await readJson(resolvedRegistryPath)
  if (registry.public_safe !== true) throw new Error('Soak registry is not marked public-safe')

  const catalogs = {}
  for (const [name, relative] of Object.entries(registry.catalogs ?? {})) {
    catalogs[name] = await readJson(safeChild(registryRoot, relative))
  }
  const maps = Object.fromEntries(
    Object.entries(catalogs).map(([name, items]) => [name, mapById(items, name)]),
  )
  const scenarios = []
  for (const entry of registry.scenarios ?? []) {
    const scenario = await readJson(safeChild(registryRoot, entry.file))
    if (scenario.id !== entry.id || scenario.public_safe !== true) {
      throw new Error(`Scenario registry mismatch for ${entry.id}`)
    }
    scenarios.push(scenario)
  }

  const corpusRoot = path.resolve(clientCorpusRoot)
  const corpusManifest = await readJson(path.join(corpusRoot, 'corpus.manifest.json'))
  const mutationCatalog = await readJson(path.join(corpusRoot, corpusManifest.mutationCatalog))
  const mutationById = mapById(mutationCatalog.mutations, 'client mutations')
  return {
    registryPath: resolvedRegistryPath,
    registryRoot,
    registry,
    catalogs,
    maps,
    scenarios,
    corpusRoot,
    corpusManifest,
    mutationCatalog,
    mutationById,
  }
}

async function buildClientInput(runtime, scenario, runId) {
  const mutationId = CLIENT_MUTATION_BY_DOMAIN.get(scenario.domain)
  if (!mutationId) return undefined
  const clients = runtime.corpusManifest.clients
  const client = clients[deterministicIndex(`${runId}\0${scenario.id}\0client`, clients.length)]
  const mutation = runtime.mutationById.get(mutationId)
  if (!client || !mutation) return undefined

  const actualReferenceRoot = path.join(runtime.corpusRoot, 'mutations', runtime.mutationCatalog.referenceTree)
  const invariantsPath = path.join(actualReferenceRoot, 'invariants.txt')
  const patchPath = path.join(runtime.corpusRoot, 'mutations', mutation.patch)
  const [invariants, patchText, fixtureFiles, clientFiles] = await Promise.all([
    readFile(invariantsPath, 'utf8'),
    readFile(patchPath, 'utf8'),
    readTree(actualReferenceRoot, 'client-policy'),
    readTree(path.join(runtime.corpusRoot, client.path), `client-source/${client.id}`),
  ])
  const badInvariants = applyUnifiedPatch(invariants, patchText)
  fixtureFiles['client-policy/invariants.txt'] = badInvariants
  return {
    client,
    mutation,
    patchPath,
    referenceRoot: actualReferenceRoot,
    scaffold: { ...clientFiles, ...fixtureFiles },
  }
}

function buildEvalMetadata(runtime, scenario, targetSkill) {
  const correctness = runtime.maps.rubrics.get(scenario.correctness_rubric_ref)
  const actionability = runtime.maps.rubrics.get(scenario.actionability_rubric_ref)
  const acceptance = runtime.maps.acceptance_thresholds.get(scenario.acceptance_ref)
  if (!correctness || !actionability || !acceptance) throw new Error(`Scenario ${scenario.id} has unresolved grading references`)
  const assertions = [
    ...correctness.criteria.map((criterion) => ({ ...criterion, id: `correctness:${criterion.id}` })),
    ...actionability.criteria.map((criterion) => ({ ...criterion, id: `actionability:${criterion.id}` })),
  ]
  const badCanaries = (scenario.grader_canaries ?? [])
    .map((id) => runtime.maps.grader_canaries.get(id))
    .filter((item) => item?.expected_grade === 'fail')
  const goodCanary = (scenario.grader_canaries ?? [])
    .map((id) => runtime.maps.grader_canaries.get(id))
    .find((item) => item?.expected_grade === 'pass')
  return {
    eval_id: scenario.id,
    eval_name: scenario.title,
    target_skill: targetSkill,
    prompt: scenario.prompt,
    assertions,
    pass_threshold: correctness.scoring.pass_threshold,
    correctness_pass_threshold: correctness.scoring.pass_threshold,
    actionability_pass_threshold: actionability.scoring.pass_threshold,
    minimum_skill_score: acceptance.correctness.min_score,
    minimum_uplift: acceptance.uplift?.min_uplift_over_baseline ?? 0,
    anti_patterns: badCanaries.map((item) => item.answer_excerpt),
    calibration_good: goodCanary?.answer_excerpt,
  }
}

export class RegistryScenarioProvider {
  constructor(runtime, {
    targetSkill,
    scenarioIds = [],
    runId = process.env.AMR_SOAK_RUN_ID ?? process.env.SOAK_RUN_ID ?? 'offline',
  } = {}) {
    if (!['redis-code', 'azure-redis-infra'].includes(targetSkill)) {
      throw new Error('integration.targetSkill must be redis-code or azure-redis-infra')
    }
    this.runtime = runtime
    this.targetSkill = targetSkill
    this.scenarioIds = new Set(scenarioIds)
    this.runId = runId
  }

  async listScenarios() {
    const selected = []
    for (const scenario of this.runtime.scenarios) {
      const scenarioTarget = targetSkillForScenario(scenario, this.targetSkill)
      if (scenarioTarget !== this.targetSkill) continue
      if (this.scenarioIds.size > 0 && !this.scenarioIds.has(scenario.id)) continue
      const scaffold = {}
      for (const artifact of scenario.input_artifacts) {
        if (!SAFE_ARTIFACT_NAME.test(artifact.name)) throw new Error(`Unsafe scenario artifact name: ${artifact.name}`)
        scaffold[`inputs/${artifact.name}`] = artifact.content
      }
      const clientInput = await buildClientInput(this.runtime, scenario, this.runId)
      Object.assign(scaffold, clientInput?.scaffold ?? {})
      const sourceFacts = Object.fromEntries(
        scenario.source_facts.map((id) => [id, this.runtime.maps.source_facts.get(id)]),
      )
      selected.push({
        id: scenario.id,
        prompt: `${scenario.prompt}\n\nReview the files in this workspace. Make concrete corrections and explain the reasoning.`,
        scaffold,
        metadata: {
          registryScenario: scenario,
          targetSkill: this.targetSkill,
          evalMetadata: buildEvalMetadata(this.runtime, scenario, this.targetSkill),
          sourceFacts,
          correctnessRubric: this.runtime.maps.rubrics.get(scenario.correctness_rubric_ref),
          actionabilityRubric: this.runtime.maps.rubrics.get(scenario.actionability_rubric_ref),
          acceptance: this.runtime.maps.acceptance_thresholds.get(scenario.acceptance_ref),
          leakageCanaries: scenario.baseline_leakage_canaries.map((id) => this.runtime.maps.baseline_leakage_canaries.get(id)),
          graderCanaries: (scenario.grader_canaries ?? []).map((id) => this.runtime.maps.grader_canaries.get(id)),
          clientInput: clientInput
            ? {
                clientId: clientInput.client.id,
                language: clientInput.client.library,
                mutationId: clientInput.mutation.id,
                patchPath: clientInput.patchPath,
                referenceRoot: clientInput.referenceRoot,
              }
            : undefined,
        },
      })
    }
    if (this.scenarioIds.size > 0) {
      const missing = [...this.scenarioIds].filter((id) => !selected.some((scenario) => scenario.id === id))
      if (missing.length > 0) throw new Error(`Configured scenario ids are missing or target the other skill: ${missing.join(', ')}`)
    }
    return selected
  }
}

export const defaults = Object.freeze({
  repositoryRoot: REPO_ROOT,
  registryPath: DEFAULT_REGISTRY_PATH,
  clientCorpusRoot: DEFAULT_CLIENT_CORPUS_ROOT,
})
