#!/usr/bin/env node
/**
 * Confidentiality gate for AMR Agent Kit.
 *
 * The shipped skills must state WHAT is expected and what works/does not, but must never
 * reveal or let anyone reconstruct the INTERNAL implementation. This check fails the build
 * if customer-facing / public-on-branch content contains internal source identifiers,
 * source path:line citations, internal error constants, or "why-level" enforcement wording.
 *
 * Public API facts (minimumTlsVersion, clusteringPolicy, port 10000, DB0, etc.) and public
 * Azure/Redis docs behavior are allowed. Lowercase "allowlist" prose is allowed; the internal
 * CamelCase constants are not.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, sep, relative } from 'node:path'

const repoRoot = process.cwd()

// Surfaces to gate: shipped package content + content made public on the branch.
const SCAN_DIRS = ['skills', 'docs', 'evals', 'samples']
const SCAN_ROOT_FILES = ['README.md', 'GEMINI.md', 'CONTRIBUTING.md', 'CHANGELOG.md']
const SCAN_EXT = new Set(['.md', '.json', '.yaml', '.yml'])

// Never scan these (intentional leak-detector fixtures live under the soak package tests,
// and generated/vendored trees are irrelevant to the shipped surface).
const EXCLUDE = ['node_modules', `${sep}.git${sep}`, `packages${sep}`]

const RULES = [
  { severity: 'BLOCKER', name: 'internal-flag-abbrev', re: /\b(mkms|mkss|bdb_[a-z_]+)\b/ },
  { severity: 'BLOCKER', name: 'internal-env-or-allowlist', re: /RE_GEO_REPLICATION_CLUSTER_LIMIT|AllowedSubscriptionsForCacheConfigHacks|\b[A-Z][A-Za-z0-9]*AllowList\b/ },
  { severity: 'BLOCKER', name: 'internal-symbol', re: /\b(ClusterRequestValidations|DatabaseRequestValidations|DatabaseControllerBase|EnterpriseSkus|ModuleValidator|RedisLabsProbe|ClusterManager|CurrentStatusExtensions|ConfigureEnterpriseCluster)\b/ },
  { severity: 'BLOCKER', name: 'internal-component', re: /\b(dmcproxy|crdt_module|client_state|sharding_plugin|one2many_transaction|RedisRP|RLabs)\b/ },
  { severity: 'BLOCKER', name: 'internal-source-path-line', re: /[\w./\\-]+\.(cs|cpp|hpp|h|go|py|c):\d+/ },
  { severity: 'BLOCKER', name: 'internal-source-file', re: /\b[A-Z][A-Za-z0-9]+\.(cs|cpp|hpp)\b/ },
  { severity: 'BLOCKER', name: 'internal-error-constant', re: /\bError_[A-Z]\w+/ },
  { severity: 'BLOCKER', name: 'why-level-enforcement', re: /hard engine constant|config-driven limit|migration-only exception|compiled-in\b|the validating component|internal migration path/i },
]

function walk(dir, out) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (EXCLUDE.some((ex) => full.includes(ex))) continue
    if (entry.isDirectory()) {
      walk(full, out)
    } else {
      const dot = entry.name.lastIndexOf('.')
      if (dot >= 0 && SCAN_EXT.has(entry.name.slice(dot))) out.push(full)
    }
  }
}

const files = []
for (const d of SCAN_DIRS) walk(join(repoRoot, d), files)
for (const f of SCAN_ROOT_FILES) {
  const full = join(repoRoot, f)
  try {
    if (statSync(full).isFile()) files.push(full)
  } catch {
    /* optional file */
  }
}

const findings = []
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      const m = line.match(rule.re)
      if (m) {
        findings.push({
          file: relative(repoRoot, file),
          line: i + 1,
          rule: rule.name,
          severity: rule.severity,
          match: m[0],
          text: line.trim().slice(0, 160),
        })
      }
    }
  })
}

console.log(`Confidentiality gate: scanned ${files.length} files across ${SCAN_DIRS.join(', ')} + shipped root docs.`)

if (findings.length === 0) {
  console.log('✓ No internal identifiers, source path:line citations, internal error constants, or why-level enforcement wording found.')
  process.exit(0)
}

console.error(`\n✗ ${findings.length} confidentiality finding(s):\n`)
for (const f of findings) {
  console.error(`  [${f.severity}] ${f.file}:${f.line} (${f.rule}) matched "${f.match}"`)
  console.error(`      ${f.text}`)
}
console.error('\nState observable behavior and public API/doc facts only. Do not name internal source, symbols, error constants, or enforcement mechanisms.')
process.exit(1)
