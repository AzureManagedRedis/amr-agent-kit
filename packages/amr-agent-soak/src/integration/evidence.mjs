import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const STATUSES = new Set(['verified', 'contested', 'unverified', 'drift'])
const KINDS = new Set(['source', 'effective-config', 'live-probe'])
const PRIVATE_PATTERNS = [
  /[A-Za-z]:[\\/][^\s"']+/,
  /\/(?:home|users|workspaces|src)\/[^\s"']+/i,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  /\bsubscriptions[\\/][^\s"']+/i,
  /\b[\w.-]+\.(?:windows\.net|azure\.com)\b/i,
  /\.(?:cs|cpp|h|go|py):[0-9]+/i,
]
const SECRET_KEY = /(authorization|token|secret|password|connection|string|sas|private.?key|endpoint|hostname|subscription|tenant|resource.?id)/i

function assertPublicString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`)
  for (const pattern of PRIVATE_PATTERNS) {
    if (pattern.test(value)) throw new Error(`${label} contains private or environment-specific content`)
  }
}

function sanitizeObject(value, label = '$') {
  if (Array.isArray(value)) return value.map((item, index) => sanitizeObject(item, `${label}[${index}]`))
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') assertPublicString(value, label)
    return value
  }
  const output = {}
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) {
      if (key === 'provider_id' || key === 'fact_id' || key === 'probe_id') output[key] = item
      else output[key] = '[REDACTED]'
    } else {
      output[key] = sanitizeObject(item, `${label}.${key}`)
    }
  }
  return output
}

async function writeAtomicJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, filePath)
}

function validateRecord(record, expectedKind, runtime) {
  if (!record || typeof record !== 'object') throw new Error('Evidence record must be an object')
  if (!KINDS.has(record.kind) || record.kind !== expectedKind) throw new Error(`Evidence record kind must be ${expectedKind}`)
  if (!STATUSES.has(record.status)) throw new Error(`Unsupported evidence status: ${record.status}`)
  assertPublicString(record.id, 'evidence.id')
  assertPublicString(record.provider_id, 'evidence.provider_id')
  assertPublicString(record.public_statement, 'evidence.public_statement')
  if (record.fact_id && !runtime.maps.source_facts.has(record.fact_id)) throw new Error(`Unknown source fact: ${record.fact_id}`)
  if (record.probe_id && !runtime.maps.live_probes.has(record.probe_id)) throw new Error(`Unknown live probe: ${record.probe_id}`)
  if (expectedKind === 'live-probe' && !record.probe_id) throw new Error('Live evidence requires probe_id')
  if (expectedKind !== 'live-probe' && !record.fact_id) throw new Error(`${expectedKind} evidence requires fact_id`)
  if (record.effective_config) {
    if (!Array.isArray(record.effective_config)) throw new Error('effective_config must be an array')
    for (const item of record.effective_config) {
      if (!/^[A-Z0-9]+(?:_[A-Z0-9]+)*$/.test(item.key) || typeof item.resolved !== 'boolean') {
        throw new Error('Effective-config evidence exposes only uppercase key names and resolved booleans')
      }
      for (const key of Object.keys(item)) {
        if (!['key', 'resolved', 'source_class', 'value_class'].includes(key)) {
          throw new Error(`Effective-config evidence field is not public-safe: ${key}`)
        }
      }
    }
  }
  return sanitizeObject(record)
}

export class EvidenceStore {
  constructor(runtime) {
    this.runtime = runtime
    this.records = new Map()
  }

  ingest(record, kind = record.kind) {
    const normalized = validateRecord(record, kind, this.runtime)
    const key = normalized.fact_id ? `fact:${normalized.fact_id}` : `probe:${normalized.probe_id}`
    this.records.set(key, normalized)
    return normalized
  }

  forFact(factId) {
    return this.records.get(`fact:${factId}`)
  }

  forProbe(probeId) {
    return this.records.get(`probe:${probeId}`)
  }

  snapshot() {
    return [...this.records.values()].sort((left, right) => left.id.localeCompare(right.id))
  }
}

async function loadEvidenceFile(filePath, kind, store) {
  const payload = JSON.parse(await readFile(filePath, 'utf8'))
  const records = Array.isArray(payload) ? payload : payload.records
  if (!Array.isArray(records)) throw new Error(`Evidence file has no records array: ${filePath}`)
  return records.map((record) => store.ingest(record, kind))
}

export class EvidenceFileProbe {
  constructor({ id, phase, kind, filePath, store }) {
    this.id = id
    this.phase = phase
    this.kind = kind
    this.filePath = filePath
    this.store = store
  }

  async run(context) {
    const startedAt = new Date().toISOString()
    if (context.signal.aborted) {
      return {
        soakRunId: context.soakRunId,
        probeId: this.id,
        phase: this.phase,
        status: 'cancelled',
        startedAt,
        finishedAt: new Date().toISOString(),
        artifactPath: '',
      }
    }
    const records = await loadEvidenceFile(this.filePath, this.kind, this.store)
    const artifactPath = path.join(context.runDir, 'citations', this.kind, `${this.id}.json`)
    await writeAtomicJson(artifactPath, { schema_version: 1, kind: this.kind, records })
    return {
      soakRunId: context.soakRunId,
      probeId: this.id,
      phase: this.phase,
      status: 'completed',
      startedAt,
      finishedAt: new Date().toISOString(),
      artifactPath,
    }
  }
}

export class RuntimeHookProbe {
  constructor({ id, phase, kind, modulePath, exportName = 'runEvidenceHook', store, repositoryRoot }) {
    this.id = id
    this.phase = phase
    this.kind = kind
    this.modulePath = path.isAbsolute(modulePath) ? modulePath : path.resolve(repositoryRoot, modulePath)
    this.exportName = exportName
    this.store = store
  }

  async run(context) {
    const startedAt = new Date().toISOString()
    const module = await import(pathToFileURL(this.modulePath).href)
    const hook = module[this.exportName]
    if (typeof hook !== 'function') throw new Error(`${this.modulePath} does not export ${this.exportName}`)
    const result = await hook({
      soakRunId: context.soakRunId,
      phase: this.phase,
      kind: this.kind,
      signal: context.signal,
    })
    const records = (Array.isArray(result) ? result : result?.records ?? []).map((record) =>
      this.store.ingest(record, this.kind),
    )
    const artifactPath = path.join(context.runDir, 'citations', this.kind, `${this.id}.json`)
    await writeAtomicJson(artifactPath, { schema_version: 1, kind: this.kind, records })
    return {
      soakRunId: context.soakRunId,
      probeId: this.id,
      phase: this.phase,
      status: context.signal.aborted ? 'cancelled' : 'completed',
      startedAt,
      finishedAt: new Date().toISOString(),
      artifactPath,
    }
  }
}

export async function createEvidenceRuntime(runtime, config = {}, repositoryRoot = process.cwd()) {
  const store = new EvidenceStore(runtime)
  const probes = []
  const hookInputs = []
  const staticInputs = [
    ['source', 'source', config.sourceFile],
    ['effective-config', 'source', config.effectiveConfigFile],
    ['live-probe', 'live', config.liveProbeFile],
  ]
  for (const [kind, phase, file] of staticInputs) {
    if (!file) continue
    const filePath = path.isAbsolute(file) ? file : path.resolve(repositoryRoot, file)
    probes.push(new EvidenceFileProbe({ id: `evidence-${kind}`, phase, kind, filePath, store }))
  }
  for (const hook of config.hooks ?? []) {
    if (!['source', 'live'].includes(hook.phase) || !KINDS.has(hook.kind)) {
      throw new Error(`Invalid runtime evidence hook: ${hook.id}`)
    }
    const modulePath = path.isAbsolute(hook.modulePath)
      ? hook.modulePath
      : path.resolve(repositoryRoot, hook.modulePath)
    const moduleBytes = await readFile(modulePath)
    hookInputs.push({
      module: path.basename(modulePath),
      sha256: createHash('sha256').update(moduleBytes).digest('hex'),
    })
    probes.push(new RuntimeHookProbe({ ...hook, modulePath, store, repositoryRoot }))
  }
  if (config.required === true && probes.filter((probe) => probe.phase === 'source').length === 0) {
    throw new Error('integration.evidence.required=true but no source/effective-config evidence hook is configured')
  }
  const inputs = []
  for (const file of [config.sourceFile, config.effectiveConfigFile, config.liveProbeFile]) {
    if (!file) continue
    const filePath = path.isAbsolute(file) ? file : path.resolve(repositoryRoot, file)
    const info = await stat(filePath)
    inputs.push({ file: path.basename(filePath), size: info.size, sha256: createHash('sha256').update(await readFile(filePath)).digest('hex') })
  }
  return {
    store,
    probes,
    snapshot: {
      required: config.required === true,
      hooks: probes.map((probe) => ({ id: probe.id, phase: probe.phase, kind: probe.kind })),
      inputs,
      hookInputs,
    },
  }
}
