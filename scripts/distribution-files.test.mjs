import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { discoverDistributionFiles, discoverNpmFiles } from './distribution-files.mjs'

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

test('distribution inventory includes declared files without generating release ZIP paths', (t) => {
  const root = createFixture(t)
  const inventory = discoverDistributionFiles(root)
  const sourcePaths = inventory.files.map(({ sourcePath }) => sourcePath)
  const npmPaths = inventory.publishedPaths.filter(({ channel }) => channel === 'npm').map(({ path }) => path)

  assert.ok(sourcePaths.includes('skills/example/new.html'))
  assert.ok(sourcePaths.includes('packages/build-tool/index.ts'))
  assert.ok(npmPaths.includes('plugin.json'))
  assert.ok(!sourcePaths.includes('evals/private.md'))
  assert.ok(inventory.publishedPaths.every(({ channel, path }) =>
    channel === 'npm' && !path.endsWith('.zip')))
})

test('missing required package roots fail', (t) => {
  const root = createFixture(t)
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

test('preview inventory retains skills and Copilot catalog without deferred host packaging', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const inventory = discoverDistributionFiles(root)
  const paths = inventory.files.map(({ sourcePath }) => sourcePath)
  for (const required of [
    'skills/redis-code/SKILL.md',
    'skills/azure-redis-infra/SKILL.md',
    'plugin.json',
    '.github/plugin/marketplace.json',
  ]) {
    assert.ok(paths.includes(required), `${required} must remain in the inventory`)
  }
  for (const removed of [
    '.claude-plugin/plugin.json',
    '.cursor-plugin/plugin.json',
    '.codex-plugin/plugin.json',
    'gemini-extension.json',
    'GEMINI.md',
    'apm.yml',
  ]) {
    assert.equal(existsSync(join(root, removed)), false, `${removed} must not ship`)
    assert.ok(!paths.includes(removed), `${removed} must not remain in the inventory`)
  }
  const workflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8')
  assert.doesNotMatch(workflow, /CreateFromDirectory|upload-artifact|gh release upload|--release-inputs/)
  assert.match(workflow, /gh release create \$tag --title/)
})
