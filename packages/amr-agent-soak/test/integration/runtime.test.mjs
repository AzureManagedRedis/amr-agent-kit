import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
    calibratedModels: [],
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

function fakeScenarioExecutor(config) {
  return {
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
    const executor = fakeScenarioExecutor(config)
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
          liveCache: { enabled: true, reviewedReady: true },
        },
      },
      processManager,
    }),
    /requires a gitignored runtimeConfigPath/,
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
    /reviewedReady=true/,
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
  assert.equal(modules.snapshot.graderInput.maxConcurrentPairs, 4)
  assert.equal(modules.snapshot.graderInput.maximumActiveModelProcesses, 16)
  assert.equal(modules.snapshot.maxConcurrentGradingPairs, 4)
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
  await assert.rejects(
    () => createSoakModules({
      config: {
        ...base,
        integration: {
          ...base.integration,
          grading: {
            ...base.integration.grading,
            maxConcurrentPairs: 5,
          },
        },
      },
      processManager,
    }),
    /maxConcurrentPairs must be an integer from 1 through 4/,
  )
  await assert.rejects(
    () => createSoakModules({
      config: {
        ...base,
        concurrency: 13,
        integration: {
          ...base.integration,
          grading: {
            ...base.integration.grading,
            maxConcurrentPairs: 4,
          },
        },
      },
      processManager,
    }),
    /controller concurrency plus integration\.grading\.maxConcurrentPairs must not exceed 16/,
  )
})

test('instantiates the reviewed ARM adapter from gitignored runtime configuration without network access', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arm-adapter-factory-'))
  const runtimeConfigPath = path.join(root, 'runtime.local.json')
  await writeFile(runtimeConfigPath, `${JSON.stringify({
    subscriptionId: 'customer-subscription',
    tenantId: 'test-tenant',
    owner: 'tester',
    runId: 'arm-adapter-factory',
    resourceGroup: 'test-resource-group',
    apiVersion: '2024-09-01-preview',
    ackCustomerSubscription: true,
    denylist: ['backing-infrastructure-subscription'],
    subscriptionDenylist: ['different-backing-subscription'],
  }, null, 2)}\n`, 'utf8')
  try {
    const config = {
      runId: 'arm-adapter-factory',
      repositoryRoot: repoRoot,
      outputRoot: root,
      skillSnapshotPath: path.join(repoRoot, 'skills', 'redis-code'),
      repetitions: 3,
      durationHours: 48,
      model: 'executor-model',
      integration: {
        targetSkill: 'redis-code',
        scenarioIds: ['scn-connection-auth-tls-entra'],
        grading: {
          mode: 'external-blind',
          modulePath: 'packages/amr-agent-soak/test/integration/fixtures/fake-blind-grader.mjs',
          minimumKappa: 0.7,
        },
        liveCache: {
          enabled: true,
          reviewedReady: true,
          runtimeConfigPath,
        },
      },
    }
    const modules = await createSoakModules({ config, processManager })
    assert.equal(modules.snapshot.liveAdapterValidation.module, 'http-adapter.mjs')
    assert.ok(modules.snapshot.liveAdapterValidation.methods.includes('createDatabase'))
    assert.equal(modules.snapshot.liveAdapterValidation.createPollTimeoutMs, 1800000)
    assert.equal(modules.snapshot.liveAdapterValidation.deletePollTimeoutMs, 1200000)
    assert.equal(modules.snapshot.liveInputs.length, 2)

    await writeFile(runtimeConfigPath, `${JSON.stringify({
      subscriptionId: 'customer-subscription',
      tenantId: 'test-tenant',
      owner: 'tester',
      runId: 'arm-adapter-factory',
      resourceGroup: 'test-resource-group',
      apiVersion: '2024-09-01-preview',
      ackCustomerSubscription: true,
      denylist: ['protected-resource-*'],
      subscriptionDenylist: ['customer-subscription'],
    }, null, 2)}\n`, 'utf8')
    await assert.rejects(
      () => createSoakModules({
        config: {
          ...config,
          integration: {
            ...config.integration,
            liveCache: {
              ...config.integration.liveCache,
              adapterModule: 'packages/amr-agent-soak/test/integration/fixtures/throwing-arm-adapter.mjs',
            },
          },
        },
        processManager,
      }),
      /present in the runtime subscription denylist/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pair-grades both arms and persists raw grader agreement through the controller', async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'blind-pair-controller-'))
  const config = {
    runId: 'blind-pair-controller',
    repositoryRoot: repoRoot,
    outputRoot,
    skillSnapshotPath: path.join(repoRoot, 'skills', 'redis-code'),
    concurrency: 12,
    repetitions: 2,
    durationHours: 48,
    timeoutMinutes: 1,
    heartbeatSeconds: 0.05,
    model: 'executor-model',
    integration: {
      targetSkill: 'redis-code',
      scenarioIds: ['scn-connection-auth-tls-entra'],
      grading: {
        mode: 'external-blind',
        modulePath: 'packages/amr-agent-soak/test/integration/fixtures/fake-blind-grader.mjs',
        minimumKappa: 0.7,
      },
      executionCache: { enabled: false },
      evidence: { required: false, hooks: [] },
      liveCache: { enabled: false },
    },
  }
  try {
    const integrated = await createSoakModules({ config, processManager })
    const summary = await runSoak(config, {
      ...integrated,
      executor: fakeScenarioExecutor(config),
      processManager,
    })
    assert.equal(summary.status, 'completed')
    assert.equal(summary.completedPairs, 2)
    const state = JSON.parse(await readFile(path.join(outputRoot, config.runId, 'state.json'), 'utf8'))
    assert.ok(Object.values(state.pairs).every((pair) => pair.gradedAt))
    for (const pair of Object.values(state.pairs)) {
      for (const arm of ['with-skill', 'without-skill']) {
        const artifact = JSON.parse(await readFile(pair.arms[arm].artifactPath, 'utf8'))
        assert.equal(artifact.grade.passed, true)
        assert.equal(artifact.grade.details.graders.length, 2)
      }
    }
    const report = await readFile(path.join(outputRoot, config.runId, 'report.md'), 'utf8')
    assert.match(report, /Cohen's kappa: 1\.000/)

    const [firstPair] = Object.values(state.pairs)
    delete firstPair.gradedAt
    delete firstPair.completedAt
    for (const arm of ['with-skill', 'without-skill']) {
      const artifact = JSON.parse(await readFile(firstPair.arms[arm].artifactPath, 'utf8'))
      delete artifact.grade
      await writeFile(firstPair.arms[arm].artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
    }
    await writeFile(
      path.join(outputRoot, config.runId, 'state.json'),
      `${JSON.stringify(state, null, 2)}\n`,
      'utf8',
    )
    const resumed = await runSoak(config, {
      ...integrated,
      executor: fakeScenarioExecutor(config),
      processManager,
    })
    assert.equal(resumed.status, 'completed')
    const resumedState = JSON.parse(await readFile(path.join(outputRoot, config.runId, 'state.json'), 'utf8'))
    assert.ok(Object.values(resumedState.pairs).every((pair) => pair.gradedAt))
  } finally {
    await rm(outputRoot, { recursive: true, force: true })
  }
})

test('continues after a contested pair and reports it as inconclusive without a zero score', async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'blind-contested-controller-'))
  const config = {
    runId: 'blind-contested-controller',
    repositoryRoot: repoRoot,
    outputRoot,
    skillSnapshotPath: path.join(repoRoot, 'skills', 'redis-code'),
    concurrency: 12,
    repetitions: 2,
    durationHours: 48,
    timeoutMinutes: 1,
    heartbeatSeconds: 0.05,
    model: 'executor-model',
    integration: {
      targetSkill: 'redis-code',
      scenarioIds: ['scn-connection-auth-tls-entra'],
      grading: {
        mode: 'external-blind',
        modulePath: 'packages/amr-agent-soak/test/integration/fixtures/fake-blind-grader.mjs',
        minimumKappa: 0.7,
        testInconclusiveFirstPair: true,
      },
      executionCache: { enabled: false },
      evidence: { required: false, hooks: [] },
      liveCache: { enabled: false },
    },
  }
  try {
    const integrated = await createSoakModules({ config, processManager })
    const summary = await runSoak(config, {
      ...integrated,
      executor: fakeScenarioExecutor(config),
      processManager,
    })
    assert.equal(summary.status, 'completed')
    assert.equal(summary.completedPairs, 2)

    const state = JSON.parse(await readFile(path.join(outputRoot, config.runId, 'state.json'), 'utf8'))
    assert.ok(Object.values(state.pairs).every((pair) => pair.gradedAt))
    const grades = []
    for (const pair of Object.values(state.pairs)) {
      for (const arm of ['with-skill', 'without-skill']) {
        const artifact = JSON.parse(await readFile(pair.arms[arm].artifactPath, 'utf8'))
        grades.push(artifact.grade)
      }
    }
    assert.equal(grades.filter((grade) => grade.inconclusive).length, 2)
    assert.equal(grades.filter((grade) => grade.passed).length, 2)

    const benchmark = JSON.parse(
      await readFile(path.join(outputRoot, config.runId, 'benchmark.json'), 'utf8'),
    )
    assert.deepEqual(benchmark.outcome_counts, {
      passed_runs: 2,
      failed_runs: 0,
      inconclusive_runs: 2,
      inconclusive_pairs: 1,
    })
    assert.equal(benchmark.results[0].paired_statistics.n, 1)
    assert.equal(benchmark.results[0].with_skill_summary.efficacy.mean, 1)
    assert.equal(benchmark.results[0].without_skill_summary.efficacy.mean, 1)
    const report = await readFile(path.join(outputRoot, config.runId, 'report.md'), 'utf8')
    assert.match(report, /Inconclusive pairs: \*\*1\*\*/)
    assert.doesNotMatch(report, /\| 0\.000 \| 0\.000 \|/)
  } finally {
    await rm(outputRoot, { recursive: true, force: true })
  }
})
