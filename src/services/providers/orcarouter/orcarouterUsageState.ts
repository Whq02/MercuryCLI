import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getProductUserAgent } from '../../../utils/http.js'
import { credentialFingerprint } from '../credentialIdentity.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { catalogueTrafficVerdict } from '../catalogueGate.js'
import { usagePollTtlMs, usageStaleAfterMs } from '../usageFreshness.js'
import type { ActiveSourceUsage, ProviderSessionSpend, UsageRefreshIo } from '../providerUsage.js'
import { orcarouterApiBase, resolveOrcarouterApiKey } from './orcarouterAccounts.js'

interface BillingSnapshot {
  observedAtMs: number
  attemptedAtMs: number
  usedUSD?: number
  limitUSD?: number
  unlimited?: boolean
  expiresAtMs?: number
  error?: string
}
const cache = new Map<string, BillingSnapshot>()
const inFlight = new Map<string, Promise<void>>()
function identity(key: string, base: string): string { return `${credentialFingerprint(key)}:${base}` }
function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

export async function refreshOrcarouterUsage(io: UsageRefreshIo = {}): Promise<void> {
  const env = io.env ?? process.env
  const key = resolveOrcarouterApiKey(env)
  if (!key || !catalogueTrafficVerdict('orcarouter', env).allowed) return
  const base = orcarouterApiBase(env)
  const id = identity(key.key, base)
  const now = io.now ?? Date.now
  const previous = cache.get(id)
  if (!io.force && previous && now() - previous.attemptedAtMs < usagePollTtlMs()) return
  const running = inFlight.get(id)
  if (running) return running
  const work = (async () => {
    try {
      const read = async (path: string): Promise<Record<string, unknown>> => {
        const response = await fetchWithProviderDeadline(io.fetchImpl ?? getApiFetch(), 'orcarouter', 15_000, `${base}/dashboard/billing/${path}`, {
          headers: { accept: 'application/json', authorization: `Bearer ${key.key}`, 'user-agent': getProductUserAgent() },
          ...(io.fetchImpl ? {} : getProxyFetchOptions()),
        } as RequestInit)
        if (!response.ok) throw new Error(`OrcaRouter billing ${path} returned HTTP ${response.status}`)
        const body = await response.json()
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(`OrcaRouter billing ${path} returned no object`)
        return body as Record<string, unknown>
      }
      const [usage, subscription] = await Promise.all([read('usage'), read('subscription')])
      const cents = number(usage.total_usage)
      const limit = number(subscription.hard_limit_usd) ?? number(subscription.soft_limit_usd) ?? number(subscription.system_hard_limit_usd)
      const expiry = number(subscription.access_until)
      if (cents === undefined && limit === undefined) throw new Error('OrcaRouter billing endpoints stated no usage or credit limit')
      cache.set(id, { observedAtMs: now(), attemptedAtMs: now(),
        ...(cents !== undefined ? { usedUSD: cents / 100 } : {}),
        ...(limit === 100_000_000 ? { unlimited: true } : limit !== undefined ? { limitUSD: limit } : {}),
        ...(expiry !== undefined && expiry > 0 ? { expiresAtMs: expiry * 1000 } : {}),
      })
    } catch (error) {
      cache.set(id, { ...previous, observedAtMs: previous?.observedAtMs ?? 0, attemptedAtMs: now(), error: (error instanceof Error ? error.message : String(error)).split(key.key).join('[redacted]') })
    } finally { inFlight.delete(id) }
  })()
  inFlight.set(id, work)
  return work
}

export function orcarouterUsageView(spend: ProviderSessionSpend, credentialed = resolveOrcarouterApiKey() !== undefined): ActiveSourceUsage {
  if (!credentialed) return { provider: 'orcarouter', sourceKind: 'none', label: 'OrcaRouter usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'not connected — /logins orcarouter adds a key' }
  const key = resolveOrcarouterApiKey()
  const reading = key ? cache.get(identity(key.key, orcarouterApiBase())) : undefined
  const stamp = { source: 'endpoint' as const, observedAtMs: reading?.observedAtMs, freshForMs: usageStaleAfterMs() }
  const remaining = reading?.limitUSD !== undefined && reading.usedUSD !== undefined ? Math.max(0, reading.limitUSD - reading.usedUSD) : undefined
  const display = remaining !== undefined ? `USD ${remaining.toFixed(2)} remaining credit` : undefined
  return {
    provider: 'orcarouter', sourceKind: 'api-key', label: 'API usage', shape: 'api-spend', windows: [], pools: [], spend, tier: 'API billing',
    figures: [
      ...(reading?.usedUSD !== undefined ? [{ key: 'usage', label: 'Total usage', value: `USD ${reading.usedUSD.toFixed(2)}`, ...stamp }] : []),
      ...(reading?.limitUSD !== undefined ? [{ key: 'credit-limit', label: 'Total credit limit', value: `USD ${reading.limitUSD.toFixed(2)}`, ...stamp }] : []),
      ...(reading?.unlimited ? [{ key: 'credit-limit', label: 'Key credit limit', value: 'none set', ...stamp }] : []),
      ...(reading?.expiresAtMs !== undefined ? [{ key: 'expiry', label: 'Key expires', value: new Date(reading.expiresAtMs).toISOString(), ...stamp }] : []),
    ],
    credits: display !== undefined ? { state: 'reported', display, compact: display, ...stamp } : { state: 'unreported', reason: reading?.unlimited ? 'the key has no credit limit — orcarouter.ai/console/billing shows the workspace wallet' : 'not read — /usage reads the billing endpoints', compact: reading?.unlimited ? 'no key limit' : 'not read' },
    ...(display !== undefined ? { balance: { display, observedAtMs: reading!.observedAtMs } } : {}),
    ...(reading?.error ? { readerNote: reading.error, readerNoteCompact: reading.error } : {}),
  }
}
