import { API_BILLING_TIER, laneCredentialedLive } from './shared.js'
import type { ActiveSourceUsage, ActiveUsageReads, ProviderSessionSpend, UsageWindowView, ZenGoObservationView } from '../providerUsage.js'
import { usageStaleAfterMs } from '../usageFreshness.js'

const ZEN_GO_WINDOW_KEYS: Record<'5 hour' | 'weekly' | 'monthly', string> = { '5 hour': '5h', weekly: 'wk', monthly: 'mo' }

export function zenGoWindowViews(observation: ZenGoObservationView): UsageWindowView[] {
  if (observation.usage === null) return []
  return observation.usage.windows.map(window => ({
    key: ZEN_GO_WINDOW_KEYS[window.name],
    label: `Go ${window.name}`,
    state: 'live',
    usedPct: Math.min(100, Math.max(0, window.usedPercent)),
    ...(window.resetsAtMs !== undefined ? { resetsAtMs: window.resetsAtMs } : {}),
    observedAtMs: observation.usage!.observedAtMs,
    source: 'endpoint',
    freshForMs: usageStaleAfterMs(),
  }))
}

function liveZenGoUsage(): ZenGoObservationView {
  const { zenObservedGoUsage } = require('../zen/zenUsageState.js') as typeof import('../zen/zenUsageState.js')
  return zenObservedGoUsage()
}

export function zenUsageView(provider: 'zen', spend: ProviderSessionSpend, reads: ActiveUsageReads | undefined): ActiveSourceUsage {
  const credentialed = reads?.laneCredentialed?.(provider) ?? laneCredentialedLive(provider)
  if (!credentialed) return { provider, sourceKind: 'none', label: 'OpenCode Zen usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'not connected — /logins zen adds a key' }
  const { ZEN_BALANCE_NOTE, ZEN_GO_ABSENT_NOTE, zenGoFailureWords } = require('../zen/zenUsageState.js') as typeof import('../zen/zenUsageState.js')
  const observation = (reads?.zenGoUsage ?? liveZenGoUsage)()
  const windows = zenGoWindowViews(observation)
  const note = observation.failure ? zenGoFailureWords(observation.failure) : undefined
  const absence = observation.plan === 'none' ? `${ZEN_GO_ABSENT_NOTE}; ${ZEN_BALANCE_NOTE}` : ZEN_BALANCE_NOTE
  return {
    provider, sourceKind: 'api-key', label: 'API usage', shape: 'api-spend', windows, pools: [], spend, tier: API_BILLING_TIER,
    credits: { state: 'unreported', reason: 'the gateway states no balance to clients — the OpenCode console shows it', compact: 'console only' },
    absence,
    ...(note ? { readerNote: note, readerNoteCompact: note } : {}),
  }
}
