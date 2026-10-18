import { credentialFingerprint } from '../credentialIdentity.js'
import { retryAfterHeaderMs } from '../../api/retryAfter.js'
import { cerebrasChatCompletionsUrl, resolveCerebrasApiKey } from './cerebrasAccounts.js'
import type { ActiveSourceUsage, ProviderSessionSpend } from '../providerUsage.js'

const readings = new Map<string, { at: number; retryAt?: number; limited: boolean }>()
const identity = (key: string, url: string): string => `${credentialFingerprint(key)}:${url}`

export function cerebrasRecordHeaders(headers: Headers, status: number | undefined, key: string | undefined, url: string): void {
  if (!key) return
  const at = Date.now()
  const wait = status === 429 ? retryAfterHeaderMs(headers.get('retry-after') ?? undefined) : undefined
  if (status === 429 || (status !== undefined && status >= 200 && status < 300)) readings.set(identity(key, url), { at, limited: status === 429, ...(wait !== undefined ? { retryAt: at + wait } : {}) })
}

export function cerebrasUsageView(spend: ProviderSessionSpend, credentialed = resolveCerebrasApiKey() !== undefined): ActiveSourceUsage {
  if (!credentialed) return { provider: 'cerebras', sourceKind: 'none', label: 'Cerebras usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'not connected — /logins cerebras adds a key' }
  const key = resolveCerebrasApiKey()
  const reading = key ? readings.get(identity(key.key, cerebrasChatCompletionsUrl())) : undefined
  return { provider: 'cerebras', sourceKind: 'api-key', label: 'API usage', shape: 'api-spend', windows: [], pools: [], spend, tier: 'API billing',
    credits: { state: 'unreported', reason: 'account spend is shown at cloud.cerebras.ai, Analytics → Cost', compact: 'console only' },
    ...(reading?.limited ? { readerNote: 'The latest Cerebras response was rate limited; a retry asks the provider again.', readerNoteCompact: 'last response: rate limited' } : {}),
    ...(reading?.retryAt !== undefined ? { figures: [{ key: 'retry', label: 'Requested retry time', value: new Date(reading.retryAt).toLocaleString(), resetsAtMs: reading.retryAt, observedAtMs: reading.at, source: 'headers', freshForMs: 60_000 }] } : {}),
    absence: 'The session ledger counts tokens and spend. Account spend and limits are shown at cloud.cerebras.ai; the API states no remaining credit balance here.' }
}
