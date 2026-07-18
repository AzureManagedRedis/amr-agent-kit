import assert from 'node:assert/strict'
import test from 'node:test'
import { loadSoakRegistry, RegistryScenarioProvider, applyUnifiedPatch, defaults } from '../../src/integration/registry.mjs'
import { RegistryGrader } from '../../src/integration/grading-adapter.mjs'
import * as integration from '../../src/integration/index.mjs'

test('loads all validated registry scenarios and selects one target skill', async () => {
  const runtime = await loadSoakRegistry()
  assert.equal(runtime.scenarios.length, 17)
  const provider = new RegistryScenarioProvider(runtime, {
    targetSkill: 'redis-code',
    scenarioIds: ['scn-connection-auth-tls-entra'],
    runId: 'registry-test',
  })
  const [scenario] = await provider.listScenarios()
  assert.equal(scenario.id, 'scn-connection-auth-tls-entra')
  assert.equal(scenario.metadata.targetSkill, 'redis-code')
  assert.ok(scenario.scaffold['inputs/client-config.txt'])
  assert.ok(Object.keys(scenario.scaffold).some((name) => name.startsWith('client-source/')))
  assert.match(scenario.scaffold['client-policy/invariants.txt'], /client-lifecycle=create-per-request/)
  assert.doesNotMatch(JSON.stringify(scenario.scaffold), /source_fact_ref|embedded_defects/)
})

test('rejects a scenario assigned to the other target skill', async () => {
  const runtime = await loadSoakRegistry()
  const provider = new RegistryScenarioProvider(runtime, {
    targetSkill: 'redis-code',
    scenarioIds: ['scn-sku-workload-sizing'],
  })
  await assert.rejects(() => provider.listScenarios(), /target the other skill/)
})

test('applies retained unified mutation patches deterministically', () => {
  const source = 'a=1\nb=2\nc=3\n'
  const patch = '--- a/reference-good/invariants.txt\n+++ b/reference-good/invariants.txt\n@@ -1,3 +1,3 @@\n a=1\n-b=2\n+b=unsafe\n c=3\n'
  assert.equal(applyUnifiedPatch(source, patch), 'a=1\nb=unsafe\nc=3\n')
  assert.ok(defaults.registryPath.endsWith('registry.json'))
})

test('classifies every frozen known-good and known-bad grader canary', async () => {
  const runtime = await loadSoakRegistry()
  for (const targetSkill of ['redis-code', 'azure-redis-infra']) {
    const scenarios = await new RegistryScenarioProvider(runtime, {
      targetSkill,
      runId: 'calibration-test',
    }).listScenarios()
    const grader = new RegistryGrader()
    await assert.doesNotReject(() => grader.assertCalibration(scenarios))
    for (const scenario of scenarios) {
      for (const canary of scenario.metadata.graderCanaries) {
        const result = await grader.grade({ responseText: canary.answer_excerpt }, scenario)
        assert.equal(result.passed, canary.expected_grade === 'pass', canary.id)
      }
    }
  }
})

test('integration package barrel exposes unambiguous adapter symbols', () => {
  assert.equal(typeof integration.createSoakModules, 'function')
  assert.equal(typeof integration.RegistryGrader, 'function')
  assert.equal(typeof integration.RegistryScenarioProvider, 'function')
  assert.equal(typeof integration.FileExecutionArtifactCache, 'function')
})
