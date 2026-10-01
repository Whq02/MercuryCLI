import { errorMessageWithCause } from '../../../utils/errors.js'
import { writeStoredXaiApiKey, writeStoredXaiManagementApiKey } from '../../../utils/router/providerSecrets.js'
import { resolveXaiApiKey, xaiApiBase, xaiInferenceBase } from './xaiAccounts.js'
import { startXaiDeviceAuth, pollXaiDeviceToken, writeXaiTokens, writePreferredXaiSource, type XaiDeviceAuthStart, type XaiOauthIo } from './xaiOauth.js'
import { recordSignIn } from '../../../utils/accounts/signInLedger.js'
import { fetchXaiUsage, xaiUsageFailureWords, type XaiUsageIo } from './xaiUsageState.js'
import { fetchXaiLiveModels, XaiCatalogueHttpError } from './xaiCatalogue.js'

export interface XaiKeyLoginOutcome {
  ok: boolean
  stored: boolean
  receipt: string
}
export async function storeXaiApiKeyLogin(
  key: string,
  io?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number },
): Promise<XaiKeyLoginOutcome> {
  key = key.trim()
  if (!key) return { ok: false, stored: false, receipt: 'Paste a non-empty xAI API key.' }
  const env = io?.env ?? process.env
  const safe = (message: string): string => message.split(key).join('[redacted]')
  let note: string
  try {
    const result = await fetchXaiLiveModels({ baseUrl: xaiApiBase(env), key, ...(io?.fetchImpl ? { fetchImpl: io.fetchImpl } : {}) })
    note = `${result.models.length} chat ${result.models.length === 1 ? 'model' : 'models'} listed`
  } catch (error) {
    if (error instanceof XaiCatalogueHttpError && (error.status === 401 || error.status === 403)) {
      return { ok: false, stored: false, receipt: `xAI refused this key (HTTP ${error.status}) — nothing stored; check the key and its model-list permissions at console.x.ai and paste again.` }
    }
    note = `UNVERIFIED — the model list could not confirm the key (${safe(errorMessageWithCause(error))})`
  }
  try {
    writeStoredXaiApiKey(key)
    writePreferredXaiSource('api-key')
  } catch (error) {
    return { ok: false, stored: false, receipt: `Could not store the key: ${safe(errorMessageWithCause(error))}` }
  }
  const shadow = env.XAI_API_KEY?.trim() ? ' NOTE: XAI_API_KEY is set and wins over this stored key.' : ''
  return { ok: true, stored: true, receipt: `xAI API key stored (auth-scoped, mode 600) · ${note}. Requests use api.x.ai under usage-based billing.${shadow}` }
}
export async function storeXaiManagementKeyLogin(key: string, io?: XaiUsageIo): Promise<XaiKeyLoginOutcome> {
  key = key.trim()
  if (!key) return { ok: false, stored: false, receipt: 'Paste an xAI management key, or leave it blank to skip.' }
  const env = io?.env ?? process.env
  const apiKey = resolveXaiApiKey(env)?.key
  if (!apiKey) return { ok: false, stored: false, receipt: 'Add the xAI API key first — its metadata identifies the team whose usage is read.' }
  const probe = await fetchXaiUsage(apiKey, key, io)
  if (probe.state === 'failed' && probe.failure.kind === 'refused') {
    return { ok: false, stored: false, receipt: `${xaiUsageFailureWords(probe.failure)} — management key not stored.` }
  }
  const safe = (message: string): string => message.split(key).join('[redacted]').split(apiKey).join('[redacted]')
  try { writeStoredXaiManagementApiKey(key) } catch (error) {
    return { ok: false, stored: false, receipt: `Could not store the management key: ${safe(errorMessageWithCause(error))}` }
  }
  const note = probe.state === 'confirmed' ? 'team usage confirmed' : `UNVERIFIED — ${xaiUsageFailureWords(probe.failure)}`
  const shadow = env.XAI_MANAGEMENT_API_KEY?.trim() ? ' NOTE: XAI_MANAGEMENT_API_KEY is set and wins over this stored key.' : ''
  return { ok: true, stored: true, receipt: `xAI management key stored (auth-scoped, mode 600) · ${note}. /usage reads the team meter.${shadow}` }
}
export const XAI_CONNECT_ROWS = [
  { label: 'Sign in with your Grok account — SuperGrok / X Premium', value: 'device' },
  { label: 'Paste an API key (usage-based billing)', value: 'key' },
]
export const XAI_CONNECT_STOPPED_RECEIPT = 'Grok sign-in cancelled — an approval already in flight still lands; /accounts shows and removes it.'
export type XaiDeviceLoginEvent =
  | { phase: 'starting' | 'finishing' }
  | { phase: 'waiting'; start: XaiDeviceAuthStart; polls: number; note?: string }
export async function runXaiDeviceLogin(args: {
  io?: XaiOauthIo
  sleep?: (ms: number) => Promise<void>
  cancelled?: () => boolean
  onEvent?: (event: XaiDeviceLoginEvent) => void
} = {}): Promise<{ ok: boolean; receipt: string; settledAfterCancel?: true }> {
  const cancelled = args.cancelled ?? (() => false)
  const now = args.io?.now ?? Date.now
  const sleep = args.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  args.onEvent?.({ phase: 'starting' })
  let start: XaiDeviceAuthStart
  try { start = await startXaiDeviceAuth(args.io) } catch (error) {
    return { ok: false, receipt: errorMessageWithCause(error) }
  }
  let polls = 0
  let interval = start.intervalSec
  args.onEvent?.({ phase: 'waiting', start, polls })
  while (!cancelled() && now() < start.expiresAtMs) {
    await sleep(Math.min(interval * 1000, start.expiresAtMs - now()))
    if (cancelled() || now() >= start.expiresAtMs) break
    let result: Awaited<ReturnType<typeof pollXaiDeviceToken>>
    try { result = await pollXaiDeviceToken(start, args.io) } catch {
      args.onEvent?.({ phase: 'waiting', start, polls: ++polls, note: 'xAI did not return a token answer — waiting until the code expires.' })
      continue
    }
    polls++
    if (result.state === 'slow-down') interval += 5
    if (result.state === 'pending' || result.state === 'slow-down') {
      args.onEvent?.({ phase: 'waiting', start, polls })
      continue
    }
    if (result.state !== 'authorized') return { ok: false, receipt: `Grok sign-in ${result.state} — nothing stored; /logins xai retries.` }
    args.onEvent?.({ phase: 'finishing' })
    try {
      writeXaiTokens(result.tokens)
      writePreferredXaiSource('grok-subscription')
      recordSignIn('xai', 'oauth')
    } catch { return { ok: false, receipt: 'xAI approved sign-in but storing the grant failed; /logins xai retries.' } }
    const late = (): { ok: boolean; receipt: string; settledAfterCancel: true } => ({ ok: true, settledAfterCancel: true, receipt: 'Grok sign-in completed after cancel — the approved grant is stored; /accounts removes it.' })
    if (cancelled()) return late()
    let note = 'UNVERIFIED — the model list did not answer; the first turn proves access'
    try {
      const list = await fetchXaiLiveModels({ baseUrl: xaiInferenceBase('oauth', args.io?.env), key: result.tokens.accessToken, fetchImpl: args.io?.fetchImpl })
      note = `${list.models.length} chat models listed; inference is not yet verified`
    } catch (error) {
      if (error instanceof XaiCatalogueHttpError) note = `UNVERIFIED — model list HTTP ${error.status}; xAI decides subscription eligibility`
    }
    if (cancelled()) return late()
    return { ok: true, receipt: `Grok subscription sign-in stored (auth-scoped, mode 600) · ${note}. Requests use cli-chat-proxy.grok.com on the subscription's included pool. Subscription wins over API keys; /accounts manages it. The consent page may call the shared public client Grok Build.` }
  }
  return { ok: false, receipt: cancelled() ? 'Grok sign-in cancelled — nothing stored.' : 'Grok device code expired — /logins xai retries.' }
}
