#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NPM_PACK_ARGS = ['pack', '--dry-run', '--json', '--ignore-scripts']

function toPosix(path) {
  return path.split(sep).join('/')
}

function normalizeRelativePath(path) {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/, '')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`Distribution path must be relative: ${path}`)
  }
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    throw new Error(`Distribution path escapes its root: ${path}`)
  }
  return normalized
}

function resolveInsideRoot(root, relativePath) {
  const normalized = normalizeRelativePath(relativePath)
  const absolutePath = resolve(root, normalized)
  const fromRoot = relative(root, absolutePath)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`Distribution path escapes its root: ${relativePath}`)
  }
  return { absolutePath, relativePath: toPosix(fromRoot) }
}

function runNpmPack(root) {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(command, NPM_PACK_ARGS, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    windowsHide: true,
  })
  if (result.error) {
    throw new Error(`Unable to run npm pack: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(`npm pack failed with exit code ${result.status}: ${result.stderr.trim()}`)
  }
  return result.stdout
}

function validateRequiredPackageRoots(root) {
  const packagePath = resolveInsideRoot(root, 'package.json')
  const packageJson = JSON.parse(readFileSync(packagePath.absolutePath, 'utf8'))
  if (!Array.isArray(packageJson.files) || packageJson.files.length === 0) {
    throw new Error('package.json must declare a nonempty files array')
  }

  const requiredPaths = []
  for (const entry of packageJson.files) {
    if (typeof entry !== 'string' || /[*?{}[\]]/.test(entry)) {
      throw new Error(`Unsupported package.json files entry: ${String(entry)}`)
    }
    const requiredPath = resolveInsideRoot(root, entry)
    let stat
    try {
      stat = lstatSync(requiredPath.absolutePath)
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Required package input is missing: ${entry}`)
      throw error
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Required package input must not be a symbolic link: ${entry}`)
    }
    if (!stat.isFile() && !stat.isDirectory()) {
      throw new Error(`Required package input is not a file or directory: ${entry}`)
    }
    requiredPaths.push({ path: requiredPath.relativePath, directory: stat.isDirectory() })
  }
  return requiredPaths
}

export function discoverNpmFiles(root = REPO_ROOT, { runPack = runNpmPack } = {}) {
  const absoluteRoot = resolve(root)
  const requiredPaths = validateRequiredPackageRoots(absoluteRoot)

  const output = runPack(absoluteRoot)
  let records
  try {
    records = JSON.parse(output)
  } catch (error) {
    throw new Error(`npm pack returned invalid JSON: ${error.message}`)
  }
  if (!Array.isArray(records) || records.length !== 1 || !Array.isArray(records[0]?.files)) {
    throw new Error('npm pack must return one package record with a files array')
  }
  if (records[0].files.length === 0) {
    throw new Error('npm pack returned an empty files array')
  }

  const files = records[0].files.map((entry) => {
    if (typeof entry?.path !== 'string') {
      throw new Error('npm pack returned a file without a path')
    }
    const source = resolveInsideRoot(absoluteRoot, entry.path)
    const stat = lstatSync(source.absolutePath)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`npm pack returned an unsupported input: ${entry.path}`)
    }
    return {
      sourcePath: source.relativePath,
      publishedPaths: [{ channel: 'npm', path: source.relativePath }],
    }
  })
  const packagedPaths = new Set(files.map(({ sourcePath }) => sourcePath))
  for (const required of requiredPaths) {
    const included = required.directory
      ? [...packagedPaths].some((path) => path.startsWith(`${required.path}/`))
      : packagedPaths.has(required.path)
    if (!included) throw new Error(`npm inventory omitted required package input: ${required.path}`)
  }

  const publishedPaths = files.map(({ publishedPaths: paths }) => paths[0])
  if (typeof records[0].filename === 'string' && records[0].filename.length > 0) {
    publishedPaths.push({ channel: 'npm', path: normalizeRelativePath(records[0].filename) })
  }

  return { files, publishedPaths }
}

export function discoverDistributionFiles(root = REPO_ROOT, options = {}) {
  return discoverNpmFiles(root, options)
}
