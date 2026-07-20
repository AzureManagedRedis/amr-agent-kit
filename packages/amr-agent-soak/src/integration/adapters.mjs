import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { generateReport } from '../report/generate.mjs'
import { materializeRetainedBundle } from './retained-artifacts.mjs'

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function writeAtomicJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, filePath)
}

function cacheFile(root, key) {
  const digest = createHash('sha256').update(JSON.stringify(key)).digest('hex')
  return path.join(root, `${digest}.json`)
}

export class FileExecutionArtifactCache {
  constructor(root) {
    this.root = root
  }

  async get(key) {
    try {
      return await readJson(cacheFile(this.root, key))
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }

  async put(key, artifact) {
    await writeAtomicJson(cacheFile(this.root, key), artifact)
  }
}

function durationMs(artifact) {
  const start = Date.parse(artifact.startedAt)
  const finish = Date.parse(artifact.finishedAt)
  return Number.isFinite(start) && Number.isFinite(finish) ? Math.max(0, finish - start) : 0
}

function reportManifest(summary, config, resourceEvidence) {
  const live = config.liveCache?.enabled === true
  const cleanup = resourceEvidence ?? {}
  return {
    SoakRunId: summary.runId,
    selector: config.targetSkill,
    lease_class: live ? (config.report?.leaseClass ?? 'exclusive') : 'dry-run',
    resource_id: live ? 'owned-runtime-resources' : 'not-provisioned',
    namespace: config.report?.namespace ?? `soak:${summary.runId}`,
    cleanup_terminal_state: live
      ? (cleanup.zeroOrphans && cleanup.checkedLedger === 0 ? 'terminal-deleted' : 'incomplete')
      : 'not-applicable',
    orphan_count: live ? Number(cleanup.orphanCount ?? 0) : 0,
  }
}

async function optionalJson(filePath) {
  if (!filePath) return undefined
  try {
    return await readJson(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

export class IntegrationReporter {
  constructor({ runDir, runtime, integrationConfig, evidenceStore }) {
    this.runDir = runDir
    this.runtime = runtime
    this.integrationConfig = integrationConfig
    this.evidenceStore = evidenceStore
  }

  async onEvent() {
    // The core event ledger is already append-only and fsync-backed.
  }

  async finalize(summary) {
    const [state, scenarios] = await Promise.all([
      readJson(path.join(this.runDir, 'state.json')),
      readJson(path.join(this.runDir, 'scenarios.snapshot.json')),
    ])
    const scenarioById = new Map(scenarios.map((scenario) => [scenario.id, scenario]))
    const runs = []
    const clients = []
    for (const [pairId, pair] of Object.entries(state.pairs)) {
      const scenario = scenarioById.get(pair.scenarioId)
      if (!scenario) continue
      const artifacts = {}
      for (const arm of ['with-skill', 'without-skill']) {
        const artifactPath = pair.arms?.[arm]?.artifactPath
        if (!artifactPath) continue
        const artifact = await readJson(artifactPath)
        artifacts[arm] = artifact
        const grading = artifact.grade?.details?.grading
        const inconclusive = artifact.grade?.inconclusive === true || grading?.inconclusive === true
        runs.push({
          eval_id: scenario.id,
          run_id: pairId,
          arm,
          model: this.integrationConfig.model ?? 'configured-executor',
          status: artifact.status,
          contaminated: (artifact.trace?.contamination ?? []).length > 0,
          complete: true,
          grading: grading
            ? { ...grading, inconclusive }
            : {
                assertions: [{ id: 'missing-grade', statement: 'Grading output was missing', passed: false }],
                score: 0,
                efficacy_score: 0,
                correctness_score: 0,
                safety_score: 0,
                passed: false,
                inconclusive: false,
              },
          graders: artifact.grade?.details?.graders,
          timing: {
            duration_ms: durationMs(artifact),
            started_at: artifact.startedAt,
            finished_at: artifact.finishedAt,
          },
        })
      }
      clients.push(await materializeRetainedBundle({
        artifactRoot: this.runDir,
        pairId,
        scenario,
        artifacts,
        runtime: this.runtime,
        mode: this.integrationConfig.liveCache?.enabled === true ? 'live' : 'offline',
      }))
    }
    const metadata = scenarios.map((scenario) => scenario.metadata.evalMetadata)
    const evidencePath = this.integrationConfig.liveCache?.evidencePath
      ? path.resolve(this.integrationConfig.repositoryRoot, this.integrationConfig.liveCache.evidencePath)
      : path.join(this.runDir, 'resource-janitor.evidence.json')
    const resourceEvidence = await optionalJson(evidencePath)
    const input = {
      skill_name: this.integrationConfig.targetSkill,
      eval_metadata: metadata,
      runs,
      clients,
      artifact_root: this.runDir,
      manifest: reportManifest(summary, this.integrationConfig, resourceEvidence),
    }
    const result = await generateReport(input, { outDir: this.runDir, artifactRoot: this.runDir, clients })
    await writeAtomicJson(path.join(this.runDir, 'evidence-summary.json'), {
      schema_version: 1,
      records: this.evidenceStore.snapshot(),
    })
    await writeAtomicJson(path.join(this.runDir, 'integration-summary.json'), {
      schema_version: 1,
      run: summary,
      retained_clients: clients.length,
      report_files: Object.keys(result.files),
      evidence_records: this.evidenceStore.snapshot().length,
    })
  }
}

export const internals = Object.freeze({ durationMs, reportManifest })
