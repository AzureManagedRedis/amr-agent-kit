import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { writeJanitorHeartbeat } from '../../src/cache/janitor.mjs'
import { checkResourceJanitorReadiness } from '../../src/integration/resource-janitor-readiness.mjs'

test('requires fresh heartbeat matching the exact SystemProcessManager identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'resource-janitor-ready-'))
  const startedAt = '2026-07-17T00:00:00.000Z'
  const identity = {
    pid: 4242,
    startedAt,
    name: 'node.exe',
    executablePath: 'C:\\node\\node.exe',
    commandLineHash: 'command-hash',
  }
  const configPath = path.join(root, 'config.json')
  await writeFile(path.join(root, 'pids.json'), JSON.stringify({ resourceJanitor: identity }))
  await writeFile(configPath, JSON.stringify({
    integration: { liveCache: { janitorIntervalMs: 1000 } },
  }))
  const manager = { async identify() { return identity } }
  try {
    writeJanitorHeartbeat(path.join(root, 'resource-janitor.heartbeat.json'), {
      identity: {
        pid: identity.pid,
        startedAt: Date.parse(startedAt),
        name: identity.name,
        executablePath: identity.executablePath,
        commandHash: identity.commandLineHash,
      },
      now: () => 10_000,
    })
    assert.equal((await checkResourceJanitorReadiness({
      runDir: root,
      configPath,
      processManager: manager,
      now: () => 11_000,
    })).ready, true)
    assert.equal((await checkResourceJanitorReadiness({
      runDir: root,
      configPath,
      processManager: manager,
      now: () => 14_001,
    })).ready, false)
    assert.equal((await checkResourceJanitorReadiness({
      runDir: root,
      configPath,
      processManager: {
        async identify() {
          return { ...identity, startedAt: '2026-07-17T00:01:00.000Z' }
        },
      },
      now: () => 11_000,
    })).ready, false)
    writeJanitorHeartbeat(path.join(root, 'resource-janitor.heartbeat.json'), {
      identity: {
        pid: identity.pid,
        startedAt: Date.parse(startedAt) + 60_000,
        name: identity.name,
        executablePath: identity.executablePath,
        commandHash: identity.commandLineHash,
      },
      now: () => 10_500,
    })
    assert.equal((await checkResourceJanitorReadiness({
      runDir: root,
      configPath,
      processManager: manager,
      now: () => 11_000,
    })).ready, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
