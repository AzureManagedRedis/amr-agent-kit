import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { scanDistribution } from './check-confidentiality.mjs'
import { discoverDistributionFiles, discoverNpmFiles, discoverReleaseInputs } from './distribution-files.mjs'

function createFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'amr-distribution-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  write(root, 'package.json', JSON.stringify({
    name: 'distribution-fixture',
    version: '1.0.0',
    files: ['skills/', 'packages/build-tool/', 'plugin.json'],
  }))
  write(root, 'skills/example/SKILL.md', 'Public skill guidance.\n')
  write(root, 'skills/example/new.html', '<p>New text surface</p>\n')
  write(root, 'packages/build-tool/index.ts', 'export const build = true\n')
  write(root, 'plugin.json', '{"name":"distribution-fixture"}\n')
  write(root, 'evals/private.md', 'Not distributed.\n')
  return root
}

function write(root, path, content) {
  const fullPath = join(root, path)
  mkdirSync(join(fullPath, '..'), { recursive: true })
  writeFileSync(fullPath, content)
}

function runNpmPack(root) {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(command, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    windowsHide: true,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function powershellScript(config) {
  const encoded = Buffer.from(JSON.stringify(config)).toString('base64')
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
$entries = [System.Collections.Generic.List[string]]::new()
foreach ($skill in $config.release.skills) {
  $source = Join-Path $config.root $skill.sourcePath
  $destination = Join-Path $config.dist $skill.archivePath
  New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
  [System.IO.Compression.ZipFile]::CreateFromDirectory($source, $destination, [System.IO.Compression.CompressionLevel]::Optimal, $true)
  $zip = [System.IO.Compression.ZipFile]::OpenRead($destination)
  try { foreach ($entry in $zip.Entries) { $entries.Add("$($skill.archivePath)/$($entry.FullName.Replace('\\','/'))") } }
  finally { $zip.Dispose() }
}
$manifestRoot = Join-Path $config.dist 'amr-agent-kit-manifests'
New-Item -ItemType Directory -Path $manifestRoot -Force | Out-Null
foreach ($manifest in $config.release.manifests) {
  Copy-Item -Path (Join-Path $config.root $manifest.sourcePath) -Destination $manifestRoot -Recurse -Force
}
$manifestZip = Join-Path $config.dist $config.release.manifestArchivePath
[System.IO.Compression.ZipFile]::CreateFromDirectory($manifestRoot, $manifestZip, [System.IO.Compression.CompressionLevel]::Optimal, $true)
$zip = [System.IO.Compression.ZipFile]::OpenRead($manifestZip)
try { foreach ($entry in $zip.Entries) { $entries.Add("$($config.release.manifestArchivePath)/$($entry.FullName.Replace('\\','/'))") } }
finally { $zip.Dispose() }
ConvertTo-Json -Compress @($entries)
`
}

test('npm pack dry-run inventory matches the independently enumerated package files', (t) => {
  const root = createFixture(t)
  const npmRecords = runNpmPack(root)
  const inventory = discoverNpmFiles(root)
  const expectedPaths = [
    ...npmRecords[0].files.map(({ path }) => path.replaceAll('\\', '/')),
    npmRecords[0].filename,
  ].sort()
  const actualPaths = inventory.publishedPaths.map(({ path }) => path).sort()

  assert.deepEqual(actualPaths, expectedPaths)
  assert.ok(actualPaths.includes('packages/build-tool/index.ts'))
})

test('release selection matches the files in temporary ZIPs and includes optional manifests', (t) => {
  const root = createFixture(t)
  write(root, 'skills/example/nested/rule.py', 'print("text")\n')
  mkdirSync(join(root, '.claude-plugin'), { recursive: true })
  write(root, '.claude-plugin/manifest.json', '{"releaseOnly":true}\n')
  mkdirSync(join(root, 'skills/example/Gen1/EmptyNested'), { recursive: true })
  mkdirSync(join(root, '.claude-plugin/empty-folder'), { recursive: true })
  write(root, '.waza.yaml', 'releaseOnly: true\n')

  const release = discoverReleaseInputs(root)
  const inventory = discoverDistributionFiles(root)
  const dist = mkdtempSync(join(tmpdir(), 'amr-release-zips-'))
  t.after(() => rmSync(dist, { recursive: true, force: true }))
  const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
  const result = spawnSync(powershell, [
    '-NoProfile', '-NonInteractive', '-Command', powershellScript({ root, dist, release }),
  ], { encoding: 'utf8', windowsHide: true })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  const actualMembers = JSON.parse(result.stdout.trim()).map((path) => path.replace(/\/+$/, '')).sort()
  const expectedMembers = inventory.publishedPaths
    .filter(({ channel, path }) => channel === 'release' && !path.endsWith('.zip'))
    .map(({ path }) => path)
    .sort()

  assert.deepEqual(actualMembers, expectedMembers)
  assert.ok(inventory.publishedPaths.some(({ channel, path }) => channel === 'release' && path.endsWith('/EmptyNested')))
  assert.ok(inventory.publishedPaths.some(({ channel, path }) => channel === 'release' && path.endsWith('/empty-folder')))
  assert.ok(release.manifests.some(({ sourcePath }) => sourcePath === '.claude-plugin'))
  assert.ok(release.manifests.some(({ sourcePath }) => sourcePath === '.waza.yaml'))
})

test('empty release directory names are published paths even without content files', (t) => {
  const root = createFixture(t)
  mkdirSync(join(root, 'skills/example/Gen1'), { recursive: true })

  const inventory = discoverDistributionFiles(root)

  assert.ok(inventory.publishedPaths.some(({ channel, path }) =>
    channel === 'release' && path === 'skills/example.zip/example/Gen1'))
  assert.ok(!inventory.files.some(({ sourcePath }) => sourcePath === 'skills/example/Gen1'))

  const result = scanDistribution(root)
  assert.ok(result.findings.some(({ rule, file, locationKind }) =>
    rule === 'product-terminology'
      && file === 'skills/example.zip/example/Gen1'
      && locationKind === 'path'))
})

test('distribution union includes new shipped files but excludes private development files', (t) => {
  const root = createFixture(t)
  const inventory = discoverDistributionFiles(root)
  const sourcePaths = inventory.files.map(({ sourcePath }) => sourcePath)
  const npmPaths = inventory.publishedPaths.filter(({ channel }) => channel === 'npm').map(({ path }) => path)

  assert.ok(sourcePaths.includes('skills/example/new.html'))
  assert.ok(sourcePaths.includes('packages/build-tool/index.ts'))
  assert.ok(npmPaths.includes('plugin.json'))
  assert.ok(!sourcePaths.includes('evals/private.md'))
})

test('missing optional release manifests are allowed but missing required package roots fail', (t) => {
  const root = createFixture(t)
  const release = discoverReleaseInputs(root)
  assert.ok(!release.manifests.some(({ sourcePath }) => sourcePath === '.waza.yaml'))

  const missingRoot = join(root, 'packages/build-tool')
  rmSync(missingRoot, { recursive: true, force: true })
  assert.throws(() => discoverNpmFiles(root), /Required package input/)
})

test('npm inventory cannot silently omit an existing required package root', (t) => {
  const root = createFixture(t)
  const missingFiles = JSON.stringify([{ filename: 'distribution-fixture-1.0.0.tgz', files: [{ path: 'package.json' }] }])

  assert.throws(() => discoverNpmFiles(root, { runPack: () => missingFiles }), /omitted required package input/)
})

test('npm inventory failures and malformed output are explicit errors', (t) => {
  const root = createFixture(t)
  assert.throws(() => discoverNpmFiles(root, { runPack: () => '{invalid' }), /invalid JSON/)
  assert.throws(() => discoverNpmFiles(root, { runPack: () => { throw new Error('npm unavailable') } }), /npm unavailable/)
  assert.throws(() => discoverNpmFiles(root, {
    runPack: () => JSON.stringify([{ files: [] }]),
  }), /empty files array/)
})

test('release-input CLI emits JSON and resolves its repository root from the script', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'amr-release-cli-cwd-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const script = resolve(dirname(fileURLToPath(import.meta.url)), 'distribution-files.mjs')
  const result = spawnSync(process.execPath, [script, '--release-inputs'], { cwd, encoding: 'utf8' })
  const root = resolve(dirname(script), '..')

  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), discoverReleaseInputs(root))
})
