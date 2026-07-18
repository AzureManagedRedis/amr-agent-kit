import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { runSoak } from '../../dist/src/core/controller.js'
import { createSoakModules } from '../../src/integration/runtime.mjs'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

function capabilities() {
  return {
    executablePath: 'fake-copilot',
    executableHash: 'fake',
    version: 'preflight',
    helpHash: 'fake',
    supportsPrompt: true,
    supportsJsonOutput: true,
    supportsNoAskUser: true,
    supportsToolApproval: true,
    supportsInstructionDisable: true,
    supportsMcpDisable: true,
    supportsNoRemote: true,
    supportsNoRemoteExport: true,
    supportsNoAutoUpdate: true,
    supportsStreamControl: true,
  }
}

const processManager = {
  async identify(pid) {
    return { pid, startedAt: '2026-01-01T00:00:00.000Z', name: 'node' }
  },
  async snapshot() { return [] },
  async isRunning() { return false },
  async terminateTree() { return { discovered: [], killed: [], skipped: [] } },
}

test('runs the integrated registry, grader, retention, and reporter through the core controller', async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'amr-soak-controller-'))
  const config = {
    runId: 'integration-controller',
    repositoryRoot: repoRoot,
    outputRoot,
    skillSnapshotPath: path.join(repoRoot, 'skills', 'redis-code'),
    concurrency: 12,
    repetitions: 2,
    durationHours: 1,
    timeoutMinutes: 1,
    heartbeatSeconds: 0.05,
    model: 'fake',
    integration: {
      targetSkill: 'redis-code',
      scenarioIds: ['scn-connection-auth-tls-entra'],
      executionCache: { enabled: false },
      evidence: { required: false, hooks: [] },
      liveCache: { enabled: false },
    },
  }
  try {
    const integrated = await createSoakModules({ config, processManager })
    const executor = {
      async probe() { return capabilities() },
      async execute(request) {
        const good = request.scenario.metadata.graderCanaries.find((item) => item.expected_grade === 'pass').answer_excerpt
        const bad = request.scenario.metadata.graderCanaries.find((item) => item.expected_grade === 'fail').answer_excerpt
        const responseText = request.arm === 'with-skill' ? good : bad
        const now = new Date().toISOString()
        return {
          soakRunId: config.runId,
          executionId: request.executionId,
          scenarioId: request.scenario.id,
          arm: request.arm,
          status: 'completed',
          startedAt: now,
          finishedAt: now,
          responseText,
          events: [],
          trace: {
            executablePath: 'fake',
            executableHash: 'fake',
            args: [],
            cwd: request.workspace.projectDir,
            pid: process.pid,
            processIdentity: await processManager.identify(process.pid),
            descendants: [],
            startedAt: now,
            finishedAt: now,
            exitCode: 0,
            signal: null,
            timedOut: false,
            cancelled: false,
            stdoutFile: '',
            stderrFile: '',
            projectHashBefore: request.workspace.projectHash,
            projectHashAfter: request.workspace.projectHash,
            profileHashBefore: request.workspace.profileHash,
            profileHashAfter: request.workspace.profileHash,
            contamination: [],
          },
        }
      },
    }
    const summary = await runSoak(config, { ...integrated, executor, processManager })
    assert.equal(summary.status, 'completed')
    assert.equal(summary.completedPairs, 2)
    const integrationSummary = JSON.parse(
      await readFile(path.join(outputRoot, config.runId, 'integration-summary.json'), 'utf8'),
    )
    assert.equal(integrationSummary.retained_clients, 2)
    const artifactIndex = JSON.parse(
      await readFile(path.join(outputRoot, config.runId, 'client-artifact-index.json'), 'utf8'),
    )
    assert.equal(artifactIndex.complete, true)
  } finally {
    await rm(outputRoot, { recursive: true, force: true })
  }
})

test('fails closed when deterministic grading is used for a long or live run', async () => {
  const base = {
    runId: 'blocked-controller',
    repositoryRoot: repoRoot,
    outputRoot: path.join(os.tmpdir(), 'blocked-controller'),
    skillSnapshotPath: path.join(repoRoot, 'skills', 'redis-code'),
    repetitions: 3,
    durationHours: 48,
    integration: {
      targetSkill: 'redis-code',
      grading: { mode: 'deterministic-preflight' },
      liveCache: { enabled: false },
    },
  }
  await assert.rejects(
    () => createSoakModules({ config: base, processManager }),
    /Deterministic grading is preflight-only/,
  )
  await assert.rejects(
    () => createSoakModules({
      config: {
        ...base,
        repetitions: 1,
        durationHours: 1,
        integration: {
          ...base.integration,
          grading: { mode: 'external-blind', modulePath: 'local-blind-grader.mjs' },
          liveCache: { enabled: true },
        },
      },
      processManager,
    }),
    /runtimeConfigPath and an ARM-shaped adapterModule/,
  )
})

test('requires a reviewed module for external blind grading', async () => {
  await assert.rejects(
    () => createSoakModules({
      config: {
        runId: 'blind-controller',
        repositoryRoot: repoRoot,
        outputRoot: path.join(os.tmpdir(), 'blind-controller'),
        skillSnapshotPath: path.join(repoRoot, 'skills', 'redis-code'),
        repetitions: 3,
        durationHours: 48,
        integration: {
          targetSkill: 'redis-code',
          grading: { mode: 'external-blind' },
          liveCache: { enabled: false },
        },
      },
      processManager,
    }),
    /requires integration.grading.modulePath/,
  )
})

test('accepts only two distinct calibrated blind graders above the kappa gate', async () => {
  const modulePath = 'packages/amr-agent-soak/test/integration/fixtures/fake-blind-grader.mjs'
  const base = {
    runId: 'blind-calibration',
    repositoryRoot: repoRoot,
    outputRoot: path.join(os.tmpdir(), 'blind-calibration'),
    skillSnapshotPath: path.join(repoRoot, 'skills', 'redis-code'),
    repetitions: 3,
    durationHours: 48,
    integration: {
      targetSkill: 'redis-code',
      scenarioIds: ['scn-connection-auth-tls-entra'],
      grading: {
        mode: 'external-blind',
        modulePath,
        minimumKappa: 0.7,
      },
      liveCache: { enabled: false },
    },
  }
  const modules = await createSoakModules({ config: base, processManager })
  assert.deepEqual(modules.snapshot.graderInput.modelIds, ['model-a', 'model-b'])
  assert.equal(modules.snapshot.graderInput.kappa, 0.9)
  await assert.rejects(
    () => createSoakModules({
      config: {
        ...base,
        integration: {
          ...base.integration,
          grading: {
            ...base.integration.grading,
            testModelIds: ['same-model', 'same-model'],
          },
        },
      },
      processManager,
    }),
    /requires two distinct model ids/,
  )
  await assert.rejects(
    () => createSoakModules({
      config: {
        ...base,
        integration: {
          ...base.integration,
          grading: {
            ...base.integration.grading,
            testKappa: 0.4,
          },
        },
      },
      processManager,
    }),
    /kappa must be >= 0.7/,
  )
  await assert.rejects(
    () => createSoakModules({
      config: {
        ...base,
        integration: {
          ...base.integration,
          grading: {
            ...base.integration.grading,
            testModelIds: 'one-model',
          },
        },
      },
      processManager,
    }),
    /modelIds as a non-empty string array/,
  )
  await assert.rejects(
    () => createSoakModules({
      config: {
        ...base,
        integration: {
          ...base.integration,
          grading: {
            ...base.integration.grading,
            minimumKappa: 'high',
          },
        },
      },
      processManager,
    }),
    /minimumKappa must be a finite number/,
  )
})
