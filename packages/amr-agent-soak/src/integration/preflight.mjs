#!/usr/bin/env node
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LeaseManager,
  LocalRpHttpAdapter,
  ResourceLedger,
  classifySkuViaProvider,
  createOwnedCache,
  deleteOwnedResource,
  runJanitorPass,
} from '../cache/index.mjs'
import { generateReport } from '../report/generate.mjs'
import { materializeRetainedBundle } from './retained-artifacts.mjs'
import { EvidenceStore } from './evidence.mjs'
import { RegistryGrader } from './grading-adapter.mjs'
import { loadSoakRegistry, RegistryScenarioProvider, defaults } from './registry.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  }
}

function fakeRp() {
  const caches = new Map()
  const databases = new Set()
  let paginationRequests = 0
  return {
    caches,
    get paginationRequests() { return paginationRequests },
    async fetchImpl(url, init = {}) {
      const parsed = new URL(url)
      const method = init.method ?? 'GET'
      const match = parsed.pathname.match(
        /^\/subscriptions\/[^/]+(?:\/resourceGroups\/[^/]+)?\/providers\/Microsoft\.Cache\/redisEnterprise(?:\/([^/]+))?(?:\/databases\/default)?$/,
      )
      if (!match) return response(404, { error: 'not found' })
      const name = match[1] ? decodeURIComponent(match[1]) : undefined
      const databaseRequest = parsed.pathname.endsWith('/databases/default')
      if (!name && method === 'GET') {
        paginationRequests += 1
        if (parsed.searchParams.get('page') === '2') {
          return response(200, { value: [...caches.values()] })
        }
        return response(200, {
          value: [],
          nextLink: `http://localhost:8443${parsed.pathname}?page=2&api-version=2024-09-01-preview`,
        })
      }
      if (databaseRequest && method === 'GET') {
        return databases.has(name)
          ? response(200, { name: 'default', properties: { provisioningState: 'Succeeded' } })
          : response(404, { error: 'not found' })
      }
      if (!databaseRequest && method === 'GET') {
        return caches.has(name) ? response(200, caches.get(name)) : response(404, { error: 'not found' })
      }
      if (method === 'PUT') {
        const body = JSON.parse(init.body ?? '{}')
        if (databaseRequest) {
          databases.add(name)
          return response(200, { name: 'default', ...body, properties: { ...body.properties, provisioningState: 'Succeeded' } })
        }
        caches.set(name, {
          name,
          ...body,
          properties: { ...body.properties, provisioningState: 'Succeeded' },
        })
        return response(200, caches.get(name))
      }
      if (!databaseRequest && method === 'DELETE') {
        if (!caches.has(name)) return response(404, { error: 'not found' })
        caches.delete(name)
        databases.delete(name)
        return response(200, { deleted: true })
      }
      return response(404, { error: 'not found' })
    },
  }
}

async function fakeCacheSmoke(root) {
  const fake = fakeRp()
  const adapter = new LocalRpHttpAdapter({ fetchImpl: fake.fetchImpl })
  const ledger = new ResourceLedger({ path: path.join(root, 'resource-ledger.jsonl') })
  const leaseManager = new LeaseManager({ fencingStatePath: path.join(root, 'fencing.json') })
  const config = {
    subscriptionId: 'customer-subscription',
    tenantId: 'test-tenant',
    resourceGroup: 'test-resource-group',
    apiVersion: '2024-09-01-preview',
    createPollTimeoutMs: 1800000,
    deletePollTimeoutMs: 1200000,
    ownerAlias: 'preflight',
    runId: 'integration',
    resourcePrefix: 'preflight-integration-',
    denylist: ['infrastructure-subscription'],
    subscriptionDenylist: ['backing-infrastructure-subscription'],
    acknowledgedCustomerSubscription: true,
  }
  const catalogProvider = async () => ({
    skus: [
      { family: 'Balanced', name: 'B0', memoryGb: 0.025 },
      { family: 'Balanced', name: 'B5', memoryGb: 6, capacityGb: 6 },
    ],
  })
  const classification = await classifySkuViaProvider(catalogProvider, 'B0', 'Balanced')
  const createLease = leaseManager.acquire({ class: 'exclusive', resourceName: 'preflight-integration-cache' })
  await createOwnedCache({
    ledger,
    adapter,
    resourceName: 'preflight-integration-cache',
    sku: classification.sku,
    location: 'test-region',
    dryRunOnly: classification.dryRunOnly,
    databaseSpec: {
      clientProtocol: 'Encrypted',
      evictionPolicy: 'NoEviction',
      clusteringPolicy: 'EnterpriseCluster',
    },
    config,
    lease: createLease,
    leaseManager,
  })
  leaseManager.release(createLease.id)
  const deleteLease = leaseManager.acquire({ class: 'exclusive', resourceName: 'preflight-integration-cache' })
  await deleteOwnedResource({
    ledger,
    adapter,
    resourceName: 'preflight-integration-cache',
    context: { config, lease: deleteLease, leaseManager },
  })
  leaseManager.release(deleteLease.id)
  const evidence = await runJanitorPass({ ledger, adapter, config, leaseManager })
  if (!evidence.zeroOrphans || fake.caches.size !== 0) throw new Error('Fake RP smoke left an orphan')
  if (fake.paginationRequests < 2) throw new Error('Fake RP smoke did not follow ARM list pagination')
  return { ...evidence, paginationRequests: fake.paginationRequests }
}

function fakeArtifact({ runId, scenario, arm, answer, projectDir, grading }) {
  const startedAt = new Date(Date.now() - 25).toISOString()
  const finishedAt = new Date().toISOString()
  return {
    soakRunId: runId,
    executionId: `${scenario.id}-${arm}`,
    scenarioId: scenario.id,
    arm,
    status: 'completed',
    startedAt,
    finishedAt,
    responseText: answer,
    events: [],
    grade: grading,
    trace: {
      executablePath: 'preflight-fake',
      executableHash: 'preflight',
      args: [],
      cwd: projectDir,
      pid: process.pid,
      processIdentity: { pid: process.pid, startedAt, name: 'node' },
      descendants: [],
      startedAt,
      finishedAt,
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      stdoutFile: '',
      stderrFile: '',
      projectHashBefore: 'preflight',
      projectHashAfter: 'preflight',
      profileHashBefore: 'preflight',
      profileHashAfter: 'preflight',
      contamination: [],
    },
  }
}

export async function runIntegrationPreflight({
  outDir = path.join(REPO_ROOT, 'eval-runs', 'integration-preflight'),
} = {}) {
  const resolvedOut = path.resolve(outDir)
  await rm(resolvedOut, { recursive: true, force: true })
  await mkdir(resolvedOut, { recursive: true })
  const runtime = await loadSoakRegistry({
    registryPath: defaults.registryPath,
    clientCorpusRoot: defaults.clientCorpusRoot,
  })
  const provider = new RegistryScenarioProvider(runtime, {
    targetSkill: 'redis-code',
    scenarioIds: ['scn-connection-auth-tls-entra'],
    runId: 'integration-preflight',
  })
  const [scenario] = await provider.listScenarios()
  const evidenceStore = new EvidenceStore(runtime)
  const grader = new RegistryGrader({ evidenceStore })
  await grader.assertCalibration([scenario])
  const good = scenario.metadata.graderCanaries.find((item) => item.expected_grade === 'pass').answer_excerpt
  const bad = scenario.metadata.graderCanaries.find((item) => item.expected_grade === 'fail').answer_excerpt
  const projectRoot = path.join(resolvedOut, 'fake-projects')
  await mkdir(projectRoot, { recursive: true })
  const runs = []
  const clients = []
  for (let repetition = 1; repetition <= 2; repetition += 1) {
    const pairId = `${scenario.id}-r${repetition}`
    const artifacts = {}
    for (const [arm, answer] of [['with-skill', good], ['without-skill', bad]]) {
      const projectDir = path.join(projectRoot, pairId, arm)
      await mkdir(projectDir, { recursive: true })
      for (const [relative, content] of Object.entries(scenario.scaffold)) {
        const file = path.join(projectDir, relative)
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, content, 'utf8')
      }
      const grade = await grader.grade({ responseText: answer }, scenario)
      artifacts[arm] = fakeArtifact({
        runId: 'integration-preflight',
        scenario,
        arm,
        answer,
        projectDir,
        grading: grade,
      })
      runs.push({
        eval_id: scenario.id,
        run_id: pairId,
        arm,
        model: 'preflight-fake',
        status: 'completed',
        complete: true,
        grading: grade.details.grading,
        timing: { duration_ms: 25 },
      })
    }
    clients.push(await materializeRetainedBundle({
      artifactRoot: resolvedOut,
      pairId,
      scenario,
      artifacts,
      runtime,
    }))
  }
  const cacheEvidence = await fakeCacheSmoke(resolvedOut)
  const report = await generateReport(
    {
      skill_name: 'redis-code',
      eval_metadata: [scenario.metadata.evalMetadata],
      runs,
      clients,
      artifact_root: resolvedOut,
      manifest: {
        SoakRunId: 'integration-preflight',
        selector: 'redis-code',
        lease_class: 'dry-run',
        resource_id: 'not-provisioned',
        namespace: 'soak:integration-preflight',
        cleanup_terminal_state: 'not-applicable',
        orphan_count: 0,
      },
    },
    { outDir: resolvedOut, artifactRoot: resolvedOut, clients },
  )
  const result = {
    schema_version: 1,
    scenarios: 1,
    paired_runs: 2,
    retained_clients: clients.length,
    cache_smoke: {
      zero_orphans: cacheEvidence.zeroOrphans,
      checked_live: cacheEvidence.checkedLive,
      pagination_requests: cacheEvidence.paginationRequests,
    },
    report_files: Object.keys(report.files),
  }
  await writeFile(path.join(resolvedOut, 'preflight-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  return result
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const outIndex = process.argv.indexOf('--out')
  const outDir = outIndex >= 0 ? process.argv[outIndex + 1] : undefined
  runIntegrationPreflight({ outDir }).then(
    (result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      process.exitCode = 1
    },
  )
}
