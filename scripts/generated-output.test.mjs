import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const outputs = ['skills/redis-code/AGENTS.md', 'skills/azure-redis-infra/AGENTS.md']

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'amr-generated-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  git(root, 'init', '--quiet')
  for (const path of outputs) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), 'Generated rule index.\n')
  }
  git(root, 'add', '.')
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', 'Fixture')
  return root
}

for (const workflow of ['release', 'validate']) {
  const source = readFileSync(new URL(`../.github/workflows/${workflow}.yml`, import.meta.url), 'utf8')
  const command = source.match(/- name: Check generated output is current\s+run: ([^\r\n]+)/)?.[1]
  assert.ok(command, `${workflow} must check generated output`)
  const check = (root) => {
    const result = spawnSync(command, { cwd: root, encoding: 'utf8', shell: true })
    assert.ifError(result.error)
    return result.status
  }

  test(`${workflow}: accepts fresh tracked output and unrelated untracked files`, (t) => {
    const root = fixture(t)
    writeFileSync(join(root, 'unrelated.txt'), 'Not generated.\n')
    assert.equal(check(root), 0)
  })

  test(`${workflow}: rejects modified generated output`, (t) => {
    const root = fixture(t)
    writeFileSync(join(root, outputs[0]), 'Stale index.\n')
    assert.notEqual(check(root), 0)
  })

  test(`${workflow}: rejects output recreated by the build but missing from the source commit`, (t) => {
    const root = fixture(t)
    git(root, 'rm', '--cached', '--', outputs[1])
    git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false',
      'commit', '--quiet', '-m', 'Omit generated output')
    assert.notEqual(check(root), 0)
  })

  test(`${workflow}: rejects staged generated changes`, (t) => {
    const root = fixture(t)
    writeFileSync(join(root, outputs[0]), 'Staged index.\n')
    git(root, 'add', '--', outputs[0])
    assert.notEqual(check(root), 0)
  })
}
