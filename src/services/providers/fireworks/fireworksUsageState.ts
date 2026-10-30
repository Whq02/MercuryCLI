import { credentialFingerprint } from '../credentialIdentity.js'
import { retryAfterHeaderMs } from '../../api/retryAfter.js'
import { fireworksChatCompletionsUrl, resolveFireworksApiKey } from './fireworksAccounts.js'
import type { ActiveSourceUsage, ProviderSessionSpend, UsageFigureView } from '../providerUsage.js'

const readings = new Map<string, { at: number; figures: UsageFigureView[]; limited: boolean }>()
const identity = (key: string, url: string): string => `${credentialFingerprint(key)}:${url}`

export function fireworksRecordHeaders(headers: Headers, status: number | undefined, key: string | undefined, url: string): void {
  if (!key) return
  const at = Date.now()
  const figures: UsageFigureView[] = []
  for (const [name, label] of [
    ['x-ratelimit-limit-tokens-prompt', 'Total prompt TPM limit'],
    ['x-ratelimit-limit-tokens-uncached-prompt', 'Uncached prompt TPM limit'],
    ['x-ratelimit-limit-tokens-cache-adjusted-prompt', 'Cache-adjusted prompt TPM limit'],
    ['x-ratelimit-limit-tokens-generated', 'Generated TPM limit'],
  ]) {
    const raw = headers.get(name!)
    const value = raw !== null && raw.trim() !== '' ? Number(raw) : Number.NaN
    if (Number.isFinite(value) && value >= 0) figures.push({ key: name!, label: label!, value: String(value), observedAtMs: at, source: 'headers', freshForMs: 60_000 })
  }
  const wait = status === 429 ? retryAfterHeaderMs(headers.get('retry-after') ?? undefined) : undefined
  if (wait !== undefined) figures.push({ key: 'retry', label: 'Requested retry time', value: new Date(at + wait).toLocaleString(), resetsAtMs: at + wait, observedAtMs: at, source: 'headers', freshForMs: 60_000 })
  if (figures.length > 0 || status === 429 || (status !== undefined && status >= 200 && status < 300)) readings.set(identity(key, url), { at, figures, limited: status === 429 })
}

export function fireworksUsageView(spend: ProviderSessionSpend, credentialed = resolveFireworksApiKey() !== undefined): ActiveSourceUsage {
  if (!credentialed) return { provider: 'fireworks', sourceKind: 'none', label: 'Fireworks usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'not connected — /logins fireworks adds a key' }
  const key = resolveFireworksApiKey()
  const reading = key ? readings.get(identity(key.key, fireworksChatCompletionsUrl())) : undefined
  return { provider: 'fireworks', sourceKind: 'api-key', label: 'API usage', shape: 'api-spend', windows: [], pools: [], figures: reading?.figures ?? [], spend, tier: 'API billing',
    credits: { state: 'unreported', reason: 'account credits are not read on this connection — app.fireworks.ai/account/billing shows them', compact: 'console only' },
    ...(reading?.limited ? { readerNote: 'The latest Fireworks response was rate limited; a retry asks the provider again.', readerNoteCompact: 'last response: rate limited' } : {}),
    absence: 'The session ledger counts tokens and spend. TPM limits come from response headers; account credits and rated costs are shown at app.fireworks.ai/account/billing.' }
}
