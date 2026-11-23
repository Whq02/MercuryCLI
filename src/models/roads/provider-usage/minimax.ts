import { API_BILLING_TIER, laneCredentialedLive } from './shared.js'
import type { ActiveSourceUsage, ActiveUsageReads, MinimaxPlanObservationView, ProviderSessionSpend, UsageWindowView } from '../providerUsage.js'
import { usageStaleAfterMs } from '../usageFreshness.js'

export function minimaxPlanWindowViews(observation: MinimaxPlanObservationView): UsageWindowView[] {
  if (observation.usage === null) return []
  const models = new Set(observation.usage.windows.map(window => window.model))
  return observation.usage.windows.map(window => ({
    key: `${window.name === '5 hour' ? '5h' : 'wk'}${models.size > 1 ? `:${window.model.toLowerCase()}` : ''}`,
    label: `M Plan ${window.name}${models.size > 1 ? ` · ${window.model}` : ''}`,
    state: 'live',
    usedPct: Math.min(100, Math.max(0, window.usedPercent)),
    ...(window.resetsAtMs !== undefined ? { resetsAtMs: window.resetsAtMs } : {}),
    observedAtMs: observation.usage!.observedAtMs,
    source: 'endpoint',
    freshForMs: usageStaleAfterMs(),
  }))
}

function liveMinimaxPlanUsage(): MinimaxPlanObservationView {
  const { minimaxObservedPlanUsage } = require('../minimax/minimaxUsageState.js') as typeof import('../minimax/minimaxUsageState.js')
  return minimaxObservedPlanUsage()
}

export function minimaxUsageView(provider: 'minimax', spend: ProviderSessionSpend, reads: ActiveUsageReads | undefined): ActiveSourceUsage {
  const credentialed = reads?.laneCredentialed?.(provider) ?? laneCredentialedLive(provider)
  if (!credentialed) return { provider, sourceKind: 'none', label: 'MiniMax usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'not connected — /logins minimax adds a key' }
  const { MINIMAX_BALANCE_NOTE, MINIMAX_PLAN_ABSENT_NOTE, minimaxPlanFailureWords } = require('../minimax/minimaxUsageState.js') as typeof import('../minimax/minimaxUsageState.js')
  const observation = (reads?.minimaxPlanUsage ?? liveMinimaxPlanUsage)()
  const windows = minimaxPlanWindowViews(observation)
  const note = observation.failure ? minimaxPlanFailureWords(observation.failure) : undefined
  const absence = observation.plan === 'none' ? `${MINIMAX_PLAN_ABSENT_NOTE}; ${MINIMAX_BALANCE_NOTE}` : MINIMAX_BALANCE_NOTE
  return {
    provider, sourceKind: 'api-key', label: 'API usage', shape: 'api-spend', windows, pools: [], spend, tier: API_BILLING_TIER,
    credits: { state: 'unreported', reason: 'the API states no balance to clients — platform.minimax.io shows it', compact: 'console only' },
    absence,
    ...(note ? { readerNote: note, readerNoteCompact: note } : {}),
  }
}
