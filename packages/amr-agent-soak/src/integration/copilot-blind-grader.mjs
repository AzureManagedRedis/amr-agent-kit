import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createBlindModelGrader,
  createExternalBlindGrader,
  runBlindModelGrading,
} from '../grading/model-grader.mjs'

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const GRADING_DEPENDENCIES = [
  path.join(PACKAGE_ROOT, 'src', 'grading', 'model-grader.mjs'),
  path.join(PACKAGE_ROOT, 'src', 'grading', 'grade.mjs'),
  path.join(PACKAGE_ROOT, 'src', 'grading', 'schema.mjs'),
  path.join(PACKAGE_ROOT, 'src', 'grading', 'statistics.mjs'),
  path.join(PACKAGE_ROOT, 'src', 'report', 'artifacts.mjs'),
  path.join(PACKAGE_ROOT, 'src', 'executor', 'copilot-cli.ts'),
  path.join(PACKAGE_ROOT, 'src', 'core', 'isolation.ts'),
  path.join(PACKAGE_ROOT, 'src', 'core', 'process.ts'),
  path.join(PACKAGE_ROOT, 'src', 'core', 'hash.ts'),
  path.join(PACKAGE_ROOT, 'src', 'core', 'atomic.ts'),
  path.join(PACKAGE_ROOT, 'dist', 'src', 'executor', 'copilot-cli.js'),
  path.join(PACKAGE_ROOT, 'dist', 'src', 'core', 'isolation.js'),
  path.join(PACKAGE_ROOT, 'dist', 'src', 'core', 'process.js'),
  path.join(PACKAGE_ROOT, 'dist', 'src', 'core', 'hash.js'),
  path.join(PACKAGE_ROOT, 'dist', 'src', 'core', 'atomic.js'),
  path.join(PACKAGE_ROOT, 'package-lock.json'),
  path.join(PACKAGE_ROOT, 'tsconfig.json'),
]

async function loadCoreRuntime() {
  const [{ CopilotCliExecutor }, { createIsolatedWorkspace }, { ProcessRegistry }] = await Promise.all([
    import('../../dist/src/executor/copilot-cli.js'),
    import('../../dist/src/core/isolation.js'),
    import('../../dist/src/core/process.js'),
  ])
  return { CopilotCliExecutor, createIsolatedWorkspace, ProcessRegistry }
}

async function combinedModuleProvenance() {
  const current = fileURLToPath(import.meta.url)
  const hash = createHash('sha256')
  const dependencies = []
  for (const dependency of [current, ...GRADING_DEPENDENCIES]) {
    const bytes = await readFile(dependency)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    hash.update(path.relative(PACKAGE_ROOT, dependency).split(path.sep).join('/'))
    hash.update(bytes)
    dependencies.push({
      file: path.relative(PACKAGE_ROOT, dependency).split(path.sep).join('/'),
      sha256,
    })
  }
  return { moduleHash: hash.digest('hex'), dependencies }
}

function safePart(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '_')
}

async function writeAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, filePath)
  return filePath
}

function rubricForScenario(scenario) {
  return {
    id: `blind:${scenario.id}`,
    criteria: [
      ...scenario.metadata.correctnessRubric.criteria.map((item) => ({
        ...item,
        id: `correctness:${item.id}`,
      })),
      ...scenario.metadata.actionabilityRubric.criteria.map((item) => ({
        ...item,
        id: `actionability:${item.id}`,
      })),
    ],
    scoring: {
      method: 'weighted-with-required-gate',
      pass_threshold: scenario.metadata.correctnessRubric.scoring.pass_threshold,
    },
  }
}

function canariesForScenario(scenario) {
  return scenario.metadata.graderCanaries.map((canary) => ({
    id: canary.id,
    prompt: scenario.prompt,
    with_skill: { answer: canary.answer_excerpt },
    without_skill: { answer: canary.answer_excerpt },
    expected_pass: canary.expected_grade === 'pass',
  }))
}

function sourceEvidenceForScenario(scenario, evidenceStore) {
  return Object.keys(scenario.metadata.sourceFacts).map((factId) => {
    const evidence = evidenceStore.forFact(factId)
    return {
      id: evidence?.id ?? factId,
      source_fact_ref: factId,
      statement: evidence?.public_statement ?? scenario.metadata.sourceFacts[factId].statement,
      category: evidence?.status ?? 'unverified',
      hash: evidence
        ? createHash('sha256').update(JSON.stringify(evidence)).digest('hex')
        : undefined,
    }
  })
}

function strictGraderPrompt() {
  return `Act as a blind evaluation grader.
Read grader-request.json. Do not infer which arm used a skill.
Return JSON only, with this exact shape:
{"grades":{"<arm-label>":{"assertions":[{"id":"<criterion-id>","statement":"<criterion>","passed":true,"evidence":"<brief evidence>"}],"score":0.0,"passed":true}}}
Include exactly one grades entry for every arm label in the request and no unknown labels.`
}

function coreArm(modelArm) {
  if (modelArm === 'with_skill') return 'with-skill'
  if (modelArm === 'without_skill') return 'without-skill'
  throw new Error(`Blind grader returned unknown true arm: ${modelArm}`)
}

export async function createBlindGrader({
  runtime,
  evidenceStore,
  config,
  repositoryRoot,
  processManager,
  controllerConfig,
  runDir,
  skillSnapshotPath,
}) {
  const modelIds = config.modelIds
  if (!Array.isArray(modelIds) || modelIds.length !== 2) {
    throw new Error('Copilot blind grader requires exactly two configured modelIds')
  }
  const provenance = await combinedModuleProvenance()
  const moduleHash = provenance.moduleHash
  const injectedModelExecutor = typeof config.modelExecutor === 'function' ? config.modelExecutor : undefined
  const core = injectedModelExecutor ? undefined : await loadCoreRuntime()
  const registry = core
    ? new core.ProcessRegistry(path.join(runDir, 'blind-grader-processes.jsonl'))
    : undefined
  const executor = core
    ? new core.CopilotCliExecutor(controllerConfig.copilotCommand, {
        processManager,
        preflightTimeoutMs: Number(config.preflightTimeoutMs ?? 30_000),
      })
    : undefined
  let callSequence = 0
  let capabilitiesPromise

  const processCallbacks = (owner) => ({
    onProcessStarted: (identity) => registry?.recordStarted(owner, identity),
    onProcessExited: (identity) => registry?.recordExited(owner, identity),
  })

  const capabilities = async () => {
    if (!capabilitiesPromise) {
      capabilitiesPromise = (async () => {
        const scenario = { id: 'blind-grader-preflight', prompt: 'preflight', scaffold: {} }
        const root = path.join(runDir, 'blind-grader-preflight')
        const withoutSkill = await core.createIsolatedWorkspace({
          root: path.join(root, 'without-skill'),
          arm: 'without-skill',
          scenario,
          skillSnapshotPath,
          repositoryRoot,
          soakRunId: controllerConfig.runId,
        })
        const withSkill = await core.createIsolatedWorkspace({
          root: path.join(root, 'with-skill'),
          arm: 'with-skill',
          scenario,
          skillSnapshotPath,
          repositoryRoot,
          soakRunId: controllerConfig.runId,
        })
        return executor.probe({ withoutSkill, withSkill })
      })()
    }
    return capabilitiesPromise
  }

  const copilotModelExecutor = async (request, context) => {
    const sequence = callSequence++
    const phase = context.phase ?? 'blind-batch'
    const owner = `blind-grader:${phase}:${context.index}:${context.modelId}:${sequence}`
    const workspace = await core.createIsolatedWorkspace({
      root: path.join(
        runDir,
        'blind-grader-workspaces',
        safePart(phase),
        `${context.index}-${safePart(context.modelId)}-${sequence}`,
      ),
      arm: 'without-skill',
      scenario: {
        id: owner,
        prompt: strictGraderPrompt(),
        scaffold: {
          'grader-request.json': `${JSON.stringify(request, null, 2)}\n`,
        },
      },
      skillSnapshotPath,
      repositoryRoot,
      soakRunId: controllerConfig.runId,
    })
    const abort = new AbortController()
    const artifact = await executor.execute(
      {
        executionId: owner,
        scenario: { id: owner, prompt: strictGraderPrompt() },
        arm: 'without-skill',
        workspace,
        timeoutMs: Number(config.timeoutMs ?? 120_000),
        model: context.modelId,
        signal: abort.signal,
        ...processCallbacks(owner),
      },
      await capabilities(),
    )
    if (artifact.status !== 'completed' || !artifact.responseText.trim()) {
      throw new Error(`Copilot blind grader ${context.modelId} failed: ${artifact.status}`)
    }
    return artifact.responseText.trim()
  }
  const modelExecutor = injectedModelExecutor ?? copilotModelExecutor

  const engineConfig = (scope) => ({
    modelExecutor,
    graderModelIds: modelIds,
    executorModelId: controllerConfig.model,
    policy: {
      requireExecutorDiversity: config.requireExecutorDiversity ?? true,
      agreementThreshold: Number(config.minimumKappa ?? 0.6),
      calibrationThreshold: Number(config.calibrationThreshold ?? 1),
    },
    moduleHash,
    timeoutMs: Number(config.timeoutMs ?? 120_000),
    artifactWriter: (name, content) =>
      writeAtomic(path.join(runDir, 'blind-grader-transcripts', safePart(scope), name), content),
  })

  // Construct through both public factories once so alias/config drift fails at startup.
  const direct = createBlindModelGrader(engineConfig('startup-direct'))
  const external = createExternalBlindGrader(engineConfig('startup-external'))
  if (direct.apiVersion !== external.apiVersion) throw new Error('Blind grader factory API versions disagree')

  let calibrationSummary
  const api = {
    snapshot: {
      moduleHash,
      apiVersion: direct.apiVersion,
      modelIds: [...modelIds],
      dependencies: provenance.dependencies,
    },
    async assertCalibration(scenarios) {
      const results = []
      for (const scenario of scenarios) {
        const good = scenario.metadata.graderCanaries.find((item) => item.expected_grade === 'pass')
        const bad = scenario.metadata.graderCanaries.find((item) => item.expected_grade === 'fail')
        if (!good || !bad) throw new Error(`Scenario ${scenario.id} is missing good/bad grader canaries`)
        const result = await runBlindModelGrading(
          engineConfig(`calibration-${scenario.id}`),
          {
            prompt: scenario.prompt,
            pairs: [{
              bundle_id: `calibration-${scenario.id}`,
              with_skill: { answer: good.answer_excerpt },
              without_skill: { answer: bad.answer_excerpt },
            }],
            rubric: rubricForScenario(scenario),
            canaries: canariesForScenario(scenario),
            sourceEvidence: sourceEvidenceForScenario(scenario, evidenceStore),
            seed: Number.parseInt(createHash('sha256').update(scenario.id).digest('hex').slice(0, 8), 16),
          },
        )
        results.push({ scenarioId: scenario.id, kappa: result.kappa, accuracy: result.calibration.accuracy })
      }
      calibrationSummary = {
        passed: true,
        modelIds: [...modelIds],
        kappa: Math.min(...results.map((item) => item.kappa)),
        scenarios: results,
      }
      return calibrationSummary
    },
    async gradePair(artifacts, scenario, pairId) {
      if (!calibrationSummary?.passed) throw new Error('Blind grader pair grading requires successful startup calibration')
      const result = await runBlindModelGrading(
        engineConfig(`pair-${pairId}`),
        {
          prompt: scenario.prompt,
          pairs: [{
            bundle_id: pairId,
            with_skill: {
              answer: artifacts['with-skill'].responseText,
              artifacts: { type: artifacts['with-skill'].status },
            },
            without_skill: {
              answer: artifacts['without-skill'].responseText,
              artifacts: { type: artifacts['without-skill'].status },
            },
          }],
          rubric: rubricForScenario(scenario),
          canaries: canariesForScenario(scenario),
          sourceEvidence: sourceEvidenceForScenario(scenario, evidenceStore),
          outputArtifacts: {
            hash: createHash('sha256').update([
              artifacts['with-skill'].trace?.executableHash,
              artifacts['without-skill'].trace?.executableHash,
            ].filter(Boolean).sort().join('\0')).digest('hex'),
          },
          seed: Number.parseInt(createHash('sha256').update(pairId).digest('hex').slice(0, 8), 16),
        },
      )
      const grades = {}
      const evaluationIndex = result.blind_batch.findIndex(
        (entry) => entry.kind === 'evaluation' && entry.bundle_id === pairId,
      )
      if (evaluationIndex < 0) {
        throw new Error(`Blind grader batch is missing evaluation bundle ${pairId}`)
      }
      for (const adjudicated of result.adjudicated) {
        const arm = coreArm(adjudicated.arm)
        const requestLabel = `pair-${evaluationIndex}-${adjudicated.blind_label}`
        grades[arm] = {
          score: adjudicated.score,
          passed: adjudicated.passed,
          details: {
            grading: adjudicated,
            graders: result.grader_results.map((grader) => grader.parsed[requestLabel]),
            blind: {
              pairId,
              kappa: adjudicated.kappa,
              models: result.grader_models,
              transcripts: result.grader_results.map((grader) => grader.transcript),
            },
          },
        }
      }
      if (!grades['with-skill'] || !grades['without-skill']) {
        throw new Error(`Blind grader did not return both arms for ${pairId}`)
      }
      return grades
    },
  }
  return api
}

export {
  createBlindModelGrader,
  createExternalBlindGrader,
  runBlindModelGrading,
}
