#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OPTIONAL_RELEASE_MANIFESTS = [
  'plugin.json',
  'gemini-extension.json',
  'apm.yml',
  '.waza.yaml',
  '.claude-plugin',
  '.cursor-plugin',
  '.codex-plugin',
]
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

export function discoverReleaseInputs(root = REPO_ROOT) {
  const absoluteRoot = resolve(root)
  const skillsPath = resolveInsideRoot(absoluteRoot, 'skills')
  let skillsStat
  try {
    skillsStat = lstatSync(skillsPath.absolutePath)
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Required release input skills/ is missing')
    throw error
  }
  if (skillsStat.isSymbolicLink() || !skillsStat.isDirectory()) {
    throw new Error('Required release input skills/ must be a directory')
  }

  const skills = []
  for (const entry of readdirSync(skillsPath.absolutePath, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      if (entry.isSymbolicLink()) throw new Error(`Unsupported release input: skills/${entry.name}`)
      continue
    }
    const sourcePath = `skills/${entry.name}`
    const directory = resolveInsideRoot(absoluteRoot, sourcePath)
    const skillFile = resolveInsideRoot(absoluteRoot, `${sourcePath}/SKILL.md`)
    let skillStat
    try {
      skillStat = lstatSync(skillFile.absolutePath)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    if (skillStat.isSymbolicLink() || !skillStat.isFile()) {
      throw new Error(`Release skill entry must be a regular file: ${sourcePath}/SKILL.md`)
    }
    const directoryStat = lstatSync(directory.absolutePath)
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new Error(`Release skill input must be a directory: ${sourcePath}`)
    }
    skills.push({
      name: entry.name,
      sourcePath,
      archivePath: `skills/${entry.name}.zip`,
    })
  }
  if (skills.length === 0) {
    throw new Error('Release packaging requires at least one skill directory containing SKILL.md')
  }

  const manifests = []
  for (const sourcePath of OPTIONAL_RELEASE_MANIFESTS) {
    const source = resolveInsideRoot(absoluteRoot, sourcePath)
    try {
      const stat = lstatSync(source.absolutePath)
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        throw new Error(`Unsupported optional release input: ${sourcePath}`)
      }
      manifests.push({ name: sourcePath, sourcePath })
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
  }

  return {
    skills,
    manifests,
    manifestArchivePath: 'amr-agent-kit-manifests.zip',
  }
}

function addPublishedPath(paths, channel, path, sourcePath) {
  const normalized = normalizeRelativePath(path)
  const key = `${channel}\0${normalized}`
  if (!paths.has(key)) {
    const entry = { channel, path: normalized }
    if (sourcePath) entry.sourcePath = normalizeRelativePath(sourcePath)
    paths.set(key, entry)
  }
}

function addContentFile(files, sourcePath, channel, publishedPath) {
  const normalizedSource = normalizeRelativePath(sourcePath)
  const item = files.get(normalizedSource) ?? { sourcePath: normalizedSource, publishedPaths: [] }
  const key = `${channel}\0${publishedPath}`
  if (!item.publishedPaths.some((entry) => `${entry.channel}\0${entry.path}` === key)) {
    item.publishedPaths.push({ channel, path: normalizeRelativePath(publishedPath) })
  }
  files.set(normalizedSource, item)
}

function relativePosix(rootPath, childPath) {
  const prefix = `${rootPath}/`
  if (!childPath.startsWith(prefix)) {
    throw new Error(`Distribution entry is outside its selected root: ${childPath}`)
  }
  return childPath.slice(prefix.length)
}

function enumerateTree(root, sourcePath, callback) {
  const directory = resolveInsideRoot(root, sourcePath)
  const entries = readdirSync(directory.absolutePath, { withFileTypes: true })
  if (entries.length === 0) {
    callback(directory.relativePath, 'directory')
    return
  }
  for (const entry of entries) {
    const childPath = `${sourcePath}/${entry.name}`
    const child = resolveInsideRoot(root, childPath)
    if (entry.isSymbolicLink()) throw new Error(`Unsupported distribution symbolic link: ${childPath}`)
    if (entry.isDirectory()) {
      enumerateTree(root, childPath, callback)
    } else if (entry.isFile()) {
      callback(child.relativePath, 'file')
    } else {
      throw new Error(`Unsupported distribution entry: ${childPath}`)
    }
  }
}

export function discoverDistributionFiles(root = REPO_ROOT, options = {}) {
  const absoluteRoot = resolve(root)
  const npm = discoverNpmFiles(absoluteRoot, options)
  const release = discoverReleaseInputs(absoluteRoot)
  const files = new Map()
  const paths = new Map()

  for (const file of npm.files) {
    addContentFile(files, file.sourcePath, 'npm', file.sourcePath)
    addPublishedPath(paths, 'npm', file.sourcePath, file.sourcePath)
  }
  for (const entry of npm.publishedPaths) addPublishedPath(paths, entry.channel, entry.path)

  for (const skill of release.skills) {
    addPublishedPath(paths, 'release', skill.archivePath)
    enumerateTree(absoluteRoot, skill.sourcePath, (sourcePath, kind) => {
      const memberPath = sourcePath === skill.sourcePath
        ? `${skill.archivePath}/${skill.name}`
        : `${skill.archivePath}/${skill.name}/${relativePosix(skill.sourcePath, sourcePath)}`
      if (kind === 'directory') {
        addPublishedPath(paths, 'release', memberPath, sourcePath)
        return
      }
      addContentFile(files, sourcePath, 'release', memberPath)
      addPublishedPath(paths, 'release', memberPath, sourcePath)
    })
  }

  addPublishedPath(paths, 'release', release.manifestArchivePath)
  for (const manifest of release.manifests) {
    const source = resolveInsideRoot(absoluteRoot, manifest.sourcePath)
    const stat = lstatSync(source.absolutePath)
    if (stat.isFile()) {
      const memberPath = `amr-agent-kit-manifests/${manifest.name}`
      addContentFile(files, manifest.sourcePath, 'release', `${release.manifestArchivePath}/${memberPath}`)
      addPublishedPath(paths, 'release', `${release.manifestArchivePath}/${memberPath}`, manifest.sourcePath)
    } else {
      enumerateTree(absoluteRoot, manifest.sourcePath, (sourcePath, kind) => {
        const innerPath = sourcePath === manifest.sourcePath
          ? manifest.name
          : `${manifest.name}/${relativePosix(manifest.sourcePath, sourcePath)}`
        const memberPath = `${release.manifestArchivePath}/amr-agent-kit-manifests/${innerPath}`
        if (kind === 'directory') {
          addPublishedPath(paths, 'release', memberPath, sourcePath)
          return
        }
        addContentFile(files, sourcePath, 'release', memberPath)
        addPublishedPath(paths, 'release', memberPath, sourcePath)
      })
    }
  }

  return {
    files: [...files.values()],
    publishedPaths: [...paths.values()],
  }
}

function runCli() {
  const [command, ...extra] = process.argv.slice(2)
  if (command !== '--release-inputs' || extra.length !== 0) {
    console.error('Usage: node scripts/distribution-files.mjs --release-inputs')
    process.exitCode = 2
    return
  }
  try {
    console.log(JSON.stringify(discoverReleaseInputs(), null, 2))
  } catch (error) {
    console.error(`Unable to enumerate release inputs: ${error.message}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli()
}
