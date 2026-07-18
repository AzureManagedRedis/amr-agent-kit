#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isJanitorHeartbeatReady } from '../cache/janitor.mjs'

function toHeartbeatIdentity(identity) {
  const startedAt = Date.parse(identity.startedAt)
  return {
    pid: identity.pid,
    startedAt: Number.isFinite(startedAt) ? startedAt : identity.startedAt,
    name: identity.name,
    executablePath: identity.executablePath,
    ...(identity.commandLineHash ? { commandHash: identity.commandLineHash } : {}),
  }
}

export async function checkResourceJanitorReadiness({
  runDir,
  configPath,
  processManager,
  now = () => Date.now(),
}) {
  const [pidRecord, controllerConfig] = await Promise.all([
    readFile(path.join(runDir, 'pids.json'), 'utf8').then(JSON.parse),
    readFile(configPath, 'utf8').then(JSON.parse),
  ])
  const expected = pidRecord.resourceJanitor
  if (!expected) return { ready: false, reason: 'resource janitor identity is missing' }
  let current
  try {
    current = await processManager.identify(expected.pid)
  } catch {
    return { ready: false, reason: 'resource janitor process is not running' }
  }
  const { identityMatches } = await import('../../dist/src/core/process.js')
  if (!identityMatches(expected, current)) {
    return { ready: false, reason: 'resource janitor process identity changed' }
  }
  const intervalMs = Number(
    controllerConfig.integration?.liveCache?.janitorIntervalMs ?? 30_000,
  )
  const maxAgeMs = Math.max(1_000, intervalMs * 3)
  const ready = isJanitorHeartbeatReady(
    path.join(runDir, 'resource-janitor.heartbeat.json'),
    {
      identity: toHeartbeatIdentity(current),
      now,
      maxAgeMs,
    },
  )
  return {
    ready,
    reason: ready ? undefined : 'resource janitor heartbeat is stale or identity-mismatched',
    identity: current,
    maxAgeMs,
  }
}

function option(args, name) {
  const index = args.indexOf(name)
  if (index < 0 || !args[index + 1]) throw new Error(`Missing required option ${name}`)
  return args[index + 1]
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const { SystemProcessManager } = await import('../../dist/src/core/process.js')
  checkResourceJanitorReadiness({
    runDir: path.resolve(option(process.argv, '--run-dir')),
    configPath: path.resolve(option(process.argv, '--config')),
    processManager: new SystemProcessManager(),
  }).then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`)
      if (!result.ready) process.exitCode = 1
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      process.exitCode = 1
    },
  )
}
