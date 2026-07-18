import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const REQUIRED_VARIANTS = ['input-bad', 'reference-good', 'with-skill', 'without-skill']
const SECRET = /(authorization|access[_-]?token|client[_-]?secret|password|connectionstring|sas|api[_-]?key|private[_-]?key)\s*[:=]\s*[^\s,;]+/gi

function childPath(root, relative) {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(root, relative)
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`retained artifact path escapes artifact root: ${relative}`)
  }
  return resolved
}

export function redact(value) {
  return String(value ?? '')
    .replace(SECRET, '$1=[REDACTED]')
    .replace(/\b(subscription|tenant|resource|workspace)[-_]?(id)?\s*[:=]\s*[A-Za-z0-9+/=_-]{12,}/gi, '$1=[REDACTED]')
}

async function filesUnder(root) {
  const output = []
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', 'bin', 'obj', 'target', '.venv'].includes(entry.name)) await visit(fullPath)
      } else if (entry.isFile()) {
        output.push(fullPath)
      }
    }
  }
  await visit(root)
  return output
}

async function sha256(filePath) {
  const hash = createHash('sha256')
  hash.update(await readFile(filePath))
  return hash.digest('hex')
}

function normalizeVariant(root, client) {
  const variants = { ...(client.variants ?? {}) }
  if (variants.bad && !variants['input-bad']) variants['input-bad'] = variants.bad
  const resolvedRoot = childPath(root, client.root ?? client.path ?? '.')
  return {
    ...client,
    client_id: String(client.client_id ?? client.id),
    root: path.relative(root, resolvedRoot) || '.',
    variants,
  }
}

export async function checkArtifactCompleteness(root, client) {
  const normalized = normalizeVariant(root, client)
  const missing = []
  for (const variant of REQUIRED_VARIANTS) {
    const variantPath = childPath(root, path.join(normalized.root, normalized.variants[variant] ?? variant))
    try {
      const info = await stat(variantPath)
      if (!info.isDirectory()) missing.push(variant)
    } catch {
      missing.push(variant)
    }
  }
  const requiredFiles = [
    ['manifest', normalized.manifest ?? 'run-manifest.json'],
    ['patches', normalized.patches ?? 'patches'],
    ['hashes', normalized.hashes ?? 'hashes.json'],
    ['reproduction', normalized.reproduction ?? 'reproduce.ps1'],
  ]
  for (const [label, relative] of requiredFiles) {
    try {
      const info = await stat(childPath(root, path.join(normalized.root, relative)))
      if (label === 'patches' ? !info.isDirectory() : !info.isFile()) missing.push(label)
    } catch {
      missing.push(label)
    }
  }
  for (const arm of ['with-skill', 'without-skill']) {
    const armArtifacts = ['transcript.md', 'build-result.json']
    if (normalized.mode === 'live') armArtifacts.push('live-result.json')
    for (const artifact of armArtifacts) {
      const relative = path.join(normalized.variants[arm] ?? arm, artifact)
      try {
        await stat(childPath(root, path.join(normalized.root, relative)))
      } catch {
        missing.push(`${arm}/${artifact}`)
      }
    }
  }
  return { complete: missing.length === 0, missing }
}

export async function buildClientArtifactIndex({ root, clients = [] }) {
  if (typeof root !== 'string' || root.length === 0) throw new TypeError('root is required')
  const entries = []
  for (const client of clients) {
    const normalized = normalizeVariant(root, client)
    const completeness = await checkArtifactCompleteness(root, normalized)
    const fileHashes = {}
    const clientRoot = path.resolve(root, normalized.root)
    try {
      for (const file of await filesUnder(clientRoot)) {
        const relative = path.relative(root, file)
        fileHashes[relative] = await sha256(file)
      }
    } catch {
      // Completeness carries the actionable failure; missing roots have no files to hash.
    }
    entries.push({
      client_id: normalized.client_id,
      scenario: redact(normalized.scenario),
      language: redact(normalized.language),
      root: normalized.root,
      variants: Object.fromEntries(REQUIRED_VARIANTS.map((variant) => [
        variant,
        path.join(normalized.root, normalized.variants[variant] ?? variant),
      ])),
      links: {
        manifest: path.join(normalized.root, normalized.manifest ?? 'run-manifest.json'),
        patches: path.join(normalized.root, normalized.patches ?? 'patches'),
        transcripts: ['with-skill', 'without-skill'].map((arm) => path.join(normalized.root, normalized.variants[arm] ?? arm, 'transcript.md')),
        build_logs: ['with-skill', 'without-skill'].map((arm) => path.join(normalized.root, normalized.variants[arm] ?? arm, 'build-result.json')),
        live_logs: normalized.mode === 'live'
          ? ['with-skill', 'without-skill'].map((arm) => path.join(normalized.root, normalized.variants[arm] ?? arm, 'live-result.json'))
          : [],
        hashes: path.join(normalized.root, normalized.hashes ?? 'hashes.json'),
        reproduction: path.join(normalized.root, normalized.reproduction ?? 'reproduce.ps1'),
      },
      hashes: fileHashes,
      completeness,
    })
  }
  return {
    schema_version: 1,
    required_variants: REQUIRED_VARIANTS,
    entries: entries.sort((a, b) => a.client_id.localeCompare(b.client_id)),
    complete: entries.every((entry) => entry.completeness.complete),
  }
}

export function candidateFixesFromRuns(runs) {
  const fixes = []
  for (const run of runs) {
    const grading = run.grading ?? {}
    for (const assertion of grading.assertions ?? []) {
      if (!assertion.passed && !assertion.pass) {
        fixes.push({
          eval_id: run.eval_id,
          run_id: run.run_id,
          assertion_id: assertion.id ?? assertion.assertion_id,
          fix: `Address failed assertion: ${redact(assertion.statement ?? assertion.description ?? 'review the assertion')}`,
        })
      }
    }
    for (const violation of grading.safety_violations ?? []) {
      fixes.push({
        eval_id: run.eval_id,
        run_id: run.run_id,
        category: 'safety',
        fix: `Remove unsafe pattern: ${redact(violation)}`,
      })
    }
  }
  return fixes
}
