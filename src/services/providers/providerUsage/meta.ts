import { API_BILLING_TIER, CARRY_UNSTATED, CREDITS_UNREPORTED, laneCredentialedLive } from './shared.js'
import type { ActiveSourceUsage, ActiveUsageReads, ProviderSessionSpend } from '../providerUsage.js'
import { providerSessionSpend } from './spend.js'
import { usageStaleAfterMs } from '../usageFreshness.js'

export function metaMuseCodeUsage(spend: ProviderSessionSpend = providerSessionSpend('meta')): ActiveSourceUsage | undefined {
  const state = require('../meta/metaUsageState.js') as typeof import('../meta/metaUsageState.js')
  const observed = state.metaObservedMuseCodeUsage()
  if (observed.usage === null) return undefined
  const note = observed.failure ? state.metaMuseCodeFailureWords(observed.failure) : undefined
  const windows = state.metaMuseCodeWindowViews(observed.usage)
  return {
    provider: 'meta',
    sourceKind: 'subscription-oauth',
    label: 'Muse Code subscription',
    shape: 'subscription-windows',
    windows,
    ...(windows.length === 0 ? { absence: 'Plan windows: not stated on the last read.' } : {}),
    pools: [],
    spend,
    tier: observed.usage.tierName ?? observed.usage.tierId ?? 'Muse Code',
    credits: {
      state: 'unreported',
      reason: 'plan windows meter the subscription',
      compact: 'plan windows',
      ...(observed.usage.observedAtMs ? { observedAtMs: observed.usage.observedAtMs, source: 'endpoint' as const, freshForMs: usageStaleAfterMs() } : {}),
    },
    carry: CARRY_UNSTATED,
    ...(note !== undefined ? { readerNote: note, readerNoteCompact: note } : {}),
  }
}

export function metaUsageView(provider: 'meta', spend: ProviderSessionSpend, reads: ActiveUsageReads | undefined): ActiveSourceUsage {
  const credentialed = reads?.laneCredentialed?.(provider) ?? laneCredentialedLive(provider)
  if (!credentialed) return { provider, sourceKind: 'none', label: 'Meta usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'not connected — /logins meta adds a key' }
  const state = require('../meta/metaUsageState.js') as typeof import('../meta/metaUsageState.js')
  const { resolveMetaAccount } = require('../meta/metaAccounts.js') as typeof import('../meta/metaAccounts.js')
  const account = reads?.laneCredentialed ? undefined : resolveMetaAccount()
  if (account?.kind === 'muse-code') {
    const subscription = metaMuseCodeUsage(spend)
    if (subscription !== undefined) return subscription
  }
  return { provider, sourceKind: 'api-key', label: 'API usage', shape: 'api-spend', windows: [], pools: [], credits: CREDITS_UNREPORTED, spend, tier: API_BILLING_TIER, absence: state.META_USAGE_ABSENCE }
}
