import type { ProviderFamilyId } from '../providerAdapter.js'
import type { UsageCarryView, UsageCreditsView } from '../providerUsage.js'
import { usageStaleAfterMs } from '../usageFreshness.js'

export function usageWindowLabel(windowMinutes?: number): string {
  if (windowMinutes === undefined) return 'win'
  if (windowMinutes >= 6 * 24 * 60) return 'wk'
  if (windowMinutes >= 24 * 60) return `${Math.round(windowMinutes / (24 * 60))}d`
  if (windowMinutes >= 60) return `${Math.round(windowMinutes / 60)}h`
  return `${Math.round(windowMinutes)}m`
}

export const CREDITS_UNREPORTED_WORDS = 'not reported by the provider'

export const CARRY_NOTHING_TAIL = 'nothing carries requests until the reset'

export const CARRY_UNSTATED_WORDS = 'the provider states nothing about what carries requests past the window'

export const CARRY_UNSTATED_COMPACT = 'past window: not stated'

export const CARRY_UNSTATED: UsageCarryView = { state: 'unstated', display: CARRY_UNSTATED_WORDS, compact: CARRY_UNSTATED_COMPACT }

export function polledBalanceCredits(balance: { display: string; observedAtMs: number } | undefined): UsageCreditsView {
  return balance !== undefined
    ? { state: 'reported', display: balance.display, compact: balance.display, source: 'endpoint', observedAtMs: balance.observedAtMs, freshForMs: usageStaleAfterMs() }
    : { state: 'unreported', reason: 'not read yet — /usage samples the balance endpoint', compact: 'not read yet' }
}

export const CREDITS_UNREPORTED: UsageCreditsView = { state: 'unreported', reason: CREDITS_UNREPORTED_WORDS, compact: 'not reported' }

export function planWord(plan: string): string {
  return plan.length > 0 ? plan[0]!.toUpperCase() + plan.slice(1) : plan
}

export const API_BILLING_TIER = 'API billing'

export function laneCredentialedLive(provider: ProviderFamilyId): boolean {
  if (provider === 'xai') {
    const { resolveXaiAccount } = require('../xai/xaiAccounts.js') as typeof import('../xai/xaiAccounts.js')
    return resolveXaiAccount() !== undefined
  }
  if (provider === 'meta') {
    const { resolveMetaApiKey } = require('../meta/metaAccounts.js') as typeof import('../meta/metaAccounts.js')
    return resolveMetaApiKey() !== undefined
  }
  if (provider === 'mistral') {
    const { resolveMistralApiKey } = require('../mistral/mistralAccounts.js') as typeof import('../mistral/mistralAccounts.js')
    return resolveMistralApiKey() !== undefined
  }
  if (provider === 'nous') {
    const { resolveNousAccount } = require('../nous/nousAccounts.js') as typeof import('../nous/nousAccounts.js')
    return resolveNousAccount() !== undefined
  }
  if (provider === 'deepseek') {
    const { resolveDeepseekApiKey } =
      require('../deepseek/deepseekAccounts.js') as typeof import('../deepseek/deepseekAccounts.js')
    return resolveDeepseekApiKey() !== undefined
  }
  if (provider === 'openai-compat') {
    const { configuredCompatEndpoints } =
      require('../openaicompat/compatAccounts.js') as typeof import('../openaicompat/compatAccounts.js')
    return configuredCompatEndpoints().length > 0
  }
  if (provider === 'zen') {
    const { resolveZenApiKey } = require('../zen/zenAccounts.js') as typeof import('../zen/zenAccounts.js')
    return resolveZenApiKey() !== undefined
  }
  if (provider === 'minimax') {
    const { resolveMinimaxApiKey } = require('../minimax/minimaxAccounts.js') as typeof import('../minimax/minimaxAccounts.js')
    return resolveMinimaxApiKey() !== undefined
  }
  if (provider === 'together') {
    const { resolveTogetherApiKey } = require('../together/togetherAccounts.js') as typeof import('../together/togetherAccounts.js')
    return resolveTogetherApiKey() !== undefined
  }
  if (provider === 'cohere') {
    const { resolveCohereApiKey } = require('../cohere/cohereAccounts.js') as typeof import('../cohere/cohereAccounts.js')
    return resolveCohereApiKey() !== undefined
  }
  if (provider === 'qwen') {
    const { resolveQwenCredentialSnapshot } = require('../qwen/qwenAccounts.js') as typeof import('../qwen/qwenAccounts.js')
    return resolveQwenCredentialSnapshot() !== undefined
  }
  return false
}
