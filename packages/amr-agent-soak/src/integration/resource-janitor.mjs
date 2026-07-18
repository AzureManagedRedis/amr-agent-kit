#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  KillSwitch,
  LeaseManager,
  ResourceLedger,
  loadRuntimeConfig,
  startJanitor,
  readJanitorIdentity,
} from '../cache/index.mjs'
import { assertLiveRuntimeConfig } from './live-runtime.mjs'

function option(args, name) {
  const index = args.indexOf(name)
  if (index < 0 || !args[index + 1]) throw new Error(`Missing required option ${name}`)
  return args[index + 1]
}

function toClaimIdentity(identity) {
  const startedAt = Date.parse(identity.startedAt)
  return {
    pid: identity.pid,
    startedAt: Number.isFinite(startedAt) ? startedAt : identity.startedAt,
    name: identity.name,
    executablePath: identity.executablePath,
    ...(identity.commandLineHash ? { commandHash: identity.commandLineHash } : {}),
  }
}

export async function resolveJanitorClaim(identityFilePath, processManager) {
  const own = toClaimIdentity(await processManager.identify(process.pid))
  const existing = readJanitorIdentity(identityFilePath)
  let resolvedExisting = null
  if (existing && typeof existing.pid === 'number') {
    try {
      resolvedExisting = toClaimIdentity(await processManager.identify(existing.pid))
    } catch {
      resolvedExisting = null
    }
  }
  return {
    identity: own,
    resolveIdentity(pid) {
      if (pid === own.pid) return own
      if (existing?.pid === pid) return resolvedExisting
      return null
    },
  }
}

export async function main() {
  const args = process.argv.slice(2)
  const configPath = path.resolve(option(args, '--config'))
  const runDir = path.resolve(option(args, '--run-dir'))
  const controllerConfig = JSON.parse(await readFile(configPath, 'utf8'))
  const live = controllerConfig.integration?.liveCache
  if (live?.enabled !== true) throw new Error('Resource janitor cannot start unless integration.liveCache.enabled=true')
  if (live.reviewedReady !== true) {
    throw new Error('Resource janitor remains blocked until integration.liveCache.reviewedReady=true after review clearance')
  }
  if (!live.runtimeConfigPath) {
    throw new Error('Live cache mode requires runtimeConfigPath')
  }
  const repositoryRoot = path.resolve(controllerConfig.repositoryRoot)
  const runtimeConfigPath = path.isAbsolute(live.runtimeConfigPath)
    ? live.runtimeConfigPath
    : path.resolve(repositoryRoot, live.runtimeConfigPath)
  const runtimeConfig = loadRuntimeConfig({
    ...process.env,
    AMR_SOAK_RUNTIME_CONFIG_PATH: runtimeConfigPath,
    AMR_SOAK_RUN_ID: controllerConfig.runId,
    AMR_SOAK_LEDGER_PATH: path.join(runDir, 'resource-ledger.jsonl'),
    AMR_SOAK_KILL_SWITCH_PATH: path.join(runDir, 'KILL-SWITCH'),
  })
  if (runtimeConfig.runId !== controllerConfig.runId) throw new Error('Runtime cache config runId does not match controller runId')
  assertLiveRuntimeConfig(runtimeConfig)
  const configuredAdapter = live.adapterModule ??
    'packages/amr-agent-soak/src/cache/http-adapter.mjs'
  const adapterModulePath = path.isAbsolute(configuredAdapter)
    ? configuredAdapter
    : path.resolve(repositoryRoot, configuredAdapter)
  const adapterModule = await import(pathToFileURL(adapterModulePath).href)
  const adapter = typeof adapterModule.createLocalRpAdapter === 'function'
    ? await adapterModule.createLocalRpAdapter({ runtimeConfig, controllerConfig, runDir })
    : typeof adapterModule.LocalRpHttpAdapter === 'function'
      ? new adapterModule.LocalRpHttpAdapter({ apiVersion: runtimeConfig.apiVersion })
      : null
  if (!adapter) {
    throw new Error(`${adapterModulePath} must export LocalRpHttpAdapter or createLocalRpAdapter`)
  }
  for (const method of ['listClusters', 'getCluster', 'deleteCluster']) {
    if (typeof adapter?.[method] !== 'function') throw new Error(`ARM-shaped adapter is missing ${method}()`)
  }
  const ledger = new ResourceLedger({ path: path.join(runDir, 'resource-ledger.jsonl') })
  const killSwitch = new KillSwitch({ path: path.join(runDir, 'KILL-SWITCH') })
  const leaseManager = new LeaseManager({
    killSwitch,
    fencingStatePath: path.join(runDir, 'resource-fencing.json'),
  })
  const cancellation = new AbortController()
  process.once('SIGTERM', () => cancellation.abort())
  process.once('SIGINT', () => cancellation.abort())
  const { SystemProcessManager } = await import('../../dist/src/core/process.js')
  const identityPath = path.join(runDir, 'resource-janitor.pid')
  const claim = await resolveJanitorClaim(identityPath, new SystemProcessManager())
  await startJanitor({
    pidFilePath: identityPath,
    heartbeatFilePath: path.join(runDir, 'resource-janitor.heartbeat.json'),
    evidencePath: path.join(runDir, 'resource-janitor.evidence.json'),
    ledger,
    adapter,
    config: runtimeConfig,
    leaseManager,
    killSwitch,
    intervalMs: Number(live.janitorIntervalMs ?? 30_000),
    signal: cancellation.signal,
    identity: claim.identity,
    resolveIdentity: claim.resolveIdentity,
  })
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
