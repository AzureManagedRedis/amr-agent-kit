import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { FileExecutionArtifactCache, IntegrationReporter } from './adapters.mjs'
import { createEvidenceRuntime } from './evidence.mjs'
import { RegistryGrader } from './grading-adapter.mjs'
import { loadSoakRegistry, RegistryScenarioProvider, defaults } from './registry.mjs'

async function hashTree(root) {
  const hash = createHash('sha256')
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (['node_modules', 'dist', 'bin', 'obj', 'target', '.git', '.offline-output', '__pycache__'].includes(entry.name)) continue
      const absolute = path.join(current, entry.name)
      const relative = path.relative(root, absolute).split(path.sep).join('/')
      hash.update(`${entry.isDirectory() ? 'd' : 'f'}:${relative}\0`)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) hash.update(await readFile(absolute))
    }
  }
  await visit(root)
  return hash.digest('hex')
}

function safeSnapshot(config, runtime, evidence) {
  return {
    targetSkill: config.targetSkill,
    scenarioIds: [...(config.scenarioIds ?? [])].sort(),
    executionCache: config.executionCache?.enabled === true,
    liveCache: config.liveCache?.enabled === true,
    gradingMode: config.grading?.mode,
    minimumGraderKappa: config.grading?.minimumKappa,
    report: {
      leaseClass: config.report?.leaseClass,
      namespace: config.report?.namespace,
    },
    resourceJanitorIntervalMs: config.liveCache?.janitorIntervalMs,
    registryVersion: runtime.registry.registry_version,
    evidence: evidence.snapshot,
  }
}

function resolvePath(repositoryRoot, value, fallback) {
  const selected = value ?? fallback
  return path.isAbsolute(selected) ? selected : path.resolve(repositoryRoot, selected)
}

export async function createSoakModules({ config, processManager }) {
  const integration = config.integration ?? {}
  const repositoryRoot = path.resolve(config.repositoryRoot ?? defaults.repositoryRoot)
  const targetSkill = integration.targetSkill
  const gradingConfig = integration.grading ?? { mode: 'deterministic-preflight' }
  if (!['redis-code', 'azure-redis-infra'].includes(targetSkill)) {
    throw new Error('Controller config integration.targetSkill must be redis-code or azure-redis-infra')
  }
  if (path.basename(path.resolve(config.skillSnapshotPath)) !== targetSkill) {
    throw new Error(`skillSnapshotPath must point to the configured target skill "${targetSkill}"`)
  }
  if (!['deterministic-preflight', 'external-blind'].includes(gradingConfig.mode)) {
    throw new Error('integration.grading.mode must be deterministic-preflight or external-blind')
  }
  if (
    gradingConfig.mode === 'deterministic-preflight' &&
    (Number(config.durationHours ?? 48) > 1 || Number(config.repetitions ?? 1) > 2 || integration.liveCache?.enabled === true)
  ) {
    throw new Error('Deterministic grading is preflight-only (duration <= 1 hour, repetitions <= 2, live cache disabled)')
  }
  const liveInputs = []
  if (integration.liveCache?.enabled === true) {
    if (!integration.liveCache.runtimeConfigPath || !integration.liveCache.adapterModule) {
      throw new Error('Live cache mode requires a gitignored runtimeConfigPath and an ARM-shaped adapterModule')
    }
    for (const [kind, configuredPath] of [
      ['adapter', integration.liveCache.adapterModule],
      ['runtime-config', integration.liveCache.runtimeConfigPath],
    ]) {
      const filePath = resolvePath(repositoryRoot, configuredPath)
      liveInputs.push({
        kind,
        file: path.basename(filePath),
        sha256: createHash('sha256').update(await readFile(filePath)).digest('hex'),
      })
    }
  }

  const registryPath = resolvePath(repositoryRoot, integration.registryPath, defaults.registryPath)
  const clientCorpusRoot = resolvePath(repositoryRoot, integration.clientCorpusRoot, defaults.clientCorpusRoot)
  const runtime = await loadSoakRegistry({ registryPath, clientCorpusRoot })
  const scenarioProvider = new RegistryScenarioProvider(runtime, {
    targetSkill,
    scenarioIds: integration.scenarioIds ?? [],
    runId: config.runId,
  })
  const scenarios = await scenarioProvider.listScenarios()
  if (scenarios.length === 0) throw new Error(`No scenarios selected for ${targetSkill}`)
  const evidence = await createEvidenceRuntime(runtime, integration.evidence ?? {}, repositoryRoot)
  let grader
  let graderInput
  if (gradingConfig.mode === 'external-blind') {
    if (!gradingConfig.modulePath) throw new Error('External blind grading requires integration.grading.modulePath')
    const graderPath = resolvePath(repositoryRoot, gradingConfig.modulePath)
    const graderModule = await import(pathToFileURL(graderPath).href)
    if (typeof graderModule.createBlindGrader !== 'function') {
      throw new Error(`${graderPath} does not export createBlindGrader`)
    }
    grader = await graderModule.createBlindGrader({
      runtime,
      evidenceStore: evidence.store,
      config: gradingConfig,
      repositoryRoot,
    })
    if (typeof grader?.grade !== 'function') throw new Error('External blind grader does not implement grade()')
    if (typeof grader.assertCalibration !== 'function') {
      throw new Error('External blind grader must implement assertCalibration()')
    }
    const calibration = await grader.assertCalibration(scenarios)
    const rawModelIds = calibration?.modelIds ?? calibration?.models
    if (
      !Array.isArray(rawModelIds) ||
      !rawModelIds.every((id) => typeof id === 'string' && id.trim().length > 0)
    ) {
      throw new Error('External blind grader calibration must report modelIds as a non-empty string array')
    }
    const modelIds = [...new Set(rawModelIds.map((id) => id.trim().toLowerCase()))]
    const minimumKappa = Number(gradingConfig.minimumKappa ?? 0.6)
    if (!Number.isFinite(minimumKappa) || minimumKappa < 0 || minimumKappa > 1) {
      throw new Error('integration.grading.minimumKappa must be a finite number from 0 through 1')
    }
    if (calibration?.passed !== true) throw new Error('External blind grader calibration did not pass')
    if (modelIds.length < 2) throw new Error('External blind grader calibration requires two distinct model ids')
    if (
      !Number.isFinite(calibration?.kappa) ||
      calibration.kappa < -1 ||
      calibration.kappa > 1 ||
      calibration.kappa < minimumKappa
    ) {
      throw new Error(`External blind grader kappa must be >= ${minimumKappa}`)
    }
    graderInput = {
      module: path.basename(graderPath),
      sha256: createHash('sha256').update(await readFile(graderPath)).digest('hex'),
      modelIds: modelIds.sort(),
      kappa: calibration.kappa,
      minimumKappa,
      calibrationHash: createHash('sha256').update(JSON.stringify(calibration)).digest('hex'),
    }
  } else {
    grader = new RegistryGrader({ evidenceStore: evidence.store })
    await grader.assertCalibration(scenarios)
    graderInput = { module: 'registry-deterministic', sha256: null }
  }
  const runDir = path.join(path.resolve(config.outputRoot ?? path.join(repositoryRoot, 'eval-runs')), config.runId)
  const reporter = new IntegrationReporter({
    runDir,
    runtime,
    integrationConfig: {
      ...integration,
      repositoryRoot,
      targetSkill,
      model: config.model,
    },
    evidenceStore: evidence.store,
  })
  const cache = integration.executionCache?.enabled === true
    ? new FileExecutionArtifactCache(path.join(runDir, 'execution-cache'))
    : undefined
  const snapshot = {
    ...safeSnapshot(integration, runtime, evidence),
    registryHash: await hashTree(path.dirname(registryPath)),
    clientCorpusHash: await hashTree(clientCorpusRoot),
    liveInputs,
    graderInput,
  }
  return {
    scenarios: scenarioProvider,
    cache,
    grader,
    reporter,
    probes: evidence.probes,
    processManager,
    snapshot,
  }
}

export { RegistryScenarioProvider, loadSoakRegistry } from './registry.mjs'
export { RegistryGrader } from './grading-adapter.mjs'
export { FileExecutionArtifactCache, IntegrationReporter } from './adapters.mjs'
