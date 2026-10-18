import { credentialFingerprint } from '../credentialIdentity.js'
import { groqApiBase, resolveGroqApiKey } from './groqAccounts.js'

interface GroqRateWindow {
  key: 'requests' | 'tokens'
  label: string
  limit?: number
  remaining?: number
  resetsAtMs?: number
}

interface GroqRateObservation {
  observedAtMs: number
  windows: GroqRateWindow[]
}

const readings = new Map<string, GroqRateObservation>()

function identity(key: string, base: string): string {
  return `${credentialFingerprint(key)}:${base}`
}

function durationMs(value: string | null): number | undefined {
  if (!value || !/^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/.test(value)) return undefined
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  const ms = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)].reduce((sum, match) => sum + Number(match[1]) * units[match[2]!]!, 0)
  return Number.isFinite(ms) ? ms : undefined
}

function numberHeader(headers: Headers, name: string): number | undefined {
  const value = headers.get(name)
  if (value === null || value.trim() === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

export function groqRecordHeaders(headers: Headers, key: string, base: string, now = Date.now()): void {
  const windows: GroqRateWindow[] = []
  for (const name of ['requests', 'tokens'] as const) {
    const limit = numberHeader(headers, `x-ratelimit-limit-${name}`)
    const remaining = numberHeader(headers, `x-ratelimit-remaining-${name}`)
    const resetMs = durationMs(headers.get(`x-ratelimit-reset-${name}`))
    if (limit === undefined && remaining === undefined && resetMs === undefined) continue
    windows.push({ key: name, label: name === 'requests' ? 'Requests per day' : 'Tokens per minute',
      ...(limit !== undefined ? { limit } : {}), ...(remaining !== undefined ? { remaining } : {}),
      ...(resetMs !== undefined ? { resetsAtMs: now + resetMs } : {}) })
  }
  if (windows.length > 0) readings.set(identity(key, base), { observedAtMs: now, windows })
}

export function groqObservedLimits(): GroqRateObservation | null {
  const key = resolveGroqApiKey()
  return key ? readings.get(identity(key.key, groqApiBase())) ?? null : null
}

export function groqHeaderWaitMs(headers: Headers): number | undefined {
  const waits = (['requests', 'tokens'] as const).flatMap(name => {
    if (numberHeader(headers, `x-ratelimit-remaining-${name}`) !== 0) return []
    const ms = durationMs(headers.get(`x-ratelimit-reset-${name}`))
    return ms !== undefined ? [ms] : []
  })
  return waits.length > 0 ? Math.max(...waits) : undefined
}

export function groqUsageView(spend: import('../providerUsage.js').ProviderSessionSpend, credentialed = resolveGroqApiKey() !== undefined): import('../providerUsage.js').ActiveSourceUsage {
  if (!credentialed) return { provider: 'groq', sourceKind: 'none', label: 'Groq usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'not connected — /logins groq adds a key' }
  const observation = groqObservedLimits()
  const windows = (observation?.windows ?? []).map(window => ({ key: window.key, label: window.label, state: 'live' as const,
    ...(window.limit !== undefined && window.limit > 0 && window.remaining !== undefined ? { usedPct: Math.min(100, Math.max(0, (1 - window.remaining / window.limit) * 100)) } : {}),
    ...(window.resetsAtMs !== undefined ? { resetsAtMs: window.resetsAtMs } : {}), observedAtMs: observation!.observedAtMs, source: 'headers' as const, freshForMs: 60_000 }))
  const figures = (observation?.windows ?? []).map(window => ({ key: window.key, label: window.label,
    value: [window.remaining !== undefined ? window.remaining + ' remaining' : undefined, window.limit !== undefined ? 'limit ' + window.limit : undefined].filter(Boolean).join(' / ') || 'reset stated',
    ...(window.resetsAtMs !== undefined ? { resetsAtMs: window.resetsAtMs } : {}), observedAtMs: observation!.observedAtMs, source: 'headers' as const, freshForMs: 60_000 }))
  return { provider: 'groq', sourceKind: 'api-key', label: 'API usage', shape: 'api-spend', windows, pools: [], figures, spend, tier: 'API billing',
    credits: { state: 'unreported', reason: 'account spend is shown at console.groq.com/dashboard/usage', compact: 'console only' },
    absence: 'The session ledger counts this key’s tokens and spend; rate limits are last observed from response headers. Account spend is shown at console.groq.com/dashboard/usage.' }
}
