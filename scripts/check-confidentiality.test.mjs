import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { formatResult, scanDistribution } from './check-confidentiality.mjs'

function createRoot(t, prefix = 'amr-confidentiality-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function write(root, path, content) {
  const fullPath = join(root, path)
  mkdirSync(join(fullPath, '..'), { recursive: true })
  writeFileSync(fullPath, content)
}

function inventory(sourcePath, publishedPath = sourcePath) {
  return {
    files: [{ sourcePath, publishedPaths: [{ channel: 'npm', path: publishedPath }] }],
    publishedPaths: [{ channel: 'npm', path: publishedPath }],
  }
}

function syntheticRule() {
  return { severity: 'BLOCKER', name: 'synthetic-blocker', re: /SYNTHETIC_BLOCK/ }
}

test('ordinary public source references are warnings, not blockers', (t) => {
  const root = createRoot(t)
  write(root, 'skills/example/SKILL.md', 'Save the sample as Program.cs.\nSee samples/example.cs:12.\n')

  const result = scanDistribution(root, {
    inventory: () => inventory('skills/example/SKILL.md'),
  })

  assert.deepEqual(result.findings.map(({ severity, rule, line }) => ({ severity, rule, line })), [
    { severity: 'WARNING', rule: 'internal-source-file', line: 1 },
    { severity: 'WARNING', rule: 'internal-source-path-line', line: 2 },
  ])
  assert.deepEqual(result.scanErrors, [])
  assert.deepEqual(result.coverage, { textFiles: 1, binaryFiles: 0, publishedPaths: 1 })
})

test('product-generation shorthand is a blocker while approved names are allowed', (t) => {
  const root = createRoot(t)
  write(root, 'skills/example/SKILL.md', 'Use AMR or ACRE, not gen1, GEN 2, Gen 1, or gen-2 terminology.\n')

  const result = scanDistribution(root, {
    inventory: () => inventory('skills/example/SKILL.md'),
  })

  assert.equal(result.findings.filter(({ rule }) => rule === 'product-terminology').length, 4)
  assert.ok(result.findings.every(({ severity }) => severity === 'BLOCKER'))
})

test('narrow terminology exceptions preserve neighboring product blockers', (t) => {
  const root = createRoot(t)
  const context = 'A VM Gen 1 host may run a product Gen 2 cache.'
  write(root, 'skills/example/SKILL.md', `${context}\n`)

  const result = scanDistribution(root, {
    inventory: () => inventory('skills/example/SKILL.md'),
    exceptions: [{
      file: 'skills/example/SKILL.md',
      rule: 'product-terminology',
      match: 'Gen 1',
      context,
      occurrence: 1,
      reason: 'Describes a virtual machine generation, not a product generation.',
    }],
  })

  assert.deepEqual(result.findings.filter(({ rule }) => rule === 'product-terminology').map(({ match }) => match), ['Gen 2'])
})

test('terminology matches across LF and CRLF lines with accurate starting lines', (t) => {
  for (const newline of ['\n', '\r\n']) {
    const root = createRoot(t)
    const content = `First line${newline}Use Gen${newline}1 for this product.${newline}Another Gen 2 product.`
    write(root, 'skills/example/SKILL.md', content)

    const result = scanDistribution(root, {
      inventory: () => inventory('skills/example/SKILL.md'),
    })

    assert.deepEqual(
      result.findings.filter(({ rule }) => rule === 'product-terminology').map(({ line }) => line),
      [2, 4],
    )
  }
})

test('a precise multiline exception does not suppress a neighboring terminology blocker', (t) => {
  for (const newline of ['\n', '\r\n']) {
    const root = createRoot(t)
    const context = `Use Gen${newline}1 for the unrelated VM generation.`
    write(root, 'skills/example/SKILL.md', `${context}${newline}A Gen 2 product is not an allowed name.`)

    const result = scanDistribution(root, {
      inventory: () => inventory('skills/example/SKILL.md'),
      exceptions: [{
        file: 'skills/example/SKILL.md',
        rule: 'product-terminology',
        match: `Gen${newline}1`,
        context,
        occurrence: 1,
        reason: 'Describes a VM generation, not a product generation.',
      }],
    })

    assert.deepEqual(result.findings.filter(({ rule }) => rule === 'product-terminology').map(({ match, line }) => ({ match, line })), [
      { match: 'Gen 2', line: 3 },
    ])
  }
})

test('distributed text surfaces and published filenames are scanned independently', (t) => {
  const root = createRoot(t, 'SYNTHETIC_BLOCK-parent-')
  write(root, 'docs/index.html', '<p>SYNTHETIC_BLOCK</p>\n')
  write(root, 'plugin.json', '{"description":"SYNTHETIC_BLOCK"}\n')
  write(root, 'packages/build-tool/example.py', 'print("SYNTHETIC_BLOCK")\n')
  write(root, 'skills/example/SKILL.md', 'Clean public content.\n')
  const files = [
    { sourcePath: 'docs/index.html', publishedPaths: [{ channel: 'npm', path: 'docs/index.html' }] },
    { sourcePath: 'plugin.json', publishedPaths: [{ channel: 'npm', path: 'plugin.json' }] },
    { sourcePath: 'packages/build-tool/example.py', publishedPaths: [{ channel: 'npm', path: 'packages/build-tool/example.py' }] },
    { sourcePath: 'skills/example/SKILL.md', publishedPaths: [{ channel: 'npm', path: 'skills/SYNTHETIC_BLOCK/SKILL.md' }] },
  ]

  const result = scanDistribution(root, {
    inventory: () => ({
      files,
      publishedPaths: files.flatMap(({ publishedPaths }) => publishedPaths),
    }),
    rules: [syntheticRule()],
  })

  assert.equal(result.findings.filter(({ rule }) => rule === 'synthetic-blocker').length, 4)
  const pathFinding = result.findings.find(({ locationKind }) => locationKind === 'path')
  assert.equal(pathFinding.file, 'skills/SYNTHETIC_BLOCK/SKILL.md')
  assert.equal(pathFinding.line, undefined)
})

test('a source-reference warning does not hide an independent blocker', (t) => {
  const root = createRoot(t)
  write(root, 'skills/example/SKILL.md', 'Program.cs SYNTHETIC_BLOCK\n')

  const result = scanDistribution(root, {
    inventory: () => inventory('skills/example/SKILL.md'),
    rules: [
      { severity: 'WARNING', name: 'internal-source-file', re: /\b[A-Z][A-Za-z0-9]+\.(cs|cpp|hpp)\b/ },
      syntheticRule(),
    ],
  })

  assert.ok(result.findings.some(({ severity, rule }) => severity === 'WARNING' && rule === 'internal-source-file'))
  assert.ok(result.findings.some(({ severity, rule }) => severity === 'BLOCKER' && rule === 'synthetic-blocker'))
})

test('warnings remain visible without failing and blockers or scan errors fail', () => {
  const warningReport = formatResult({
    findings: [{ severity: 'WARNING', rule: 'internal-source-file', file: 'skills/example/SKILL.md', line: 1, match: 'Program.cs' }],
    scanErrors: [],
    coverage: { textFiles: 1, binaryFiles: 0, publishedPaths: 1 },
  })
  const blockerReport = formatResult({
    findings: [{ severity: 'BLOCKER', rule: 'synthetic-blocker', file: 'skills/example/SKILL.md', line: 1, match: 'SYNTHETIC_BLOCK' }],
    scanErrors: [],
    coverage: { textFiles: 1, binaryFiles: 0, publishedPaths: 1 },
  })
  const errorReport = formatResult({
    findings: [],
    scanErrors: [{ rule: 'file-read-failed', operation: 'read', file: 'skills/example/SKILL.md', code: 'EIO', message: 'read failed' }],
    coverage: { textFiles: 0, binaryFiles: 0, publishedPaths: 1 },
  })

  assert.equal(warningReport.exitCode, 0)
  assert.match(warningReport.stderr, /Warnings remain/)
  assert.match(warningReport.stdout, /manual disclosure review is still required/)
  assert.doesNotMatch(`${warningReport.stdout}${warningReport.stderr}`, /no findings/i)
  assert.equal(blockerReport.exitCode, 1)
  assert.equal(errorReport.exitCode, 1)
})

test('scan errors and empty coverage are returned as blocking integrity failures', (t) => {
  const root = createRoot(t)
  write(root, 'skills/example/SKILL.md', 'Public guidance.\n')

  const readFailures = ['EACCES', 'EIO'].map((code) => scanDistribution(root, {
    inventory: () => inventory('skills/example/SKILL.md'),
    readFile: () => {
      const error = new Error('injected read failure')
      error.code = code
      throw error
    },
  }))
  const empty = scanDistribution(root, { inventory: () => ({ files: [], publishedPaths: [] }) })

  assert.ok(readFailures.every((result) => result.scanErrors.some(({ rule }) => rule === 'file-read-failed')))
  assert.deepEqual(readFailures.map(({ scanErrors }) => scanErrors[0].code), ['EACCES', 'EIO'])
  assert.equal(readFailures[0].coverage.textFiles, 0)
  assert.ok(empty.scanErrors.some(({ rule }) => rule === 'empty-coverage'))

  const inventoryFailure = scanDistribution(root, {
    inventory: () => { throw Object.assign(new Error('enumeration failed'), { code: 'EIO' }) },
  })
  assert.equal(inventoryFailure.scanErrors[0].rule, 'inventory-failed')
  assert.equal(inventoryFailure.coverage.publishedPaths, 0)
})

test('inventory paths cannot escape the explicit scan root', (t) => {
  const root = createRoot(t)
  const result = scanDistribution(root, {
    inventory: () => ({
      files: [{ sourcePath: '../outside.txt', publishedPaths: [] }],
      publishedPaths: [{ channel: 'npm', path: '../outside.txt' }],
    }),
  })

  assert.ok(result.scanErrors.some(({ rule }) => rule === 'invalid-published-path'))
  assert.ok(result.scanErrors.some(({ rule }) => rule === 'invalid-source-path'))
})

test('binary paths are checked and malformed known text is a scan error', (t) => {
  const root = createRoot(t)
  write(root, 'skills/example/image.png', 'placeholder')
  write(root, 'skills/example/broken.md', 'placeholder')
  write(root, 'LICENSE', 'placeholder')
  write(root, 'NOTICE.md', 'placeholder')
  const entries = [
    { sourcePath: 'skills/example/image.png', publishedPaths: [{ channel: 'npm', path: 'skills/example/image.png' }] },
    { sourcePath: 'skills/example/broken.md', publishedPaths: [{ channel: 'npm', path: 'skills/example/broken.md' }] },
    { sourcePath: 'LICENSE', publishedPaths: [{ channel: 'npm', path: 'LICENSE' }] },
    { sourcePath: 'NOTICE.md', publishedPaths: [{ channel: 'npm', path: 'NOTICE.md' }] },
  ]

  const result = scanDistribution(root, {
    inventory: () => ({
      files: entries,
      publishedPaths: entries.flatMap(({ publishedPaths }) => publishedPaths),
    }),
    readFile: (path) => {
      if (path.endsWith('image.png')) return Buffer.from([0, 1, 2])
      if (path.endsWith('NOTICE.md')) return Buffer.from('Notice\u0001')
      return Buffer.from([0xc3, 0x28])
    },
  })

  assert.equal(result.coverage.binaryFiles, 1)
  assert.equal(result.scanErrors.filter(({ rule }) => rule === 'invalid-text-encoding').length, 2)
  assert.ok(result.scanErrors.some(({ rule }) => rule === 'invalid-text-content'))
  assert.equal(result.coverage.publishedPaths, 4)
})

test('CLI resolves its root from the script when invoked outside the repository', (t) => {
  const root = createRoot(t)
  const script = resolve(dirname(fileURLToPath(import.meta.url)), 'check-confidentiality.mjs')
  const fromRepository = spawnSync(process.execPath, [script], { cwd: process.cwd(), encoding: 'utf8' })
  const fromElsewhere = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' })
  const summary = /^Confidentiality scan: .*$/m

  assert.match(fromRepository.stdout, summary)
  assert.match(fromElsewhere.stdout, summary)
  assert.equal(fromElsewhere.stdout.match(summary)[0], fromRepository.stdout.match(summary)[0])
})
