import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { claimJanitorIdentity } from '../../src/cache/janitor.mjs'
import { resolveJanitorClaim } from '../../src/integration/resource-janitor.mjs'

test('resolves structured identities before claiming the resource-janitor file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'resource-janitor-identity-'))
  const identityPath = path.join(root, 'resource-janitor.pid')
  await writeFile(identityPath, JSON.stringify({
    pid: 999,
    startedAt: 1,
    name: 'old-node.exe',
    executablePath: 'C:\\old\\node.exe',
  }))
  const ownStartedAt = '2026-07-17T00:00:00.000Z'
  const manager = {
    async identify(pid) {
      if (pid === process.pid) {
        return {
          pid,
          startedAt: ownStartedAt,
          name: 'node.exe',
          executablePath: 'C:\\node\\node.exe',
          commandLineHash: 'own-command',
        }
      }
      return {
        pid,
        startedAt: '2026-07-17T01:00:00.000Z',
        name: 'other.exe',
        executablePath: 'C:\\other\\other.exe',
      }
    },
  }
  try {
    const claim = await resolveJanitorClaim(identityPath, manager)
    assert.equal(claim.identity.pid, process.pid)
    assert.equal(claim.identity.startedAt, Date.parse(ownStartedAt))
    assert.equal(claim.identity.commandHash, 'own-command')
    assert.equal(claim.resolveIdentity(999).name, 'other.exe')
    claimJanitorIdentity(identityPath, claim)
    const stored = JSON.parse(await readFile(identityPath, 'utf8'))
    assert.equal(stored.pid, process.pid)
    assert.equal(stored.commandHash, 'own-command')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
