import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { FileExecutionArtifactCache, IntegrationReporter } from './adapters.mjs'
import { loadRuntimeConfig } from '../cache/config.mjs'
import { createEvidenceRuntime } from './evidence.mjs'
import { RegistryGrader } from './grading-adapter.mjs'
import { assertLiveRuntimeConfig } from './live-runtime.mjs'
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
    maxConcurrentGradingPairs: config.grading?.mode === 'external-blind'
      ? (config.grading?.maxConcurrentPairs ?? 4)
      : undefined,
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
  if (gradingConfig.mode === 'external-blind' && integration.executionCache?.enabled === true) {
    throw new Error('Execution artifact cache must be disabled for external blind grading')
  }
  const liveInputs = []
  let liveAdapterValidation
  if (integration.liveCache?.enabled === true) {
    if (integration.liveCache.reviewedReady !== true) {
      throw new Error('Live cache mode remains blocked until integration.liveCache.reviewedReady=true after review clearance')
    }
    if (!integration.liveCache.runtimeConfigPath) {
      throw new Error('Live cache mode requires a gitignored runtimeConfigPath')
    }
    const adapterModule = integration.liveCache.adapterModule ??
      'packages/amr-agent-soak/src/cache/http-adapter.mjs'
    for (const [kind, configuredPath] of [
      ['adapter', adapterModule],
      ['runtime-config', integration.liveCache.runtimeConfigPath],
    ]) {
      const filePath = resolvePath(repositoryRoot, configuredPath)
      liveInputs.push({
        kind,
        file: path.basename(filePath),
        sha256: createHash('sha256').update(await readFile(filePath)).digest('hex'),
      })
    }
    const runtimeConfigPath = resolvePath(repositoryRoot, integration.liveCache.runtimeConfigPath)
    const runtimeConfig = loadRuntimeConfig({
      ...process.env,
      AMR_SOAK_RUNTIME_CONFIG_PATH: runtimeConfigPath,
      AMR_SOAK_RUN_ID: config.runId,
    })
    assertLiveRuntimeConfig(runtimeConfig)
    const adapterPath = resolvePath(repositoryRoot, adapterModule)
    const adapterExports = await import(pathToFileURL(adapterPath).href)
    const adapter = typeof adapterExports.createLocalRpAdapter === 'function'
      ? await adapterExports.createLocalRpAdapter({ runtimeConfig, controllerConfig: config })
      : typeof adapterExports.LocalRpHttpAdapter === 'function'
        ? new adapterExports.LocalRpHttpAdapter({ apiVersion: runtimeConfig.apiVersion })
        : null
    if (!adapter) throw new Error('Reviewed ARM adapter module exposes no supported factory/class')
    const methods = ['listClusters', 'getCluster', 'createCluster', 'createDatabase', 'deleteCluster', 'listKeys']
    if (!methods.every((method) => typeof adapter[method] === 'function')) {
      throw new Error('Reviewed ARM adapter module does not implement the required redisEnterprise contract')
    }
    liveAdapterValidation = {
      module: path.basename(adapterPath),
      apiVersion: runtimeConfig.apiVersion,
      createPollTimeoutMs: runtimeConfig.createPollTimeoutMs,
      deletePollTimeoutMs: runtimeConfig.deletePollTimeoutMs,
      methods,
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
    const maxConcurrentPairs = gradingConfig.maxConcurrentPairs ?? 4
    if (!Number.isInteger(maxConcurrentPairs) || maxConcurrentPairs < 1 || maxConcurrentPairs > 4) {
      throw new Error('integration.grading.maxConcurrentPairs must be an integer from 1 through 4')
    }
    const controllerPairWorkers = Number(config.concurrency ?? 12)
    if (!Number.isInteger(controllerPairWorkers) || controllerPairWorkers + maxConcurrentPairs > 16) {
      throw new Error(
        'controller concurrency plus integration.grading.maxConcurrentPairs must not exceed 16',
      )
    }
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
      processManager,
      controllerConfig: config,
      runDir: path.join(path.resolve(config.outputRoot ?? path.join(repositoryRoot, 'eval-runs')), config.runId),
      skillSnapshotPath: path.resolve(config.skillSnapshotPath),
    })
    if (typeof grader?.gradePair !== 'function') {
      throw new Error('External blind grader does not implement gradePair()')
    }
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
      maxConcurrentPairs,
      maximumActiveModelProcesses: controllerPairWorkers + maxConcurrentPairs,
      calibrationHash: createHash('sha256').update(JSON.stringify(calibration)).digest('hex'),
      implementation: grader.snapshot,
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
    liveAdapterValidation,
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
