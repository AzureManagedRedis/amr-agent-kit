import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const BUNDLED_SKILLS = ['redis-code', 'azure-redis-infra']

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function resolveInside(root, path) {
  const absolutePath = resolve(root, path)
  const fromRoot = relative(root, absolutePath)
  assert.ok(
    fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot),
    `${path} must resolve inside ${root}`,
  )
  return absolutePath
}

const catalog = readJson(join(REPO_ROOT, '.github', 'plugin', 'marketplace.json'))
const rootPackage = readJson(join(REPO_ROOT, 'package.json'))

function pluginEntry() {
  assert.ok(Array.isArray(catalog.plugins), 'catalog plugins must be an array')
  assert.equal(catalog.plugins.length, 1, 'catalog must list exactly one plugin')
  return catalog.plugins[0]
}

function pluginRoot() {
  const { source } = pluginEntry()
  assert.equal(typeof source, 'string', 'plugin source must be a relative path')
  const root = resolveInside(REPO_ROOT, source)
  assert.ok(statSync(root).isDirectory(), `plugin source must be a directory: ${source}`)
  return root
}

test('catalog publishes the amr plugin in the amr-agent-kit marketplace', () => {
  assert.equal(catalog.name, 'amr-agent-kit')
  assert.equal(typeof catalog.owner?.name, 'string')
  assert.ok(catalog.owner.name.trim().length > 0, 'catalog owner.name must be set')
  assert.equal(pluginEntry().name, 'amr')
})

test('catalog names and description fit Copilot CLI limits', () => {
  for (const name of [catalog.name, pluginEntry().name]) {
    assert.match(name, KEBAB_CASE)
    assert.ok(name.length <= 64, `${name} must be 64 characters or fewer`)
  }
  const { description } = pluginEntry()
  assert.equal(typeof description, 'string')
  assert.ok(description.length <= 1024, 'plugin description must be 1024 characters or fewer')
})

test('catalog source resolves inside the repository to the amr plugin manifest', () => {
  const manifest = readJson(join(pluginRoot(), 'plugin.json'))
  assert.equal(manifest.name, 'amr')
})

test('catalog version matches plugin.json and package.json', () => {
  const manifest = readJson(join(pluginRoot(), 'plugin.json'))
  assert.equal(pluginEntry().version, manifest.version)
  assert.equal(pluginEntry().version, rootPackage.version)
})

test('no .plugin/plugin.json shadows the root plugin manifest', () => {
  assert.equal(existsSync(join(pluginRoot(), '.plugin', 'plugin.json')), false)
})

test('plugin skills directory bundles redis-code and azure-redis-infra', () => {
  const root = pluginRoot()
  const manifest = readJson(join(root, 'plugin.json'))
  assert.equal(typeof manifest.skills, 'string', 'plugin.json skills must be a directory path')
  const skillsDir = resolveInside(root, manifest.skills)
  for (const skill of BUNDLED_SKILLS) {
    assert.ok(statSync(join(skillsDir, skill, 'SKILL.md')).isFile(), `${skill}/SKILL.md must exist`)
  }
})
