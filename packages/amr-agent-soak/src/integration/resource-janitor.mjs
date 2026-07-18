#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  KillSwitch,
  LeaseManager,
  ResourceLedger,
  loadRuntimeConfig,
  startJanitor,
} from '../cache/index.mjs'

function option(args, name) {
  const index = args.indexOf(name)
  if (index < 0 || !args[index + 1]) throw new Error(`Missing required option ${name}`)
  return args[index + 1]
}

async function main() {
  const args = process.argv.slice(2)
  const configPath = path.resolve(option(args, '--config'))
  const runDir = path.resolve(option(args, '--run-dir'))
  const controllerConfig = JSON.parse(await readFile(configPath, 'utf8'))
  const live = controllerConfig.integration?.liveCache
  if (live?.enabled !== true) throw new Error('Resource janitor cannot start unless integration.liveCache.enabled=true')
  if (!live.runtimeConfigPath || !live.adapterModule) {
    throw new Error('Live cache mode requires runtimeConfigPath and an ARM-shaped adapterModule')
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
  const adapterModulePath = path.isAbsolute(live.adapterModule)
    ? live.adapterModule
    : path.resolve(repositoryRoot, live.adapterModule)
  const adapterModule = await import(pathToFileURL(adapterModulePath).href)
  if (typeof adapterModule.createLocalRpAdapter !== 'function') {
    throw new Error(`${adapterModulePath} does not export createLocalRpAdapter`)
  }
  const adapter = await adapterModule.createLocalRpAdapter({
    runtimeConfig,
    controllerConfig,
    runDir,
  })
  for (const method of ['listCaches', 'getCache', 'deleteCache']) {
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
  await startJanitor({
    pidFilePath: path.join(runDir, 'resource-janitor.pid'),
    heartbeatFilePath: path.join(runDir, 'resource-janitor.heartbeat.json'),
    evidencePath: path.join(runDir, 'resource-janitor.evidence.json'),
    ledger,
    adapter,
    config: runtimeConfig,
    leaseManager,
    killSwitch,
    intervalMs: Number(live.janitorIntervalMs ?? 30_000),
    signal: cancellation.signal,
  })
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
