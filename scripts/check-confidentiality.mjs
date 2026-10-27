#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverDistributionFiles } from './distribution-files.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const RULES = [
  { severity: 'BLOCKER', name: 'internal-flag-abbrev', re: /\b(mkms|mkss|bdb_[a-z_]+)\b/ },
  { severity: 'BLOCKER', name: 'internal-env-or-allowlist', re: /RE_GEO_REPLICATION_CLUSTER_LIMIT|AllowedSubscriptionsForCacheConfigHacks|\b[A-Z][A-Za-z0-9]*AllowList\b/ },
  { severity: 'BLOCKER', name: 'internal-symbol', re: /\b(ClusterRequestValidations|DatabaseRequestValidations|DatabaseControllerBase|EnterpriseSkus|ModuleValidator|RedisLabsProbe|ClusterManager|CurrentStatusExtensions|ConfigureEnterpriseCluster)\b/ },
  { severity: 'BLOCKER', name: 'internal-component', re: /\b(dmcproxy|crdt_module|client_state|sharding_plugin|one2many_transaction|RedisRP|RLabs)\b/ },
  { severity: 'WARNING', name: 'internal-source-path-line', re: /[\w./\\-]+\.(cs|cpp|hpp|h|go|py|c):\d+/ },
  { severity: 'WARNING', name: 'internal-source-file', re: /\b[A-Z][A-Za-z0-9]+\.(cs|cpp|hpp)\b/ },
  { severity: 'BLOCKER', name: 'internal-error-constant', re: /\bError_[A-Z]\w+/ },
  { severity: 'BLOCKER', name: 'why-level-enforcement', re: /hard engine constant|config-driven limit|migration-only exception|compiled-in\b|the validating component|internal migration path/i },
  { severity: 'BLOCKER', name: 'product-terminology', re: /\bgen\s*[-\u2013\u2014]?\s*[12]\b/i },
]

const KNOWN_TEXT_EXTENSIONS = new Set([
  '.bat', '.c', '.cjs', '.cmd', '.conf', '.cpp', '.cs', '.css', '.go', '.h', '.hpp', '.htm', '.html',
  '.ini', '.java', '.js', '.json', '.json5', '.jsonc', '.jsx', '.less', '.md', '.markdown', '.mdx',
  '.mjs', '.ps1', '.py', '.rs', '.sass', '.scss', '.sh', '.sql', '.svg', '.toml', '.ts', '.tsx', '.txt',
  '.xml', '.yaml', '.yml',
])
const KNOWN_BINARY_EXTENSIONS = new Set([
  '.7z', '.avif', '.bmp', '.eot', '.gif', '.ico', '.jpeg', '.jpg', '.mp3', '.mp4', '.pdf', '.png',
  '.tgz', '.tif', '.tiff', '.ttf', '.wasm', '.webp', '.woff', '.woff2', '.zip',
])
const KNOWN_TEXT_FILENAMES = new Set(['LICENSE', 'NOTICE'])
const EXCEPTIONS = []

function scanError(rule, file, operation, error) {
  return {
    rule,
    file,
    operation,
    code: error?.code ?? 'UNKNOWN',
    message: error?.message ?? String(error),
  }
}

function asInventoryError(error) {
  return scanError('inventory-failed', '', 'enumerate', error)
}

function decodeContent(buffer, file) {
  const knownText = KNOWN_TEXT_EXTENSIONS.has(extname(file).toLowerCase())
    || KNOWN_TEXT_FILENAMES.has(basename(file).toUpperCase())
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    if (knownText && /[\u0000-\u0008\u000b\u000e-\u001f]/.test(text)) {
      return { error: scanError('invalid-text-content', file, 'decode', new Error('Text file contains binary control characters')) }
    }
    if (!knownText && (KNOWN_BINARY_EXTENSIONS.has(extname(file).toLowerCase())
        || /[\u0000-\u0008\u000b\u000e-\u001f]/.test(text))) {
      return { binary: true }
    }
    return { text }
  } catch (error) {
    if (knownText) {
      return { error: scanError('invalid-text-encoding', file, 'decode', error) }
    }
    return { binary: true }
  }
}

function matchesFor(rule, value) {
  const flags = rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`
  const matcher = new RegExp(rule.re.source, flags)
  return [...value.matchAll(matcher)].map((match) => match[0])
}

function isExcepted(exceptions, { file, rule, match, context, occurrence }) {
  return exceptions.some((entry) =>
    entry.file === file
    && entry.rule === rule
    && entry.match === match
    && entry.context === context
    && entry.occurrence === occurrence
    && typeof entry.reason === 'string'
    && entry.reason.trim().length > 0)
}

function addFindings(findings, value, location, rules, exceptions) {
  for (const rule of rules) {
    const matches = matchesFor(rule, value)
    matches.forEach((match, index) => {
      const context = location.locationKind === 'path' ? value : location.context
      if (rule.name === 'product-terminology'
          && isExcepted(exceptions, {
            file: location.exceptionFile ?? location.file,
            rule: rule.name,
            match,
            context,
            occurrence: index + 1,
          })) {
        return
      }

      const finding = {
        severity: rule.severity,
        rule: rule.name,
        file: location.file,
        locationKind: location.locationKind,
        match,
      }
      if (location.line !== undefined) finding.line = location.line
      if (location.text !== undefined) finding.text = location.text
      findings.push(finding)
    })
  }
}

function lineNumberAt(text, offset) {
  return text.slice(0, offset).split(/\r\n|\r|\n/).length
}

function contextForMatch(text, start, end) {
  const firstLineStart = text.lastIndexOf('\n', start - 1) + 1
  const nextLineBreak = text.indexOf('\n', end)
  let lastLineEnd = nextLineBreak === -1 ? text.length : nextLineBreak
  if (lastLineEnd > 0 && text[lastLineEnd - 1] === '\r') lastLineEnd -= 1
  return text.slice(firstLineStart, lastLineEnd).trim()
}

function addTerminologyFindings(findings, text, location, rules, exceptions) {
  const rule = rules.find(({ name }) => name === 'product-terminology')
  if (!rule) return

  const matcher = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`)
  for (const [index, match] of [...text.matchAll(matcher)].entries()) {
    const start = match.index
    const matchedText = match[0]
    const context = contextForMatch(text, start, start + matchedText.length)
    if (isExcepted(exceptions, {
      file: location.exceptionFile ?? location.file,
      rule: rule.name,
      match: matchedText,
      context,
      occurrence: index + 1,
    })) {
      continue
    }

    findings.push({
      severity: rule.severity,
      rule: rule.name,
      file: location.file,
      locationKind: location.locationKind,
      match: matchedText,
      line: lineNumberAt(text, start),
      text: context.slice(0, 160),
    })
  }
}

function normalizeInventory(inventory) {
  if (!inventory || !Array.isArray(inventory.files) || !Array.isArray(inventory.publishedPaths)) {
    throw new Error('Distribution inventory must include files and publishedPaths arrays')
  }
  return inventory
}

function validateRelativePath(root, path) {
  if (typeof path !== 'string' || path.length === 0 || isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path)) {
    throw new Error(`Distribution path must be relative: ${String(path)}`)
  }
  const segments = path.replaceAll('\\', '/').split('/')
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    throw new Error(`Distribution path escapes its root: ${path}`)
  }
  const absolutePath = resolve(root, path)
  const fromRoot = relative(root, absolutePath)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`Distribution path escapes its root: ${path}`)
  }
  return { normalized: path.replaceAll('\\', '/'), absolutePath }
}

export function scanDistribution(root = REPO_ROOT, {
  inventory = discoverDistributionFiles,
  readFile = readFileSync,
  rules = RULES,
  exceptions = EXCEPTIONS,
} = {}) {
  const findings = []
  const scanErrors = []
  let distribution
  try {
    distribution = normalizeInventory(inventory(root))
  } catch (error) {
    return {
      findings,
      scanErrors: [asInventoryError(error)],
      coverage: { textFiles: 0, binaryFiles: 0, publishedPaths: 0 },
    }
  }

  const uniquePaths = new Map()
  for (const entry of distribution.publishedPaths) {
    if (typeof entry?.path !== 'string' || typeof entry?.channel !== 'string') {
      scanErrors.push(scanError('invalid-inventory-entry', '', 'validate path', new Error('Published path must specify channel and path')))
      continue
    }
    try {
      const path = validateRelativePath(root, entry.path).normalized
      const exceptionFile = entry.sourcePath
        ? validateRelativePath(root, entry.sourcePath).normalized
        : path
      const normalized = { channel: entry.channel, path, exceptionFile }
      const key = `${normalized.channel}\0${normalized.path}`
      uniquePaths.set(key, { channel: normalized.channel, path: normalized.path })
      addFindings(findings, path, {
        file: path,
        exceptionFile,
        locationKind: 'path',
      }, rules, exceptions)
    } catch (error) {
      scanErrors.push(scanError('invalid-published-path', entry.path, 'validate path', error))
    }
  }

  let textFiles = 0
  let binaryFiles = 0
  const visitedSources = new Set()
  for (const entry of distribution.files) {
    if (typeof entry?.sourcePath !== 'string' || !Array.isArray(entry.publishedPaths)) {
      scanErrors.push(scanError('invalid-inventory-entry', '', 'validate file', new Error('Content file must specify sourcePath and publishedPaths')))
      continue
    }
    let source
    try {
      source = validateRelativePath(root, entry.sourcePath)
    } catch (error) {
      scanErrors.push(scanError('invalid-source-path', entry.sourcePath, 'validate source', error))
      continue
    }
    if (visitedSources.has(source.normalized)) continue
    visitedSources.add(source.normalized)

    let buffer
    try {
      const contents = readFile(source.absolutePath)
      buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(contents)
    } catch (error) {
      scanErrors.push(scanError('file-read-failed', source.normalized, 'read', error))
      continue
    }

    const decoded = decodeContent(buffer, source.normalized)
    if (decoded.error) {
      scanErrors.push(decoded.error)
      continue
    }
    if (decoded.binary) {
      binaryFiles += 1
      continue
    }
    textFiles += 1
    const publishedLocations = entry.publishedPaths.length > 0
      ? entry.publishedPaths
      : [{ channel: 'source', path: source.normalized }]

    for (const published of publishedLocations) {
      if (typeof published?.path !== 'string' || typeof published?.channel !== 'string') {
        scanErrors.push(scanError('invalid-inventory-entry', source.normalized, 'validate published file', new Error('Published file path must specify channel and path')))
        continue
      }
      let publishedPath
      try {
        publishedPath = validateRelativePath(root, published.path).normalized
      } catch (error) {
        scanErrors.push(scanError('invalid-published-path', published.path, 'validate published file', error))
        continue
      }
      const lineRules = rules.filter(({ name }) => name !== 'product-terminology')
      decoded.text.split(/\r\n|\r|\n/).forEach((line, index) => {
        addFindings(findings, line, {
          file: publishedPath,
          exceptionFile: source.normalized,
          line: index + 1,
          locationKind: 'content',
          context: line.trim(),
          text: line.trim().slice(0, 160),
        }, lineRules, exceptions)
      })
      addTerminologyFindings(findings, decoded.text, {
        file: publishedPath,
        exceptionFile: source.normalized,
        locationKind: 'content',
      }, rules, exceptions)
    }
  }

  if (uniquePaths.size === 0 || visitedSources.size === 0 || textFiles === 0) {
    scanErrors.push({
      rule: 'empty-coverage',
      file: '',
      operation: 'validate coverage',
      code: 'EMPTY_COVERAGE',
      message: `Distribution scan requires published paths and text files; found ${uniquePaths.size} path(s), ${visitedSources.size} input file(s), and ${textFiles} text file(s).`,
    })
  }

  const deduplicatedFindings = [...new Map(findings.map((finding) => [
    `${finding.severity}\0${finding.rule}\0${finding.file}\0${finding.line ?? 'path'}\0${finding.match}`,
    finding,
  ])).values()]

  return {
    findings: deduplicatedFindings,
    scanErrors,
    coverage: { textFiles, binaryFiles, publishedPaths: uniquePaths.size },
  }
}

export function formatResult(result) {
  const blockers = result.findings.filter(({ severity }) => severity === 'BLOCKER')
  const warnings = result.findings.filter(({ severity }) => severity === 'WARNING')
  const stdout = [
    `Confidentiality scan: ${blockers.length} blocker(s), ${warnings.length} warning(s), ${result.scanErrors.length} scan error(s); `
    + `${result.coverage.textFiles} text file(s) inspected, ${result.coverage.binaryFiles} binary file(s) not inspected, `
    + `${result.coverage.publishedPaths} published path(s) checked.`,
  ]
  const stderr = []

  for (const finding of result.findings) {
    const location = finding.line === undefined ? `${finding.file} (path)` : `${finding.file}:${finding.line}`
    stderr.push(`  [${finding.severity}] ${location} (${finding.rule}) matched "${finding.match}"`)
    if (finding.text) stderr.push(`      ${finding.text}`)
    if (finding.rule === 'product-terminology') stderr.push('      Use AMR/ACRE product names; verify the context before editing.')
  }
  for (const error of result.scanErrors) {
    stderr.push(`  [SCAN ERROR] ${error.operation} ${error.file || '(distribution inventory)'} (${error.rule}, ${error.code}): ${error.message}`)
  }

  if (blockers.length === 0 && result.scanErrors.length === 0) {
    stdout.push('No blocking patterns detected in inspected distribution content; manual disclosure review is still required.')
    if (warnings.length > 0) stderr.push('Warnings remain and require manual review.')
  }
  stdout.push('Binary contents and arbitrary semantic disclosures are not certified.')
  return {
    exitCode: blockers.length > 0 || result.scanErrors.length > 0 ? 1 : 0,
    stdout: `${stdout.join('\n')}\n`,
    stderr: stderr.length > 0 ? `${stderr.join('\n')}\n` : '',
  }
}

function printResult(result) {
  const report = formatResult(result)
  process.stdout.write(report.stdout)
  process.stderr.write(report.stderr)
  return report.exitCode
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = printResult(scanDistribution())
}
