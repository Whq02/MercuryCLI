import { credentialFingerprint } from '../credentialIdentity.js'
import { meliousApiBase, resolveMeliousApiKey } from './meliousAccounts.js'
import type { ActiveSourceUsage, ProviderSessionSpend } from '../providerUsage.js'

interface MeliousObservation {
  observedAtMs: number
  limit?: number
  remaining?: number
  resetsAtMs?: number
  billing?: { energy: string; credits: string; paidWith: string; observedAtMs: number }
  environmentImpact?: {
    energyKwh?: number; carbonGCo2?: number; waterLiters?: number; renewablePercent?: number; pue?: number
    providerId?: string; location?: string | null
  }
}
const readings = new Map<string, MeliousObservation>()
const identity = (key: string, base: string): string => `${credentialFingerprint(key)}:${base}`
const object = (value: unknown): Record<string, unknown> | undefined => typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
const decimal = (value: unknown): string | undefined => typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? value : undefined

export function meliousRecordHeaders(headers: Headers, key: string, base: string, now = Date.now()): void {
  const numeric = (name: string): number | undefined => {
    const value = headers.get(name)
    return value === null || value.trim() === '' ? undefined : number(Number(value))
  }
  const limit = numeric('x-ratelimit-limit')
  const remaining = numeric('x-ratelimit-remaining')
  const reset = numeric('x-ratelimit-reset')
  const id = identity(key, base)
  const previous = readings.get(id)
  if (limit === undefined && remaining === undefined && reset === undefined) {
    if (previous) readings.set(id, { ...previous, billing: undefined, environmentImpact: undefined })
    return
  }
  readings.set(id, { ...previous, billing: undefined, environmentImpact: undefined, observedAtMs: now,
    ...(limit !== undefined ? { limit } : {}), ...(remaining !== undefined ? { remaining } : {}),
    ...(reset !== undefined ? { resetsAtMs: reset * 1000 } : {}),
  })
}

export function meliousRecordChunk(raw: unknown, key: string, base: string, now = Date.now()): void {
  const chunk = object(raw)
  if (!object(chunk?.usage)) return
  const cost = object(chunk?.billing_cost)
  const impact = object(chunk?.environment_impact)
  const id = identity(key, base)
  const old = readings.get(id)
  const energy = decimal(cost?.energy)
  const credits = decimal(cost?.credits)
  const billing = energy !== undefined && credits !== undefined && typeof cost?.paid_with === 'string'
    ? { energy, credits, paidWith: cost.paid_with, observedAtMs: now } : undefined
  const environmentImpact: MeliousObservation['environmentImpact'] = impact ? {
    ...(number(impact.energy_kwh) !== undefined ? { energyKwh: number(impact.energy_kwh) } : {}),
    ...(number(impact.carbon_g_co2) !== undefined ? { carbonGCo2: number(impact.carbon_g_co2) } : {}),
    ...(number(impact.water_liters) !== undefined ? { waterLiters: number(impact.water_liters) } : {}),
    ...(number(impact.renewable_percent) !== undefined ? { renewablePercent: number(impact.renewable_percent) } : {}),
    ...(number(impact.pue) !== undefined ? { pue: number(impact.pue) } : {}),
    ...(typeof impact.provider_id === 'string' ? { providerId: impact.provider_id } : {}),
    ...(typeof impact.location === 'string' || impact.location === null ? { location: impact.location } : {}),
  } : undefined
  readings.set(id, { ...old, observedAtMs: old?.observedAtMs ?? now, billing, environmentImpact })
}

export function meliousObservedUsage(): MeliousObservation | null {
  const key = resolveMeliousApiKey()
  return key ? readings.get(identity(key.key, meliousApiBase())) ?? null : null
}
export function meliousUsageView(spend: ProviderSessionSpend, credentialed = resolveMeliousApiKey() !== undefined): ActiveSourceUsage {
  if (!credentialed) return { provider: 'melious', sourceKind: 'none', label: 'Melious AI usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'not connected — /logins melious adds a key' }
  const observed = meliousObservedUsage()
  const stamp = { source: 'headers' as const, observedAtMs: observed?.observedAtMs, freshForMs: 60_000 }
  const windows = observed?.limit !== undefined && observed.limit > 0 && observed.remaining !== undefined ? [{
    key: 'requests', label: 'Requests per minute', state: 'live' as const,
    usedPct: Math.min(100, Math.max(0, (1 - observed.remaining / observed.limit) * 100)), resetsAtMs: observed.resetsAtMs, ...stamp,
  }] : []
  const figures = observed?.billing ? [{ key: 'last-charge', label: 'Last request', value: `EUR ${observed.billing.credits} · ${observed.billing.energy} energy · ${observed.billing.paidWith}`, source: 'endpoint' as const, observedAtMs: observed.billing.observedAtMs, freshForMs: 60_000 }] : []
  return { provider: 'melious', sourceKind: 'api-key', label: 'API usage', shape: 'api-spend', windows, pools: [], figures, spend, tier: 'API billing',
    credits: { state: 'unreported', reason: 'account spend is shown at melious.ai/account/usage', compact: 'console only' },
    absence: 'Melious AI bills in EUR. The session ledger counts tokens; melious.ai/account/usage shows account spend.' }
}
