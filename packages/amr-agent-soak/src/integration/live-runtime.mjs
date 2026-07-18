import { assertSubscriptionNotDenylisted } from '../cache/guards.mjs'

export function assertLiveRuntimeConfig(runtimeConfig) {
  assertSubscriptionNotDenylisted(
    runtimeConfig.subscriptionId,
    runtimeConfig.subscriptionDenylist,
  )
  if (!runtimeConfig.resourceGroup) {
    throw new Error('Live cache runtime config requires resourceGroup')
  }
  if (!Array.isArray(runtimeConfig.denylist) || runtimeConfig.denylist.length === 0) {
    throw new Error('Live cache runtime config requires a non-empty resource denylist')
  }
  if (
    !Array.isArray(runtimeConfig.subscriptionDenylist) ||
    runtimeConfig.subscriptionDenylist.length === 0
  ) {
    throw new Error('Live cache runtime config requires a non-empty subscription denylist')
  }
  if (!Number.isFinite(runtimeConfig.createPollTimeoutMs) || runtimeConfig.createPollTimeoutMs < 1000) {
    throw new Error('Live cache runtime config requires createPollTimeoutMs >= 1000')
  }
  if (!Number.isFinite(runtimeConfig.deletePollTimeoutMs) || runtimeConfig.deletePollTimeoutMs < 1000) {
    throw new Error('Live cache runtime config requires deletePollTimeoutMs >= 1000')
  }
  return runtimeConfig
}
