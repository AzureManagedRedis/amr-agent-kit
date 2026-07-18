import { createHash } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const EXCLUDED = new Set(['node_modules', 'bin', 'obj', 'target', '.git', '.offline-output', '__pycache__'])

function childPath(root, relative) {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(root, relative)
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Retained artifact path escapes its root: ${relative}`)
  }
  return resolved
}

async function writeAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, content)
  await rename(temporary, filePath)
}

async function copyTree(source, destination) {
  await cp(source, destination, {
    recursive: true,
    force: true,
    filter: (item) => !item.split(path.sep).some((part) => EXCLUDED.has(part)),
  })
}

async function filesUnder(root) {
  const files = []
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (EXCLUDED.has(entry.name)) continue
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) files.push(absolute)
    }
  }
  await visit(root)
  return files.sort((left, right) => left.localeCompare(right))
}

async function hashesFor(root, excluded = new Set()) {
  const hashes = {}
  for (const file of await filesUnder(root)) {
    const relative = path.relative(root, file).split(path.sep).join('/')
    if (excluded.has(relative)) continue
    hashes[relative] = createHash('sha256').update(await readFile(file)).digest('hex')
  }
  return hashes
}

async function writeScaffold(root, scaffold) {
  for (const [relative, content] of Object.entries(scaffold ?? {})) {
    await writeAtomic(childPath(root, relative), content)
  }
}

async function copyArm(bundleRoot, arm, artifact) {
  const armRoot = path.join(bundleRoot, arm)
  await mkdir(armRoot, { recursive: true })
  if (artifact?.trace?.cwd) {
    try {
      if ((await stat(artifact.trace.cwd)).isDirectory()) await copyTree(artifact.trace.cwd, path.join(armRoot, 'project'))
    } catch {
      // The transcript and build result retain the failure even if the project vanished.
    }
  }
  await writeAtomic(path.join(armRoot, 'transcript.md'), `# ${arm}\n\n${artifact?.responseText ?? ''}\n`)
  await writeAtomic(
    path.join(armRoot, 'build-result.json'),
    `${JSON.stringify({
      schema_version: 1,
      status: artifact?.status ?? 'missing',
      started_at: artifact?.startedAt,
      finished_at: artifact?.finishedAt,
      grade: artifact?.grade,
      contamination: artifact?.trace?.contamination ?? [],
    }, null, 2)}\n`,
  )
}

function reproductionScript(runId) {
  return `[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$hashes = Get-Content -Raw (Join-Path $root 'hashes.json') | ConvertFrom-Json
foreach ($entry in $hashes.PSObject.Properties) {
    $path = Join-Path $root ($entry.Name -replace '/', [IO.Path]::DirectorySeparatorChar)
    if (-not (Test-Path $path)) { throw "Missing retained artifact: $($entry.Name)" }
    $actual = (Get-FileHash -Algorithm SHA256 $path).Hash.ToLowerInvariant()
    if ($actual -ne [string]$entry.Value) { throw "Hash mismatch: $($entry.Name)" }
}
@{ runId = '${runId}'; verified = $true; checked = $hashes.PSObject.Properties.Count } | ConvertTo-Json
`
}

export async function materializeRetainedBundle({
  artifactRoot,
  pairId,
  scenario,
  artifacts,
  runtime,
}) {
  const bundleRoot = childPath(artifactRoot, path.join('retained-clients', pairId))
  await mkdir(bundleRoot, { recursive: true })
  await writeScaffold(path.join(bundleRoot, 'input-bad'), scenario.scaffold)

  const clientInput = scenario.metadata?.clientInput
  const referenceRoot = path.join(bundleRoot, 'reference-good')
  if (clientInput) {
    const client = runtime.corpusManifest.clients.find((item) => item.id === clientInput.clientId)
    await copyTree(path.join(runtime.corpusRoot, client.path), path.join(referenceRoot, 'client-source', client.id))
    await copyTree(clientInput.referenceRoot, path.join(referenceRoot, 'client-policy'))
  } else {
    await writeAtomic(
      path.join(referenceRoot, 'expected-guidance.json'),
      `${JSON.stringify({
        scenario: scenario.id,
        correctness: scenario.metadata.correctnessRubric.criteria,
        actionability: scenario.metadata.actionabilityRubric.criteria,
      }, null, 2)}\n`,
    )
  }

  await Promise.all([
    copyArm(bundleRoot, 'with-skill', artifacts['with-skill']),
    copyArm(bundleRoot, 'without-skill', artifacts['without-skill']),
  ])
  const patchesRoot = path.join(bundleRoot, 'patches')
  await mkdir(patchesRoot, { recursive: true })
  const patchPaths = []
  if (clientInput?.patchPath) {
    const destination = path.join(patchesRoot, path.basename(clientInput.patchPath))
    await cp(clientInput.patchPath, destination, { force: true })
    patchPaths.push(path.relative(bundleRoot, destination).split(path.sep).join('/'))
  } else {
    const destination = path.join(patchesRoot, 'scenario-input.patch')
    await writeAtomic(destination, 'Scenario input is synthetic; no source patch was applied.\n')
    patchPaths.push(path.relative(bundleRoot, destination).split(path.sep).join('/'))
  }

  await mkdir(path.join(bundleRoot, 'reports'), { recursive: true })
  await writeAtomic(path.join(bundleRoot, 'reports', 'index.json'), `${JSON.stringify({ version: 1, reports: [] }, null, 2)}\n`)
  await writeAtomic(path.join(bundleRoot, 'reproduce.ps1'), reproductionScript(pairId))
  const manifest = {
    runId: pairId.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
    client: clientInput?.clientId ?? 'source-guidance',
    scenario: scenario.id,
    mode: 'offline',
    referenceGood: 'reference-good',
    bad: 'input-bad',
    withSkill: 'with-skill',
    withoutSkill: 'without-skill',
    patches: patchPaths,
    hashes: 'hashes.json',
    reproductionCommand: 'reproduce.ps1',
    report: 'reports/report.md',
  }
  await writeAtomic(path.join(bundleRoot, 'run-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeAtomic(
    path.join(bundleRoot, 'reports', 'report.md'),
    `# Retained pair ${pairId}\n\n- [manifest](../run-manifest.json)\n- [input-bad](../input-bad)\n- [reference-good](../reference-good)\n- [with-skill](../with-skill)\n- [without-skill](../without-skill)\n- [patches](../patches)\n- [hashes](../hashes.json)\n- [reproduce](../reproduce.ps1)\n`,
  )
  const hashes = await hashesFor(bundleRoot, new Set(['hashes.json']))
  await writeAtomic(path.join(bundleRoot, 'hashes.json'), `${JSON.stringify(hashes, null, 2)}\n`)
  return {
    client_id: `${manifest.client}:${pairId}`,
    scenario: scenario.id,
    language: clientInput?.language ?? 'n/a',
    root: path.relative(artifactRoot, bundleRoot),
    variants: {
      'input-bad': 'input-bad',
      'reference-good': 'reference-good',
      'with-skill': 'with-skill',
      'without-skill': 'without-skill',
    },
    manifest: 'run-manifest.json',
    patches: 'patches',
    hashes: 'hashes.json',
    reproduction: 'reproduce.ps1',
  }
}

export const internals = Object.freeze({ childPath, hashesFor, reproductionScript })
